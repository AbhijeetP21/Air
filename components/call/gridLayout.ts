'use client'

import { useLayoutEffect, useRef, useState } from 'react'

// Shared tile-layout math for the call grids (ported from Pact's Meet-style
// computed layout). The container is measured and, for every possible column
// count, we compute how large a tile could be; the arrangement with the
// largest tiles wins. Tiles prefer 16:9 but may narrow to 4:3 to spend more
// of the screen on video before letterboxing.

export const GAP_PX = 12 // matches gap-3
// Tile aspect-ratio bounds for the computed layout.
const MAX_TILE_AR = 16 / 9
const MIN_TILE_AR = 4 / 3
// Below this container width, use the phone layout (Tailwind's sm breakpoint).
export const PHONE_MAX_WIDTH_PX = 640

export type Layout = { cols: number; tileW: number; tileH: number }

/** Pick the column count that yields the largest tiles for this container. */
export function bestLayout(
  count: number,
  width: number,
  height: number,
): Layout {
  let best: Layout = { cols: 1, tileW: 0, tileH: 0 }
  let bestArea = -1
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const cellW = (width - GAP_PX * (cols - 1)) / cols
    const cellH = (height - GAP_PX * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue
    // Fit the largest aspect-clamped tile inside the cell.
    const cellAR = cellW / cellH
    const tileAR = Math.min(Math.max(cellAR, MIN_TILE_AR), MAX_TILE_AR)
    const tileW = cellAR >= tileAR ? cellH * tileAR : cellW
    const tileH = cellAR >= tileAR ? cellH : cellW / tileAR
    const area = tileW * tileH
    if (area > bestArea) {
      bestArea = area
      best = { cols, tileW: Math.floor(tileW), tileH: Math.floor(tileH) }
    }
  }
  return best
}

/**
 * Measure a container with a ResizeObserver. Returns the ref to attach and the
 * latest size (null until the first committed frame, so callers can render an
 * empty measuring frame first).
 */
export function useContainerSize() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () =>
      setSize((prev) => {
        const w = el.clientWidth
        const h = el.clientHeight
        return prev && prev.w === w && prev.h === h ? prev : { w, h }
      })
    measure()
    // ResizeObserver covers container-driven changes; the window listener is a
    // fallback for environments where RO notifications are frame-throttled.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  return { containerRef, size }
}
