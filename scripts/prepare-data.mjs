#!/usr/bin/env node
/**
 * Datapipeline: hämtar geodata för området runt uteplatsen och skriver
 * webbappens datafiler till public/data/.
 *
 *   node scripts/prepare-data.mjs
 *
 * Byggnader: OpenStreetMap via Overpass (fotavtryck + höjd/våningar).
 * Terräng:   Lantmäteriets markhöjdmodell (1 m-grid GeoTIFF) via STAC om
 *            inloggning finns (env GEOTORGET_USER/GEOTORGET_PASS — gratis
 *            konto på geotorget.lantmateriet.se, beställ behörighet för
 *            "Markhöjdmodell Nedladdning"). Annars platt mark med
 *            konfigurerbart gårdsdjup (site.config.json: courtyardDepth).
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeLocalFrame } from '../src/coords.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'data')
mkdirSync(outDir, { recursive: true })

const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'))
const frame = makeLocalFrame(cfg.lon, cfg.lat)
const half = cfg.areaSize / 2
const margin = 40 // ta med byggnader strax utanför rutan

// WGS84-bbox som täcker området + marginal
const dLat = (half + margin) / 111320
const dLon = (half + margin) / (111320 * Math.cos((cfg.lat * Math.PI) / 180))
const bbox = [cfg.lat - dLat, cfg.lon - dLon, cfg.lat + dLat, cfg.lon + dLon]

const OVERPASS_SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

async function fetchOverpass(query) {
  let lastErr
  for (const server of OVERPASS_SERVERS) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        headers: { 'User-Agent': 'uteplats-sol/1.0' },
        body: new URLSearchParams({ data: query }),
      })
      if (!res.ok) throw new Error(`${server}: HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      console.warn(`Overpass misslyckades (${err.message}), provar nästa...`)
    }
  }
  throw new Error(`Alla Overpass-servrar misslyckades: ${lastErr.message}`)
}

function parseHeight(tags) {
  const h = parseFloat(tags.height)
  if (Number.isFinite(h) && h > 0) return { height: h, source: 'height' }
  const levels = parseFloat(tags['building:levels'])
  if (Number.isFinite(levels) && levels > 0) {
    return {
      height: levels * cfg.metersPerLevel + cfg.roofExtra,
      source: 'levels',
    }
  }
  return { height: cfg.defaultBuildingHeight, source: 'default' }
}

function ringToLocal(geometry) {
  return geometry.map((p) => {
    const { x, y } = frame.wgs84ToLocal(p.lon, p.lat)
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100]
  })
}

function ringInArea(ring) {
  return ring.some(
    ([e, n]) => Math.abs(e) <= half + margin && Math.abs(n) <= half + margin
  )
}

async function buildBuildings() {
  const [s, w, n, e] = bbox
  const query = `[out:json][timeout:90];
(
  way["building"](${s},${w},${n},${e});
  relation["building"](${s},${w},${n},${e});
);
out tags geom;`
  console.log('Hämtar byggnader från OpenStreetMap...')
  const data = await fetchOverpass(query)

  const buildings = []
  const stats = { height: 0, levels: 0, default: 0, skipped: 0 }

  for (const el of data.elements) {
    const tags = el.tags ?? {}
    const { height, source } = parseHeight(tags)
    const rings = []

    if (el.type === 'way' && el.geometry?.length >= 4) {
      rings.push(ringToLocal(el.geometry))
    } else if (el.type === 'relation') {
      for (const m of el.members ?? []) {
        if (m.role === 'outer' && m.geometry?.length >= 4) {
          const ring = ringToLocal(m.geometry)
          const [x0, y0] = ring[0]
          const [x1, y1] = ring[ring.length - 1]
          if (Math.hypot(x1 - x0, y1 - y0) < 0.5) rings.push(ring)
          else stats.skipped++
        }
      }
    }

    for (const ring of rings) {
      if (!ringInArea(ring)) continue
      buildings.push({
        id: `${el.type}/${el.id}`,
        height: Math.round(height * 10) / 10,
        source,
        levels: tags['building:levels'] ?? null,
        footprint: ring,
      })
      stats[source]++
    }
  }

  writeFileSync(
    join(outDir, 'buildings.json'),
    JSON.stringify(
      {
        attribution: '© OpenStreetMap contributors (ODbL)',
        origin: { lat: cfg.lat, lon: cfg.lon, ...frame.origin },
        areaSize: cfg.areaSize,
        buildings,
      },
      null,
      1
    )
  )
  console.log(
    `${buildings.length} byggnader (exakt höjd: ${stats.height}, ` +
      `från våningar: ${stats.levels}, schablon: ${stats.default}` +
      (stats.skipped ? `, ej slutna ringar hoppade: ${stats.skipped}` : '') +
      ')'
  )
}

function readEnvLocal() {
  try {
    const lines = readFileSync(join(root, '.env.local'), 'utf8').split('\n')
    const env = {}
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
      if (m) env[m[1]] = m[2]
    }
    return env
  } catch {
    return {}
  }
}

async function buildTerrain() {
  const envLocal = readEnvLocal()
  const user = process.env.GEOTORGET_USER ?? envLocal.GEOTORGET_USER
  const pass = process.env.GEOTORGET_PASS ?? envLocal.GEOTORGET_PASS
  if (!user || !pass) {
    console.log(
      'Ingen Geotorget-inloggning (GEOTORGET_USER/GEOTORGET_PASS) — ' +
        `platt mark med gårdsdjup ${cfg.courtyardDepth} m används. ` +
        'Skapa gratis konto på geotorget.lantmateriet.se för riktig terräng.'
    )
    writeFileSync(
      join(outDir, 'terrain.json'),
      JSON.stringify({
        mode: 'flat',
        courtyardDepth: cfg.courtyardDepth,
        areaSize: cfg.areaSize,
      })
    )
    return
  }

  console.log('Hämtar markhöjdmodell från Lantmäteriet (STAC)...')
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

  // Hitta 1m-grid-items som täcker området
  const cornersWgs = [
    [-half, -half], [half, -half], [half, half], [-half, half], [-half, -half],
  ].map(([de, dn]) => {
    // grov inverstransform räcker för sök-polygonen
    const lat = cfg.lat + dn / 111320
    const lon = cfg.lon + de / (111320 * Math.cos((cfg.lat * Math.PI) / 180))
    return [lon, lat]
  })
  const search = await fetch('https://api.lantmateriet.se/stac-hojd/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['mhm-65_6', 'mhm-65_7', 'mhm-66_6'],
      intersects: { type: 'Polygon', coordinates: [cornersWgs] },
      limit: 20,
    }),
  })
  if (!search.ok) throw new Error(`STAC-sökning: HTTP ${search.status}`)
  const items = (await search.json()).features.filter((f) =>
    f.collection.startsWith('mhm-')
  )
  if (!items.length) throw new Error('Inga DTM-rutor täcker området.')
  console.log(`${items.length} DTM-ruta/rutor: ${items.map((i) => i.id).join(', ')}`)

  const { fromArrayBuffer } = await import('geotiff')
  const size = cfg.areaSize + 1 // 1 m-grid, inkl. båda kanterna
  const grid = new Float32Array(size * size).fill(NaN)

  for (const item of items) {
    const res = await fetch(item.assets.data.href, {
      headers: { Authorization: auth },
    })
    if (!res.ok) throw new Error(`Nedladdning ${item.id}: HTTP ${res.status}`)
    const tiff = await fromArrayBuffer(await res.arrayBuffer())
    const image = await tiff.getImage()
    const [originE, originN] = [image.getOrigin()[0], image.getOrigin()[1]]
    const [resE, resN] = image.getResolution() // resN är negativ (norr→söder)
    const raster = (await image.readRasters())[0]
    const w = image.getWidth()
    const h = image.getHeight()

    for (let row = 0; row < size; row++) {
      const n = frame.origin.n + half - row // norr → söder
      for (let col = 0; col < size; col++) {
        const e = frame.origin.e - half + col
        const px = Math.floor((e - originE) / resE)
        const py = Math.floor((n - originN) / resN)
        if (px >= 0 && px < w && py >= 0 && py < h) {
          const v = raster[py * w + px]
          if (v > -1000) grid[row * size + col] = v
        }
      }
    }
  }

  const missing = grid.reduce((acc, v) => acc + (Number.isNaN(v) ? 1 : 0), 0)
  if (missing > 0)
    console.warn(`Varning: ${missing} celler utan höjddata (sätts till medel).`)
  let sum = 0
  let count = 0
  for (const v of grid) if (!Number.isNaN(v)) { sum += v; count++ }
  const mean = sum / count
  for (let i = 0; i < grid.length; i++) if (Number.isNaN(grid[i])) grid[i] = mean

  const centerIdx = Math.round(half) * size + Math.round(half)
  writeFileSync(join(outDir, 'terrain.bin'), Buffer.from(grid.buffer))
  writeFileSync(
    join(outDir, 'terrain.json'),
    JSON.stringify({
      mode: 'dtm',
      attribution: 'Markhöjdmodell © Lantmäteriet (CC BY 4.0)',
      areaSize: cfg.areaSize,
      gridSize: size,
      originElevation: grid[centerIdx],
      file: 'terrain.bin',
    })
  )
  console.log(
    `Terräng klar (${size}×${size} @ 1 m, uteplatsens marknivå ${grid[centerIdx].toFixed(1)} möh).`
  )
}

// Vägbredd (meter) per OSM-vägklass — för visualiseringen.
const ROAD_WIDTHS = {
  motorway: 10, trunk: 10, primary: 9, secondary: 7, tertiary: 6,
  residential: 5, unclassified: 5, service: 4, living_street: 4,
  pedestrian: 4, footway: 2, path: 2, cycleway: 2.5, steps: 2,
}

async function buildRoads() {
  const [s, w, n, e] = bbox
  const types = Object.keys(ROAD_WIDTHS).join('|')
  const query = `[out:json][timeout:90];
way["highway"~"^(${types})$"](${s},${w},${n},${e});
out tags geom;`
  console.log('Hämtar vägar från OpenStreetMap...')
  const data = await fetchOverpass(query)

  const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])
  const roads = []
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const path = ringToLocal(el.geometry)
    if (!ringInArea(path)) continue
    const kind = el.tags?.highway
    let width = ROAD_WIDTHS[kind] ?? 4
    // Stora gator ligger ofta som två enkelriktade filer med glapp emellan —
    // bredda filerna så de smälter ihop visuellt (exakthet oviktig här).
    if (MAJOR.has(kind) && el.tags?.oneway === 'yes') width *= 1.9
    roads.push({ id: `way/${el.id}`, width, kind, path })
  }
  writeFileSync(
    join(outDir, 'roads.json'),
    JSON.stringify({
      attribution: '© OpenStreetMap contributors (ODbL)',
      roads,
    })
  )
  console.log(`${roads.length} vägsegment.`)
}

/**
 * DSM från Lantmäteriets laserpunktmoln (COPC). Range-läser bara de delar
 * av filen som täcker området, rastrerar högsta retur per 1 m-cell och
 * klassar varje cell (mark/vatten/byggnad/vegetation) med OSM-fotavtrycken
 * som byggnadsmask. Kräver att --terrain och --buildings körts först.
 */
