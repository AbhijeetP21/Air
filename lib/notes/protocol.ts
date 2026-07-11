// Wire protocol for AI note-taking. Rides its own LiveKit data-channel topic,
// same trust model as chat/hand: the sender identity always comes from the
// SFU-verified participant, never from the payload, and every inbound field is
// treated as hostile until sanitized.
//
// Two message kinds:
//  - 'state'  — a participant turned note-taking on/off. While anyone has it
//    on, every capable client transcribes its OWN mic locally and shares the
//    finished lines, so each voice is recognized from its clean, pre-mix audio
//    and speaker attribution is free (the line's author is its speaker).
//  - 'line'   — one finished utterance of the sender's own speech.

export const NOTES_TOPIC = 'notes'

/** Max characters accepted for a single transcript line (send and receive). */
export const MAX_LINE_LENGTH = 600

/** Cap on transcript lines retained in memory (a 3h call stays well under). */
export const MAX_TRANSCRIPT_LINES = 5000

export type NotesSignal =
  | { kind: 'state'; active: boolean }
  | { kind: 'line'; text: string; at: number }

/** One utterance in the assembled transcript (speaker = verified sender). */
export type TranscriptLine = {
  id: string
  /** LiveKit identity of the speaker (session id). */
  peerId: string
  displayName: string
  text: string
  at: number // epoch ms
}

/** Validate an inbound (untrusted) notes payload. Returns null when invalid. */
export function sanitizeNotesSignal(value: unknown): NotesSignal | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { kind?: unknown; active?: unknown; text?: unknown; at?: unknown }
  if (raw.kind === 'state') {
    return { kind: 'state', active: Boolean(raw.active) }
  }
  if (raw.kind === 'line') {
    if (typeof raw.text !== 'string') return null
    const text = cleanTranscriptText(raw.text.slice(0, MAX_LINE_LENGTH))
    if (!text) return null
    // Untrusted timestamp: clamp to (0, now]. A future `at` must not be able to
    // reorder the shared transcript or render a bogus clock — same rule the
    // raised-hand queue applies. Missing/broken falls back to now.
    const rawAt = Number(raw.at)
    const at =
      Number.isFinite(rawAt) && rawAt > 0
        ? Math.min(rawAt, Date.now())
        : Date.now()
    return { kind: 'line', text, at }
  }
  return null
}

// Whisper emits stage-direction artifacts on non-speech audio ("[BLANK_AUDIO]",
// "(soft music)", "♪ ♪"). A line that is only artifacts carries no meaning.
const ARTIFACT_ONLY = /^[\s[\](){}♪♫*_\-–—.·…]*$/
const BRACKETED = /[[(][^\])]*[\])]/g

/**
 * Normalize a raw ASR result into a transcript-worthy line: collapse
 * whitespace, strip bracketed sound-effect annotations, and reject lines with
 * no real content. Returns '' when the line should be dropped.
 */
export function cleanTranscriptText(raw: string): string {
  const withoutAnnotations = raw.replace(BRACKETED, ' ')
  const collapsed = withoutAnnotations.replace(/\s+/g, ' ').trim()
  if (!collapsed || ARTIFACT_ONLY.test(collapsed)) return ''
  // Require at least one letter or digit in any script.
  if (!/[\p{L}\p{N}]/u.test(collapsed)) return ''
  return collapsed
}

/**
 * Insert a line in chronological (`at`) order, keeping at most
 * MAX_TRANSCRIPT_LINES (drops oldest). Lines from different peers arrive
 * interleaved over the network, so appending by receipt order would misorder
 * the transcript (and its export's start time). We scan from the end — lines
 * almost always arrive in order, making this O(1) amortized — and place
 * out-of-order arrivals by timestamp. Ties keep arrival order (stable).
 */
export function appendTranscriptLine(
  prev: TranscriptLine[],
  line: TranscriptLine,
): TranscriptLine[] {
  let i = prev.length
  while (i > 0 && prev[i - 1]!.at > line.at) i--
  const next =
    i === prev.length
      ? [...prev, line]
      : [...prev.slice(0, i), line, ...prev.slice(i)]
  return next.length > MAX_TRANSCRIPT_LINES
    ? next.slice(next.length - MAX_TRANSCRIPT_LINES)
    : next
}
