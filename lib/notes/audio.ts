// Pure DSP helpers for local transcription: an energy-based speech segmenter
// (cuts the mic feed into utterances at pauses) and a resampler down to the
// 16 kHz mono Whisper expects. No Web Audio types here — everything takes
// plain Float32Arrays so it's testable off-browser.

/** Whisper models are trained on 16 kHz mono input. */
export const WHISPER_SAMPLE_RATE = 16000

export type SegmenterOptions = {
  /** Sample rate of the incoming frames. */
  sampleRate: number
  /** RMS above this counts as speech. Calm rooms sit well below it. */
  rmsThreshold?: number
  /** Close the segment after this much continuous silence. */
  silenceMs?: number
  /** Hard cap per segment — long monologues are split and transcribed early. */
  maxSegmentMs?: number
  /** Discard "segments" shorter than this (coughs, keyboard taps). */
  minSpeechMs?: number
  /** Pre-roll retained before speech onset so the first word isn't clipped. */
  paddingMs?: number
}

const DEFAULTS = {
  rmsThreshold: 0.01,
  silenceMs: 700,
  maxSegmentMs: 15000,
  minSpeechMs: 400,
  paddingMs: 240,
}

/** Root-mean-square level of a frame (0..1 for normalized float samples). */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!
  return Math.sqrt(sum / frame.length)
}

/**
 * Linear-interpolation resampler. Fine for speech-to-text (Whisper's mel
 * frontend is tolerant); avoids shipping a polyphase filter for a transcript.
 */
export function resampleTo(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return input
  const outLength = Math.max(1, Math.round((input.length * outRate) / inRate))
  const out = new Float32Array(outLength)
  const step = (input.length - 1) / Math.max(1, outLength - 1)
  for (let i = 0; i < outLength; i++) {
    const pos = i * step
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = pos - lo
    out[i] = input[lo]! * (1 - frac) + input[hi]! * frac
  }
  return out
}

/**
 * Streaming voice-activity segmenter. Feed it fixed-or-variable-size frames;
 * it returns finished utterances (speech bounded by silence, or split at the
 * max length). Silence-only stretches produce nothing, so an idle or muted mic
 * costs no transcription work.
 */
export class SpeechSegmenter {
  private readonly opts: Required<SegmenterOptions>
  private frames: Float32Array[] = []
  private bufferedSamples = 0
  private inSpeech = false
  private silentSamples = 0
  private preRoll: Float32Array[] = []
  private preRollSamples = 0

  constructor(options: SegmenterOptions) {
    this.opts = { ...DEFAULTS, ...options }
  }

  private msToSamples(ms: number): number {
    return Math.round((ms / 1000) * this.opts.sampleRate)
  }

  /** Feed one frame; returns any utterances completed by it. */
  push(frame: Float32Array): Float32Array[] {
    const done: Float32Array[] = []
    const loud = rms(frame) >= this.opts.rmsThreshold

    if (!this.inSpeech) {
      if (loud) {
        // Speech onset: start the segment with the buffered pre-roll.
        this.inSpeech = true
        this.frames = [...this.preRoll, frame]
        this.bufferedSamples = this.preRollSamples + frame.length
        this.silentSamples = 0
        this.preRoll = []
        this.preRollSamples = 0
      } else {
        // Idle: keep a short rolling pre-roll so onsets aren't clipped.
        this.preRoll.push(frame)
        this.preRollSamples += frame.length
        const maxPreRoll = this.msToSamples(this.opts.paddingMs)
        while (this.preRollSamples - (this.preRoll[0]?.length ?? 0) >= maxPreRoll) {
          this.preRollSamples -= this.preRoll.shift()!.length
        }
      }
      return done
    }

    // In speech: accumulate, tracking trailing silence.
    this.frames.push(frame)
    this.bufferedSamples += frame.length
    this.silentSamples = loud ? 0 : this.silentSamples + frame.length

    const silenceLimit = this.msToSamples(this.opts.silenceMs)
    const maxSamples = this.msToSamples(this.opts.maxSegmentMs)
    if (this.silentSamples >= silenceLimit || this.bufferedSamples >= maxSamples) {
      const segment = this.take()
      if (segment) done.push(segment)
    }
    return done
  }

  /** Close out any in-progress utterance (e.g. on stop / mic mute). */
  flush(): Float32Array | null {
    if (!this.inSpeech) return null
    return this.take()
  }

  private take(): Float32Array | null {
    const speechSamples = this.bufferedSamples - this.silentSamples
    const segment =
      speechSamples >= this.msToSamples(this.opts.minSpeechMs)
        ? concat(this.frames, this.bufferedSamples)
        : null
    this.frames = []
    this.bufferedSamples = 0
    this.inSpeech = false
    this.silentSamples = 0
    return segment
  }
}

function concat(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const f of frames) {
    out.set(f, offset)
    offset += f.length
  }
  return out
}
