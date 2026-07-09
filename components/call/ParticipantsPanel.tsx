'use client'

import { useMemo, useState } from 'react'
import {
  Check,
  DoorClosed,
  Hand,
  MicOff,
  Search,
  UserX,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

import { cn, initialsFromName } from '@/lib/utils'
import type { JoinRequest, Participant } from '@/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Slide-out roster. Searchable (rooms can get large), shows each person's
 * mic/camera/hand state, and — for the host — exposes force-mute and remove
 * controls plus a mute-all. Clicking a row spotlights that participant.
 */
export function ParticipantsPanel({
  open,
  onClose,
  participants,
  selfPeerId,
  hostId,
  isHost,
  onFocus,
  onMute,
  onMuteVideo,
  onRemove,
  onMuteAll,
  waitingRoomEnabled,
  onToggleWaitingRoom,
  pendingRequests,
  onApprove,
  onDeny,
  onAdmitAll,
}: {
  open: boolean
  onClose: () => void
  participants: Participant[]
  selfPeerId: string
  hostId: string
  isHost: boolean
  onFocus?: (peerId: string) => void
  onMute: (identity: string) => void
  onMuteVideo: (identity: string) => void
  onRemove: (identity: string) => void
  onMuteAll: () => void
  /** Waiting room (host only; ignored otherwise). */
  waitingRoomEnabled: boolean
  onToggleWaitingRoom: (on: boolean) => void
  pendingRequests: JoinRequest[]
  onApprove: (requestId: string) => void
  onDeny: (requestId: string) => void
  onAdmitAll: () => void
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return participants
    return participants.filter((p) => p.displayName.toLowerCase().includes(q))
  }, [participants, query])

  if (!open) return null

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l bg-card shadow-xl">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          Participants
          <span className="ml-1.5 text-muted-foreground">
            ({participants.length})
          </span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close participants"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search participants"
            aria-label="Search participants"
            autoComplete="off"
            className="pl-8"
          />
        </div>
        {isHost && participants.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full gap-1.5"
            onClick={onMuteAll}
          >
            <VolumeX className="size-4" />
            Mute everyone
          </Button>
        )}
      </div>

      {/* Waiting room — host only. */}
      {isHost && (
        <div className="border-b p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <DoorClosed className="size-4 text-primary" />
              <div>
                <p className="font-medium">Waiting room</p>
                <p className="text-xs text-muted-foreground">
                  New joiners need your approval.
                </p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={waitingRoomEnabled}
              aria-label="Waiting room"
              onClick={() => onToggleWaitingRoom(!waitingRoomEnabled)}
              className={cn(
                'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
                waitingRoomEnabled ? 'bg-primary' : 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'inline-block size-5 rounded-full bg-white shadow-sm transition-transform',
                  waitingRoomEnabled ? 'translate-x-5' : 'translate-x-0',
                )}
              />
            </button>
          </div>

          {waitingRoomEnabled && pendingRequests.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  Waiting to join ({pendingRequests.length})
                </p>
                {pendingRequests.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={onAdmitAll}
                  >
                    <Check className="size-3.5" />
                    Admit all
                  </Button>
                )}
              </div>
              <ul>
                {pendingRequests.map((req) => (
                  <li
                    key={req.id}
                    className="flex items-center gap-2 rounded-lg px-1 py-1.5"
                  >
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px]">
                        {initialsFromName(req.display_name || '?')}
                      </AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {req.display_name || 'Guest'}
                    </span>
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => onApprove(req.id)}
                    >
                      Admit
                    </Button>
                    <button
                      type="button"
                      onClick={() => onDeny(req.id)}
                      aria-label={`Deny ${req.display_name || 'Guest'}`}
                      title="Deny"
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <ul className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <li className="pt-8 text-center text-sm text-muted-foreground">
            No one matches “{query}”.
          </li>
        ) : (
          filtered.map((p) => {
            const isSelf = p.peerId === selfPeerId
            const isRoomHost = p.userId === hostId
            const canModerate = isHost && !isSelf
            return (
              <li key={p.peerId} className="flex items-center gap-1 pr-1">
                <button
                  type="button"
                  onClick={() => onFocus?.(p.peerId)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted"
                >
                  <Avatar className="size-8 shrink-0">
                    {p.avatarUrl ? (
                      <AvatarImage src={p.avatarUrl} alt={p.displayName} />
                    ) : null}
                    <AvatarFallback className="text-xs">
                      {initialsFromName(p.displayName)}
                    </AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {p.displayName}
                      {isSelf && (
                        <span className="text-muted-foreground"> (You)</span>
                      )}
                    </p>
                    {isRoomHost && (
                      <p className="text-xs text-muted-foreground">Host</p>
                    )}
                  </div>

                  {/* Status glyphs. */}
                  <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {p.handRaised && <Hand className="size-4 text-primary" />}
                    {!p.audioEnabled && (
                      <MicOff className="size-4 text-red-400" />
                    )}
                    {!p.videoEnabled && <VideoOff className="size-4" />}
                  </div>
                </button>

                {/* Host actions (siblings of the focus button, not nested). */}
                {canModerate && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onMute(p.peerId)}
                      disabled={!p.audioEnabled}
                      aria-label={`Mute ${p.displayName}`}
                      title="Mute"
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <Volume2 className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMuteVideo(p.peerId)}
                      disabled={!p.videoEnabled}
                      aria-label={`Pause ${p.displayName}'s video`}
                      title="Pause video"
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <Video className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(p.peerId)}
                      aria-label={`Remove ${p.displayName}`}
                      title="Remove from call"
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <UserX className="size-4" />
                    </button>
                  </div>
                )}
              </li>
            )
          })
        )}
      </ul>
    </aside>
  )
}
