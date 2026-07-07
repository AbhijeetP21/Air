// Mints a short-lived LiveKit access token after verifying the caller is
// authenticated and the room is real, active, and unexpired.
//
// The LiveKit API key + secret live only in this server route — they never
// reach the client bundle. The browser receives just the signed JWT and the
// (public) LiveKit URL, then connects to the SFU directly.
//
// Auth-gated: only signed-in users get a token, and the grant is scoped to the
// single room they asked for.

import { AccessToken } from 'livekit-server-sdk'
import { NextResponse } from 'next/server'

import { createServerClient } from '@/lib/supabase/server'
import { LIVEKIT_URL } from '@/lib/env'
import { MAX_DISPLAY_NAME_LENGTH } from '@/lib/utils'
import type { Room } from '@/types'

// The server SDK signs tokens with Node crypto — force the Node runtime (not
// Edge) and never cache: the response is per-user and auth-gated.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  if (!apiKey || !apiSecret || !LIVEKIT_URL) {
    console.error('[livekit-token] LiveKit env vars are not configured.')
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

  let slug: unknown
  let sessionId: unknown
  try {
    ;({ slug, sessionId } = (await request.json()) as {
      slug?: unknown
      sessionId?: unknown
    })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (typeof slug !== 'string' || !slug) {
    return NextResponse.json({ error: 'Missing room slug' }, { status: 400 })
  }
  // The LiveKit identity is a client-generated session id (not the user id), so
  // the same account can join from two tabs/devices without LiveKit treating it
  // as one participant reconnecting and kicking the first session. The trusted
  // user id travels in server-set metadata instead. nanoid alphabet only.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,24}$/.test(sessionId)) {
    return NextResponse.json({ error: 'Missing session id' }, { status: 400 })
  }

  // RLS ("read active rooms") already hides inactive/expired rooms, so a missing
  // row covers not-found, deactivated, and expired — but re-check expiry so a
  // room that lapsed between the page load and join is rejected.
  const { data: room } = await supabase
    .from('rooms')
    .select('slug, is_active, expires_at')
    .eq('slug', slug)
    .maybeSingle<Pick<Room, 'slug' | 'is_active' | 'expires_at'>>()

  const isExpired = room?.expires_at
    ? new Date(room.expires_at).getTime() <= Date.now()
    : false
  if (!room || !room.is_active || isExpired) {
    return NextResponse.json({ error: 'Room not found' }, { status: 404 })
  }

  const displayName = (
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email?.split('@')[0] ??
    'Guest'
  )
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)

  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ?? null

  const at = new AccessToken(apiKey, apiSecret, {
    identity: sessionId,
    name: displayName,
    // Server-set (unforgeable by other participants): who this session really
    // is. Clients read it to key rosters and gate the host badge.
    metadata: JSON.stringify({ userId: user.id, avatarUrl }),
    ttl: '2h',
  })
  at.addGrant({
    roomJoin: true,
    room: room.slug,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  return NextResponse.json({ token: await at.toJwt(), url: LIVEKIT_URL })
}
