// Host-only room moderation: force-mute a participant, remove (kick) them, or
// mute everyone else at once.
//
// These actions use the LiveKit server API (RoomServiceClient), which requires
// the API key + secret — so they run here, never on the client. The caller must
// be the room's creator; that's enforced against the DB on every request, so a
// forged body can't grant moderation rights.

import { RoomServiceClient, TrackType } from 'livekit-server-sdk'
import { NextResponse } from 'next/server'

import { createServerClient } from '@/lib/supabase/server'
import { LIVEKIT_URL } from '@/lib/env'
import type { Room } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Action = 'mute' | 'remove' | 'mute-all'

/** LiveKit's server API speaks https, but the public URL is a wss endpoint. */
function httpHost(wssUrl: string): string {
  return wssUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!apiKey || !apiSecret || !LIVEKIT_URL) {
    return NextResponse.json(
      { error: 'Video service is not configured' },
      { status: 500 },
    )
  }

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { slug?: unknown; action?: unknown; targetIdentity?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const slug = body.slug
  const action = body.action as Action
  const targetIdentity = body.targetIdentity
  if (typeof slug !== 'string' || !slug) {
    return NextResponse.json({ error: 'Missing room slug' }, { status: 400 })
  }
  if (action !== 'mute' && action !== 'remove' && action !== 'mute-all') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  // Only the room's creator may moderate. RLS lets any member read the row, so
  // we compare created_by explicitly rather than trusting the client.
  const { data: room } = await supabase
    .from('rooms')
    .select('slug, created_by')
    .eq('slug', slug)
    .maybeSingle<Pick<Room, 'slug' | 'created_by'>>()
  if (!room) {
    return NextResponse.json({ error: 'Room not found' }, { status: 404 })
  }
  if (room.created_by !== user.id) {
    return NextResponse.json({ error: 'Host only' }, { status: 403 })
  }

  const svc = new RoomServiceClient(httpHost(LIVEKIT_URL), apiKey, apiSecret)

  try {
    if (action === 'remove') {
      if (typeof targetIdentity !== 'string' || !targetIdentity) {
        return NextResponse.json({ error: 'Missing target' }, { status: 400 })
      }
      await svc.removeParticipant(slug, targetIdentity)
    } else if (action === 'mute') {
      if (typeof targetIdentity !== 'string' || !targetIdentity) {
        return NextResponse.json({ error: 'Missing target' }, { status: 400 })
      }
      await muteParticipantAudio(svc, slug, targetIdentity)
    } else {
      // mute-all: mute everyone except the host (the caller). Identities are
      // per-session ids, so the host is recognised by the userId in the
      // server-set participant metadata (see the token route).
      const participants = await svc.listParticipants(slug)
      await Promise.all(
        participants
          .filter((p) => metadataUserId(p.metadata) !== user.id)
          .map((p) => muteParticipantAudio(svc, slug, p.identity)),
      )
    }
  } catch (err) {
    console.error('[livekit-room] moderation action failed', err)
    return NextResponse.json({ error: 'Action failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}

/** Extract the trusted userId from server-set participant metadata. */
function metadataUserId(metadata: string | undefined): string | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { userId?: unknown }
    return typeof parsed.userId === 'string' ? parsed.userId : null
  } catch {
    return null
  }
}

/** Mute a participant's microphone track, if they have one publishing. */
async function muteParticipantAudio(
  svc: RoomServiceClient,
  room: string,
  identity: string,
): Promise<void> {
  const info = await svc.getParticipant(room, identity)
  const audio = info.tracks.find((t) => t.type === TrackType.AUDIO)
  if (audio && !audio.muted) {
    await svc.mutePublishedTrack(room, identity, audio.sid, true)
  }
}
