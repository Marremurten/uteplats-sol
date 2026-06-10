import { describe, it, expect } from 'vitest'
import { detectTrees } from '../src/trees.js'

// Litet testlandskap: 21×21-grid över 20×20 m, platt mark på 5 möh.
// Vegetation läggs in som klass 3 med DSM-höjd = mark + kronhöjd.
function makeWorld() {
  const gridSize = 21
  const ground = 5
  const grid = new Float32Array(gridSize * gridSize).fill(ground)
  const groundGrid = new Float32Array(gridSize * gridSize).fill(ground)
  const classGrid = new Uint8Array(gridSize * gridSize) // 0 = mark
  const veg = (col, row, height) => {
    classGrid[row * gridSize + col] = 3
    grid[row * gridSize + col] = ground + height
  }
  return { gridSize, areaSize: 20, grid, groundGrid, classGrid, veg }
}

describe('detectTrees', () => {
  it('hittar ett träd i en sammanhängande vegetationsklump', () => {
    const w = makeWorld()
    // 3×3-krona kring (10, 10), toppen i mitten 8 m hög
    for (let r = 9; r <= 11; r++)
      for (let c = 9; c <= 11; c++) w.veg(c, r, 6)
    w.veg(10, 10, 8)
    const trees = detectTrees(w)
    expect(trees).toHaveLength(1)
    expect(trees[0].ground).toBe(5)
    expect(trees[0].top).toBe(13) // 5 + 8
  })

  it('toppen placeras rätt i lokala koordinater (e öst, n norr)', () => {
    const w = makeWorld()
    // kolumn 14, rad 4 → e = 14 − 10 = 4, n = 10 − 4 = 6
    w.veg(14, 4, 7)
    const trees = detectTrees(w)
    expect(trees).toHaveLength(1)
    expect(trees[0].e).toBe(4)
    expect(trees[0].n).toBe(6)
  })

  it('två åtskilda klumpar blir två träd', () => {
    const w = makeWorld()
    w.veg(3, 3, 7)
    w.veg(16, 16, 9)
    expect(detectTrees(w)).toHaveLength(2)
  })

  it('en avlång klump med två tydliga toppar blir två träd', () => {
    const w = makeWorld()
    // sammanhängande häck rad 10, kolumn 3..16, med toppar i ändarna
    for (let c = 3; c <= 16; c++) w.veg(c, 10, 5)
    w.veg(4, 10, 9)
    w.veg(15, 10, 8)
    const trees = detectTrees(w)
    expect(trees).toHaveLength(2)
  })

  it('låga buskar räknas inte som träd', () => {
    const w = makeWorld()
    w.veg(10, 10, 1.5) // under minsta trädhöjd
    expect(detectTrees(w)).toHaveLength(0)
  })

  it('tom klasskarta ger inga träd', () => {
    const w = makeWorld()
    expect(detectTrees(w)).toHaveLength(0)
  })
})
