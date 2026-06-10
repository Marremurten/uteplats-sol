import { describe, it, expect } from 'vitest'
import { detectChimneys } from '../src/chimneys.js'

// Bygger raw/smoothed-kartor (Map<"e,n", höjd>) över ett platt tak på 20 m,
// med valfria spikar i raw.
function flatRoof(w, h, level = 20) {
  const raw = new Map()
  const smoothed = new Map()
  for (let n = 0; n < h; n++) {
    for (let e = 0; e < w; e++) {
      raw.set(`${e},${n}`, level)
      smoothed.set(`${e},${n}`, level)
    }
  }
  return { raw, smoothed }
}

describe('detectChimneys', () => {
  it('hittar en spik som sticker upp över den utjämnade ytan', () => {
    const { raw, smoothed } = flatRoof(10, 10)
    raw.set('4,5', 21.8) // 1,8 m skorsten
    const found = detectChimneys(raw, smoothed)
    expect(found).toHaveLength(1)
    expect(found[0].e).toBe(4)
    expect(found[0].n).toBe(5)
    expect(found[0].base).toBe(20)
    expect(found[0].top).toBeCloseTo(21.8)
  })

  it('hittar inget på en jämn takyta', () => {
    const { raw, smoothed } = flatRoof(10, 10)
    expect(detectChimneys(raw, smoothed)).toHaveLength(0)
  })

  it('ignorerar spikar under tröskeln (~1 m)', () => {
    const { raw, smoothed } = flatRoof(10, 10)
    raw.set('3,3', 20.6) // bara 0,6 m — ventilation, inte skorsten
    expect(detectChimneys(raw, smoothed)).toHaveLength(0)
  })

  it('klustrar ihopliggande spikceller till en skorsten', () => {
    const { raw, smoothed } = flatRoof(10, 10)
    raw.set('4,5', 21.5)
    raw.set('5,5', 21.7) // grannar — samma murstock
    const found = detectChimneys(raw, smoothed)
    expect(found).toHaveLength(1)
    expect(found[0].top).toBeCloseTo(21.7) // klustrets max
  })

  it('separata spikar blir separata skorstenar', () => {
    const { raw, smoothed } = flatRoof(12, 12)
    raw.set('2,2', 21.5)
    raw.set('9,9', 21.6)
    expect(detectChimneys(raw, smoothed)).toHaveLength(2)
  })

  it('kapar höga antennspikar till skorstenshöjd', () => {
    const { raw, smoothed } = flatRoof(10, 10)
    raw.set('5,5', 28) // 8 m — antenn/mast, inte murstock
    const found = detectChimneys(raw, smoothed)
    expect(found).toHaveLength(1)
    expect(found[0].top - found[0].base).toBeLessThanOrEqual(2.5)
  })
})
