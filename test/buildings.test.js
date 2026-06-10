import { describe, it, expect } from 'vitest'
import { dedupeFootprints } from '../src/buildings.js'

const rect = (x0, y0, w, h) => [
  [x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0],
]

describe('dedupeFootprints', () => {
  it('släpper igenom hus som inte överlappar', () => {
    const buildings = [
      { id: 'a', footprint: rect(0, 0, 10, 10) },
      { id: 'b', footprint: rect(20, 0, 10, 10) },
    ]
    expect(dedupeFootprints(buildings).map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('tar bort byggnadsdelen när den ligger ovanpå byggnadskroppen', () => {
    // OSM: stor kropp + mindre del på samma yta → två lasertak z-fightas
    const buildings = [
      { id: 'kropp', footprint: rect(0, 0, 30, 20) },
      { id: 'del', footprint: rect(2, 2, 12, 10) },
    ]
    expect(dedupeFootprints(buildings).map((b) => b.id)).toEqual(['kropp'])
  })

  it('behåller grannar som bara delar en kant', () => {
    const buildings = [
      { id: 'a', footprint: rect(0, 0, 10, 10) },
      { id: 'b', footprint: rect(10, 0, 10, 10) },
    ]
    expect(dedupeFootprints(buildings)).toHaveLength(2)
  })

  it('liten hörnöverlapp fäller ingen', () => {
    const buildings = [
      { id: 'a', footprint: rect(0, 0, 10, 10) },
      { id: 'b', footprint: rect(8, 8, 10, 10) }, // ~4% av vardera
    ]
    expect(dedupeFootprints(buildings)).toHaveLength(2)
  })
})
