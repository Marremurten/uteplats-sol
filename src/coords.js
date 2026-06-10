import proj4 from 'proj4'

// SWEREF99 TM (EPSG:3006)
const SWEREF99TM =
  '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs'

/** WGS84 (lon, lat) → SWEREF99 TM { e, n } */
export function wgs84ToSweref(lon, lat) {
  const [e, n] = proj4('WGS84', SWEREF99TM, [lon, lat])
  return { e, n }
}

/** SWEREF99 TM (e, n) → WGS84 { lon, lat } */
export function swerefToWgs84(e, n) {
  const [lon, lat] = proj4(SWEREF99TM, 'WGS84', [e, n])
  return { lon, lat }
}

/**
 * Meridiankonvergens i SWEREF99 TM (radianer): vinkeln från rutnätsnorr
 * till sant norr, positiv när sant norr ligger väster om rutnätsnorr
 * (vilket gäller öster om mittmeridianen 15°E). I Stockholm ≈ 2,6°.
 */
export function gridConvergence(lon, lat) {
  const rad = Math.PI / 180
  return Math.atan(Math.tan((lon - 15) * rad) * Math.sin(lat * rad))
}

/**
 * Local frame: meters east/north relative an origin (the patio).
 * three.js mapping is done in scene.js: x = east, y = up, z = -north.
 */
export function makeLocalFrame(originLon, originLat) {
  const origin = wgs84ToSweref(originLon, originLat)
  return {
    origin,
    toLocal(e, n) {
      return { x: e - origin.e, y: n - origin.n }
    },
    wgs84ToLocal(lon, lat) {
      const { e, n } = wgs84ToSweref(lon, lat)
      return this.toLocal(e, n)
    },
  }
}
