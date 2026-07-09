'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  Loader2,
  NotebookPen,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { downloadFile, toSpeakerTurns, transcriptToMarkdown } from '@/lib/notes/export'
import type { TranscriptLine } from '@/lib/notes/protocol'
import type { TranscriberStatus } from '@/lib/notes/transcriber'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * AI notes: live meeting transcript + on-device summary. Everything is local —
 * each participant's speech is transcribed on their own machine, lines are
 * shared over the call's data channel, and the summary model runs in this tab.
 * Nothing is ever uploaded or stored server-side.
 */
export function NotesPanel({
  open,
  onClose,
  transcript,
  selfPeerId,
  roomName,
  notesEnabled,
  onToggleNotes,
  noteTakers,
  transcriberStatus,
  transcriberProgress,
  canTranscribe,
}: {
  open: boolean
  onClose: () => void
  transcript: TranscriptLine[]
  selfPeerId: string
  roomName: string
  notesEnabled: boolean
  onToggleNotes: () => void
  noteTakers: string[]
  transcriberStatus: TranscriberStatus
  transcriberProgress: number | null
  canTranscribe: boolean
}) {
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryStage, setSummaryStage] = useState<{
    label: string
    pct: number | null
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  const turns = toSpeakerTurns(transcript)
  const notesRunning = notesEnabled || noteTakers.length > 0

  // Follow the live transcript unless the user scrolled up to read back.
  useEffect(() => {
    if (open && followRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [transcript.length, open])

  if (!open) return null

  async function generateSummary() {
    setSummarizing(true)
    setSummaryStage({ label: 'Starting', pct: null })
    try {
      // Lazy-load the summarizer (and its model runtime) only when asked.
      const { summarizeTranscript } = await import('@/lib/notes/summarizer')
      const text = await summarizeTranscript(transcript, (label, pct) =>
        setSummaryStage({ label, pct }),
      )
      setSummary(text)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'The summary failed. Try again.',
      )
    } finally {
      setSummarizing(false)
      setSummaryStage(null)
    }
  }

  async function copySummary() {
    if (!summary) return
    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the summary')
    }
  }

  function exportMarkdown() {
    downloadFile(
      `${roomName.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase() || 'meeting'}-notes.md`,
      transcriptToMarkdown(transcript, {
        roomName,
        summary: summary ?? undefined,
      }),
    )
  }

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l bg-card shadow-xl">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <NotebookPen className="size-4" />
          AI notes
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notes"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {/* On/off + engine status. */}
      <div className="space-y-2 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium">Take notes</p>
            <p className="text-xs text-muted-foreground">
              Everyone in the call is notified.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notesEnabled}
            aria-label="Take notes"
            onClick={onToggleNotes}
            className={cn(
              'inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
              notesEnabled ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'inline-block size-5 rounded-full bg-white shadow-sm transition-transform',
                notesEnabled ? 'translate-x-5' : 'translate-x-0',
              )}
            />
          </button>
        </div>

        {noteTakers.length > 0 && !notesEnabled && (
          <p className="text-xs text-muted-foreground">
            {noteTakers.join(', ')} {noteTakers.length === 1 ? 'is' : 'are'}{' '}
            taking notes.
          </p>
        )}

        {notesRunning && !canTranscribe && (
          <p className="text-xs text-muted-foreground">
            This device can&apos;t transcribe (needs a desktop browser), but
            you&apos;ll still see everyone else&apos;s lines here.
          </p>
        )}

        {transcriberStatus === 'loading' && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Downloading the speech model
            {transcriberProgress !== null ? ` — ${transcriberProgress}%` : '…'}
          </p>
        )}
        {transcriberStatus === 'error' && (
          <p className="text-xs text-destructive">
            The speech model couldn&apos;t start on this device.
          </p>
        )}
      </div>

      {/* Live transcript. */}
      <div
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget
          followRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {turns.length === 0 ? (
          <p className="pt-8 text-center text-sm text-muted-foreground">
            {notesRunning
              ? 'Listening… lines appear as people speak.'
              : 'Turn on notes to start a live, on-device transcript.'}
          </p>
        ) : (
          turns.map((turn, i) => (
            <div key={`${turn.peerId}-${turn.at}-${i}`}>
              <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium">
                  {turn.peerId === selfPeerId ? 'You' : turn.displayName}
                </span>
                <span>{formatTime(turn.at)}</span>
              </div>
              <p className="text-sm leading-relaxed">{turn.text}</p>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Summary. */}
      {summary && (
        <div className="max-h-56 space-y-2 overflow-y-auto border-t px-4 py-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="size-3.5" />
              Summary
            </h3>
            <button
              type="button"
              onClick={() => void copySummary()}
              aria-label="Copy summary"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="size-3.5 text-green-500" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {summary}
          </div>
        </div>
      )}

      {/* Actions. */}
      <div className="space-y-2 border-t p-3">
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={transcript.length === 0 || summarizing}
            onClick={() => void generateSummary()}
          >
            {summarizing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {summary ? 'Refresh summary' : 'Summarize'}
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={transcript.length === 0}
            onClick={exportMarkdown}
          >
            <Download className="size-4" />
            Export .md
          </Button>
        </div>

        {summarizing && summaryStage && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {summaryStage.label}
            {summaryStage.pct !== null ? ` — ${summaryStage.pct}%` : '…'}
          </p>
        )}

        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3 shrink-0" />
          Transcription and summaries run on participants&apos; devices. Nothing
          is uploaded or stored.
        </p>
      </div>
    </aside>
  )
}
