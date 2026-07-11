/* eslint-disable @typescript-eslint/no-explicit-any */
// The token route is the security boundary for joining a call: it must refuse
// unauthenticated callers, bad session ids, dead rooms, and unapproved joiners
// in waiting-room mode — and mint a token with trusted server-set metadata.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSupabaseMock,
  type SupabaseMockState,
} from './helpers/supabaseMock'

const h = vi.hoisted(() => ({
  supabase: null as any,
  tokens: [] as any[],
}))

vi.mock('@/lib/env', () => ({
  LIVEKIT_URL: 'wss://test.livekit.cloud',
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => h.supabase,
}))

vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    grants: any[] = []
    constructor(
      public apiKey: string,
      public apiSecret: string,
      public opts: any,
    ) {
      h.tokens.push(this)
    }
    addGrant(grant: any) {
      this.grants.push(grant)
    }
    async toJwt() {
      return 'test-jwt'
    }
  },
}))

import { POST } from '@/app/api/livekit-token/route'

const HOST_ID = 'user-host'
const JOINER_ID = 'user-joiner'
const SESSION_ID = 'abcDEF123456' // 12 chars, nanoid alphabet

const activeRoom = (overrides: Record<string, unknown> = {}) => ({
  id: 'room-1',
  slug: 'testroom',
  is_active: true,
  expires_at: null,
  created_by: HOST_ID,
  waiting_room: false,
  broadcast: false,
  ...overrides,
})

function useState(state: SupabaseMockState) {
  const mock = createSupabaseMock(state)
  h.supabase = mock.client
  return mock
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/livekit-token', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const joiner = { id: JOINER_ID, email: 'joiner@example.com' }

beforeEach(() => {
  h.tokens.length = 0
  vi.stubEnv('LIVEKIT_API_KEY', 'test-key')
  vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('livekit-token route', () => {
  it('500s when LiveKit env vars are missing (no secret leak in body)', async () => {
    vi.stubEnv('LIVEKIT_API_KEY', '')
    useState({ user: joiner })
    const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('test-secret')
  })

  it('401s unauthenticated callers before touching the body', async () => {
    useState({ user: null })
    const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
    expect(res.status).toBe(401)
  })

  it('400s malformed JSON', async () => {
    useState({ user: joiner })
    const res = await post('this is not json')
    expect(res.status).toBe(400)
  })

  it('400s a missing or non-string slug', async () => {
    useState({ user: joiner })
    expect((await post({ sessionId: SESSION_ID })).status).toBe(400)
    expect((await post({ slug: 42, sessionId: SESSION_ID })).status).toBe(400)
    expect((await post({ slug: '', sessionId: SESSION_ID })).status).toBe(400)
  })

  it('rejects invalid session ids (shape is the anti-collision contract)', async () => {
    useState({ user: joiner })
    const bad = [
      undefined,
      42,
      'short', // < 8 chars
      'x'.repeat(25), // > 24 chars
      'has space 123', // outside nanoid alphabet
      'inject";drop--', // punctuation
    ]
    for (const sessionId of bad) {
      const res = await post({ slug: 'testroom', sessionId })
      expect(res.status).toBe(400)
    }
  })

  it('404s when the room is missing, inactive, or expired', async () => {
    for (const roomRow of [
      null,
      activeRoom({ is_active: false }),
      activeRoom({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]) {
      useState({ user: joiner, tables: { rooms: { select: { data: roomRow } } } })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(404)
    }
  })

  it('mints a token for an active room with the identity/metadata contract', async () => {
    useState({
      user: {
        id: JOINER_ID,
        email: 'joiner@example.com',
        user_metadata: {
          full_name: 'Joan Joiner',
          avatar_url: 'https://cdn.example/a.png',
        },
      },
      tables: { rooms: { select: { data: activeRoom() } } },
    })
    const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      token: 'test-jwt',
      url: 'wss://test.livekit.cloud',
    })

    const token = h.tokens[0]
    // Identity is the session id, NOT the user id (two-tab safety).
    expect(token.opts.identity).toBe(SESSION_ID)
    expect(token.opts.name).toBe('Joan Joiner')
    // The trusted userId travels in server-set metadata.
    expect(JSON.parse(token.opts.metadata)).toEqual({
      userId: JOINER_ID,
      avatarUrl: 'https://cdn.example/a.png',
    })
    // Grant is scoped to exactly the requested room.
    expect(token.grants).toEqual([
      expect.objectContaining({ roomJoin: true, room: 'testroom' }),
    ])
  })

  it('derives the display name from email when metadata has no name', async () => {
    useState({
      user: { id: JOINER_ID, email: 'ada.lovelace@example.com' },
      tables: { rooms: { select: { data: activeRoom() } } },
    })
    await post({ slug: 'testroom', sessionId: SESSION_ID })
    expect(h.tokens[0].opts.name).toBe('ada.lovelace')
  })

  describe('broadcast rooms', () => {
    it('denies publish to non-hosts (enforced in the grant, not just UI)', async () => {
      useState({
        user: joiner,
        tables: { rooms: { select: { data: activeRoom({ broadcast: true }) } } },
      })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(200)
      expect(h.tokens[0].grants[0]).toMatchObject({
        canPublish: false,
        canPublishData: true, // chat stays open
        canSubscribe: true,
      })
    })

    it('grants publish to the host', async () => {
      useState({
        user: { id: HOST_ID, email: 'host@example.com' },
        tables: { rooms: { select: { data: activeRoom({ broadcast: true }) } } },
      })
      await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(h.tokens[0].grants[0]).toMatchObject({ canPublish: true })
    })

    it('grants publish to everyone in a normal room', async () => {
      useState({
        user: joiner,
        tables: { rooms: { select: { data: activeRoom() } } },
      })
      await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(h.tokens[0].grants[0]).toMatchObject({ canPublish: true })
    })
  })

  describe('waiting room', () => {
    const waitingRoomState = (
      joinRequest: { status: string } | null,
      user = joiner,
    ) =>
      useState({
        user,
        tables: {
          rooms: { select: { data: activeRoom({ waiting_room: true }) } },
          room_join_requests: { select: { data: joinRequest } },
        },
      })

    it('403s approval_required when the joiner has no request yet', async () => {
      waitingRoomState(null)
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('approval_required')
    })

    it('403s approval_pending while the host has not decided', async () => {
      waitingRoomState({ status: 'pending' })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('approval_pending')
    })

    it('403s approval_denied after the host declines', async () => {
      waitingRoomState({ status: 'denied' })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('approval_denied')
    })

    it('mints a token once approved', async () => {
      waitingRoomState({ status: 'approved' })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(200)
    })

    it('lets the host straight in without any join request', async () => {
      waitingRoomState(null, { id: HOST_ID, email: 'host@example.com' })
      const res = await post({ slug: 'testroom', sessionId: SESSION_ID })
      expect(res.status).toBe(200)
    })
  })
})
