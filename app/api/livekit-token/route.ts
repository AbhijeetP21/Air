// Mints a short-lived LiveKit access token after verifying the caller is
// authenticated and the room is real, active, and unexpired.
//
// The LiveKit API key + secret live only in this server route — they never
// reach the client bundle. The browser receives just the signed JWT and the
// (public) LiveKit URL, then connects to the SFU directly.
//
// Auth-gated: only signed-in users get a token, and the grant is scoped to the
// single room they asked for.

import { createHmac } from 'node:crypto'

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { NextResponse } from 'next/server'

import { createServerClient } from '@/lib/supabase/server'
import { LIVEKIT_URL } from '@/lib/env'
import { MAX_DISPLAY_NAME_LENGTH } from '@/lib/utils'
import type { Room } from '@/types'

// The server SDK signs tokens with Node crypto — force the Node runtime (not
// Edge) and never cache: the response is per-user and auth-gated.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** LiveKit's server API speaks https, but the public URL is a wss endpoint. */
function httpHost(wssUrl: string): string {
  return wssUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

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

  // Look the room up by exact slug through a SECURITY DEFINER function. The
  // rooms table is otherwise readable only by its creator (no enumeration), so
  // this is the one path that resolves a slug for a joiner. It already filters
  // inactive/expired rows, so a null result covers not-found/deactivated/expired.
  const { data: room } = (await supabase.rpc('get_active_room_by_slug', {
    p_slug: slug,
  })) as {
    data: Pick<
      Room,
      | 'id'
      | 'slug'
      | 'is_active'
      | 'expires_at'
      | 'created_by'
      | 'waiting_room'
      | 'broadcast'
      | 'max_participants'
    > | null
  }

  if (!room) {
    return NextResponse.json({ error: 'Room not found' }, { status: 404 })
  }

  const isHost = room.created_by === user.id

  // Access control for non-hosts. A 'denied' request is a ban — recorded by a
  // host kick (see the livekit-room route) or a waiting-room denial — and is
  // ALWAYS enforced, even when the waiting room is off, so a removed user can't
  // rejoin by reloading. The waiting-room gate is layered on top for rooms that
  // require approval. The client keys off `code`: 'approval_required' → file a
  // request, 'approval_pending' → keep polling, 'approval_denied' → final.
  if (!isHost) {
    const { data: joinRequest } = await supabase
      .from('room_join_requests')
      .select('status')
      .eq('room_id', room.id)
      .eq('user_id', user.id)
      .maybeSingle<{ status: 'pending' | 'approved' | 'denied' }>()

    if (joinRequest?.status === 'denied') {
      return NextResponse.json(
        { error: 'The host declined your request', code: 'approval_denied' },
        { status: 403 },
      )
    }
    if (room.waiting_room) {
      if (!joinRequest) {
        return NextResponse.json(
          { error: 'Ask to join first', code: 'approval_required' },
          { status: 403 },
        )
      }
      if (joinRequest.status === 'pending') {
        return NextResponse.json(
          { error: 'Waiting for the host', code: 'approval_pending' },
          { status: 403 },
        )
      }
    }
  }

  // Server-side capacity enforcement. The client has its own guard, but a
  // modified client could ignore it, so count the real participants on the SFU
  // and refuse once the room is full. Best-effort: if the room doesn't exist
  // yet (nobody has joined) or LiveKit is briefly unreachable, this fails open
  // and the client-side guard remains the backstop. The host is exempt so they
  // can always get into their own room.
  if (!isHost && room.max_participants) {
    try {
      const svc = new RoomServiceClient(httpHost(LIVEKIT_URL), apiKey, apiSecret)
      const existing = await svc.listParticipants(room.slug)
      if (existing.length >= room.max_participants) {
        return NextResponse.json(
          { error: 'Room is full', code: 'room_full' },
          { status: 403 },
        )
      }
    } catch {
      // Room not provisioned yet or a transient LiveKit error — don't block.
    }
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

  // The LiveKit identity is namespaced with a per-user tag derived from an
  // HMAC of the user id under the (server-only) API secret. Two DIFFERENT users
  // can never mint the same identity, so an attacker can't present a victim's
  // identity to make the SFU disconnect them (LiveKit evicts the older holder
  // of a colliding identity). The same user's own tabs share the tag but differ
  // by sessionId, so multi-device joins still don't kick each other. The tag is
  // opaque and doesn't leak the raw user id.
  const userTag = createHmac('sha256', apiSecret)
    .update(user.id)
    .digest('base64url')
    .slice(0, 12)
  const identity = `${userTag}.${sessionId}`

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: displayName,
    // Server-set (unforgeable by other participants): who this session really
    // is. Clients read it to key rosters and gate the host badge.
    metadata: JSON.stringify({ userId: user.id, avatarUrl }),
    ttl: '2h',
  })
  // Broadcast rooms: only the host may publish A/V. Enforced here in the
  // grant — a modified client can't turn its own mic on. Data (chat) stays
  // open to everyone.
  at.addGrant({
    roomJoin: true,
    room: room.slug,
    canPublish: !room.broadcast || isHost,
    canSubscribe: true,
    canPublishData: true,
  })

  return NextResponse.json({ token: await at.toJwt(), url: LIVEKIT_URL })
}
