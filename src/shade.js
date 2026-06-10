import * as THREE from 'three'
import { sunDirection } from './sun.js'

const _raycaster = new THREE.Raycaster()
const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()

/**
 * Is the point sunlit at the given moment?
 * point: THREE.Vector3 in scene coordinates (typically the patio marker,
 * ~1.2 m above ground). occluders: array of meshes (terrain + buildings).
 * Returns false when the sun is below the horizon.
 */
export function isSunlit(date, lat, lon, point, occluders, gridRotation = 0) {
  const sun = sunDirection(date, lat, lon, gridRotation)
  if (sun.altitude <= 0) return false
  _origin.copy(point)
  _dir.set(sun.x, sun.y, sun.z).normalize()
  _raycaster.set(_origin, _dir)
  _raycaster.far = 2000
  return _raycaster.intersectObjects(occluders, true).length === 0
}

/**
 * Sweep one day in `stepMinutes` steps and return sunlit intervals
 * [{ start: Date, end: Date }]. The day is the local calendar day of `date`.
 */
export function sunWindows(
  date, lat, lon, point, occluders, stepMinutes = 5, gridRotation = 0
) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const windows = []
  let current = null
  for (let m = 0; m < 24 * 60; m += stepMinutes) {
    const t = new Date(dayStart.getTime() + m * 60000)
    if (isSunlit(t, lat, lon, point, occluders, gridRotation)) {
      if (!current) current = { start: t, end: t }
      current.end = new Date(t.getTime() + stepMinutes * 60000)
    } else if (current) {
      windows.push(current)
      current = null
    }
  }
  if (current) windows.push(current)
  return windows
}
