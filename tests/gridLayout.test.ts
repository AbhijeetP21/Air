// The measured Meet-style grid math. If this regresses, tiles overflow the
// container or waste half the screen — the exact bug the feature replaced.

import { describe, expect, it } from 'vitest'

import { bestLayout, GAP_PX } from '@/components/call/gridLayout'

const MAX_AR = 16 / 9
const MIN_AR = 4 / 3

describe('bestLayout', () => {
  it('gives a lone 16:9 container to a single tile edge-to-edge', () => {
    const l = bestLayout(1, 1280, 720)
    expect(l.cols).toBe(1)
    expect(l.tileW).toBe(1280)
    expect(l.tileH).toBe(720)
  })

  it('letterboxes a single tile in an ultrawide container at 16:9', () => {
    const l = bestLayout(1, 2000, 500)
    expect(l.cols).toBe(1)
    expect(l.tileH).toBe(500)
    // Width is capped by the aspect clamp, not the container.
    expect(l.tileW).toBe(Math.floor(500 * MAX_AR))
  })

  it('clamps a single tile in a tall container to 4:3', () => {
    const l = bestLayout(1, 500, 2000)
    expect(l.cols).toBe(1)
    expect(l.tileW).toBe(500)
    expect(l.tileH).toBe(Math.floor(500 / MIN_AR))
  })

  it('prefers 2x2 over a single row for 4 tiles in a square container', () => {
    const l = bestLayout(4, 1000, 1000)
    expect(l.cols).toBe(2)
  })

  it('never overflows the container and keeps tiles within the AR clamp', () => {
    const sizes = [
      [1280, 720],
      [1920, 1080],
      [640, 900], // portrait phone-ish
      [834, 1112], // tablet portrait
      [3440, 1440], // ultrawide
      [700, 700],
    ] as const
    for (const [w, h] of sizes) {
      for (let count = 1; count <= 16; count++) {
        const l = bestLayout(count, w, h)
        expect(l.cols).toBeGreaterThanOrEqual(1)
        expect(l.cols).toBeLessThanOrEqual(count)
        const rows = Math.ceil(count / l.cols)
        // The full grid (tiles + gaps) must fit inside the container.
        expect(l.cols * l.tileW + GAP_PX * (l.cols - 1)).toBeLessThanOrEqual(w)
        expect(rows * l.tileH + GAP_PX * (rows - 1)).toBeLessThanOrEqual(h)
        // Aspect ratio stays within [4:3, 16:9] (tolerance for Math.floor).
        if (l.tileW > 0 && l.tileH > 0) {
          const ar = l.tileW / l.tileH
          expect(ar).toBeGreaterThanOrEqual(MIN_AR - 0.02)
          expect(ar).toBeLessThanOrEqual(MAX_AR + 0.02)
        }
      }
    }
  })

  it('grows tile area monotonically as participants leave', () => {
    // Fewer tiles should never mean smaller tiles.
    let prevArea = 0
    for (let count = 16; count >= 1; count--) {
      const l = bestLayout(count, 1600, 900)
      const area = l.tileW * l.tileH
      expect(area).toBeGreaterThanOrEqual(prevArea)
      prevArea = area
    }
  })

  it('survives a zero-sized container without crashing', () => {
    const l = bestLayout(5, 0, 0)
    expect(l.cols).toBe(1)
    expect(l.tileW).toBe(0)
    expect(l.tileH).toBe(0)
  })

  it('handles a container narrower than the gaps', () => {
    const l = bestLayout(10, 20, 20)
    expect(l.cols).toBeGreaterThanOrEqual(1)
    expect(l.tileW).toBeGreaterThanOrEqual(0)
  })
})
