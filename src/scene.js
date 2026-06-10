import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  computeBoundsTree, disposeBoundsTree, acceleratedRaycast,
} from 'three-mesh-bvh'
import { pickBuildingStyle, hashId } from './style.js'
import { dedupeFootprints } from './buildings.js'
import { detectChimneys } from './chimneys.js'
import { detectTrees } from './trees.js'
import { createParticles } from './particles.js'
import {
  seasonParams, AUTUMN_CROWN_COLORS, BLOSSOM_COLORS, SPRING_LEAF, TWIG_COLOR,
} from './seasons.js'

// BVH-accelererade raycasts — terrängen är ~500k trianglar och sveps
// 288 gånger per dagsfönster.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const SKY_DAY = new THREE.Color(0x87b5dd)
const SKY_LOW = new THREE.Color(0xd9a06b)
const SKY_NIGHT = new THREE.Color(0x101522)

// Säsongstintade varianter av ljus och himmel (lerpas i setSeason).
const SKY_DAY_WINTER = new THREE.Color(0xb9cad9)
const SKY_DAY_AUTUMN = new THREE.Color(0x8fb3d4)
const SKY_LOW_AUTUMN = new THREE.Color(0xe2a05e)
const SUN_COLOR = new THREE.Color(0xfff3e0)
const SUN_WINTER = new THREE.Color(0xe9f1ff)
const SUN_AUTUMN = new THREE.Color(0xffe0b0)
const HEMI_SKY = new THREE.Color(0xbdd4ee)
const HEMI_SKY_WINTER = new THREE.Color(0xcfe0f2)
const HEMI_GROUND = new THREE.Color(0x3a3a33)
const HEMI_GROUND_SNOW = new THREE.Color(0x9aa3ad)

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
  // Brantare default-vinkel så att markören på gården syns över taken.
  camera.position.set(90, 260, 130)

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
  // Utan normalBias blir flacka, lätt ojämna tak spräckliga av
  // självskuggningsbrus när solen står lågt.
  sunLight.shadow.normalBias = 1.2
  scene.add(sunLight, sunLight.target)

  const hemi = new THREE.HemisphereLight(0xbdd4ee, 0x3a3a33, 0.75)
  scene.add(hemi)

  // Säsongsuniforms: delas av terräng-, väg- och takmaterialen så att
  // hela scenen byter årstid med fem float-skrivningar (terrängen är
  // ~500k trianglar — CPU-omfärgning per sliderdrag vore för dyrt).
  const seasonUniforms = {
    uSnow: { value: 0 },
    uFrost: { value: 0 },
    uDull: { value: 0 },
    uLitter: { value: 0 },
    uIce: { value: 0 },
  }

  // --- Terräng ---
  const terrainMesh = makeTerrain(data.terrain, seasonUniforms)
  scene.add(terrainMesh)
  // Låt marken skugga sig själv i kuperad terräng.
  if (data.terrain.mode === 'dsm') terrainMesh.castShadow = true

  // Skuggvärlden för raycast: hus med laserhöjder, ingen vegetation.
  // Osynlig — visuellt visas fulla DSM:en (med träd).
  let occluderMesh = null
  if (data.terrain.occluderGrid) {
    occluderMesh = makeGridMesh(
      data.terrain, data.terrain.occluderGrid, new THREE.MeshBasicMaterial()
    )
    occluderMesh.visible = false
    scene.add(occluderMesh)
  }

  // --- Vägar (kosmetik, ingår inte i skuggberäkningen) ---
  if (data.roads?.length)
    scene.add(makeRoads(data.roads, data.terrain, seasonUniforms))

  // --- Byggnader (extruderade hus med per-hus-material; i DSM-läget rent
  // visuella — skuggvärlden är laser-occludern ovan) ---
  // Fönstren glöder när solen är nere; uniformen delas av alla väggmaterial
  // och drivs från setSun.
  const nightUniform = { value: 0 }
  const styleCache = new Map()
  const materialsFor = (id) => {
    const s = pickBuildingStyle(id)
    const key = `${s.wallColor}:${s.roofColor}`
    let mats = styleCache.get(key)
    if (!mats) {
      mats = {
        wall: makeWallMaterial(s.wallColor, nightUniform),
        roof: makeRoofMaterial(s.roofColor, seasonUniforms),
      }
      styleCache.set(key, mats)
    }
    return mats
  }
  const buildingsGroup = new THREE.Group()
  for (const b of dedupeFootprints(data.buildings)) {
    // Med laserdata: skarpa väggar till takfoten + laserformat tak
    // (nockar, valmningar) och skorstenar. Annars: platt låda.
    const mesh = data.terrain.sampleOccluder
      ? makeLaserBuilding(b, data.terrain, materialsFor(b.id))
      : makeBuilding(b, data.terrain, materialsFor(b.id))
    if (mesh) buildingsGroup.add(mesh)
  }
  scene.add(buildingsGroup)

  // --- Träd (instansierade stam + krona per detekterat träd; skuggar
  // visuellt men ingår inte i sol-occludern — medvetet) ---
  const t = data.terrain
  let updateTreeSeason = () => {}
  if (t.classGrid && t.canopyGrid && t.groundGrid) {
    const trees = makeTreesGroup(t)
    scene.add(trees.group)
    updateTreeSeason = trees.updateSeason
  }

  // --- Uteplatsmarkören (på marknivå, även om DSM:en skulle ha fångat
  // ett parasoll eller en trädkrona över punkten) ---
  const groundY = data.terrain.sampleGround(0, 0)
  const eyeHeight = 1.2
  const samplePoint = new THREE.Vector3(0, groundY + eyeHeight, 0)

  const marker = new THREE.Group()
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.4, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xd62828 })
  )
  pole.position.y = groundY + 6
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xd62828, emissive: 0x801010, emissiveIntensity: 0.6,
    })
  )
  dot.position.y = groundY + 12
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(4, 32),
    new THREE.MeshStandardMaterial({ color: 0xe0c468, roughness: 0.8 })
  )
  pad.rotation.x = -Math.PI / 2
  pad.position.y = groundY + 0.03
  pad.receiveShadow = true
  marker.add(pole, dot, pad)
  scene.add(marker)

  // --- Säsongspartiklar (snöfall, fallande löv) — egen loop som bara
  // körs när intensiteten är > 0 (renderNow är hoisted) ---
  const particles = createParticles({ scene, renderNow, groundY })

  // Raycasts sker innan första renderingen (init-beräkningen av dagens
  // solfönster) — bygg världsmatriserna explicit, annars träffar strålarna
  // oroterad/oplacerad geometri.
  scene.updateMatrixWorld(true)

  // Med laser-occluder: den ENSAM är skuggvärlden (innehåller mark + hus
  // med uppmätta takformer). De extruderade husen är då bara visuella.
  const occluders = occluderMesh
    ? [occluderMesh]
    : [terrainMesh, buildingsGroup]

  // Säsongstintade ljus-/himmelsfärger — muteras i setSeason så att
  // setSun (som körs vid varje sliderevent) förblir allokeringsfri.
  const skyDaySeason = SKY_DAY.clone()
  const skyLowSeason = SKY_LOW.clone()
  const _sky = new THREE.Color()
  const _mix = new THREE.Color()
  let hemiSnowBoost = 0

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
    // snötäcket studsar upp himmelsljus — lite extra ambient på vintern
    hemi.intensity = (0.12 + 0.63 * dayness) * (1 + hemiSnowBoost)
    // Fönstren tänds i skymningen: fullt sken strax under horisonten.
    nightUniform.value = THREE.MathUtils.clamp(
      (0.03 - sun.altitude) / 0.08, 0, 1
    )
    const sky =
      sun.altitude <= 0
        ? SKY_NIGHT
        : _sky.copy(skyLowSeason).lerp(skyDaySeason, dayness)
    scene.background.copy(sky)
  }

  const flatGround = !(
    data.terrain.mode === 'dtm' || data.terrain.mode === 'dsm'
  )

  function setSeason(p) {
    seasonUniforms.uSnow.value = p.snowCover
    seasonUniforms.uFrost.value = p.frost
    seasonUniforms.uDull.value = p.groundDull
    seasonUniforms.uLitter.value = p.leafLitter
    seasonUniforms.uIce.value = p.ice
    // Platt mark saknar vertexfärger/attribut — tona materialfärgen direkt.
    if (flatGround) {
      terrainMesh.material.color
        .copy(COLOR_GROUND)
        .lerp(_mix.setHex(0x99906f), p.groundDull)
        .lerp(_mix.setHex(0xc9ccc2), p.frost * 0.8)
        .lerp(_mix.setHex(0xedf2f7), p.snowCover)
    }
    updateTreeSeason(p)
    skyDaySeason
      .copy(SKY_DAY)
      .lerp(SKY_DAY_AUTUMN, p.autumness)
      .lerp(SKY_DAY_WINTER, p.winterness)
    skyLowSeason.copy(SKY_LOW).lerp(SKY_LOW_AUTUMN, p.autumness)
    sunLight.color
      .copy(SUN_COLOR)
      .lerp(SUN_AUTUMN, p.autumness * 0.7)
      .lerp(SUN_WINTER, p.winterness)
    hemi.color.copy(HEMI_SKY).lerp(HEMI_SKY_WINTER, p.winterness)
    hemi.groundColor.copy(HEMI_GROUND).lerp(HEMI_GROUND_SNOW, p.snowCover)
    hemiSnowBoost = 0.2 * p.snowCover
    particles.setIntensity({
      snow: p.snowfallIntensity, leaf: p.leafFallIntensity,
    })
  }

  function renderNow() {
    renderer.render(scene, camera)
  }

  // Rendera på begäran i stället för 60 fps — scenen är statisk mellan
  // interaktioner och terrängen är tung (~500k trianglar). Medan
  // partikelloopen kör renderar den varje frame; då är detta en no-op.
  let renderPending = false
  function requestRender() {
    if (renderPending || particles.running) return
    renderPending = true
    requestAnimationFrame(() => {
      renderPending = false
      renderNow()
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

  return { requestRender, setSun, setSeason, samplePoint, occluders }
}

// Mälarens yta ligger ~0,86 möh (RH 2000); DTM:n är hydro-utplattad så
// allt under den här nivån är vatten.
const WATER_LEVEL = 1.2
const COLOR_GROUND = new THREE.Color(0x8a9a7b)
const COLOR_WATER = new THREE.Color(0x3e6f9e)
// Cellklasser från pipelinen: 0 mark, 1 vatten, 2 byggnad, 3 vegetation.
// Basytan är ren mark (hus och träd ritas som egna objekt ovanpå):
// byggnadsceller blir gårds-/gatuyta, vegetationsceller gräs.
const CLASS_COLORS = [
  COLOR_GROUND,
  COLOR_WATER,
  new THREE.Color(0x9b9183),
  new THREE.Color(0x74905e),
]

// Höjdgrid → roterat mesh i markplanet, med BVH för snabba raycasts.
function makeGridMesh(terrain, grid, material) {
  const seg = terrain.gridSize - 1
  const geo = new THREE.PlaneGeometry(
    terrain.areaSize, terrain.areaSize, seg, seg
  )
  const pos = geo.attributes.position
  const z0 = terrain.originElevation
  for (let i = 0; i < pos.count; i++) pos.setZ(i, grid[i] - z0)
  geo.computeVertexNormals()
  geo.computeBoundsTree()
  const mesh = new THREE.Mesh(geo, material)
  mesh.rotation.x = -Math.PI / 2 // XY-plan → XZ-plan, +y → −z (norr)
  return mesh
}

function makeTerrain(terrain, seasonUniforms) {
  const size = terrain.areaSize
  let geo
  let material
  if (terrain.mode === 'dtm' || terrain.mode === 'dsm') {
    const seg = terrain.gridSize - 1
    geo = new THREE.PlaneGeometry(size, size, seg, seg)
    const pos = geo.attributes.position
    const z0 = terrain.originElevation
    const colors = new Float32Array(pos.count * 3)
    // I DSM-läget ritas ren mark (utan hus/träd) — husen är extruderade
    // objekt och träden instansierade modeller ovanpå.
    const heightGrid =
      terrain.mode === 'dsm' && terrain.groundGrid
        ? terrain.groundGrid
        : terrain.grid
    // PlaneGeometry: rad 0 = +y (norr efter rotation), vänster→höger = +x.
    for (let i = 0; i < pos.count; i++) {
      const elev = heightGrid[i]
      pos.setZ(i, elev - z0)
      const c = terrain.classGrid
        ? CLASS_COLORS[terrain.classGrid[i]] ?? COLOR_GROUND
        : elev < WATER_LEVEL
          ? COLOR_WATER
          : COLOR_GROUND
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // Säsongsmasker: vatten ur klassgriden (fryser till is), lövförna
    // i en avklingande zon kring vegetationsceller.
    const water = new Float32Array(pos.count)
    for (let i = 0; i < pos.count; i++) {
      water[i] = terrain.classGrid
        ? terrain.classGrid[i] === 1 ? 1 : 0
        : heightGrid[i] < WATER_LEVEL ? 1 : 0
    }
    geo.setAttribute('aWater', new THREE.BufferAttribute(water, 1))
    const litter = terrain.classGrid
      ? litterMask(terrain.classGrid, terrain.gridSize)
      : new Float32Array(pos.count)
    geo.setAttribute('aLitter', new THREE.BufferAttribute(litter, 1))
    geo.computeVertexNormals()
    material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1,
    })
    injectSeasonTint(material, seasonUniforms, {
      masks: true,
      glsl: `
        float upness = smoothstep(0.45, 0.8, normalize(vSeaNormal).y);
        if (vWater > 0.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.81, 0.86, 0.90), uIce);
        } else {
          float luma = dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2));
          diffuseColor.rgb = mix(diffuseColor.rgb,
            vec3(luma * 1.05, luma * 0.95, luma * 0.75), uDull);
          diffuseColor.rgb = mix(diffuseColor.rgb,
            vec3(0.60, 0.48, 0.27), uLitter * vLitter * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb,
            vec3(0.79, 0.80, 0.76), uFrost * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb,
            vec3(0.93, 0.95, 0.97), uSnow * upness);
        }`,
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

/**
 * Injicerar säsongstintning av diffusfärgen i ett standardmaterial.
 * Världsnormalen skickas som egen varying — terrängen är roterad −π/2 och
 * chunkarnas `normal` är view-space, så den duger inte för "uppåthet".
 * Samma injektionspunkt som fönstershadern (efter färg, före ljussättning).
 */
function injectSeasonTint(mat, seasonUniforms, { masks = false, glsl }) {
  mat.onBeforeCompile = (shader) => {
    for (const k of Object.keys(seasonUniforms))
      shader.uniforms[k] = seasonUniforms[k]
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vSeaNormal;` +
          (masks
            ? `
        attribute float aWater;
        attribute float aLitter;
        varying float vWater;
        varying float vLitter;`
            : '')
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSeaNormal = normalize(mat3(modelMatrix) * objectNormal);` +
          (masks
            ? `
        vWater = aWater;
        vLitter = aLitter;`
            : '')
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uSnow;
        uniform float uFrost;
        uniform float uDull;
        uniform float uLitter;
        uniform float uIce;
        varying vec3 vSeaNormal;` +
          (masks
            ? `
        varying float vWater;
        varying float vLitter;`
            : '')
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          ${glsl}
        }`
      )
  }
  return mat
}

// Lövförnemask: närhet till vegetationsceller (klass 3) med linjär
// avklingning — två separabla max-pass (rader, sedan kolumner).
function litterMask(classGrid, size) {
  const R = 3
  const tmp = new Float32Array(classGrid.length)
  const out = new Float32Array(classGrid.length)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let m = 0
      for (let d = -R; d <= R; d++) {
        const cc = c + d
        if (cc < 0 || cc >= size) continue
        if (classGrid[r * size + cc] !== 3) continue
        const v = 1 - Math.abs(d) / (R + 1)
        if (v > m) m = v
      }
      tmp[r * size + c] = m
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) {
      let m = 0
      for (let d = -R; d <= R; d++) {
        const rr = r + d
        if (rr < 0 || rr >= size) continue
        const v = tmp[rr * size + c] * (1 - Math.abs(d) / (R + 1))
        if (v > m) m = v
      }
      out[r * size + c] = m
    }
  }
  return out
}

// Tak: snön lägger sig på flacka ytor; branta tak fäller den.
function makeRoofMaterial(color, seasonUniforms) {
  return injectSeasonTint(
    new THREE.MeshStandardMaterial({ color, roughness: 0.85 }),
    seasonUniforms,
    {
      glsl: `
        float upness = smoothstep(0.35, 0.75, normalize(vSeaNormal).y);
        diffuseColor.rgb = mix(diffuseColor.rgb,
          vec3(0.93, 0.95, 0.97), uSnow * upness);`,
    }
  )
}

// Vägar som plana band draperade strax ovanför terrängen.
function makeRoads(roads, terrain, seasonUniforms) {
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
      const y00 = terrain.sampleGround(e0 + px, n0 + pn) + lift
      const y01 = terrain.sampleGround(e0 - px, n0 - pn) + lift
      const y10 = terrain.sampleGround(e1 + px, n1 + pn) + lift
      const y11 = terrain.sampleGround(e1 - px, n1 - pn) + lift
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
      const yc = terrain.sampleGround(e, n) + lift
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
    injectSeasonTint(
      new THREE.MeshStandardMaterial({ color: 0x6e6e6e, roughness: 0.95 }),
      seasonUniforms,
      {
        // halv styrka: vägarna läses som plogade/körda
        glsl: `
        float upness = smoothstep(0.45, 0.8, normalize(vSeaNormal).y);
        diffuseColor.rgb = mix(diffuseColor.rgb,
          vec3(0.88, 0.90, 0.92), uSnow * 0.45 * upness);`,
      }
    )
  )
  mesh.receiveShadow = true
  return mesh
}

function pointInPolygon(e, n, fp) {
  let inside = false
  for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
    const [xi, yi] = fp[i]
    const [xj, yj] = fp[j]
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

/**
 * Hus med skarpa väggar och laserformat tak: väggarna extruderas från
 * lägsta markpunkten till takfoten (15:e percentilen av laserytan inom
 * fotavtrycket), och taket är ett 1 m-grid av laserytan, klippt mot
 * fotavtrycket och nedvikt till takfoten i kanterna.
 *
 * mats: { wall, roof }. Spikar som medianfiltret tar bort blir skorstenar.
 */
function makeLaserBuilding(b, terrain, mats) {
  const ring = b.footprint
  if (ring.length < 4) return null

  let baseY = Infinity
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [e, n] of ring) {
    baseY = Math.min(baseY, terrain.sampleGround(e, n))
    x0 = Math.min(x0, e); x1 = Math.max(x1, e)
    y0 = Math.min(y0, n); y1 = Math.max(y1, n)
  }

  // Laserytan i husets celler → takfot (p15) och fallback-höjd
  const heights = []
  const inside = new Map()
  for (let n = Math.floor(y0); n <= Math.ceil(y1); n++) {
    for (let e = Math.floor(x0); e <= Math.ceil(x1); e++) {
      if (pointInPolygon(e, n, ring)) {
        const h = terrain.sampleOccluder(e, n)
        inside.set(`${e},${n}`, h)
        heights.push(h)
      }
    }
  }
  if (heights.length < 6) return makeBuilding(b, terrain, mats)

  // Rå yta innan filtret — spikarna som filtreras bort är skorstenarna.
  const rawInside = new Map(inside)

  // Takytan jämnas i tre pass: 2× 3×3-median (tar punktspikar —
  // skorstenar/antenner — men bevarar nockar, som har stöd längs hela sin
  // längd) och därefter ett medelvärdespass begränsat till ±0,35 m, som
  // tar laserbrusets småbucklor utan att äta upp nock- och takkupskanter.
  const medianPass = (src) => {
    const out = new Map()
    for (const key of src.keys()) {
      const [e, n] = key.split(',').map(Number)
      const neigh = []
      for (let dn = -1; dn <= 1; dn++) {
        for (let de = -1; de <= 1; de++) {
          const v = src.get(`${e + de},${n + dn}`)
          if (v !== undefined) neigh.push(v)
        }
      }
      neigh.sort((a, c) => a - c)
      out.set(key, neigh[Math.floor(neigh.length / 2)])
    }
    return out
  }
  const cappedMeanPass = (src, cap) => {
    const out = new Map()
    for (const key of src.keys()) {
      const [e, n] = key.split(',').map(Number)
      let sum = 0
      let count = 0
      for (let dn = -1; dn <= 1; dn++) {
        for (let de = -1; de <= 1; de++) {
          const v = src.get(`${e + de},${n + dn}`)
          if (v !== undefined) {
            sum += v
            count++
          }
        }
      }
      const v0 = src.get(key)
      const mean = sum / count
      out.set(key, v0 + Math.max(-cap, Math.min(cap, mean - v0)))
    }
    return out
  }
  const smoothed = cappedMeanPass(medianPass(medianPass(inside)), 0.35)
  for (const [key, v] of smoothed) inside.set(key, v)

  // Takfot: p15 av laserytan — men bara av celler som faktiskt ligger uppe
  // på huset. Celler nära marknivå (gårdsgenomsläpp, kantfel där fotavtrycket
  // sticker ut över gatan) drar annars ner takfoten så att takkjolen
  // draperar hela fasaden.
  heights.sort((a, c) => a - c)
  const tall = heights.filter((h) => h > baseY + 2.5)
  const pool = tall.length >= 6 ? tall : heights
  const eaveY = Math.max(
    pool[Math.floor(pool.length * 0.15)],
    baseY + 3 // aldrig lägre väggar än ~en våning
  )
  // Tak-tak: trädkronor som hänger in över fotavtrycket bakas in i
  // laserytan som stora bulor. Kapa ytan strax över p92 — nocken har stöd
  // i många celler och överlever, bulorna klipps.
  const ridgeCap = pool[Math.floor(pool.length * 0.92)] + 1

  const group = new THREE.Group()

  // Väggar: extrudering bas → takfot
  const shape = new THREE.Shape()
  shape.moveTo(ring[0][0], ring[0][1])
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i][0], ring[i][1])
  shape.closePath()
  const wallGeo = new THREE.ExtrudeGeometry(shape, {
    depth: eaveY - baseY,
    bevelEnabled: false,
  })
  const walls = new THREE.Mesh(wallGeo, mats.wall)
  walls.rotation.x = -Math.PI / 2
  walls.position.y = baseY
  walls.castShadow = true
  walls.receiveShadow = true
  group.add(walls)

  // Tak: grid över bbox; utanför fotavtrycket viks ytan ner till takfoten,
  // trianglar helt utanför klipps bort.
  const cols = Math.ceil(x1) - Math.floor(x0) + 1
  const rows = Math.ceil(y1) - Math.floor(y0) + 1
  const verts = []
  const tris = []
  const heightAt = (e, n) => {
    const h = inside.get(`${e},${n}`)
    // Utanför fotavtrycket viks ytan ner en bit UNDER takfoten (in bakom
    // väggen) och innanför ligger den strax ÖVER — ligger något av dem
    // exakt i takfotsplanet z-fightas det med väggens topplock till ett
    // vitt flimmer.
    if (h === undefined) return eaveY - 0.6
    return Math.min(Math.max(h, eaveY + 0.05), ridgeCap)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const e = Math.floor(x0) + c
      const n = Math.floor(y0) + r
      verts.push(e, heightAt(e, n), -n)
    }
  }
  const isIn = (r, c) =>
    inside.has(`${Math.floor(x0) + c},${Math.floor(y0) + r}`)
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const bb = a + 1
      const cc = a + cols
      const dd = cc + 1
      // hoppa över rutor som helt saknar kontakt med huset
      if (!isIn(r, c) && !isIn(r, c + 1) && !isIn(r + 1, c) && !isIn(r + 1, c + 1))
        continue
      tris.push(a, bb, cc, bb, dd, cc)
    }
  }
  const roofGeo = new THREE.BufferGeometry()
  roofGeo.setAttribute(
    'position', new THREE.BufferAttribute(new Float32Array(verts), 3)
  )
  roofGeo.setIndex(tris)
  roofGeo.computeVertexNormals()
  const roof = new THREE.Mesh(roofGeo, mats.roof)
  roof.castShadow = true
  roof.receiveShadow = true
  group.add(roof)

  // Skorstenar där rå laseryta sticker upp över den utjämnade takytan.
  // Höjderna i kartorna är redan i scen-Y (samplern drar av origonivån).
  const chimneys = detectChimneys(rawInside, inside)
    .filter((ch) => ch.cells >= 2) // encellsspikar är fläktar/antenner
    .sort((a, c) => c.cells - a.cells)
    .slice(0, 5) // de största murstockarna räcker
  for (const ch of chimneys) {
    // följ med ner om takytan kapats (ridgeCap)
    const base = Math.min(ch.base, ridgeCap)
    const h = ch.top - ch.base + 0.4 // nedsänkt 0,4 m i taket
    const box = new THREE.Mesh(CHIMNEY_GEO, CHIMNEY_MAT)
    box.scale.set(1, h, 1)
    box.position.set(ch.e, base - 0.4 + h / 2, -ch.n)
    box.castShadow = true
    group.add(box)
  }

  group.userData.id = b.id
  return group
}

