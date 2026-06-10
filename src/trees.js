/**
 * Träddetektering ur laserdatan: vegetationsceller (klass 3) klustras till
 * enskilda träd. Toppar plockas girigt i höjdordning; från varje topp
 * "flödar" kronan ut genom celler som inte är högre än cellen den kom
 * ifrån (+ liten tolerans för laserbrus). Det som blir kvar efter en krona
 * är nästa träds topp — så en sammanhängande häck med två tydliga toppar
 * blir två träd, medan en jämn plätt blir ett.
 *
 * Koordinater: grid med rad 0 = norr, kolumn 0 = väst (samma som DSM:n).
 * Returnerar lokala meter: e öst, n norr; ground/top i gridens absoluta möh.
 */

const VEG_CLASS = 3
const MIN_TREE_HEIGHT = 2.5 // m krona över mark — lägre är buskage
const CANOPY_TOLERANCE = 1.5 // m uppförsbacke som ändå räknas till kronan

export function detectTrees({ classGrid, grid, groundGrid, gridSize, areaSize }) {
  const half = areaSize / 2
  const idx = (col, row) => row * gridSize + col

  // Kandidatceller: vegetation som når trädhöjd.
  const candidates = []
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const i = idx(col, row)
      if (classGrid[i] !== VEG_CLASS) continue
      if (grid[i] - groundGrid[i] < MIN_TREE_HEIGHT) continue
      candidates.push(i)
    }
  }
  candidates.sort((a, b) => grid[b] - grid[a])

  const claimed = new Uint8Array(gridSize * gridSize)
  const trees = []
  for (const peak of candidates) {
    if (claimed[peak]) continue
    // Kronflödning: BFS nedåt/likahöjt från toppen, genom all vegetation
    // (även under trädhöjd — buskskiktet hör till kronans fot).
    const queue = [peak]
    claimed[peak] = 1
    let cells = 0
    while (queue.length) {
      const cur = queue.pop()
      cells++
      const cc = cur % gridSize
      const cr = (cur - cc) / gridSize
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const col = cc + dc
          const row = cr + dr
          if (col < 0 || row < 0 || col >= gridSize || row >= gridSize) continue
          const nb = idx(col, row)
          if (claimed[nb] || classGrid[nb] !== VEG_CLASS) continue
          if (grid[nb] > grid[cur] + CANOPY_TOLERANCE) continue
          claimed[nb] = 1
          queue.push(nb)
        }
      }
    }
    const col = peak % gridSize
    const row = (peak - col) / gridSize
    trees.push({
      e: col - half,
      n: half - row,
      ground: groundGrid[peak],
      top: grid[peak],
      radius: Math.max(1.2, Math.sqrt(cells / Math.PI)),
    })
  }
  return trees
}
