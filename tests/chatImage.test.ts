// sanitizeChatImage guards the data channel against malicious image payloads —
// a peer can send arbitrary JSON, so every branch here is a security check.

import { describe, expect, it } from 'vitest'

import { sanitizeChatImage } from '@/lib/chat/image'

const MAX_DATA_URL_BYTES = 56 * 1024

const validImage = () => ({
  src: `data:image/jpeg;base64,${'A'.repeat(100)}`,
  width: 640,
  height: 480,
})

describe('sanitizeChatImage', () => {
  it('accepts a well-formed image payload', () => {
    const out = sanitizeChatImage(validImage())
    expect(out).toEqual(validImage())
  })

  it('rejects non-objects', () => {
    expect(sanitizeChatImage(undefined)).toBeUndefined()
    expect(sanitizeChatImage(null)).toBeUndefined()
    expect(sanitizeChatImage('data:image/png;base64,AAAA')).toBeUndefined()
    expect(sanitizeChatImage(42)).toBeUndefined()
  })

  it('rejects a missing or non-string src', () => {
    expect(sanitizeChatImage({ width: 10, height: 10 })).toBeUndefined()
    expect(
      sanitizeChatImage({ src: 123, width: 10, height: 10 }),
    ).toBeUndefined()
  })

  it('rejects src that is not a data:image/ URL', () => {
    for (const src of [
      'https://evil.example/x.png',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'DATA:IMAGE/PNG;base64,AAAA', // scheme is case-sensitive here on purpose
    ]) {
      expect(sanitizeChatImage({ src, width: 10, height: 10 })).toBeUndefined()
    }
  })

  it('rejects an oversized data URL (memory bloat guard)', () => {
    const huge = {
      src: `data:image/jpeg;base64,${'A'.repeat(MAX_DATA_URL_BYTES * 2)}`,
      width: 100,
      height: 100,
    }
    expect(sanitizeChatImage(huge)).toBeUndefined()
  })

  it('allows headroom just under the hard cap', () => {
    const nearCap = {
      src: `data:image/jpeg;base64,${'A'.repeat(MAX_DATA_URL_BYTES * 2 - 100)}`,
      width: 100,
      height: 100,
    }
    expect(sanitizeChatImage(nearCap)).toBeDefined()
  })

  it('rejects non-finite dimensions', () => {
    const base = validImage()
    expect(sanitizeChatImage({ ...base, width: NaN })).toBeUndefined()
    expect(sanitizeChatImage({ ...base, height: Infinity })).toBeUndefined()
    expect(sanitizeChatImage({ ...base, width: 'wide' })).toBeUndefined()
  })

  it('clamps and rounds dimensions to sane bounds', () => {
    const base = validImage()
    expect(sanitizeChatImage({ ...base, width: 0 })?.width).toBe(1)
    expect(sanitizeChatImage({ ...base, width: -50 })?.width).toBe(1)
    expect(sanitizeChatImage({ ...base, height: 99999 })?.height).toBe(8192)
    expect(sanitizeChatImage({ ...base, width: 100.6 })?.width).toBe(101)
  })
})
