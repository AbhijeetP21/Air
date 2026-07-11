import { rtcError, rtcLog } from '@/lib/webrtc/log'

// MediaPipe Selfie Segmentation runs entirely in-browser. The model + WASM are
// self-hosted from /public/mediapipe; the camera is blurred on-device before
// the processed track is published to the SFU.
const ASSET_PATH = '/mediapipe'
const BLUR_PX = 12
const FPS = 30
const FRAME_INTERVAL_MS = 1000 / FPS

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySegmentation = any

// The MediaPipe bundle is a Closure-compiled script that assigns its
// `SelfieSegmentation` constructor onto the global object rather than ES-
// exporting it. So we load the self-hosted script once and read it off window.
let scriptPromise: Promise<unknown> | null = null

function loadSelfieSegmentation(): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  if (w.SelfieSegmentation) return Promise.resolve(w.SelfieSegmentation)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${ASSET_PATH}/selfie_segmentation.js`
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      if (w.SelfieSegmentation) resolve(w.SelfieSegmentation)
      else reject(new Error('SelfieSegmentation global not found after load'))
    }
    script.onerror = () => reject(new Error('Failed to load selfie_segmentation.js'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

/**
 * Replaces a camera video track with one whose background is blurred, using
 * person segmentation. A hidden <video> feeds frames to the segmenter; each
 * result is composited (sharp person over a blurred copy of the frame) onto a
 * canvas, and the canvas stream becomes the outbound video track.
 */
export class BackgroundProcessor {
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private segmentation: AnySegmentation = null
  private output: MediaStream | null = null
  private sourceTrack: MediaStreamTrack | null = null
  private raf = 0
  private vfc = 0
  private running = false

  async start(input: MediaStream): Promise<MediaStreamTrack> {
    const track = input.getVideoTracks()[0]
    if (!track) throw new Error('No video track to process')
    this.sourceTrack = track

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SelfieSegmentation = (await loadSelfieSegmentation()) as any

    const video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([track])
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve()
    })
    await video.play().catch(() => {})

    const width = video.videoWidth || 640
    const height = video.videoHeight || 480
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')

    // Blur cost scales with pixel area, and it's the most expensive part of
    // every frame. Blur a quarter-resolution copy (half the radius ≈ the same
    // visual softness) and scale it back up — ~4x cheaper for the same look.
    const bgCanvas = document.createElement('canvas')
    bgCanvas.width = Math.max(1, Math.round(width / 2))
    bgCanvas.height = Math.max(1, Math.round(height / 2))
    const bgCtx = bgCanvas.getContext('2d')
    if (!bgCtx) throw new Error('Canvas 2D context unavailable')
    bgCtx.filter = `blur(${BLUR_PX / 2}px)`

    const segmentation = new SelfieSegmentation({
      locateFile: (file: string) => `${ASSET_PATH}/${file}`,
    })
    segmentation.setOptions({ modelSelection: 1, selfieMode: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    segmentation.onResults((results: any) => {
      bgCtx.drawImage(results.image, 0, 0, bgCanvas.width, bgCanvas.height)
      ctx.save()
      ctx.clearRect(0, 0, width, height)
      // Mask → keep the person, then paint the blurred frame behind them.
      ctx.drawImage(results.segmentationMask, 0, 0, width, height)
      ctx.globalCompositeOperation = 'source-in'
      ctx.drawImage(results.image, 0, 0, width, height)
      ctx.globalCompositeOperation = 'destination-over'
      ctx.drawImage(bgCanvas, 0, 0, width, height)
      ctx.restore()
    })

    this.video = video
    this.canvas = canvas
    this.segmentation = segmentation
    this.running = true

    // Pace segmentation to the *camera's* frames, not the display refresh:
    // requestVideoFrameCallback fires exactly once per delivered camera frame,
    // which removes the rAF-beat jitter that made the output stutter. rAF is
    // the fallback for browsers without rVFC, gated to ~FPS with a small
    // epsilon so timer jitter can't skip alternate frames (33.2ms < 33.33ms
    // would otherwise halve the frame rate).
    let lastSent = 0
    const scheduleNext = () => {
      if (!this.running || !this.video) return
      if ('requestVideoFrameCallback' in this.video) {
        this.vfc = this.video.requestVideoFrameCallback(() => void pump())
      } else {
        this.raf = requestAnimationFrame(() => void pump())
      }
    }
    const pump = async () => {
      if (!this.running || !this.video) return
      const now = performance.now()
      // Skip the (expensive) segmentation while the camera is disabled — a
      // paused/backgrounded camera only delivers black frames, and its LiveKit
      // publication is muted so remotes already see the avatar. Segmenting them
      // would burn CPU/GPU for no visible output. Keep scheduling cheaply so we
      // resume the instant the camera comes back.
      if (
        this.sourceTrack?.enabled !== false &&
        now - lastSent >= FRAME_INTERVAL_MS - 2
      ) {
        lastSent = now
        try {
          await segmentation.send({ image: this.video })
        } catch {
          // transient frame error — keep going
        }
      }
      scheduleNext()
    }
    void pump()

    this.output = canvas.captureStream(FPS)
    const out = this.output.getVideoTracks()[0]
    if (!out) throw new Error('Background blur produced no track')
    rtcLog('Media', 'background blur active')
    return out
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.vfc && this.video && 'cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.vfc)
    }
    this.output?.getTracks().forEach((t) => t.stop())
    try {
      this.segmentation?.close?.()
    } catch {
      // ignore
    }
    if (this.video) this.video.srcObject = null
    this.video = null
    this.canvas = null
    this.segmentation = null
    this.output = null
    this.sourceTrack = null
  }
}

/**
 * Try to build a blurred-background track from `input`. Returns the track +
 * processor, or null if the model fails to load (caller keeps the raw camera).
 */
export async function tryCreateBlur(
  input: MediaStream,
): Promise<{ track: MediaStreamTrack; processor: BackgroundProcessor } | null> {
  if (input.getVideoTracks().length === 0) return null
  try {
    const processor = new BackgroundProcessor()
    const track = await processor.start(input)
    return { track, processor }
  } catch (err) {
    rtcError('Media', 'background blur unavailable; using raw camera', err)
    return null
  }
}
