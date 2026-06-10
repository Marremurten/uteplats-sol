import * as THREE from 'three'
import { loadData } from './data.js'
import { createScene } from './scene.js'
import { setupUI } from './ui.js'
import { sunDirection } from './sun.js'
import { gridConvergence } from './coords.js'
import { isSunlit, sunWindows } from './shade.js'
import { seasonParams } from './seasons.js'

async function init() {
  const data = await loadData()
  const { lat, lon } = data.site
  // Scenens axlar är SWEREF99-rutnätets — korrigera solens azimut för
  // meridiankonvergensen (~2,6° i Stockholm).
  const gridRot = gridConvergence(lon, lat)

  const canvas = document.getElementById('scene')
  const { requestRender, setSun, setSeason, samplePoint, occluders } =
    createScene(canvas, data)

  document.getElementById('attribution').textContent =
    data.attributions.join(' · ') +
    (data.terrain.mode === 'flat'
      ? ` · Platt mark (gårdsdjup ${data.terrain.courtyardDepth} m) — kör pipelinen med Geotorget-konto för riktig terräng`
      : '')

  let lastDoy = null
  setupUI({
    lat,
    lon,
    onChange(date, doy) {
      // Säsongen beror bara på dagen — tidsreglaget ska inte trigga
      // omräkning av träd/mark.
      if (doy !== lastDoy) {
        lastDoy = doy
        setSeason(seasonParams(doy))
      }
      const sun = sunDirection(date, lat, lon, gridRot)
      setSun(sun)
      requestRender()
      if (sun.altitude <= 0) return null
      return isSunlit(date, lat, lon, samplePoint, occluders, gridRot)
    },
    getWindows(date) {
      return sunWindows(date, lat, lon, samplePoint, occluders, 5, gridRot)
    },
  })

  requestRender()

  // Debug-lucka för tester/felsökning: vad blockerar solen vid tidpunkt t?
  window.__app = {
    sunAt: (iso) => sunDirection(new Date(iso), lat, lon, gridRot),
    isSunlitAt: (iso) =>
      isSunlit(new Date(iso), lat, lon, samplePoint, occluders, gridRot),
    windowsAt: (iso) =>
      sunWindows(new Date(iso), lat, lon, samplePoint, occluders, 5, gridRot)
        .map((w) => `${w.start.toTimeString().slice(0, 5)}–${w.end.toTimeString().slice(0, 5)}`),
    blockerAt: (iso) => {
      const sun = sunDirection(new Date(iso), lat, lon, gridRot)
      if (sun.altitude <= 0) return { sun, hit: 'under horisonten' }
      const rc = new THREE.Raycaster(
        samplePoint.clone(),
        new THREE.Vector3(sun.x, sun.y, sun.z).normalize()
      )
      rc.firstHitOnly = true
      const hits = rc.intersectObjects(occluders, true)
      return {
        sunAltDeg: (sun.altitude * 180) / Math.PI,
        hit: hits[0]
          ? {
              id: hits[0].object.userData.id ?? 'terräng',
              distance: Math.round(hits[0].distance),
              point: hits[0].point.toArray().map((v) => Math.round(v)),
            }
          : null,
      }
    },
  }
}

init().catch((err) => {
  document.getElementById('status').textContent = `Fel: ${err.message}`
  console.error(err)
})