async function buildDsm() {
  const envLocal = readEnvLocal()
  const user = process.env.GEOTORGET_USER ?? envLocal.GEOTORGET_USER
  const pass = process.env.GEOTORGET_PASS ?? envLocal.GEOTORGET_PASS
  if (!user || !pass)
    throw new Error('DSM kräver Geotorget-inloggning (.env.local).')
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')

  // DTM som golv/hålfyllnad + byggnadsmask från OSM
  // Läs alltid DTM-filen direkt (terrain.json kan redan peka på dsm.bin
  // efter en tidigare --dsm-körning).
  if (!existsSync(join(outDir, 'terrain.bin')))
    throw new Error('Kör --terrain (DTM) före --dsm.')
  const dtm = new Float32Array(
    readFileSync(join(outDir, 'terrain.bin')).buffer
  )
  const footprints = JSON.parse(
    readFileSync(join(outDir, 'buildings.json'), 'utf8')
  ).buildings.map((b) => b.footprint)

  const size = cfg.areaSize + 1
  const dsm = new Float32Array(size * size).fill(NaN)
  const topClass = new Uint8Array(size * size) // LAS-klass för högsta retur

  console.log('Söker COPC-punktmoln i STAC...')
  const cornersWgs = [
    [-half, -half], [half, -half], [half, half], [-half, half], [-half, -half],
  ].map(([de, dn]) => [
    cfg.lon + de / (111320 * Math.cos((cfg.lat * Math.PI) / 180)),
    cfg.lat + dn / 111320,
  ])
  const search = await fetch('https://api.lantmateriet.se/stac-hojd/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['dsm-skoglig-copc'],
      intersects: { type: 'Polygon', coordinates: [cornersWgs] },
      limit: 10,
    }),
  })
  if (!search.ok) throw new Error(`STAC-sökning: HTTP ${search.status}`)
  const items = (await search.json()).features
  if (!items.length) throw new Error('Inget COPC-punktmoln täcker området.')
  console.log(`${items.length} COPC-fil(er): ${items.map((i) => i.id).join(', ')}`)

  const { Copc } = await import('copc')
  const minE = frame.origin.e - half
  const maxE = frame.origin.e + half
  const minN = frame.origin.n - half
  const maxN = frame.origin.n + half

  for (const item of items) {
    const url = item.assets.data.href
    // Servern rate-limitar range-anrop (sporadiska 403). Ladda i stället ner
    // hela kakelfilen en gång till en lokal cache och läs den därifrån.
    const cacheDir = join(root, '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const cachePath = join(cacheDir, `${item.id}.copc.laz`)
    if (!existsSync(cachePath)) {
      console.log(`Laddar ner ${item.id} (hel fil, cachas i .cache/)...`)
      let res
      for (let attempt = 1; ; attempt++) {
        res = await fetch(url, { headers: { Authorization: auth } })
        if (res.ok) break
        if (attempt >= 6)
          throw new Error(`Nedladdning ${item.id}: HTTP ${res.status}`)
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
      writeFileSync(cachePath, Buffer.from(await res.arrayBuffer()))
      console.log(
        `Klar: ${(statSync(cachePath).size / 1e6).toFixed(0)} MB.`
      )
    } else {
      console.log(`Använder cachad ${item.id} (.cache/).`)
    }

    const copc = await Copc.create(cachePath)
    let pointsUsed = 0

    // Läs ALLA noder och filtrera per punkt — nyckel-voxlarnas geometri
    // visade sig opålitlig att resonera om, och filen är ändå lokal.
    async function walk(pageRef) {
      const { nodes, pages } = await Copc.loadHierarchyPage(cachePath, pageRef)
      const entries = Object.entries(nodes)
      let done = 0
      for (const [, node] of entries) {
        if (!node || !node.pointCount) continue
        const view = await Copc.loadPointDataView(cachePath, copc, node)
        const getX = view.getter('X')
        const getY = view.getter('Y')
        const getZ = view.getter('Z')
        const getC = view.getter('Classification')
        for (let i = 0; i < view.pointCount; i++) {
          const e = getX(i)
          const n = getY(i)
          if (e < minE || e > maxE || n < minN || n > maxN) continue
          const cls = getC(i)
          if (cls === 7 || cls === 18) continue // brus
          const col = Math.round(e - minE)
          const row = Math.round(maxN - n)
          const idx = row * size + col
          const z = getZ(i)
          if (Number.isNaN(dsm[idx]) || z > dsm[idx]) {
            dsm[idx] = z
            topClass[idx] = cls
          }
          pointsUsed++
        }
        if (++done % 500 === 0)
          console.log(`  ${done}/${entries.length} noder lästa...`)
      }
      for (const [, page] of Object.entries(pages)) {
        if (page) await walk(page)
      }
    }
    await walk(copc.info.rootHierarchyPage)
    console.log(`${item.id}: ${pointsUsed} punkter i området.`)
  }

  // Hål → DTM; och DSM aldrig under DTM (gles laser vid blanka ytor).
  let holes = 0
  for (let i = 0; i < dsm.length; i++) {
    if (Number.isNaN(dsm[i])) {
      dsm[i] = dtm[i]
      holes++
    } else if (dsm[i] < dtm[i]) dsm[i] = dtm[i]
  }
  if (holes) console.log(`${holes} celler utan laserpunkter fylldes från DTM.`)

  // Cellklassning för färgsättning: 0 mark, 1 vatten, 2 byggnad, 3 vegetation
  const cellClass = new Uint8Array(size * size)
  const boxes = footprints.map((fp) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [e, n] of fp) {
      x0 = Math.min(x0, e); x1 = Math.max(x1, e)
      y0 = Math.min(y0, n); y1 = Math.max(y1, n)
    }
    return [x0, x1, y0, y1]
  })
  const inPoly = (e, n, fp) => {
    let inside = false
    for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
      const [xi, yi] = fp[i]
      const [xj, yj] = fp[j]
      if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi)
        inside = !inside
    }
    return inside
  }
  for (let row = 0; row < size; row++) {
    const n = half - row
    for (let col = 0; col < size; col++) {
      const e = col - half
      const idx = row * size + col
      const dz = dsm[idx] - dtm[idx]
      if (topClass[idx] === 9 || dsm[idx] < 1.2) cellClass[idx] = 1
      else if (dz > 2.0) {
        let inBuilding = false
        for (let b = 0; b < footprints.length; b++) {
          const [x0, x1, y0, y1] = boxes[b]
          if (e < x0 || e > x1 || n < y0 || n > y1) continue
          if (inPoly(e, n, footprints[b])) { inBuilding = true; break }
        }
        cellClass[idx] = inBuilding ? 2 : 3
      }
    }
  }

  // Skuggvärlden ("occluder"): laserhöjd där OSM-fotavtryck finns (= husens
  // verkliga uppmätta höjder), marknivå i övrigt. Vegetation skuggar alltså
  // inte — användarens facit är observerat genom/förbi träden, och lövverk
  // är varken massivt eller åretruntgrönt.
  const occluder = new Float32Array(size * size)
  for (let i = 0; i < occluder.length; i++) {
    occluder[i] = cellClass[i] === 2 ? Math.max(dsm[i], dtm[i]) : dtm[i]
  }

  // Lasermätt takhöjd per hus: medianen av DSM (absolut möh) över husets
  // celler — skrivs in i buildings.json så visualiseringen kan extrudera
  // skarpa hus med rätt höjd.
  const buildingsData = JSON.parse(
    readFileSync(join(outDir, 'buildings.json'), 'utf8')
  )
  let calibrated = 0
  for (const b of buildingsData.buildings) {
    const fp = b.footprint
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [e, n] of fp) {
      x0 = Math.min(x0, e); x1 = Math.max(x1, e)
      y0 = Math.min(y0, n); y1 = Math.max(y1, n)
    }
    const zs = []
    for (let n = Math.ceil(y0); n <= Math.floor(y1); n++) {
      for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) {
        const col = Math.round(e + half)
        const row = Math.round(half - n)
        if (col < 0 || col > size - 1 || row < 0 || row > size - 1) continue
        const idx = row * size + col
        if (cellClass[idx] === 2 && inPoly(e, n, fp)) zs.push(dsm[idx])
      }
    }
    if (zs.length >= 8) {
      zs.sort((a, b) => a - b)
      b.roofElevation = Math.round(zs[Math.floor(zs.length / 2)] * 10) / 10
      calibrated++
    }
  }
  writeFileSync(
    join(outDir, 'buildings.json'),
    JSON.stringify(buildingsData, null, 1)
  )
  console.log(
    `${calibrated}/${buildingsData.buildings.length} hus fick lasermätt takhöjd.`
  )

  const center = Math.round(half) * size + Math.round(half)
  writeFileSync(join(outDir, 'dsm.bin'), Buffer.from(dsm.buffer))
  writeFileSync(join(outDir, 'dsm_occluder.bin'), Buffer.from(occluder.buffer))
  writeFileSync(join(outDir, 'dsm_class.bin'), Buffer.from(cellClass.buffer))
  writeFileSync(
    join(outDir, 'terrain.json'),
    JSON.stringify({
      // Visuellt: slät markmodell + extruderade hus (lasermätta höjder).
      // Skuggberäkning: laser-ytmodellen inom husfotavtryck (occluderFile).
      mode: 'dtm',
      attribution: 'Höjddata & laserdata © Lantmäteriet (CC BY 4.0)',
      areaSize: cfg.areaSize,
      gridSize: size,
      originElevation: dtm[center], // markens nivå vid uteplatsen
      file: 'terrain.bin',
      occluderFile: 'dsm_occluder.bin',
      classFile: 'dsm_class.bin',
      // Full ytmodell (inkl. vegetation) — trädhöjder för visualiseringen.
      dsmFile: 'dsm.bin',
    })
  )
  console.log(
    `DSM klar (${size}×${size} @ 1 m). Uteplatsens mark ${dtm[center].toFixed(1)} möh, ` +
      `DSM där: ${dsm[center].toFixed(1)} möh.`
  )
}

// Välj steg: --buildings / --terrain / --roads / --dsm (inga flaggor = alla)
const args = process.argv.slice(2)
const all = args.length === 0
if (all || args.includes('--buildings')) await buildBuildings()
if (all || args.includes('--terrain')) await buildTerrain()
if (all || args.includes('--roads')) await buildRoads()
if (args.includes('--dsm')) await buildDsm() // opt-in: kräver DTM + byggnader
console.log('Klart. Data i public/data/')
