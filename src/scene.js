import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  computeBoundsTree, disposeBoundsTree, acceleratedRaycast,
} from 'three-mesh-bvh'

// BVH-accelererade raycasts — terrängen är ~500k trianglar och sveps
// 288 gånger per dagsfönster.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

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

  // --- Vägar (kosmetik, ingår inte i skuggberäkningen) ---
  if (data.roads?.length) scene.add(makeRoads(data.roads, data.terrain))

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

  // Rendera på begäran i stället för 60 fps — scenen är statisk mellan
  // interaktioner och terrängen är tung (~500k trianglar).
  let renderPending = false
  function requestRender() {
    if (renderPending) return
    renderPending = true
    requestAnimationFrame(() => {
      renderPending = false
      renderer.render(scene, camera)
    })
  }
  controls.addEventListener('change', requestRender)

  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    requestRender()
  }
  window.addEventListener('resize', resize)
  resize()

  return { requestRender, setSun, samplePoint, occluders }
}

// Mälarens yta ligger ~0,86 möh (RH 2000); DTM:n är hydro-utplattad så
// allt under den här nivån är vatten.
const WATER_LEVEL = 1.2
const COLOR_GROUND = new THREE.Color(0x8a9a7b)
const COLOR_WATER = new THREE.Color(0x3e6f9e)

function makeTerrain(terrain) {
  const size = terrain.areaSize
  let geo
  let material
  if (terrain.mode === 'dtm') {
    const seg = terrain.gridSize - 1
    geo = new THREE.PlaneGeometry(size, size, seg, seg)
    const pos = geo.attributes.position
    const z0 = terrain.originElevation
    const colors = new Float32Array(pos.count * 3)
    // PlaneGeometry: rad 0 = +y (norr efter rotation), vänster→höger = +x.
    for (let i = 0; i < pos.count; i++) {
      const elev = terrain.grid[i]
      pos.setZ(i, elev - z0)
      const c = elev < WATER_LEVEL ? COLOR_WATER : COLOR_GROUND
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1,
    })
  } else {
    geo = new THREE.PlaneGeometry(size, size, 1, 1)
    material = new THREE.MeshStandardMaterial({
      color: COLOR_GROUND, roughness: 1,
    })
  }
  geo.computeBoundsTree()
  const mesh = new THREE.Mesh(geo, material)
  mesh.rotation.x = -Math.PI / 2 // XY-plan → XZ-plan, +y → −z (norr)
  mesh.receiveShadow = true
  return mesh
}

// Vägar som plana band draperade strax ovanför terrängen.
function makeRoads(roads, terrain) {
  const positions = []
  const lift = 0.18 // över marken, under skuggkänslighet

  for (const road of roads) {
    const p = road.path
    const hw = road.width / 2
    for (let i = 0; i < p.length - 1; i++) {
      const [e0, n0] = p[i]
      const [e1, n1] = p[i + 1]
      const dx = e1 - e0
      const dn = n1 - n0
      const len = Math.hypot(dx, dn)
      if (len < 0.01) continue
      // perpendikulär i markplanet
      const px = (-dn / len) * hw
      const pn = (dx / len) * hw
      const y00 = terrain.sample(e0 + px, n0 + pn) + lift
      const y01 = terrain.sample(e0 - px, n0 - pn) + lift
      const y10 = terrain.sample(e1 + px, n1 + pn) + lift
      const y11 = terrain.sample(e1 - px, n1 - pn) + lift
      // två trianglar per segment; (e, n) → (x: e, y: höjd, z: −n).
      // Moturs sett uppifrån (+y) så att normalerna pekar upp.
      positions.push(
        e0 + px, y00, -(n0 + pn), e0 - px, y01, -(n0 - pn), e1 + px, y10, -(n1 + pn),
        e1 + px, y10, -(n1 + pn), e0 - px, y01, -(n0 - pn), e1 - px, y11, -(n1 - pn)
      )
    }
  }

  // Runda "lock" i varje knutpunkt så att segmenten hänger ihop i kurvor
  // och korsningar (annars blir det kilformade glipor).
  const SIDES = 8
  for (const road of roads) {
    const hw = road.width / 2
    for (const [e, n] of road.path) {
      const yc = terrain.sample(e, n) + lift
      for (let s = 0; s < SIDES; s++) {
        const a0 = (s / SIDES) * Math.PI * 2
        const a1 = ((s + 1) / SIDES) * Math.PI * 2
        positions.push(
          e, yc, -n,
          e + Math.cos(a0) * hw, yc, -(n + Math.sin(a0) * hw),
          e + Math.cos(a1) * hw, yc, -(n + Math.sin(a1) * hw)
        )
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position', new THREE.BufferAttribute(new Float32Array(positions), 3)
  )
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.95 })
  )
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
  geo.computeBoundsTree()
  const mesh = new THREE.Mesh(geo, material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = baseY
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.id = b.id
  return mesh
}
