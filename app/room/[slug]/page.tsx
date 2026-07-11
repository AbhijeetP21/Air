import { notFound, redirect } from 'next/navigation'

import { createServerClient } from '@/lib/supabase/server'
import type { Room } from '@/types'
import { RoomClient } from '@/components/call/RoomClient'

type RoomPageProps = {
  params: Promise<{ slug: string }>
}

export default async function RoomPage({ params }: RoomPageProps) {
  const { slug } = await params
  const supabase = await createServerClient()

  // Resolve the slug through the SECURITY DEFINER lookup: the rooms table is
  // readable only by its creator (no enumeration), and this function returns
  // the single active, unexpired row matching the exact slug — so a missing
  // result covers all of: not found, deactivated, expired.
  const { data: room } = (await supabase.rpc('get_active_room_by_slug', {
    p_slug: slug,
  })) as { data: Room | null }

  if (!room) {
    notFound()
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Middleware guards this route, but re-check so props are never null-typed.
  if (!user) {
    redirect(`/login?next=/room/${slug}`)
  }

  const displayName =
    (user.user_metadata?.full_name as string | undefined) ??
    (user.user_metadata?.name as string | undefined) ??
    user.email?.split('@')[0] ??
    'Guest'
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ?? null

  return (
    <RoomClient
      slug={room.slug}
      roomId={room.id}
      roomName={room.display_name}
      maxParticipants={room.max_participants}
      hostId={room.created_by}
      waitingRoom={room.waiting_room}
      broadcast={room.broadcast}
      user={{ id: user.id, displayName, avatarUrl }}
    />
  )
}