const CHIMNEY_GEO = new THREE.BoxGeometry(0.9, 1, 0.9)
const CHIMNEY_MAT = new THREE.MeshStandardMaterial({
  color: 0x5a4339, roughness: 0.95,
})

function makeBuilding(b, terrain, mats) {
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
  // Lasermätt takhöjd (absolut möh) går före OSM-uppskattningen.
  const totalHeight =
    b.roofElevation != null && terrain.originElevation != null
      ? b.roofElevation - terrain.originElevation - baseY
      : topGround - baseY + b.height + (terrain.buildingExtra ?? 0)

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
  const mesh = new THREE.Mesh(geo, mats.wall)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = baseY
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.id = b.id
  return mesh
}

/**
 * Väggmaterial med procedurella fönster: ett rutnät (våningar ~3 m,
 * fönsterfack ~2,4 m) målas i fragmentshadern på alla nära vertikala ytor,
 * i världskoordinater (u = läge längs väggen, v = höjd). Mörkt glas på
 * dagen; på natten lyser ett slumpmässigt urval av fönstren varmt via den
 * delade uNight-uniformen (sätts i setSun).
 */
function makeWallMaterial(color, nightUniform) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = nightUniform
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWinPos;
        varying vec3 vWinNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWinPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWinNormal = normalize(mat3(modelMatrix) * objectNormal);`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying vec3 vWinPos;
        varying vec3 vWinNormal;
        float winHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 nw = normalize(vWinNormal);
          if (abs(nw.y) < 0.45) {
            // u längs väggen (tangent i markplanet), v = höjd över havet
            vec2 tang = normalize(vec2(-nw.z, nw.x));
            float u = dot(vWinPos.xz, tang);
            float v = vWinPos.y;
            vec2 cell = vec2(floor(u / 2.4), floor(v / 3.0));
            vec2 f = vec2(fract(u / 2.4), fract(v / 3.0));
            float win =
              step(0.32, f.x) * step(f.x, 0.68) *
              step(0.34, f.y) * step(f.y, 0.82);
            if (win > 0.5) {
              // mörkt blågrått glas med svag spegelkänsla
              diffuseColor.rgb = mix(
                diffuseColor.rgb, vec3(0.15, 0.18, 0.23), 0.88
              );
              // ~hälften av fönstren tända på natten, varmt sken
              float lit = step(0.5, winHash(cell));
              totalEmissiveRadiance +=
                vec3(1.0, 0.72, 0.38) * (uNight * lit * 1.6);
            }
          }
        }`
      )
  }
  return mat
}

