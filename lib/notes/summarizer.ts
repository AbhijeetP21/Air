/* eslint-disable @typescript-eslint/no-explicit-any */
// On-device meeting summarization. Two engines, tried in order:
//
//  1. The browser's built-in Prompt API (Chrome ships Gemini Nano) — zero
//     download when present.
//  2. WebLLM (WebGPU): a small instruction-tuned open model (Gemma-class),
//     fetched once from the WebLLM CDN and cached locally.
//
// Either way the transcript never leaves the device. Long calls are
// map-reduced: chunks → bullet notes → final summary.

import { chunkTranscript, transcriptToPlainText } from '@/lib/notes/export'
import type { TranscriptLine } from '@/lib/notes/protocol'

/** Progress callback: a human-readable stage label + optional 0-100 percent. */
export type SummarizeProgress = (label: string, pct: number | null) => void

// A transcript at or under this goes to the model in one pass.
const MAX_SINGLE_PASS_CHARS = 20_000
const CHUNK_CHARS = 12_000

const SYSTEM_PROMPT =
  'You are a meeting note-taker. You are given a meeting transcript with ' +
  'speaker names. Write concise, faithful notes in Markdown with exactly ' +
  'these sections: "### Summary" (one short paragraph), "### Key points" ' +
  '(bullets), and "### Action items" (bullets with owners when stated; write ' +
  '"None discussed" if there are none). Never invent facts that are not in ' +
  'the transcript.'

const CHUNK_PROMPT =
  'Condense this portion of a meeting transcript into detailed bullet notes. ' +
  'Keep speaker attributions, decisions, numbers, and any tasks. Output only ' +
  'the bullets.'

type Generate = (system: string, user: string) => Promise<string>

/** Whether any local summarization engine could run on this device. */
export function supportsLocalSummarization(): boolean {
  if (typeof window === 'undefined') return false
  const hasPromptApi = Boolean((globalThis as any).LanguageModel)
  const hasWebGpu = Boolean((navigator as any).gpu)
  return hasPromptApi || hasWebGpu
}

/**
 * Choose the WebLLM prebuilt model best suited to note summarization on
 * modest hardware: prefer small Gemma instruction models, then other small
 * instruct models. Returns null when nothing suitable is offered.
 * (Exported for tests.)
 */
export function pickWebLLMModel(modelIds: string[]): string | null {
  const score = (id: string): number => {
    const lower = id.toLowerCase()
    if (!/instruct|-it-|-it$|chat/.test(lower)) return -1
    if (/(^|[^a-z])(vision|audio|embed)/.test(lower)) return -1
    let s = 0
    if (lower.includes('gemma')) s += 100
    const size = lower.match(/(\d+(?:\.\d+)?)b/)
    const params = size ? Number(size[1]) : NaN
    if (!Number.isFinite(params) || params > 4) return -1
    // Smaller downloads first among candidates of the same family tier.
    s += 10 - Math.min(params, 9)
    // Prefer 4-bit quantizations (smallest VRAM) when the id encodes one.
    if (lower.includes('q4')) s += 1
    return s
  }
  let best: string | null = null
  let bestScore = 0
  for (const id of modelIds) {
    const s = score(id)
    if (s > bestScore) {
      best = id
      bestScore = s
    }
  }
  return best
}

/** Engine 1: the browser's built-in Prompt API (Gemini Nano in Chrome). */
async function createPromptApiGenerate(
  onProgress: SummarizeProgress,
): Promise<Generate | null> {
  const LanguageModel = (globalThis as any).LanguageModel
  if (!LanguageModel?.create) return null
  try {
    const availability = await LanguageModel.availability?.()
    if (availability === 'unavailable') return null
    const session = await LanguageModel.create({
      monitor(m: any) {
        m.addEventListener?.('downloadprogress', (e: any) => {
          onProgress('Preparing the built-in model', Math.round((e.loaded ?? 0) * 100))
        })
      },
    })
    return async (system, user) => {
      // The Prompt API takes one text prompt; fold the system role in.
      const out = await session.prompt(`${system}\n\n${user}`)
      return String(out)
    }
  } catch {
    return null
  }
}

/** Engine 2: WebLLM with a small open instruct model over WebGPU. */
async function createWebLLMGenerate(
  onProgress: SummarizeProgress,
): Promise<Generate | null> {
  if (!(navigator as any).gpu) return null
  try {
    const webllm = await import('@mlc-ai/web-llm')
    const modelId = pickWebLLMModel(
      webllm.prebuiltAppConfig.model_list.map((m: any) => m.model_id),
    )
    if (!modelId) return null
    const engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (p: { text?: string; progress?: number }) => {
        onProgress(
          p.text || 'Downloading the summary model',
          typeof p.progress === 'number' ? Math.round(p.progress * 100) : null,
        )
      },
    })
    return async (system, user) => {
      const res = await engine.chat.completions.create({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      })
      return res.choices[0]?.message?.content ?? ''
    }
  } catch {
    return null
  }
}

/**
 * Summarize the transcript entirely on-device. Throws with a user-facing
 * message when no engine can run here.
 */
export async function summarizeTranscript(
  lines: TranscriptLine[],
  onProgress: SummarizeProgress,
): Promise<string> {
  if (lines.length === 0) throw new Error('Nothing to summarize yet.')

  onProgress('Loading the on-device model', null)
  const generate =
    (await createPromptApiGenerate(onProgress)) ??
    (await createWebLLMGenerate(onProgress))
  if (!generate) {
    throw new Error(
      'This device can’t run the local summary model (WebGPU is required). The transcript is still available to download.',
    )
  }

  const fullText = transcriptToPlainText(lines)
  if (fullText.length <= MAX_SINGLE_PASS_CHARS) {
    onProgress('Writing the summary', null)
    return (await generate(SYSTEM_PROMPT, `Transcript:\n\n${fullText}`)).trim()
  }

  // Map-reduce for long calls: bullet-notes per chunk, then a final pass.
  const chunks = chunkTranscript(lines, CHUNK_CHARS)
  const notes: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress(
      `Reading the transcript (part ${i + 1} of ${chunks.length})`,
      Math.round((i / chunks.length) * 100),
    )
    notes.push(await generate(CHUNK_PROMPT, chunks[i]!))
  }
  onProgress('Writing the summary', null)
  return (
    await generate(
      SYSTEM_PROMPT,
      `Bullet notes from a long meeting (in order):\n\n${notes.join('\n\n')}`,
    )
  ).trim()
}
