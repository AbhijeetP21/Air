'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Participant } from '@/types'
import { Button } from '@/components/ui/button'
import { VideoTile } from '@/components/call/VideoTile'
import {
  GAP_PX,
  PHONE_MAX_WIDTH_PX,
  bestLayout,
  useContainerSize,
} from '@/components/call/gridLayout'

/**
 * Large-room grid. A mesh maxes out ~5; an SFU scales, but the client still
 * can't render dozens of live videos — so we page the tiles instead of mounting
 * them all. The parent sorts `participants` so the most relevant people (local
 * user + recent speakers) lead, meaning page 1 stays useful as the room grows.
 *
 * Tiles use the same measured Meet-style layout as the small-room grid, so a
 * page of 6 fills the screen just as well as a page of 12 (see gridLayout.ts).
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
  /** Tiles per page (phones page fewer automatically). */
  pageSize?: number
}) {
  const [page, setPage] = useState(0)
  const { containerRef, size } = useContainerSize()

  // Phones page fewer tiles: 12 postage stamps on a 6-inch screen are useless.
  const isPhone = size !== null && size.w < PHONE_MAX_WIDTH_PX
  const effectivePageSize = isPhone ? Math.min(pageSize, 6) : pageSize

  const total = participants.length
  const totalPages = Math.max(1, Math.ceil(total / effectivePageSize))

  // Clamp the page when the roster shrinks (people leaving) so we never land on
  // an empty page past the end.
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1)
  }, [page, totalPages])

  const safePage = Math.min(page, totalPages - 1)
  const start = safePage * effectivePageSize
  const pageParticipants = participants.slice(start, start + effectivePageSize)
  const visibleKey = pageParticipants.map((p) => p.peerId).join(',')

  // Report the on-screen identities whenever the page contents change. Deriving
  // the ids from the string key keeps this effect free of array-identity churn.
  useEffect(() => {
    onVisibleChange(visibleKey ? visibleKey.split(',') : [])
  }, [visibleKey, onVisibleChange])

  const renderTile = (p: Participant) => (
    <VideoTile
      participant={p}
      mirror={p.isLocal && mirrorLocal}
      localSpeaking={p.isLocal ? localSpeaking : undefined}
      compact
      onExpand={onFocus ? () => onFocus(p.peerId) : undefined}
    />
  )

  // Measure on the first committed frame; children render right after.
  if (size === null) {
    return <div ref={containerRef} className="size-full" />
  }

  const pager = totalPages > 1 && (
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
  )

  if (isPhone) {
    return (
      <div ref={containerRef} className="flex size-full flex-col gap-3">
        <div
          className={cn(
            'grid min-h-0 flex-1 auto-rows-fr gap-3',
            pageParticipants.length <= 2 ? 'grid-cols-1' : 'grid-cols-2',
          )}
        >
          {pageParticipants.map((p, i) => (
            <div
              key={p.peerId}
              className={cn(
                'min-h-0',
                pageParticipants.length % 2 === 1 &&
                  pageParticipants.length > 1 &&
                  i === pageParticipants.length - 1 &&
                  'col-span-2',
              )}
            >
              {renderTile(p)}
            </div>
          ))}
        </div>
        {pager}
      </div>
    )
  }

  // Reserve a little height for the pager row before computing tile sizes.
  const pagerHeight = totalPages > 1 ? 44 : 0
  const { cols, tileW, tileH } = bestLayout(
    pageParticipants.length,
    size.w,
    size.h - pagerHeight,
  )
  const rows: Participant[][] = []
  for (let i = 0; i < pageParticipants.length; i += cols) {
    rows.push(pageParticipants.slice(i, i + cols))
  }

  return (
    <div ref={containerRef} className="flex size-full flex-col gap-3">
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center"
        style={{ gap: GAP_PX }}
      >
        {rows.map((row) => (
          <div
            key={row[0].peerId}
            className="flex justify-center"
            style={{ gap: GAP_PX }}
          >
            {row.map((p) => (
              <div key={p.peerId} style={{ width: tileW, height: tileH }}>
                {renderTile(p)}
              </div>
            ))}
          </div>
        ))}
      </div>
      {pager}
    </div>
  )
}
