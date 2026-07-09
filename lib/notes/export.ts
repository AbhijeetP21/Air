// Transcript assembly helpers: coalesce raw utterance lines into readable
// speaker turns, render Markdown for export, and chunk long transcripts so a
// small on-device model can map-reduce them.

import type { TranscriptLine } from '@/lib/notes/protocol'

/** Merge consecutive lines from one speaker within this window into a turn. */
const TURN_MERGE_MS = 30_000

export type SpeakerTurn = {
  peerId: string
  displayName: string
  text: string
  at: number
}

/** Group utterances into speaker turns for display and export. */
export function toSpeakerTurns(lines: TranscriptLine[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = []
  for (const line of lines) {
    const last = turns[turns.length - 1]
    if (
      last &&
      last.peerId === line.peerId &&
      line.at - last.at <= TURN_MERGE_MS
    ) {
      last.text += ` ${line.text}`
    } else {
      turns.push({
        peerId: line.peerId,
        displayName: line.displayName,
        text: line.text,
        at: line.at,
      })
    }
  }
  return turns
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Render the full transcript (and optional summary) as Markdown. */
export function transcriptToMarkdown(
  lines: TranscriptLine[],
  meta: { roomName: string; summary?: string },
): string {
  const turns = toSpeakerTurns(lines)
  const startedAt = lines[0]?.at
  const parts: string[] = [
    `# ${meta.roomName} — meeting notes`,
    '',
    startedAt ? `_${new Date(startedAt).toLocaleString()}_` : '',
    '',
  ]
  if (meta.summary) {
    parts.push('## Summary', '', meta.summary.trim(), '')
  }
  parts.push('## Transcript', '')
  for (const turn of turns) {
    parts.push(`**${turn.displayName}** (${formatClock(turn.at)}): ${turn.text}`, '')
  }
  parts.push('---', '', '_Transcribed and summarized on-device by Air. No audio or text left the participants’ machines._')
  return parts.filter((p, i, a) => p !== '' || a[i - 1] !== '').join('\n')
}

/** Plain-text rendering of the transcript for the summarizer prompt. */
export function transcriptToPlainText(lines: TranscriptLine[]): string {
  return toSpeakerTurns(lines)
    .map((t) => `${t.displayName}: ${t.text}`)
    .join('\n')
}

/**
 * Split a transcript into chunks of at most `maxChars`, breaking on turn
 * boundaries so no speaker's sentence is cut mid-thought. Small models have
 * modest usable contexts; long calls get summarized chunk-by-chunk first.
 */
export function chunkTranscript(
  lines: TranscriptLine[],
  maxChars: number,
): string[] {
  const turns = toSpeakerTurns(lines).map(
    (t) => `${t.displayName}: ${t.text}`,
  )
  const chunks: string[] = []
  let current = ''
  for (const turn of turns) {
    // A single oversized turn still becomes its own (oversized) chunk rather
    // than being dropped; models truncate gracefully, silence doesn't.
    if (current && current.length + turn.length + 1 > maxChars) {
      chunks.push(current)
      current = turn
    } else {
      current = current ? `${current}\n${turn}` : turn
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/** Trigger a client-side download of `content` as a file. */
export function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
