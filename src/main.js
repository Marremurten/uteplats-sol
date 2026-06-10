import { loadData } from './data.js'
import { createScene } from './scene.js'
import { setupUI } from './ui.js'
import { sunDirection } from './sun.js'
import { gridConvergence } from './coords.js'
import { isSunlit, sunWindows } from './shade.js'

async function init() {
  const data = await loadData()
  const { lat, lon } = data.site
  // Scenens axlar är SWEREF99-rutnätets — korrigera solens azimut för
  // meridiankonvergensen (~2,6° i Stockholm).
  const gridRot = gridConvergence(lon, lat)

  const canvas = document.getElementById('scene')
  const { render, setSun, samplePoint, occluders } = createScene(canvas, data)

  document.getElementById('attribution').textContent =
    data.attributions.join(' · ') +
    (data.terrain.mode === 'flat'
      ? ` · Platt mark (gårdsdjup ${data.terrain.courtyardDepth} m) — kör pipelinen med Geotorget-konto för riktig terräng`
      : '')

  setupUI({
    lat,
    lon,
    onChange(date) {
      const sun = sunDirection(date, lat, lon, gridRot)
      setSun(sun)
      if (sun.altitude <= 0) return null
      return isSunlit(date, lat, lon, samplePoint, occluders, gridRot)
    },
    getWindows(date) {
      return sunWindows(date, lat, lon, samplePoint, occluders, 5, gridRot)
    },
  })

  renderLoop()
  function renderLoop() {
    render()
    requestAnimationFrame(renderLoop)
  }
}

init().catch((err) => {
  document.getElementById('status').textContent = `Fel: ${err.message}`
  console.error(err)
})
