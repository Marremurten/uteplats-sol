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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

  const roads = []
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue
    const path = ringToLocal(el.geometry)
    if (!ringInArea(path)) continue
    roads.push({
      id: `way/${el.id}`,
      width: ROAD_WIDTHS[el.tags?.highway] ?? 4,
      kind: el.tags?.highway,
      path,
    })
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

// Välj steg: --buildings / --terrain / --roads (inga flaggor = alla)
const args = process.argv.slice(2)
const all = args.length === 0
if (all || args.includes('--buildings')) await buildBuildings()
if (all || args.includes('--terrain')) await buildTerrain()
if (all || args.includes('--roads')) await buildRoads()
console.log('Klart. Data i public/data/')
