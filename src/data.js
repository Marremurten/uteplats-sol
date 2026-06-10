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
  if (terrainMeta.mode === 'dtm' || terrainMeta.mode === 'dsm') {
    const loadGrid = (name) =>
      fetch(`data/${name}`).then((r) => {
        if (!r.ok) throw new Error(`Kunde inte läsa ${name}`)
        return r.arrayBuffer()
      })
    const grid = new Float32Array(await loadGrid(terrainMeta.file))
    // I DSM-läget: separat markgrid (för markör/vägar) och cellklasser
    // (för färgsättning av ytan).
    const groundGrid = terrainMeta.groundFile
      ? new Float32Array(await loadGrid(terrainMeta.groundFile))
      : null
    const classGrid = terrainMeta.classFile
      ? new Uint8Array(await loadGrid(terrainMeta.classFile))
      : null
    // Skuggvärlden: hus med laserhöjder, utan vegetation (se pipelinen).
    const occluderGrid = terrainMeta.occluderFile
      ? new Float32Array(await loadGrid(terrainMeta.occluderFile))
      : null
    // Full ytmodell inkl. vegetation — trädhöjder för visualiseringen.
    // I dsm-läget är huvudgriden redan den fulla ytmodellen.
    const canopyGrid = terrainMeta.dsmFile
      ? new Float32Array(await loadGrid(terrainMeta.dsmFile))
      : terrainMeta.mode === 'dsm'
        ? grid
        : null
    const size = terrainMeta.gridSize
    const half = terrainMeta.areaSize / 2
    const z0 = terrainMeta.originElevation

    // Bilinjär sampling; (e, n) i lokala meter → höjd relativt uteplatsen.
    const makeSampler = (g) => (e, n) => {
      const col = Math.min(Math.max(e + half, 0), terrainMeta.areaSize)
      const row = Math.min(Math.max(half - n, 0), terrainMeta.areaSize)
      const c0 = Math.floor(col)
      const r0 = Math.floor(row)
      const c1 = Math.min(c0 + 1, size - 1)
      const r1 = Math.min(r0 + 1, size - 1)
      const fc = col - c0
      const fr = row - r0
      return (
        g[r0 * size + c0] * (1 - fc) * (1 - fr) +
        g[r0 * size + c1] * fc * (1 - fr) +
        g[r1 * size + c0] * (1 - fc) * fr +
        g[r1 * size + c1] * fc * fr -
        z0
      )
    }

    terrain = {
      mode: terrainMeta.mode,
      areaSize: terrainMeta.areaSize,
      gridSize: size,
      grid,
      // I dtm-läget är huvudgriden marken; i dsm-läget är marken separat.
      groundGrid: groundGrid ?? (terrainMeta.mode === 'dtm' ? grid : null),
      canopyGrid,
      classGrid,
      occluderGrid,
      originElevation: z0,
      attribution: terrainMeta.attribution,
      sample: makeSampler(grid),
      // Markens nivå (utan hus/träd) — för markör och vägar i DSM-läget.
      sampleGround: groundGrid ? makeSampler(groundGrid) : makeSampler(grid),
      // Laserytan inom husfotavtryck (skuggvärlden) — används även för
      // takformerna i visualiseringen.
      sampleOccluder: occluderGrid ? makeSampler(occluderGrid) : null,
      // I grid-lägena ingår nedsänkningen i terrängen.
      buildingExtra: 0,
    }
  } else {
    const depth = terrainMeta.courtyardDepth ?? 0
    terrain = {
      mode: 'flat',
      areaSize: terrainMeta.areaSize,
      courtyardDepth: depth,
      sample: () => 0,
      sampleGround: () => 0,
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
