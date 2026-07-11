/* eslint-disable @typescript-eslint/no-explicit-any */
// Host-only moderation. The invariants under test: only the room creator may
// act, kicked users get their join request denied (sticky in waiting-room
// mode), mute targets the right track, and mute-all never mutes the host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSupabaseMock,
  type SupabaseMockState,
} from './helpers/supabaseMock'

const h = vi.hoisted(() => ({
  supabase: null as any,
  svc: {
    getParticipant: vi.fn(),
    removeParticipant: vi.fn(),
    mutePublishedTrack: vi.fn(),
    listParticipants: vi.fn(),
  },
  ctorArgs: [] as any[],
}))

vi.mock('@/lib/env', () => ({
  LIVEKIT_URL: 'wss://test.livekit.cloud',
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => h.supabase,
}))

vi.mock('livekit-server-sdk', () => ({
  TrackType: { AUDIO: 0, VIDEO: 1 },
  TrackSource: { CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3 },
  RoomServiceClient: class {
    constructor(...args: any[]) {
      h.ctorArgs.push(args)
    }
    getParticipant = h.svc.getParticipant
    removeParticipant = h.svc.removeParticipant
    mutePublishedTrack = h.svc.mutePublishedTrack
    listParticipants = h.svc.listParticipants
  },
}))

import { POST } from '@/app/api/livekit-room/route'

const HOST_ID = 'user-host'
const room = { id: 'room-1', slug: 'testroom', created_by: HOST_ID }
const host = { id: HOST_ID, email: 'host@example.com' }

// Mirror the mocked enums for readable test data.
const AUDIO = 0
const VIDEO = 1
const CAMERA = 1
const SCREEN_SHARE = 3

function useState(state: SupabaseMockState) {
  const mock = createSupabaseMock(state)
  h.supabase = mock.client
  return mock
}

