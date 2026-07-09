'use client'

import { cn } from '@/lib/utils'
import type { Participant } from '@/types'
import { VideoTile } from '@/components/call/VideoTile'
import {
  GAP_PX,
  PHONE_MAX_WIDTH_PX,
  bestLayout,
  useContainerSize,
} from '@/components/call/gridLayout'

/**
 * Responsive grid for small rooms (≤5 participants; larger rooms use
 * PaginatedGrid).
 *
 * Desktop/tablet: Meet-style computed layout — the container is measured and
 * the column count that yields the largest tiles wins (see gridLayout.ts).
 * Rows are centered, so odd tail tiles (3rd of 3, 5th of 5) sit centered.
 *
 * Phones (narrow containers) keep the FaceTime/Meet fill-the-screen behavior:
 * equal-height rows, stacking 1–2 people vertically and using 2 columns for
 * 3–5 (the odd last tile spans the full width). This avoids tiny letterboxed
 * tiles with a dead black void below.
 */
export function ParticipantGrid({
  participants,
  mirrorLocal,
  localSpeaking,
  onFocus,
}: {
  participants: Participant[]
  /** Mirror the local tile (front camera, not screen-sharing). */
  mirrorLocal: boolean
  localSpeaking: boolean
  onFocus?: (peerId: string) => void
}) {
  const count = participants.length
  const { containerRef, size } = useContainerSize()

  const renderTile = (p: Participant) => (
    <VideoTile
      participant={p}
      mirror={p.isLocal && mirrorLocal}
      localSpeaking={p.isLocal ? localSpeaking : undefined}
      onExpand={onFocus ? () => onFocus(p.peerId) : undefined}
    />
  )

  // Measure on the first committed frame; children render right after.
  if (size === null) {
    return <div ref={containerRef} className="size-full" />
  }

  if (size.w < PHONE_MAX_WIDTH_PX) {
    return (
      <div ref={containerRef} className="size-full">
        <div
          className={cn(
            'grid size-full auto-rows-fr gap-3',
            count <= 2 ? 'grid-cols-1' : 'grid-cols-2',
          )}
        >
          {participants.map((p, i) => (
            <div
              key={p.peerId}
              className={cn(
                'min-h-0',
                // Odd tail tile (3rd of 3, 5th of 5) gets its own full row.
                count % 2 === 1 && count > 1 && i === count - 1 && 'col-span-2',
              )}
            >
              {renderTile(p)}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const { cols, tileW, tileH } = bestLayout(count, size.w, size.h)
  const rows: Participant[][] = []
  for (let i = 0; i < count; i += cols) rows.push(participants.slice(i, i + cols))

  return (
    <div ref={containerRef} className="size-full">
      <div
        className="flex size-full flex-col items-center justify-center"
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
    </div>
  )
}
