import * as THREE from 'three'
import { AUTUMN_CROWN_COLORS } from './seasons.js'

// Säsongspartiklar: snöfall och fallande löv i en fast box kring
// uteplatsen (origo). Modulen driver en egen renderloop som bara körs
// medan någon intensitet är > 0 — resten av tiden behåller appen sin
// on-demand-rendering.

const RADIUS = 70 // boxens halvbredd (m)
const SNOW_N = 1200
const SNOW_TOP = 50 // snöns fallhöjd över marken (m)
const LEAF_N = 120
const LEAF_TOP = 18 // löven släpper från kronhöjd, inte från himlen

function makeSnowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.7)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 32, 32)
  return new THREE.CanvasTexture(c)
}

export function createParticles({ scene, renderNow, groundY }) {
  // --- Snö: en Points-sky, positionerna uppdateras på CPU per frame ---
  const snowPos = new Float32Array(SNOW_N * 3)
  const snowSpeed = new Float32Array(SNOW_N)
  const snowPhase = new Float32Array(SNOW_N)
  for (let i = 0; i < SNOW_N; i++) {
    snowPos[i * 3] = (Math.random() * 2 - 1) * RADIUS
    snowPos[i * 3 + 1] = groundY + Math.random() * SNOW_TOP
    snowPos[i * 3 + 2] = (Math.random() * 2 - 1) * RADIUS
    snowSpeed[i] = 0.8 + Math.random() * 0.8
    snowPhase[i] = Math.random() * Math.PI * 2
  }
  const snowGeo = new THREE.BufferGeometry()
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3))
  const snowMat = new THREE.PointsMaterial({
    size: 0.5, map: makeSnowTexture(), transparent: true,
    depthWrite: false, sizeAttenuation: true,
  })
  const snow = new THREE.Points(snowGeo, snowMat)
  snow.frustumCulled = false
  snow.visible = false
  scene.add(snow)

  // --- Löv: instansierade små plan som tumlar nedåt ---
  const leafGeo = new THREE.PlaneGeometry(0.45, 0.45)
  const leafMat = new THREE.MeshStandardMaterial({
    roughness: 1, side: THREE.DoubleSide,
  })
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, LEAF_N)
  const leafState = []
  const c = new THREE.Color()
  for (let i = 0; i < LEAF_N; i++) {
    leafState.push({
      x: (Math.random() * 2 - 1) * RADIUS,
      y: groundY + 0.5 + Math.random() * LEAF_TOP,
      z: (Math.random() * 2 - 1) * RADIUS,
      speed: 0.4 + Math.random() * 0.5,
      rot: new THREE.Euler(
        Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI
      ),
      spin: { x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 },
      phase: Math.random() * Math.PI * 2,
    })
    leaves.setColorAt(
      i, c.setHex(AUTUMN_CROWN_COLORS[i % AUTUMN_CROWN_COLORS.length])
    )
  }
  leaves.frustumCulled = false
  leaves.visible = false
  scene.add(leaves)

  const dummy = new THREE.Object3D()
  let elapsed = 0

  function updateSnow(dt) {
    for (let i = 0; i < SNOW_N; i++) {
      let y = snowPos[i * 3 + 1] - snowSpeed[i] * dt
      if (y < groundY) y += SNOW_TOP
      snowPos[i * 3 + 1] = y
      snowPos[i * 3] += Math.sin(elapsed * 1.3 + snowPhase[i]) * 0.6 * dt
    }
    snowGeo.attributes.position.needsUpdate = true
  }

  function updateLeaves(dt) {
    leafState.forEach((l, i) => {
      l.y -= l.speed * dt
      if (l.y < groundY + 0.1) l.y += LEAF_TOP
      l.x += Math.sin(elapsed * 0.9 + l.phase) * 1.2 * dt
      l.rot.x += l.spin.x * dt
      l.rot.y += l.spin.y * dt
      l.rot.z += l.spin.z * dt
      dummy.position.set(l.x, l.y, l.z)
      dummy.rotation.copy(l.rot)
      dummy.updateMatrix()
      leaves.setMatrixAt(i, dummy.matrix)
    })
    leaves.instanceMatrix.needsUpdate = true
  }

  let snowLevel = 0
  let leafLevel = 0
  let running = false
  let last = 0

  function tick(t) {
    if (!running) return
    // klampa dt så att partiklarna inte teleporterar efter en tab-paus
    const dt = Math.min((t - last) / 1000, 0.05)
    last = t
    elapsed += dt
    if (snowLevel > 0) updateSnow(dt)
    if (leafLevel > 0) updateLeaves(dt)
    renderNow()
    if ((snowLevel > 0 || leafLevel > 0) && !document.hidden) {
      requestAnimationFrame(tick)
    } else {
      running = false
    }
  }

  function start() {
    if (running) return
    running = true
    last = performance.now()
    requestAnimationFrame(tick)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false
    else if (snowLevel > 0 || leafLevel > 0) start()
  })

  function setIntensity({ snow: s, leaf: l }) {
    snowLevel = s
    leafLevel = l
    snow.visible = s > 0
    snowGeo.setDrawRange(0, Math.round(SNOW_N * s))
    snowMat.opacity = 0.9 * Math.min(1, s * 2)
    leaves.visible = l > 0
    leaves.count = Math.round(LEAF_N * l)
    if (s > 0 || l > 0) start()
    // vid 0 renderar loopen en sista frame (utan partiklar) och självdör
  }

  return {
    setIntensity,
    get running() {
      return running
    },
  }
}
