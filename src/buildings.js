/**
 * OSM kan innehålla både byggnadskroppen och en byggnadsdel (building:part)
 * över samma yta. Båda får då identiska lasertak — två ytor på exakt samma
 * plats som z-fightas till ett flimmer. Behåll den största per överlapp.
 */
export function dedupeFootprints(buildings) {
  const boxes = buildings.map((b) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [e, n] of b.footprint) {
      x0 = Math.min(x0, e); x1 = Math.max(x1, e)
      y0 = Math.min(y0, n); y1 = Math.max(y1, n)
    }
    return { x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) }
  })
  const dropped = new Set()
  for (let i = 0; i < buildings.length; i++) {
    if (dropped.has(i)) continue
    for (let j = i + 1; j < buildings.length; j++) {
      if (dropped.has(j)) continue
      const a = boxes[i]
      const c = boxes[j]
      const ow = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0)
      const oh = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0)
      if (ow <= 0 || oh <= 0) continue
      const overlap = (ow * oh) / Math.min(a.area, c.area)
      if (overlap > 0.5) dropped.add(a.area >= c.area ? j : i)
    }
  }
  return buildings.filter((_, i) => !dropped.has(i))
}
