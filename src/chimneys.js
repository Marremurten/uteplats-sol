/**
 * Skorstensdetektering ur lasertakets spikar: medianfiltret i
 * husbygget tar bort punktspikar (skorstenar/antenner) ur takytan —
 * differensen mellan rå och utjämnad yta är en karta över var de sitter.
 *
 * raw/smoothed: Map<"e,n", höjd> över husets celler (1 m-grid).
 * Returnerar ett kluster per skorsten: { e, n, base, top, cells }.
 */

const SPIKE_MIN = 1.0 // m över utjämnad yta för att räknas som skorsten
const CHIMNEY_MAX = 2.5 // m — högre spikar är antenner/master; kapa

export function detectChimneys(raw, smoothed) {
  // Spikceller: rå yta tydligt över den utjämnade.
  const spikes = new Map()
  for (const [key, h] of raw) {
    const s = smoothed.get(key)
    if (s !== undefined && h - s >= SPIKE_MIN) spikes.set(key, h)
  }

  // Klustra 8-grannskap — ihopliggande spikceller är samma murstock.
  const seen = new Set()
  const chimneys = []
  for (const start of spikes.keys()) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    const cells = []
    while (queue.length) {
      const key = queue.pop()
      const [e, n] = key.split(',').map(Number)
      cells.push({ e, n, h: spikes.get(key) })
      for (let dn = -1; dn <= 1; dn++) {
        for (let de = -1; de <= 1; de++) {
          const nk = `${e + de},${n + dn}`
          if (!seen.has(nk) && spikes.has(nk)) {
            seen.add(nk)
            queue.push(nk)
          }
        }
      }
    }
    // Mittpunkt = högsta cellen; bas = utjämnad takyta där.
    cells.sort((a, b) => b.h - a.h)
    const peak = cells[0]
    const base = smoothed.get(`${peak.e},${peak.n}`)
    const top = Math.min(peak.h, base + CHIMNEY_MAX)
    chimneys.push({ e: peak.e, n: peak.n, base, top, cells: cells.length })
  }
  return chimneys
}
