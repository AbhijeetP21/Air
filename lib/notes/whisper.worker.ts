// Dedicated worker running Whisper via transformers.js (ONNX Runtime Web).
// Inference happens here so mel extraction + decoding never touch the call's
// main thread. Prefers WebGPU; falls back to WASM on machines without it.
//
// The model is fetched from the Hugging Face CDN once and cached by the
// browser (Cache API) — after the first download, transcription is fully
// offline. Audio never leaves this worker; only text goes back.

import { pipeline, env } from '@huggingface/transformers'

// Small enough to download in seconds, strong enough for meeting speech.
const MODEL_ID = 'onnx-community/whisper-base'

env.allowLocalModels = false

type InMessage =
  | { type: 'load' }
  | { type: 'transcribe'; id: number; audio: Float32Array }

type AsrPipeline = (
  audio: Float32Array,
) => Promise<{ text: string } | Array<{ text: string }>>

const scope = globalThis as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', handler: (e: MessageEvent) => void) => void
  navigator?: { gpu?: unknown }
}

let asrPromise: Promise<AsrPipeline> | null = null
// Serialize jobs — the pipeline is single-instance and decode is stateful.
let queue: Promise<void> = Promise.resolve()

function loadAsr(): Promise<AsrPipeline> {
  if (asrPromise) return asrPromise
  asrPromise = (async () => {
    const progress_callback = (p: { status?: string; progress?: number }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        scope.postMessage({ type: 'progress', progress: p.progress })
      }
    }
    try {
      if (!scope.navigator?.gpu) throw new Error('WebGPU unavailable')
      return (await pipeline('automatic-speech-recognition', MODEL_ID, {
        device: 'webgpu',
        // Whisper's encoder is precision-sensitive; the decoder quantizes well.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      })) as unknown as AsrPipeline
    } catch {
      // WASM path: slower but universal. q8 keeps the download small.
      return (await pipeline('automatic-speech-recognition', MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback,
      })) as unknown as AsrPipeline
    }
  })()
  return asrPromise
}

scope.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as InMessage
  queue = queue.then(async () => {
    try {
      if (msg.type === 'load') {
        await loadAsr()
        scope.postMessage({ type: 'ready' })
        return
      }
      if (msg.type === 'transcribe') {
        const asr = await loadAsr()
        const out = await asr(msg.audio)
        const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
        scope.postMessage({ type: 'line', id: msg.id, text })
      }
    } catch (err) {
      scope.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })
})
