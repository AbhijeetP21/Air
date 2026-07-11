// Main-thread controller for local transcription: taps the (processed) mic
// stream, segments it into utterances with a lightweight VAD, and hands each
// utterance to the Whisper worker. Emits cleaned transcript lines.
//
// Privacy: the audio path is mic → this tab's worker → text. Nothing is
// uploaded anywhere; the resulting text lines are shared with the room over
// the same encrypted data channel that carries chat.

import { resampleTo, SpeechSegmenter, WHISPER_SAMPLE_RATE } from '@/lib/notes/audio'
import { cleanTranscriptText } from '@/lib/notes/protocol'
import { rtcError, rtcLog } from '@/lib/webrtc/log'

export type TranscriberStatus = 'idle' | 'loading' | 'ready' | 'error'

export type TranscriberHandlers = {
  /** A finished, cleaned line of the local user's speech. */
  onLine: (text: string) => void
  /** Model lifecycle: loading (with 0-100 progress), ready, or error. */
  onStatus: (status: TranscriberStatus, progress?: number) => void
}

/** Whether this device can run local transcription at all. */
export function supportsLocalTranscription(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    window.isSecureContext
  )
}

export class LocalTranscriber {
  private worker: Worker | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private sink: GainNode | null = null
  private segmenter: SpeechSegmenter | null = null
  private nextJobId = 1
  private lastLine = ''
  private stopped = false

  constructor(private readonly handlers: TranscriberHandlers) {}

  /** Begin transcribing the audio track of `stream` (the processed mic). */
  start(stream: MediaStream, opts: { model?: 'tiny' | 'base' } = {}): void {
    const audioTrack = stream.getAudioTracks()[0]
    if (!audioTrack) {
      this.handlers.onStatus('error')
      return
    }
    this.stopped = false
    this.handlers.onStatus('loading', 0)

    this.worker = new Worker(new URL('./whisper.worker.ts', import.meta.url))
    this.worker.addEventListener('message', (e: MessageEvent) => {
      if (this.stopped) return
      const msg = e.data as
        | { type: 'progress'; progress: number }
        | { type: 'ready' }
        | { type: 'line'; id: number; text: string }
        | { type: 'error'; message: string }
      if (msg.type === 'progress') {
        this.handlers.onStatus('loading', Math.round(msg.progress))
      } else if (msg.type === 'ready') {
        this.handlers.onStatus('ready')
      } else if (msg.type === 'line') {
        const text = cleanTranscriptText(msg.text)
        // Whisper can hallucinate the same phrase on trailing-silence chunks;
        // dropping exact consecutive repeats removes the common case.
        if (text && text !== this.lastLine) {
          this.lastLine = text
          this.handlers.onLine(text)
        }
      } else if (msg.type === 'error') {
        rtcError('Notes', `worker error: ${msg.message}`)
        this.handlers.onStatus('error')
      }
    })
    this.worker.postMessage({ type: 'load', model: opts.model ?? 'base' })

    // Tap the mic. ScriptProcessor is legacy but universally supported and
    // costs only a buffer copy per ~85ms; the heavy work lives in the worker.
    const audioContext = new AudioContext()
    this.audioContext = audioContext
    this.segmenter = new SpeechSegmenter({ sampleRate: audioContext.sampleRate })
    this.source = audioContext.createMediaStreamSource(
      new MediaStream([audioTrack]),
    )
    this.processor = audioContext.createScriptProcessor(4096, 1, 1)
    // ScriptProcessor only fires while connected to the destination; a
    // zero-gain sink keeps the graph alive without echoing the mic.
    this.sink = audioContext.createGain()
    this.sink.gain.value = 0
    this.processor.onaudioprocess = (e) => {
      if (this.stopped || !this.segmenter) return
      // Copy — the engine reuses the buffer between callbacks.
      const frame = new Float32Array(e.inputBuffer.getChannelData(0))
      for (const segment of this.segmenter.push(frame)) {
        this.transcribe(segment, audioContext.sampleRate)
      }
    }
    this.source.connect(this.processor)
    this.processor.connect(this.sink)
    this.sink.connect(audioContext.destination)
    rtcLog('Notes', 'local transcription started')
  }

  private transcribe(segment: Float32Array, sampleRate: number): void {
    if (!this.worker) return
    const audio = resampleTo(segment, sampleRate, WHISPER_SAMPLE_RATE)
    this.worker.postMessage(
      { type: 'transcribe', id: this.nextJobId++, audio },
      [audio.buffer],
    )
  }

  /** Stop capturing and release the worker + audio graph. */
  stop(): void {
    this.stopped = true
    // Transcribe any utterance in progress before tearing down? No — the
    // worker is going away; a clean stop beats a half-line race.
    this.processor?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    if (this.processor) this.processor.onaudioprocess = null
    void this.audioContext?.close().catch(() => {})
    this.worker?.terminate()
    this.worker = null
    this.audioContext = null
    this.source = null
    this.processor = null
    this.sink = null
    this.segmenter = null
    rtcLog('Notes', 'local transcription stopped')
  }
}
