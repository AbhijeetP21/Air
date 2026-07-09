// The notes wire protocol receives untrusted peer payloads — every branch of
// the sanitizer is a defense. cleanTranscriptText also gates what the local
// Whisper output is allowed to put in the shared transcript.

import { describe, expect, it } from 'vitest'

import {
  appendTranscriptLine,
  cleanTranscriptText,
  MAX_LINE_LENGTH,
  MAX_TRANSCRIPT_LINES,
  sanitizeNotesSignal,
  type TranscriptLine,
} from '@/lib/notes/protocol'

describe('sanitizeNotesSignal', () => {
  it('accepts a state signal and coerces active to boolean', () => {
    expect(sanitizeNotesSignal({ kind: 'state', active: true })).toEqual({
      kind: 'state',
      active: true,
    })
    expect(sanitizeNotesSignal({ kind: 'state', active: 'yes' })).toEqual({
      kind: 'state',
      active: true,
    })
    expect(sanitizeNotesSignal({ kind: 'state' })).toEqual({
      kind: 'state',
      active: false,
    })
  })

  it('accepts a line signal with finite timestamp', () => {
    const out = sanitizeNotesSignal({ kind: 'line', text: 'hello there', at: 42 })
    expect(out).toEqual({ kind: 'line', text: 'hello there', at: 42 })
  })

  it('substitutes now for a missing/broken timestamp', () => {
    const before = Date.now()
    const out = sanitizeNotesSignal({ kind: 'line', text: 'hi all', at: 'NaN' })
    expect(out?.kind).toBe('line')
    if (out?.kind === 'line') {
      expect(out.at).toBeGreaterThanOrEqual(before)
    }
  })

  it('rejects junk', () => {
    expect(sanitizeNotesSignal(null)).toBeNull()
    expect(sanitizeNotesSignal('line')).toBeNull()
    expect(sanitizeNotesSignal({ kind: 'explode' })).toBeNull()
    expect(sanitizeNotesSignal({ kind: 'line', text: 42 })).toBeNull()
    // A line that cleans to nothing is dropped entirely.
    expect(sanitizeNotesSignal({ kind: 'line', text: '[BLANK_AUDIO]' })).toBeNull()
  })

  it('clamps oversized lines to the budget', () => {
    const out = sanitizeNotesSignal({
      kind: 'line',
      text: 'word '.repeat(1000),
      at: 1,
    })
    expect(out?.kind).toBe('line')
    if (out?.kind === 'line') {
      expect(out.text.length).toBeLessThanOrEqual(MAX_LINE_LENGTH)
    }
  })
})

describe('cleanTranscriptText', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanTranscriptText('  hello   world \n')).toBe('hello world')
  })

  it('drops Whisper non-speech artifacts', () => {
    expect(cleanTranscriptText('[BLANK_AUDIO]')).toBe('')
    expect(cleanTranscriptText(' (soft music) ')).toBe('')
    expect(cleanTranscriptText('♪ ♪')).toBe('')
    expect(cleanTranscriptText('...')).toBe('')
    expect(cleanTranscriptText('')).toBe('')
  })

  it('strips inline annotations but keeps the speech', () => {
    expect(cleanTranscriptText('so [coughs] as I was saying')).toBe(
      'so as I was saying',
    )
  })

  it('keeps normal multilingual speech', () => {
    expect(cleanTranscriptText('चलो शुरू करते हैं')).toBe('चलो शुरू करते हैं')
  })
})

describe('appendTranscriptLine', () => {
  const line = (id: number): TranscriptLine => ({
    id: String(id),
    peerId: 'p1',
    displayName: 'Ada',
    text: `line ${id}`,
    at: id,
  })

  it('appends and caps retention at the max, dropping oldest', () => {
    let lines: TranscriptLine[] = []
    for (let i = 0; i < MAX_TRANSCRIPT_LINES + 10; i++) {
      lines = appendTranscriptLine(lines, line(i))
    }
    expect(lines).toHaveLength(MAX_TRANSCRIPT_LINES)
    expect(lines[0]!.id).toBe('10')
    expect(lines[lines.length - 1]!.id).toBe(String(MAX_TRANSCRIPT_LINES + 9))
  })
})