const hostState = () =>
  useState({ user: host, tables: { rooms: { select: { data: room } } } })

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/livekit-room', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.stubEnv('LIVEKIT_API_KEY', 'test-key')
  vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret')
  h.ctorArgs.length = 0
  for (const fn of Object.values(h.svc)) fn.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('livekit-room route', () => {
  it('401s unauthenticated callers', async () => {
    useState({ user: null })
    const res = await post({ slug: 'testroom', action: 'mute-all' })
    expect(res.status).toBe(401)
  })

  it('400s malformed JSON, missing slug, and unknown actions', async () => {
    hostState()
    expect((await post('nope')).status).toBe(400)
    expect((await post({ action: 'mute' })).status).toBe(400)
    expect(
      (await post({ slug: 'testroom', action: 'explode' })).status,
    ).toBe(400)
  })

  it('404s when the room does not exist', async () => {
    useState({ user: host, tables: { rooms: { select: { data: null } } } })
    const res = await post({ slug: 'ghost', action: 'mute-all' })
    expect(res.status).toBe(404)
  })

  it('403s a non-host even with a well-formed request', async () => {
    useState({
      user: { id: 'user-imposter' },
      tables: { rooms: { select: { data: room } } },
    })
    const res = await post({
      slug: 'testroom',
      action: 'remove',
      targetIdentity: 'victim123456',
    })
    expect(res.status).toBe(403)
    expect(h.svc.removeParticipant).not.toHaveBeenCalled()
  })

  it('400s targeted actions without a target', async () => {
    for (const action of ['mute', 'mute-video', 'remove']) {
      hostState()
      const res = await post({ slug: 'testroom', action })
      expect(res.status).toBe(400)
    }
  })

  it('talks to LiveKit over https, not wss', async () => {
    hostState()
    h.svc.listParticipants.mockResolvedValue([])
    await post({ slug: 'testroom', action: 'mute-all' })
    expect(h.ctorArgs[0][0]).toBe('https://test.livekit.cloud')
  })

  describe('remove', () => {
    it('kicks the participant and denies their join request by trusted userId', async () => {
      const mock = hostState()
      h.svc.getParticipant.mockResolvedValue({
        identity: 'target-session',
        metadata: JSON.stringify({ userId: 'user-kicked' }),
        tracks: [],
      })
      const res = await post({
        slug: 'testroom',
        action: 'remove',
        targetIdentity: 'target-session',
      })
      expect(res.status).toBe(200)
      expect(h.svc.removeParticipant).toHaveBeenCalledWith(
        'testroom',
        'target-session',
      )
      // A 'denied' ban row is upserted (insert-or-update) so the kick is
      // durable even when the user has no existing request — the token route
      // then refuses them unconditionally.
      const reqChain = mock.chains['room_join_requests']?.[0]
      expect(reqChain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          room_id: room.id,
          user_id: 'user-kicked',
          status: 'denied',
        }),
        expect.objectContaining({ onConflict: 'room_id,user_id' }),
      )
    })

    it('still kicks when metadata is missing or malformed (no DB write)', async () => {
      for (const metadata of [undefined, 'not-json', '{"userId":42}']) {
        const mock = hostState()
        h.svc.removeParticipant.mockReset()
        h.svc.getParticipant.mockResolvedValue({
          identity: 't',
          metadata,
          tracks: [],
        })
        const res = await post({
          slug: 'testroom',
          action: 'remove',
          targetIdentity: 't',
        })
        expect(res.status).toBe(200)
        expect(h.svc.removeParticipant).toHaveBeenCalled()
        expect(mock.chains['room_join_requests']).toBeUndefined()
      }
    })
  })

  describe('mute', () => {
    it('mutes the audio track when live', async () => {
      hostState()
      h.svc.getParticipant.mockResolvedValue({
        tracks: [
          { type: VIDEO, sid: 'vid-1', muted: false },
          { type: AUDIO, sid: 'aud-1', muted: false },
        ],
      })
      const res = await post({
        slug: 'testroom',
        action: 'mute',
        targetIdentity: 'target-session',
      })
      expect(res.status).toBe(200)
      expect(h.svc.mutePublishedTrack).toHaveBeenCalledWith(
        'testroom',
        'target-session',
        'aud-1',
        true,
      )
      expect(h.svc.mutePublishedTrack).toHaveBeenCalledTimes(1)
    })

    it('no-ops when the audio track is already muted or absent', async () => {
      for (const tracks of [
        [{ type: AUDIO, sid: 'aud-1', muted: true }],
        [{ type: VIDEO, sid: 'vid-1', muted: false }],
        [],
      ]) {
        hostState()
        h.svc.mutePublishedTrack.mockReset()
        h.svc.getParticipant.mockResolvedValue({ tracks })
        const res = await post({
          slug: 'testroom',
          action: 'mute',
          targetIdentity: 'target-session',
        })
        expect(res.status).toBe(200)
        expect(h.svc.mutePublishedTrack).not.toHaveBeenCalled()
      }
    })
  })

  describe('mute-video', () => {
    it('prefers the camera track over a screen share', async () => {
      hostState()
      h.svc.getParticipant.mockResolvedValue({
        tracks: [
          { type: VIDEO, source: SCREEN_SHARE, sid: 'screen-1', muted: false },
          { type: VIDEO, source: CAMERA, sid: 'cam-1', muted: false },
          { type: AUDIO, sid: 'aud-1', muted: false },
        ],
      })
      await post({
        slug: 'testroom',
        action: 'mute-video',
        targetIdentity: 'target-session',
      })
      expect(h.svc.mutePublishedTrack).toHaveBeenCalledWith(
        'testroom',
        'target-session',
        'cam-1',
        true,
      )
    })

    it('falls back to any video track when there is no camera', async () => {
      hostState()
      h.svc.getParticipant.mockResolvedValue({
        tracks: [
          { type: VIDEO, source: SCREEN_SHARE, sid: 'screen-1', muted: false },
        ],
      })
      await post({
        slug: 'testroom',
        action: 'mute-video',
        targetIdentity: 'target-session',
      })
      expect(h.svc.mutePublishedTrack).toHaveBeenCalledWith(
        'testroom',
        'target-session',
        'screen-1',
        true,
      )
    })
  })

  describe('mute-all', () => {
    it('mutes everyone except the host (matched by trusted metadata userId)', async () => {
      hostState()
      h.svc.listParticipants.mockResolvedValue([
        {
          identity: 'host-session',
          metadata: JSON.stringify({ userId: HOST_ID }),
        },
        {
          identity: 'guest-a',
          metadata: JSON.stringify({ userId: 'user-a' }),
        },
        {
          identity: 'guest-b',
          metadata: JSON.stringify({ userId: 'user-b' }),
        },
      ])
      h.svc.getParticipant.mockImplementation(async (_room, identity) => ({
        identity,
        tracks: [{ type: AUDIO, sid: `aud-${identity}`, muted: false }],
      }))
      const res = await post({ slug: 'testroom', action: 'mute-all' })
      expect(res.status).toBe(200)
      const mutedSids = h.svc.mutePublishedTrack.mock.calls.map((c) => c[2])
      expect(mutedSids.sort()).toEqual(['aud-guest-a', 'aud-guest-b'])
    })
  })

  it('502s when LiveKit rejects the action', async () => {
    hostState()
    h.svc.getParticipant.mockRejectedValue(new Error('participant not found'))
    const res = await post({
      slug: 'testroom',
      action: 'mute',
      targetIdentity: 'gone-session',
    })
    expect(res.status).toBe(502)
  })
})
