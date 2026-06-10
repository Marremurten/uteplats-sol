import { describe, it, expect } from 'vitest'
import {
  wgs84ToSweref, swerefToWgs84, makeLocalFrame, gridConvergence,
} from '../src/coords.js'
import { sunDirection } from '../src/sun.js'
import SunCalc from 'suncalc'

const SITE = { lat: 59.319274089055156, lon: 18.034358285443005 }

describe('SWEREF99 TM', () => {
  it('placerar uteplatsen i rätt Lantmäteriet-ruta', () => {
    // STAC-sökningen för punkten gav 1m-grid-rutan 65775_6725_25
    // (2,5 km-ruta med SV-hörn N 6577500, E 672500).
    const { e, n } = wgs84ToSweref(SITE.lon, SITE.lat)
    expect(e).toBeGreaterThan(672500)
    expect(e).toBeLessThan(675000)
    expect(n).toBeGreaterThan(6577500)
    expect(n).toBeLessThan(6580000)
  })

  it('är inverterbar (rundresa < 1 mm)', () => {
    const { e, n } = wgs84ToSweref(SITE.lon, SITE.lat)
    const { lon, lat } = swerefToWgs84(e, n)
    expect(lon).toBeCloseTo(SITE.lon, 8)
    expect(lat).toBeCloseTo(SITE.lat, 8)
  })

  it('lokala ramen har origo i uteplatsen och meter-skala', () => {
    const frame = makeLocalFrame(SITE.lon, SITE.lat)
    const at = frame.wgs84ToLocal(SITE.lon, SITE.lat)
    expect(at.x).toBeCloseTo(0, 6)
    expect(at.y).toBeCloseTo(0, 6)

    // ~111 m norrut = +0.001 lat. Rutnätet är vridet (meridiankonvergens
    // ~2,6° öster om mittmeridianen) så sann norr får negativ x i rutnätet.
    const north = frame.wgs84ToLocal(SITE.lon, SITE.lat + 0.001)
    expect(north.y).toBeGreaterThan(105)
    expect(north.y).toBeLessThan(118)
    expect(north.x).toBeLessThan(-3)
    expect(north.x).toBeGreaterThan(-8)
  })

  it('meridiankonvergensen i Stockholm ≈ 2,6°', () => {
    const deg = (gridConvergence(SITE.lon, SITE.lat) * 180) / Math.PI
    expect(deg).toBeGreaterThan(2.4)
    expect(deg).toBeLessThan(2.8)
  })

  it('konvergensrotationen vrider solvektorn åt rätt håll, med rätt vinkel', () => {
    const conv = gridConvergence(SITE.lon, SITE.lat)
    const noon = SunCalc.getTimes(
      new Date('2026-06-21T12:00:00'), SITE.lat, SITE.lon
    ).solarNoon
    const a = sunDirection(noon, SITE.lat, SITE.lon, 0)
    const b = sunDirection(noon, SITE.lat, SITE.lon, conv)

    // Horisontalvinkeln ska skilja exakt konvergensen...
    const angA = Math.atan2(a.x, a.z)
    const angB = Math.atan2(b.x, b.z)
    expect(angB - angA).toBeCloseTo(conv, 8)
    // ...åt rätt håll: sant söder har positiv x i rutnätet (spegelbilden
    // av att sann norr har negativ x), så middagssolen vrids mot +x.
    expect(b.x).toBeGreaterThan(a.x)
    // Höjden påverkas inte.
    expect(b.y).toBeCloseTo(a.y, 10)
  })
})
