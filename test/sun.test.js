import { describe, it, expect } from 'vitest'
import SunCalc from 'suncalc'
import { sunDirection } from '../src/sun.js'

const LAT = 59.319274
const LON = 18.034358
const DEG = Math.PI / 180

function atSolarNoon(dateStr) {
  return SunCalc.getTimes(new Date(dateStr), LAT, LON).solarNoon
}

describe('sunDirection', () => {
  it('sommarsolståndet: middagshöjd ≈ 54°', () => {
    const sun = sunDirection(atSolarNoon('2026-06-21T12:00:00'), LAT, LON)
    expect(sun.altitude / DEG).toBeGreaterThan(53)
    expect(sun.altitude / DEG).toBeLessThan(55.5)
  })

  it('vintersolståndet: middagshöjd ≈ 7°', () => {
    const sun = sunDirection(atSolarNoon('2026-12-21T12:00:00'), LAT, LON)
    expect(sun.altitude / DEG).toBeGreaterThan(6)
    expect(sun.altitude / DEG).toBeLessThan(8.5)
  })

  it('vid solnoon pekar vektorn mot söder (+z) och uppåt (+y)', () => {
    const sun = sunDirection(atSolarNoon('2026-06-21T12:00:00'), LAT, LON)
    expect(sun.z).toBeGreaterThan(0.5)
    expect(sun.y).toBeGreaterThan(0.7)
    expect(Math.abs(sun.x)).toBeLessThan(0.1)
  })

  it('morgonsol kommer från öster (+x mot solen)', () => {
    // kl 06 lokal sommartid står solen i öst-nordöst
    const sun = sunDirection(new Date('2026-06-21T06:00:00+02:00'), LAT, LON)
    expect(sun.x).toBeGreaterThan(0.5)
  })

  it('enhetsvektor', () => {
    const sun = sunDirection(new Date('2026-06-21T15:00:00+02:00'), LAT, LON)
    const len = Math.hypot(sun.x, sun.y, sun.z)
    expect(len).toBeCloseTo(1, 6)
  })
})