// Krontyper: klot (lövträd), bred oval (gamla lövträd), kägla (barrträd).
const CROWN_TYPES = [
  { geo: new THREE.SphereGeometry(1, 8, 6), oval: false },
  { geo: new THREE.SphereGeometry(1, 8, 6), oval: true },
  { geo: new THREE.ConeGeometry(1, 1, 8), oval: false },
]
const TRUNK_GEO = new THREE.CylinderGeometry(0.6, 1, 1, 6)
const TREE_GREENS = [0x4f7a42, 0x5e8a4d, 0x6f9a55, 0x47703f, 0x86975a]
const CONIFER_WINTER = 0x3d5c3a

/**
 * Detekterar enskilda träd ur laserdatan och bygger dem som instansierade
 * stammar + kronor. Variationen (krontyp, storlek, kulör, rotation,
 * lutning) är deterministisk per trädposition — inget träd byter skepnad
 * mellan körningar. Träden ingår inte i sol-occludern (medvetet).
 */
function makeTreesGroup(terrain) {
  const detected = detectTrees({
    classGrid: terrain.classGrid,
    grid: terrain.canopyGrid,
    groundGrid: terrain.groundGrid,
    gridSize: terrain.gridSize,
    areaSize: terrain.areaSize,
  })
  const z0 = terrain.originElevation

  // Gallring: encellsfynd är oftast laserbrus (balkonger, takutsprång) —
  // bort. Träd alldeles intill en husfasad är mest felklassade utsprång;
  // släpp bara igenom någon enstaka.
  const size = terrain.gridSize
  const half = terrain.areaSize / 2
  const nearBuilding = (t) => {
    const col = Math.round(t.e + half)
    const row = Math.round(half - t.n)
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        const c = col + dc
        const r = row + dr
        if (c < 0 || r < 0 || c >= size || r >= size) continue
        if (terrain.classGrid[r * size + c] === 2) return true
      }
    }
    return false
  }
  const trees = detected.filter((t) => {
    if (t.radius < 1.3) return false
    if (nearBuilding(t)) return hashId(`${t.e},${t.n}`) % 6 === 0
    return true
  })

  // Sortera instanserna per krontyp så att varje InstancedMesh får exakt
  // sina träd.
  const byType = CROWN_TYPES.map(() => [])
  for (const t of trees) {
    const h = hashId(`${t.e},${t.n}`)
    const r01 = (n) => ((h >>> n) & 0xff) / 255
    const type = h % 10 <= 5 ? 0 : h % 10 <= 8 ? 1 : 2
    // Nedskalad mot lasern och kapad — träden ska inte dominera husen.
    const height = Math.min((t.top - t.ground) * (0.78 + 0.14 * r01(3)), 13)
    const trunkH = height * (type === 2 ? 0.2 : 0.35)
    const crownH = height - trunkH
    // Kronbredd från det lasermätta kronarealet, men aldrig så smal att
    // trädet blir en pelare (täta trädrader delar celler och får annars
    // pyttesmå radier) — och aldrig bredare än ett gathusträd.
    let crownR = Math.max(t.radius * (0.6 + 0.3 * r01(8)), 1.2)
    crownR = Math.max(crownR, crownH * (type === 2 ? 0.22 : 0.3))
    crownR = Math.min(crownR, 3.5, crownH * 0.8)
    byType[type].push({
      e: t.e, n: t.n, y: t.ground - z0,
      height, trunkH, crownH, crownR,
      rotY: r01(16) * Math.PI * 2,
      tilt: (r01(20) - 0.5) * 0.08,
      // Säsongsfärgerna är deterministiska per träd, precis som formen:
      // samma träd får samma höstkulör varje år.
      summerColor: TREE_GREENS[(h >>> 4) % TREE_GREENS.length],
      autumnColor: AUTUMN_CROWN_COLORS[(h >>> 12) % AUTUMN_CROWN_COLORS.length],
      blossomColor:
        h % 6 === 0 ? BLOSSOM_COLORS[(h >>> 7) % BLOSSOM_COLORS.length] : null,
      jitter: ((h >>> 24) & 0xff) / 255,
    })
  }

  const group = new THREE.Group()
  const dummy = new THREE.Object3D()
  // Löv- och barrkronor behöver olika säsongsbeteende (opacity och
  // skuggor styrs per material) — därför två material.
  const deciduousMat = new THREE.MeshStandardMaterial({
    roughness: 0.95, transparent: true,
  })
  const coniferMat = new THREE.MeshStandardMaterial({ roughness: 0.95 })
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x5d4a36, roughness: 1,
  })

  const allTrees = byType.flat()
  const trunks = new THREE.InstancedMesh(TRUNK_GEO, trunkMat, allTrees.length)
  let ti = 0
  for (const t of allTrees) {
    dummy.position.set(t.e, t.y + t.trunkH / 2 + 0.2, -t.n)
    dummy.rotation.set(0, 0, t.tilt)
    // stammen går en bit upp i kronan så att glipor aldrig syns
    dummy.scale.set(
      0.12 + t.height * 0.02, t.trunkH + t.crownH * 0.3, 0.12 + t.height * 0.02
    )
    dummy.updateMatrix()
    trunks.setMatrixAt(ti++, dummy.matrix)
  }
  trunks.castShadow = true
  group.add(trunks)

  const crownMeshes = []
  CROWN_TYPES.forEach((ct, type) => {
    const list = byType[type]
    if (!list.length) return
    const mesh = new THREE.InstancedMesh(
      ct.geo, type === 2 ? coniferMat : deciduousMat, list.length
    )
    mesh.castShadow = true
    crownMeshes.push({ mesh, list, conifer: type === 2, oval: ct.oval })
    group.add(mesh)
  })

  // Skriver kronornas matriser och färger för en given årstid. Körs en
  // gång per ändrad dag — några hundra instanser, långt under 1 ms.
  const cBase = new THREE.Color()
  const cMix = new THREE.Color()
  function updateSeason(p) {
    for (const { mesh, list, conifer, oval } of crownMeshes) {
      list.forEach((t, i) => {
        let f = 1
        if (conifer) {
          // Barrträd fäller inga barr: mörkare vintergrönt + snöpudring.
          cBase
            .setHex(t.summerColor)
            .lerp(cMix.setHex(CONIFER_WINTER), p.winterness * 0.5)
            .lerp(cMix.set(1, 1, 1), p.snowCover * 0.18)
        } else {
          // Jittern staggar varje träds tajming någon vecka.
          const local = (x) =>
            Math.min(Math.max((x - 0.35 * t.jitter) / 0.65, 0), 1)
          f = local(p.foliage)
          const a = local(p.autumnBlend)
          const b = t.blossomColor ? p.blossom : 0
          if (b > f) f = b // blommande kronor är fulla
          const maturity = f * f * (3 - 2 * f)
          cBase
            .setHex(SPRING_LEAF)
            .lerp(cMix.setHex(t.summerColor), maturity)
            .lerp(cMix.setHex(t.autumnColor), a)
          if (b > 0) cBase.lerp(cMix.setHex(t.blossomColor), b)
          // kal krona = liten gråbrun "riskrona" i kvistton
          cBase.lerp(cMix.setHex(TWIG_COLOR), 1 - f)
        }
        mesh.setColorAt(i, cBase)

        const s = conifer ? 1 : 0.55 + 0.45 * f
        dummy.position.set(t.e, t.y + t.trunkH + t.crownH / 2, -t.n)
        dummy.rotation.set(t.tilt, t.rotY, t.tilt)
        dummy.scale.set(
          t.crownR * (oval ? 1.25 : 1) * s,
          (conifer ? t.crownH : t.crownH / 2) * s,
          t.crownR * s,
        )
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })
      mesh.instanceColor.needsUpdate = true
      mesh.instanceMatrix.needsUpdate = true
      // Fulla kronblobbar som skuggor under kala träd ser fel ut.
      if (!conifer) mesh.castShadow = p.foliage > 0.25
    }
    deciduousMat.opacity = 0.45 + 0.55 * p.foliage
  }

  updateSeason(seasonParams(172)) // sommardefault tills setSeason körs
  return { group, updateSeason }
}
