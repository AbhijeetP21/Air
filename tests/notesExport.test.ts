// Transcript assembly: speaker-turn coalescing, Markdown export, and the
// chunking that feeds long transcripts to a small model, plus the WebLLM
// model picker used by the summarizer.

import { describe, expect, it } from 'vitest'

import {
  chunkTranscript,
  toSpeakerTurns,
  transcriptToMarkdown,
  transcriptToPlainText,
} from '@/lib/notes/export'
import { pickWebLLMModel } from '@/lib/notes/summarizer'
import type { TranscriptLine } from '@/lib/notes/protocol'

const line = (
  peerId: string,
  name: string,
  text: string,
  at: number,
): TranscriptLine => ({ id: `${peerId}-${at}`, peerId, displayName: name, text, at })

const sample = [
  line('a', 'Ada', 'Morning everyone.', 1000),
  line('a', 'Ada', 'Let us start with the roadmap.', 3000),
  line('b', 'Grace', 'The launch slipped to Friday.', 8000),
  line('a', 'Ada', 'Okay, noted.', 12000),
]

describe('toSpeakerTurns', () => {
  it('merges consecutive lines from one speaker within the window', () => {
    const turns = toSpeakerTurns(sample)
    expect(turns).toHaveLength(3)
    expect(turns[0]!.text).toBe('Morning everyone. Let us start with the roadmap.')
    expect(turns[1]!.displayName).toBe('Grace')
  })

  it('does not merge across a long pause', () => {
    const turns = toSpeakerTurns([
      line('a', 'Ada', 'Before the break.', 0),
      line('a', 'Ada', 'After the break.', 60_000),
    ])
    expect(turns).toHaveLength(2)
  })

  it('handles an empty transcript', () => {
    expect(toSpeakerTurns([])).toEqual([])
  })
})

describe('transcriptToMarkdown', () => {
  it('includes title, speakers, and the privacy note', () => {
    const md = transcriptToMarkdown(sample, { roomName: 'Weekly sync' })
    expect(md).toContain('# Weekly sync — meeting notes')
    expect(md).toContain('## Transcript')
    expect(md).toContain('**Ada**')
    expect(md).toContain('**Grace**')
    expect(md).toContain('on-device')
    expect(md).not.toContain('## Summary')
  })

  it('includes the summary section when provided', () => {
    const md = transcriptToMarkdown(sample, {
      roomName: 'Weekly sync',
      summary: '### Summary\nShipping Friday.',
    })
    expect(md.indexOf('## Summary')).toBeGreaterThan(-1)
    expect(md.indexOf('## Summary')).toBeLessThan(md.indexOf('## Transcript'))
  })
})

describe('transcriptToPlainText', () => {
  it('renders one Name: text line per turn', () => {
    const text = transcriptToPlainText(sample)
    expect(text.split('\n')).toHaveLength(3)
    expect(text).toContain('Grace: The launch slipped to Friday.')
  })
})

describe('chunkTranscript', () => {
  it('returns one chunk for a short transcript', () => {
    expect(chunkTranscript(sample, 10_000)).toHaveLength(1)
  })

  it('splits on turn boundaries under the size cap', () => {
    const lines: TranscriptLine[] = []
    for (let i = 0; i < 40; i++) {
      lines.push(line(`p${i % 3}`, `Speaker${i % 3}`, 'word '.repeat(60).trim(), i * 60_000))
    }
    const chunks = chunkTranscript(lines, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000)
      // No chunk starts or ends mid-turn: every chunk line is a full turn.
      for (const l of chunk.split('\n')) {
        expect(l).toMatch(/^Speaker\d: /)
      }
    }
  })

  it('keeps an oversized single turn rather than dropping it', () => {
    const big = [line('a', 'Ada', 'word '.repeat(500).trim(), 0)]
    const chunks = chunkTranscript(big, 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.length).toBeGreaterThan(100)
  })
})

describe('pickWebLLMModel', () => {
  it('prefers a small Gemma instruct model', () => {
    const pick = pickWebLLMModel([
      'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      'gemma-2-2b-it-q4f16_1-MLC',
      'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
      'gemma-2-27b-it-q4f16_1-MLC',
    ])
    expect(pick).toBe('gemma-2-2b-it-q4f16_1-MLC')
  })

  it('falls back to another small instruct model without Gemma', () => {
    const pick = pickWebLLMModel([
      'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      'Llama-3.1-70B-Instruct-q4f16_1-MLC',
    ])
    expect(pick).toBe('Llama-3.2-1B-Instruct-q4f16_1-MLC')
  })

  it('never picks base (non-instruct) or huge models', () => {
    expect(
      pickWebLLMModel(['gemma-2-2b-q4f16_1-MLC', 'Llama-3.1-70B-Instruct-MLC']),
    ).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(pickWebLLMModel([])).toBeNull()
  })
})
