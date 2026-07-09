import { describe, expect, it } from 'vitest'

import {
  generateSlug,
  getRoomUrl,
  initialsFromName,
  MAX_DISPLAY_NAME_LENGTH,
  sanitizeDisplayName,
} from '@/lib/utils'

describe('generateSlug', () => {
  it('produces 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSlug()).toMatch(/^[23456789abcdefghijkmnpqrstuvwxyz]{8}$/)
    }
  })

  it('does not repeat across a small sample', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSlug()))
    expect(seen.size).toBe(200)
  })
})

describe('sanitizeDisplayName', () => {
  it('returns null for empty-ish input', () => {
    expect(sanitizeDisplayName(null)).toBeNull()
    expect(sanitizeDisplayName(undefined)).toBeNull()
    expect(sanitizeDisplayName('')).toBeNull()
    expect(sanitizeDisplayName('   ')).toBeNull()
  })

  it('trims whitespace', () => {
    expect(sanitizeDisplayName('  Ada  ')).toBe('Ada')
  })

  it('clamps to the max length', () => {
    const long = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 25)
    expect(sanitizeDisplayName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH)
  })
})

describe('initialsFromName', () => {
  it('uses first + last word initials', () => {
    expect(initialsFromName('Ada Lovelace')).toBe('AL')
    expect(initialsFromName('Ada Byron Lovelace')).toBe('AL')
  })

  it('uses the first two letters of a single word', () => {
    expect(initialsFromName('plato')).toBe('PL')
  })

  it('falls back to ? for blank names', () => {
    expect(initialsFromName('   ')).toBe('?')
  })
})

describe('getRoomUrl', () => {
  it('joins the app URL and slug without double slashes', () => {
    expect(getRoomUrl('abc23456')).toMatch(/^https?:\/\/.+\/room\/abc23456$/)
    expect(getRoomUrl('abc23456')).not.toContain('//room')
  })
})
