// The speech segmenter decides what audio ever reaches the ASR model — bugs
// here mean missed speech or hallucinated transcription of silence.

import { describe, expect, it } from 'vitest'

import { resampleTo, rms, SpeechSegmenter } from '@/lib/notes/audio'

const RATE = 16000

/** A frame of loud pseudo-speech (well above the default 0.01 threshold). */
function speech(ms: number): Float32Array {
  const out = new Float32Array(Math.round((ms / 1000) * RATE))
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin(i / 10)
  return out
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * RATE))
}

const segmenter = () => new SpeechSegmenter({ sampleRate: RATE })

describe('rms', () => {
  it('is 0 for silence and rises with amplitude', () => {
    expect(rms(silence(100))).toBe(0)
    expect(rms(speech(100))).toBeGreaterThan(0.1)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})

describe('resampleTo', () => {
  it('is identity at equal rates', () => {
    const input = speech(50)
    expect(resampleTo(input, RATE, RATE)).toBe(input)
  })

  it('scales the length by the rate ratio', () => {
    const input = new Float32Array(48000) // 1s @ 48k
    const out = resampleTo(input, 48000, 16000)
    expect(out.length).toBe(16000)
  })

  it('preserves a constant signal', () => {
    const input = new Float32Array(4800).fill(0.5)
    const out = resampleTo(input, 48000, 16000)
    for (const v of out) expect(v).toBeCloseTo(0.5, 5)
  })
})

describe('SpeechSegmenter', () => {
  it('produces nothing for pure silence', () => {
    const s = segmenter()
    for (let i = 0; i < 50; i++) {
      expect(s.push(silence(100))).toEqual([])
    }
    expect(s.flush()).toBeNull()
  })

  it('closes an utterance after the silence gap', () => {
    const s = segmenter()
    const out: Float32Array[] = []
    out.push(...s.push(speech(1000)))
    expect(out).toEqual([]) // still in speech
    // 800ms of silence crosses the 700ms default gap.
    for (let i = 0; i < 8; i++) out.push(...s.push(silence(100)))
    expect(out).toHaveLength(1)
    // The utterance carries (at least) the original second of speech.
    expect(out[0]!.length).toBeGreaterThanOrEqual(RATE)
  })

  it('discards blips shorter than the min speech length', () => {
    const s = segmenter()
    const out: Float32Array[] = []
    out.push(...s.push(speech(100))) // a cough
    for (let i = 0; i < 10; i++) out.push(...s.push(silence(100)))
    expect(out).toEqual([])
  })

  it('splits a long monologue at the max segment length', () => {
    const s = segmenter()
    const out: Float32Array[] = []
    // 20s of continuous speech in 500ms frames → must split around 15s.
    for (let i = 0; i < 40; i++) out.push(...s.push(speech(500)))
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0]!.length).toBeLessThanOrEqual(RATE * 15.5)
    expect(out[0]!.length).toBeGreaterThanOrEqual(RATE * 14)
  })

  it('includes pre-roll so the onset is not clipped', () => {
    const s = segmenter()
    s.push(silence(100)) // becomes pre-roll
    s.push(speech(1000))
    const flushed = s.flush()
    expect(flushed).not.toBeNull()
    // Utterance = ~240ms of retained pre-roll (capped) + the second of speech.
    expect(flushed!.length).toBeGreaterThan(RATE)
  })

  it('flush returns the in-progress utterance and resets', () => {
    const s = segmenter()
    s.push(speech(1000))
    expect(s.flush()).not.toBeNull()
    expect(s.flush()).toBeNull()
  })
})
