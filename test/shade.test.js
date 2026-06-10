import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import SunCalc from 'suncalc'
import { isSunlit, sunWindows } from '../src/shade.js'

const LAT = 59.319274
const LON = 18.034358

// En 10 m hög, bred vägg 5 m söder om punkten (söder = +z).
function southWall() {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(40, 10, 1))
  wall.position.set(0, 5, 5.5)
  wall.updateMatrixWorld()
  return wall
}

const point = new THREE.Vector3(0, 1.2, 0)
const noon = SunCalc.getTimes(new Date('2026-06-21T12:00:00'), LAT, LON).solarNoon

describe('isSunlit', () => {
  it('öppen plats: sol mitt på dagen', () => {
    expect(isSunlit(noon, LAT, LON, point, [])).toBe(true)
  })

  it('hög vägg i söder skuggar vid låg vintersol', () => {
    const winterNoon = SunCalc.getTimes(
      new Date('2026-12-21T12:00:00'), LAT, LON
    ).solarNoon
    // vintersol ~7°: väggen (10 m, 5 m bort) kräver ~60° för att passera
    expect(isSunlit(winterNoon, LAT, LON, point, [southWall()])).toBe(false)
  })

  it('samma vägg skuggar även högsommarsol (54° < 60°)', () => {
    expect(isSunlit(noon, LAT, LON, point, [southWall()])).toBe(false)
  })

  it('låg vägg i söder släpper förbi högsommarsol', () => {
    const lowWall = new THREE.Mesh(new THREE.BoxGeometry(40, 3, 1))
    lowWall.position.set(0, 1.5, 5.5)
    lowWall.updateMatrixWorld()
    // 3 m vägg, krön 1.8 m över ögonhöjd, 5 m bort ⇒ ~20° < 54°
    expect(isSunlit(noon, LAT, LON, point, [lowWall])).toBe(true)
  })

  it('vägg i norr skuggar inte middagssol', () => {
    const northWall = new THREE.Mesh(new THREE.BoxGeometry(40, 10, 1))
    northWall.position.set(0, 5, -5.5)
    northWall.updateMatrixWorld()
    expect(isSunlit(noon, LAT, LON, point, [northWall])).toBe(true)
  })

  it('natt: aldrig sol', () => {
    expect(
      isSunlit(new Date('2026-06-21T01:00:00+02:00'), LAT, LON, point, [])
    ).toBe(false)
  })
})

describe('sunWindows', () => {
  it('öppen plats: ett fönster ≈ soluppgång–solnedgång', () => {
    const d = new Date('2026-06-21T12:00:00')
    const windows = sunWindows(d, LAT, LON, point, [])
    expect(windows.length).toBe(1)
    // SunCalc:s sunrise/sunset gäller övre solranden inkl. refraktion;
    // geometrisk solhöjd > 0 inträffar 10–20 min senare/tidigare vid
    // midsommar på denna breddgrad (flack solbana).
    const times = SunCalc.getTimes(d, LAT, LON)
    expect(Math.abs(windows[0].start - times.sunrise)).toBeLessThan(25 * 60000)
    expect(Math.abs(windows[0].end - times.sunset)).toBeLessThan(25 * 60000)
  })

  it('instängd gård (väggar runt om): inget fönster på vintern', () => {
    const walls = []
    for (const [x, z] of [[0, 8], [0, -8], [8, 0], [-8, 0]]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(17, 20, 1))
      w.position.set(x, 10, z)
      if (x !== 0) w.rotation.y = Math.PI / 2
      w.updateMatrixWorld()
      walls.push(w)
    }
    const windows = sunWindows(new Date('2026-12-21T12:00:00'), LAT, LON, point, walls)
    expect(windows).toEqual([])
  })
})
