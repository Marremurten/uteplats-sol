/**
 * Deterministiskt fasad-/takval per hus: en hash av OSM-id:t väljer ur en
 * kurerad Stockholmspalett. Samma id ger alltid samma stil — inget hus
 * byter färg mellan körningar.
 */

// Taken är genomgående gråskala (plåt/papp i stadsmiljö); fasaderna står
// för kulören.
export const PALETTE = [
  {
    kind: 'brick',
    walls: [0x9c5e4a, 0x7d4536],
    roofs: [0x3d3d40, 0x57575a],
  },
  {
    kind: 'plaster',
    walls: [0xd8b376, 0xb9b3a6, 0xe6e0d4, 0xd9b7a8, 0xcf9b76],
    roofs: [0x46464a, 0x5c5c60, 0x6e6e72, 0x38383b],
  },
]

// FNV-1a — billig, jämnt spridd över korta strängar som "way/17398164".
export function hashId(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function pickBuildingStyle(id) {
  const h = hashId(String(id))
  // ~1/3 tegel, 2/3 puts.
  const brick = h % 3 === 0
  const p = PALETTE[brick ? 0 : 1]
  const wallColor = p.walls[(h >>> 8) % p.walls.length]
  const roofColor = p.roofs[(h >>> 16) % p.roofs.length]
  return { wallColor, roofColor, isBrick: brick }
}
