// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// Host-side waiting-room queue: polling gate, one-time arrival toasts,
// optimistic approve/deny/admit-all with revert-on-error.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSupabaseMock,
  type SupabaseMockState,
} from './helpers/supabaseMock'

const h = vi.hoisted(() => ({
  supabase: null as any,
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => h.supabase,
}))

vi.mock('sonner', () => ({ toast: h.toast }))

import { useWaitingRoom } from '@/hooks/useWaitingRoom'

const request = (id: string, name = 'Guest') => ({
  id,
  room_id: 'room-1',
  user_id: `user-${id}`,
  display_name: name,
  status: 'pending' as const,
  created_at: new Date().toISOString(),
})

function useState(state: SupabaseMockState) {
  const mock = createSupabaseMock(state)
  h.supabase = mock.client
  return mock
}

const hostArgs = {
  roomId: 'room-1',
  isHost: true,
  initialEnabled: true,
  active: true,
}

beforeEach(() => {
  h.toast.mockClear()
  h.toast.error.mockClear()
})

describe('useWaitingRoom', () => {
  it('stays inert for non-hosts', async () => {
    const mock = useState({
      tables: {
        room_join_requests: { select: { data: [request('r1')] } },
      },
    })
    const { result } = renderHook(() =>
      useWaitingRoom({ ...hostArgs, isHost: false }),
    )
    // Give any stray effect a tick to run, then assert nothing happened.
    await act(async () => {})
    expect(result.current.pending).toEqual([])
    expect(mock.client.from).not.toHaveBeenCalled()
  })

  it('does not poll while the waiting room is off', async () => {
    const mock = useState({
      tables: { room_join_requests: { select: { data: [request('r1')] } } },
    })
    renderHook(() => useWaitingRoom({ ...hostArgs, initialEnabled: false }))
    await act(async () => {})
    expect(mock.client.from).not.toHaveBeenCalled()
  })

  it('loads the pending queue and announces each arrival once', async () => {
    useState({
      tables: {
        room_join_requests: {
          select: { data: [request('r1', 'Ada'), request('r2', 'Grace')] },
        },
      },
    })
    const { result } = renderHook(() => useWaitingRoom(hostArgs))
    await waitFor(() => expect(result.current.pending).toHaveLength(2))
    expect(h.toast).toHaveBeenCalledTimes(2)
    expect(h.toast).toHaveBeenCalledWith(
      'Ada wants to join',
      expect.anything(),
    )
  })

  it('approve removes the request optimistically and writes approved', async () => {
    const mock = useState({
      tables: {
        room_join_requests: { select: { data: [request('r1', 'Ada')] } },
      },
    })
    const { result } = renderHook(() => useWaitingRoom(hostArgs))
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    await act(async () => {
      await result.current.approve('r1')
    })
    expect(result.current.pending).toEqual([])

    const writeChain = mock.chains['room_join_requests']?.find(
      (c: any) => c.update.mock.calls.length > 0,
    )
    expect(writeChain.update).toHaveBeenCalledWith({ status: 'approved' })
    expect(writeChain.eq).toHaveBeenCalledWith('id', 'r1')
  })

  it('deny writes denied', async () => {
    const mock = useState({
      tables: {
        room_join_requests: { select: { data: [request('r1')] } },
      },
    })
    const { result } = renderHook(() => useWaitingRoom(hostArgs))
    await waitFor(() => expect(result.current.pending).toHaveLength(1))

    await act(async () => {
      await result.current.deny('r1')
    })
    const writeChain = mock.chains['room_join_requests']?.find(
      (c: any) => c.update.mock.calls.length > 0,
    )
    expect(writeChain.update).toHaveBeenCalledWith({ status: 'denied' })
  })

  it('re-fetches and toasts when a resolve fails, without re-announcing', async () => {
    useState({
      tables: {
        room_join_requests: {
          select: { data: [request('r1', 'Ada')] },
          write: { error: { message: 'rls says no' } },
        },
      },
    })
    const { result } = renderHook(() => useWaitingRoom(hostArgs))
    await waitFor(() => expect(result.current.pending).toHaveLength(1))
    expect(h.toast).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.approve('r1')
    })
    // The failed write triggers a refresh that restores the row…
    await waitFor(() => expect(result.current.pending).toHaveLength(1))
    expect(h.toast.error).toHaveBeenCalled()
    // …but Ada is not announced a second time.
    expect(h.toast).toHaveBeenCalledTimes(1)
  })

  it('admitAll clears the queue with one bulk pending-scoped update', async () => {
    const mock = useState({
      tables: {
        room_join_requests: {
          select: { data: [request('r1'), request('r2'), request('r3')] },
        },
      },
    })
    const { result } = renderHook(() => useWaitingRoom(hostArgs))
    await waitFor(() => expect(result.current.pending).toHaveLength(3))

    await act(async () => {
      await result.current.admitAll()
    })
    expect(result.current.pending).toEqual([])

    const writeChain = mock.chains['room_join_requests']?.find(
      (c: any) => c.update.mock.calls.length > 0,
    )
    expect(writeChain.update).toHaveBeenCalledWith({ status: 'approved' })
    // Scoped to this room's still-pending rows only.
    expect(writeChain.eq).toHaveBeenCalledWith('room_id', 'room-1')
    expect(writeChain.eq).toHaveBeenCalledWith('status', 'pending')
  })

  it('setWaitingRoom updates optimistically and persists the flag', async () => {
    const mock = useState({
      tables: {
        rooms: { select: { data: null } },
        room_join_requests: { select: { data: [] } },
      },
    })
    const { result } = renderHook(() =>
      useWaitingRoom({ ...hostArgs, initialEnabled: false }),
    )
    await act(async () => {
      await result.current.setWaitingRoom(true)
    })
    expect(result.current.enabled).toBe(true)
    const roomChain = mock.chains['rooms']?.[0]
    expect(roomChain.update).toHaveBeenCalledWith({ waiting_room: true })
    expect(roomChain.eq).toHaveBeenCalledWith('id', 'room-1')
  })

  it('setWaitingRoom reverts and toasts when the write fails', async () => {
    useState({
      tables: {
        rooms: { write: { error: { message: 'nope' } } },
        room_join_requests: { select: { data: [] } },
      },
    })
    const { result } = renderHook(() =>
      useWaitingRoom({ ...hostArgs, initialEnabled: false }),
    )
    await act(async () => {
      await result.current.setWaitingRoom(true)
    })
    expect(result.current.enabled).toBe(false)
    expect(h.toast.error).toHaveBeenCalled()
  })
})
