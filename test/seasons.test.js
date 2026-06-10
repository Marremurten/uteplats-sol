import { describe, it, expect } from 'vitest'
import { seasonParams } from '../src/seasons.js'

describe('seasonParams', () => {
  it('midsommar (dag 172): full grönska, ingen snö', () => {
    const p = seasonParams(172)
    expect(p.foliage).toBe(1)
    expect(p.snowCover).toBe(0)
    expect(p.autumnBlend).toBe(0)
    expect(p.snowfallIntensity).toBe(0)
    expect(p.leafFallIntensity).toBe(0)
    expect(p.icon).toBe('☀️')
  })

  it('15 januari: full vinter', () => {
    const p = seasonParams(15)
    expect(p.snowCover).toBe(1)
    expect(p.ice).toBe(1)
    expect(p.foliage).toBe(0)
    expect(p.snowfallIntensity).toBeGreaterThan(0.5)
    expect(p.icon).toBe('❄️')
  })

  it('5 oktober (dag 278): höstfärger och lövfall', () => {
    const p = seasonParams(278)
    expect(p.autumnBlend).toBeGreaterThan(0.7)
    expect(p.leafFallIntensity).toBeGreaterThan(0.3)
    expect(p.snowCover).toBe(0)
    expect(p.icon).toBe('🍂')
  })

  it('5 maj (dag 125): blomning och lövsprickning på gång', () => {
    const p = seasonParams(125)
    expect(p.blossom).toBeGreaterThan(0.5)
    expect(p.foliage).toBeGreaterThan(0.1)
    expect(p.foliage).toBeLessThan(1)
    expect(p.icon).toBe('🌸')
  })

  it('15 mars (dag 74): varken sommargrönt eller barmark', () => {
    const p = seasonParams(74)
    expect(p.foliage).toBe(0)
    expect(p.snowCover).toBeGreaterThan(0)
    expect(p.snowCover).toBeLessThan(1)
    expect(p.frost).toBeGreaterThan(0.3)
    expect(p.ice).toBe(1)
  })

  it('alla kanaler är kontinuerliga över hela året inkl. årsskiftet', () => {
    let prev = seasonParams(365)
    for (let d = 1; d <= 365; d++) {
      const p = seasonParams(d)
      for (const k of Object.keys(p)) {
        if (typeof p[k] !== 'number') continue
        expect(
          Math.abs(p[k] - prev[k]),
          `${k} hoppar vid dag ${d}`
        ).toBeLessThanOrEqual(0.12)
      }
      prev = p
    }
  })

  it('ikonsekvensen över året är ❄️→🌸→☀️→🍂→❄️ utan flimmer', () => {
    const seq = []
    for (let d = 1; d <= 365; d++) {
      const icon = seasonParams(d).icon
      if (seq[seq.length - 1] !== icon) seq.push(icon)
    }
    expect(seq).toEqual(['❄️', '🌸', '☀️', '🍂', '❄️'])
  })
})
