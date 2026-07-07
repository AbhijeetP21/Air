'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Participant } from '@/types'
import { Button } from '@/components/ui/button'
import { VideoTile } from '@/components/call/VideoTile'

/**
 * Large-room grid. A mesh maxes out ~5; an SFU scales, but the client still
 * can't render dozens of live videos — so we page the tiles instead of mounting
 * them all. The parent sorts `participants` so the most relevant people (local
 * user + recent speakers) lead, meaning page 1 stays useful as the room grows.
 *
 * The visible page is reported via `onVisibleChange` so the call hook can
 * subscribe video only for who's actually on screen (audio stays on for all).
 */
export function PaginatedGrid({
  participants,
  mirrorLocal,
  localSpeaking,
  onFocus,
  onVisibleChange,
  pageSize = 12,
}: {
  participants: Participant[]
  mirrorLocal: boolean
  localSpeaking: boolean
  onFocus?: (peerId: string) => void
  /** Reports the identities on the current page (for selective subscription). */
  onVisibleChange: (ids: string[]) => void
  /** Tiles per page. */
  pageSize?: number
}) {
  const [page, setPage] = useState(0)

  const total = participants.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  // Clamp the page when the roster shrinks (people leaving) so we never land on
  // an empty page past the end.
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1)
  }, [page, totalPages])

  const safePage = Math.min(page, totalPages - 1)
  const start = safePage * pageSize
  const pageParticipants = participants.slice(start, start + pageSize)
  const visibleKey = pageParticipants.map((p) => p.peerId).join(',')

  // Report the on-screen identities whenever the page contents change. Deriving
  // the ids from the string key keeps this effect free of array-identity churn.
  useEffect(() => {
    onVisibleChange(visibleKey ? visibleKey.split(',') : [])
  }, [visibleKey, onVisibleChange])

  return (
    <div className="flex size-full flex-col gap-3">
      <div className="grid min-h-0 w-full flex-1 auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {pageParticipants.map((p) => (
          <div key={p.peerId} className={cn('min-h-0')}>
            <VideoTile
              participant={p}
              mirror={p.isLocal && mirrorLocal}
              localSpeaking={p.isLocal ? localSpeaking : undefined}
              compact
              onExpand={onFocus ? () => onFocus(p.peerId) : undefined}
            />
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3 text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="tabular-nums">
            {start + 1}–{start + pageParticipants.length} of {total} · page{' '}
            {safePage + 1}/{totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={safePage >= totalPages - 1}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
