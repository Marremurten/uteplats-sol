import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const SKY_DAY = new THREE.Color(0x87b5dd)
const SKY_LOW = new THREE.Color(0xd9a06b)
const SKY_NIGHT = new THREE.Color(0x101522)

/**
 * Bygger three.js-scenen. Returnerar handtag för rendering, solstyrning
 * och raycast-avläsning.
 * Konvention: x = öst, y = upp, z = söder (−z = norr).
 */
export function createScene(canvas, data) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = SKY_DAY.clone()

  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000)
  camera.position.set(120, 140, 160)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0, 0)
  controls.maxPolarAngle = Math.PI / 2 - 0.02
  controls.maxDistance = 900

  // --- Ljus ---
  const sunLight = new THREE.DirectionalLight(0xfff3e0, 2.6)
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(4096, 4096)
  const half = data.areaSize / 2 + 60
  Object.assign(sunLight.shadow.camera, {
    left: -half, right: half, top: half, bottom: -half, near: 10, far: 1600,
  })
  sunLight.shadow.bias = -0.0004
  scene.add(sunLight, sunLight.target)

  const hemi = new THREE.HemisphereLight(0xbdd4ee, 0x3a3a33, 0.75)
  scene.add(hemi)

  // --- Terräng ---
  const terrainMesh = makeTerrain(data.terrain)
  scene.add(terrainMesh)

  // --- Byggnader ---
  const buildingsGroup = new THREE.Group()
  const buildingMat = new THREE.MeshStandardMaterial({
    color: 0xc9b8a3, roughness: 0.9,
  })
  for (const b of data.buildings) {
    const mesh = makeBuilding(b, data.terrain, buildingMat)
    if (mesh) buildingsGroup.add(mesh)
  }
  scene.add(buildingsGroup)

  // --- Uteplatsmarkören ---
  const groundY = data.terrain.sample(0, 0)
  const eyeHeight = 1.2
  const samplePoint = new THREE.Vector3(0, groundY + eyeHeight, 0)

  const marker = new THREE.Group()
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 4, 12),
    new THREE.MeshStandardMaterial({ color: 0xd62828 })
  )
  pole.position.y = groundY + 2
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xd62828, emissive: 0x801010, emissiveIntensity: 0.6,
    })
  )
  dot.position.y = groundY + 4
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(3, 32),
    new THREE.MeshStandardMaterial({ color: 0xe0c468, roughness: 0.8 })
  )
  pad.rotation.x = -Math.PI / 2
  pad.position.y = groundY + 0.03
  pad.receiveShadow = true
  marker.add(pole, dot, pad)
  scene.add(marker)

  const occluders = [terrainMesh, buildingsGroup]

  function setSun(sun) {
    const up = Math.max(sun.altitude, 0)
    const dayness = Math.min(up / 0.15, 1) // 0..1 över de första ~8.5°
    if (sun.altitude > 0) {
      sunLight.visible = true
      sunLight.position.set(sun.x * 700, sun.y * 700, sun.z * 700)
      sunLight.intensity = 2.6 * (0.4 + 0.6 * dayness)
    } else {
      sunLight.visible = false
    }
    hemi.intensity = 0.12 + 0.63 * dayness
    const sky =
      sun.altitude <= 0
        ? SKY_NIGHT
        : SKY_LOW.clone().lerp(SKY_DAY, dayness)
    scene.background.copy(sky)
  }

  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()

  function render() {
    controls.update()
    renderer.render(scene, camera)
  }

  return { render, setSun, samplePoint, occluders }
}

function makeTerrain(terrain) {
  const size = terrain.areaSize
  let geo
  if (terrain.mode === 'dtm') {
    const seg = terrain.gridSize - 1
    geo = new THREE.PlaneGeometry(size, size, seg, seg)
    const pos = geo.attributes.position
    const z0 = terrain.originElevation
    // PlaneGeometry: rad 0 = +y (norr efter rotation), vänster→höger = +x.
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, terrain.grid[i] - z0)
    }
    geo.computeVertexNormals()
  } else {
    geo = new THREE.PlaneGeometry(size, size, 1, 1)
  }
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x8a9a7b, roughness: 1 })
  )
  mesh.rotation.x = -Math.PI / 2 // XY-plan → XZ-plan, +y → −z (norr)
  mesh.receiveShadow = true
  return mesh
}

function makeBuilding(b, terrain, material) {
  const ring = b.footprint
  if (ring.length < 4) return null

  // Bas på lägsta markpunkten under fotavtrycket; höjden räknas från den
  // högsta (så att huset inte sjunker in i sluttande mark).
  let baseY = Infinity
  let topGround = -Infinity
  for (const [e, n] of ring) {
    const g = terrain.sample(e, n)
    baseY = Math.min(baseY, g)
    topGround = Math.max(topGround, g)
  }
  const totalHeight =
    topGround - baseY + b.height + (terrain.buildingExtra ?? 0)

  // Shape i XY (x = öst, y = norr), extrudering längs +z, sedan roteras
  // (x, y, z) → (x, z, −y) så att z-djupet blir höjd.
  const shape = new THREE.Shape()
  shape.moveTo(ring[0][0], ring[0][1])
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], ring[i][1])
  shape.closePath()

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: totalHeight,
    bevelEnabled: false,
  })
  const mesh = new THREE.Mesh(geo, material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = baseY
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.id = b.id
  return mesh
}
