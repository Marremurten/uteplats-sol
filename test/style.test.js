import { describe, it, expect } from 'vitest'
import { pickBuildingStyle, PALETTE } from '../src/style.js'

// Riktiga OSM-id:n ur buildings.json har formen "way/17398164".
const ids = Array.from({ length: 200 }, (_, i) => `way/${17000000 + i * 137}`)

describe('pickBuildingStyle', () => {
  it('är deterministisk — samma id ger samma stil', () => {
    const a = pickBuildingStyle('way/17398164')
    const b = pickBuildingStyle('way/17398164')
    expect(a).toEqual(b)
  })

  it('ger kulörer ur den kurerade paletten', () => {
    const walls = new Set(PALETTE.flatMap((p) => p.walls))
    const roofs = new Set(PALETTE.flatMap((p) => p.roofs))
    for (const id of ids) {
      const s = pickBuildingStyle(id)
      expect(walls).toContain(s.wallColor)
      expect(roofs).toContain(s.roofColor)
    }
  })

  it('korrelerar tak med fasad — tegelhus får tegelrött tak', () => {
    const brick = PALETTE.find((p) => p.kind === 'brick')
    for (const id of ids) {
      const s = pickBuildingStyle(id)
      if (s.isBrick) expect(brick.roofs).toContain(s.roofColor)
    }
  })

  it('blandar tegel och puts i rimlig fördelning (~1/3 tegel)', () => {
    const brickShare =
      ids.filter((id) => pickBuildingStyle(id).isBrick).length / ids.length
    expect(brickShare).toBeGreaterThan(0.15)
    expect(brickShare).toBeLessThan(0.5)
  })

  it('varierar — minst 5 olika fasadkulörer över många hus', () => {
    const distinct = new Set(ids.map((id) => pickBuildingStyle(id).wallColor))
    expect(distinct.size).toBeGreaterThanOrEqual(5)
  })

  it('alla tak är gråskala', () => {
    for (const id of ids) {
      const c = pickBuildingStyle(id).roofColor
      const r = (c >> 16) & 0xff
      const g = (c >> 8) & 0xff
      const b = c & 0xff
      // gråskala: kanalerna får skilja max ett par steg
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(6)
    }
  })
})
