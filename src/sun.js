import SunCalc from 'suncalc'

/**
 * Sun direction in the scene's local frame, as a unit vector pointing
 * FROM the ground TOWARD the sun.
 *
 * Scene convention: x = east, y = up, z = south (-z = north).
 * SunCalc azimuth: 0 = south, positive toward west. Altitude above horizon.
 *
 * `gridRotation` (radianer): meridiankonvergens när scenens axlar är
 * SWEREF99-rutnätets öst/norr i stället för sanna — vektorn roteras så att
 * solens azimut (relativ sant norr) hamnar rätt i rutnätsramen.
 */
export function sunDirection(date, lat, lon, gridRotation = 0) {
  const { altitude, azimuth } = SunCalc.getPosition(date, lat, lon)
  const cosAlt = Math.cos(altitude)
  // Mot solen, i sanna väderstreck (azimut 0 = söder, växer mot väster):
  const eTrue = -Math.sin(azimuth) * cosAlt
  const nTrue = -Math.cos(azimuth) * cosAlt
  // Sant norr = (−sin γ, cos γ) i rutnätsramen ⇒ rotera EN-planet med γ.
  const cosG = Math.cos(gridRotation)
  const sinG = Math.sin(gridRotation)
  const e = eTrue * cosG - nTrue * sinG
  const n = eTrue * sinG + nTrue * cosG
  return {
    x: e,
    y: Math.sin(altitude),
    z: -n,
    altitude,
    azimuth,
  }
}

export function sunTimes(date, lat, lon) {
  return SunCalc.getTimes(date, lat, lon)
}
