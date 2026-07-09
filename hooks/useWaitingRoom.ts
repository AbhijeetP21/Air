'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { createClient } from '@/lib/supabase/client'
import type { JoinRequest } from '@/types'

// How often the host re-reads the pending queue. Polling (vs realtime) keeps
// this dependency-free and works without enabling replication on the table.
const QUEUE_POLL_MS = 5000

/**
 * Host-side waiting-room state: the on/off toggle (persisted on the room row)
 * and the live queue of pending join requests with approve / deny / admit-all.
 * All writes go through the browser Supabase client — RLS restricts them to
 * the room's creator. Non-hosts get inert values.
 */
export function useWaitingRoom({
  roomId,
  isHost,
  initialEnabled,
  active,
}: {
  roomId: string
  isHost: boolean
  /** rooms.waiting_room at page load. */
  initialEnabled: boolean
  /** Only poll while actually in the call. */
  active: boolean
}) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, setPending] = useState<JoinRequest[]>([])
  // Ids already announced via toast, so re-polls don't re-announce.
  const announcedRef = useRef<Set<string>>(new Set())
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null)
  const supabase = () => {
    if (!supabaseRef.current) supabaseRef.current = createClient()
    return supabaseRef.current
  }

  const refresh = useCallback(async () => {
    const { data } = await supabase()
      .from('room_join_requests')
      .select('id, room_id, user_id, display_name, status, created_at')
      .eq('room_id', roomId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .returns<JoinRequest[]>()
    if (data) setPending(data)
  }, [roomId])

  // Poll the queue while hosting an active call with the waiting room on.
  useEffect(() => {
    if (!isHost || !active || !enabled) {
      setPending([])
      return
    }
    void refresh()
    const timer = setInterval(() => void refresh(), QUEUE_POLL_MS)
    return () => clearInterval(timer)
  }, [isHost, active, enabled, refresh])

  // Announce new arrivals once each.
  useEffect(() => {
    for (const req of pending) {
      if (!announcedRef.current.has(req.id)) {
        announcedRef.current.add(req.id)
        toast(`${req.display_name || 'Someone'} wants to join`, { icon: '🚪' })
      }
    }
  }, [pending])

  const setWaitingRoom = useCallback(
    async (on: boolean) => {
      setEnabled(on) // optimistic — reverted on failure
      const { error } = await supabase()
        .from('rooms')
        .update({ waiting_room: on })
        .eq('id', roomId)
      if (error) {
        setEnabled(!on)
        toast.error("Couldn't update the waiting room setting.")
      }
    },
    [roomId],
  )

  const resolve = useCallback(
    async (requestId: string, status: 'approved' | 'denied') => {
      // Optimistic removal; the joiner's next token poll picks up the change.
      setPending((prev) => prev.filter((r) => r.id !== requestId))
      const { error } = await supabase()
        .from('room_join_requests')
        .update({ status })
        .eq('id', requestId)
      if (error) {
        toast.error("That didn't work. Try again.")
        void refresh()
      }
    },
    [refresh],
  )

  const approve = useCallback(
    (requestId: string) => resolve(requestId, 'approved'),
    [resolve],
  )
  const deny = useCallback(
    (requestId: string) => resolve(requestId, 'denied'),
    [resolve],
  )

  /** Admit everyone currently waiting — one update, no per-person clicking. */
  const admitAll = useCallback(async () => {
    setPending([])
    const { error } = await supabase()
      .from('room_join_requests')
      .update({ status: 'approved' })
      .eq('room_id', roomId)
      .eq('status', 'pending')
    if (error) {
      toast.error("Couldn't admit everyone. Try again.")
      void refresh()
    }
  }, [roomId, refresh])

  return { enabled, pending, setWaitingRoom, approve, deny, admitAll }
}
