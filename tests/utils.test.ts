import { describe, it, expect } from 'vitest'
import { getUtcTimestamp, getUniqueId } from '../src/utils/common'

describe('getUtcTimestamp', () => {
  it('returns a float (seconds since epoch)', () => {
    const t = getUtcTimestamp()
    expect(typeof t).toBe('number')
    expect(t % 1).not.toBe(0)  // has fractional part
  })

  it('is close to Date.now() / 1000', () => {
    const t = getUtcTimestamp()
    const now = Date.now() / 1000
    expect(Math.abs(t - now)).toBeLessThan(1)
  })

  it('is after 2024-01-01 (sanity check)', () => {
    expect(getUtcTimestamp()).toBeGreaterThan(1_700_000_000)
  })

  it('increases monotonically between calls', async () => {
    const t1 = getUtcTimestamp()
    await new Promise(r => setTimeout(r, 5))
    const t2 = getUtcTimestamp()
    expect(t2).toBeGreaterThan(t1)
  })
})

describe('getUniqueId', () => {
  it('returns a non-empty string', () => {
    const id = getUniqueId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('returns uppercase ULID format (26 chars, Crockford base32)', () => {
    const id = getUniqueId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => getUniqueId()))
    expect(ids.size).toBe(100)
  })
})
