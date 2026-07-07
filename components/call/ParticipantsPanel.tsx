'use client'

import { useMemo, useState } from 'react'
import { Hand, MicOff, Search, UserX, VideoOff, Volume2, VolumeX, X } from 'lucide-react'

import { initialsFromName } from '@/lib/utils'
import type { Participant } from '@/types'
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
  onRemove,
  onMuteAll,
}: {
  open: boolean
  onClose: () => void
  participants: Participant[]
  selfPeerId: string
  hostId: string
  isHost: boolean
  onFocus?: (peerId: string) => void
  onMute: (identity: string) => void
  onRemove: (identity: string) => void
  onMuteAll: () => void
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
