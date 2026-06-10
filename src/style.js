/**
 * Deterministiskt fasad-/takval per hus: en hash av OSM-id:t väljer ur en
 * kurerad Stockholmspalett. Samma id ger alltid samma stil — inget hus
 * byter färg mellan körningar.
 */

export const PALETTE = [
  {
    kind: 'brick',
    walls: [0x9c5e4a, 0x7d4536],
    roofs: [0x8f4a39],
  },
  {
    kind: 'plaster',
    walls: [0xd8b376, 0xb9b3a6, 0xe6e0d4, 0xd9b7a8, 0xcf9b76],
    roofs: [0x4a4a4e, 0x6a6a66, 0x5a8a78],
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
  // Kopparngrönt (sista putstaket) ska vara enstaka — vikta om det.
  let roofIdx = (h >>> 16) % p.roofs.length
  if (!brick && roofIdx === 2 && (h >>> 24) % 4 !== 0) roofIdx = h % 2
  const roofColor = p.roofs[roofIdx]
  return { wallColor, roofColor, isBrick: brick }
}
