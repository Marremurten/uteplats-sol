/**
 * Laddar de pipeline-genererade datafilerna och exponerar dem i appens
 * lokala koordinatsystem (meter öst/norr från uteplatsen, marknivå vid
 * uteplatsen = 0).
 */
export async function loadData() {
  const [terrainMeta, buildingsData, roadsData] = await Promise.all([
    fetch('data/terrain.json').then(mustJson('terrain.json')),
    fetch('data/buildings.json').then(mustJson('buildings.json')),
    // Vägar är valfri kosmetika — saknas filen (eller svarar dev-servern
    // med HTML-fallback) visas scenen utan vägar.
    fetch('data/roads.json')
      .then((r) => r.json())
      .catch(() => ({ roads: [] })),
  ])

  let terrain
  if (terrainMeta.mode === 'dtm') {
    const buf = await fetch(`data/${terrainMeta.file}`).then((r) => {
      if (!r.ok) throw new Error(`Kunde inte läsa ${terrainMeta.file}`)
      return r.arrayBuffer()
    })
    const grid = new Float32Array(buf)
    const size = terrainMeta.gridSize
    const half = terrainMeta.areaSize / 2
    const z0 = terrainMeta.originElevation
    terrain = {
      mode: 'dtm',
      areaSize: terrainMeta.areaSize,
      gridSize: size,
      grid,
      originElevation: z0,
      attribution: terrainMeta.attribution,
      // Bilinjär sampling; (e, n) i lokala meter → höjd relativt uteplatsen.
      sample(e, n) {
        const col = Math.min(Math.max(e + half, 0), terrainMeta.areaSize)
        const row = Math.min(Math.max(half - n, 0), terrainMeta.areaSize)
        const c0 = Math.floor(col)
        const r0 = Math.floor(row)
        const c1 = Math.min(c0 + 1, size - 1)
        const r1 = Math.min(r0 + 1, size - 1)
        const fc = col - c0
        const fr = row - r0
        const v =
          grid[r0 * size + c0] * (1 - fc) * (1 - fr) +
          grid[r0 * size + c1] * fc * (1 - fr) +
          grid[r1 * size + c0] * (1 - fc) * fr +
          grid[r1 * size + c1] * fc * fr
        return v - z0
      },
      // I DTM-läget ingår nedsänkningen i terrängen.
      buildingExtra: 0,
    }
  } else {
    const depth = terrainMeta.courtyardDepth ?? 0
    terrain = {
      mode: 'flat',
      areaSize: terrainMeta.areaSize,
      courtyardDepth: depth,
      sample: () => 0,
      // Platt mark = gårdens golvnivå. Husens OSM-höjder utgår från
      // gatunivån, som ligger `depth` meter högre — silhuetten från gården
      // blir rätt om husen förlängs med gårdsdjupet.
      buildingExtra: depth,
    }
  }

  return {
    site: buildingsData.origin,
    areaSize: buildingsData.areaSize,
    buildings: buildingsData.buildings,
    roads: roadsData.roads,
    terrain,
    attributions: [
      buildingsData.attribution,
      terrain.attribution,
    ].filter(Boolean),
  }
}

function mustJson(name) {
  return (r) => {
    if (!r.ok)
      throw new Error(
        `Kunde inte läsa ${name} — kör "npm run prepare-data" först.`
      )
    return r.json()
  }
}
