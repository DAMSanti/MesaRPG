import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { CuboidCollider, CylinderCollider, RigidBody } from '@react-three/rapier'
import { SkeletonUtils } from 'three-stdlib'
import * as THREE from 'three'
import { hashTile, buildingKind, plainsGroundVariant, terrainTexture } from '../terrain'
import { GROUND_BASE_HEIGHT, HEX_SIZE } from '../hexMath'
import { MODEL_SCALE } from './Mech3D'

// MECH-factor multiplier — this file's tree/rock/building/decor scales
// were all tuned by eye against the mech (MODEL_SCALE), not the hex grid,
// same family as HexMap.tsx's own FOG_HEIGHT/AttackEffects.tsx's MECH_FACTOR.
const MECH_FACTOR = MODEL_SCALE / 1.65

// A real, textured .glb tree (public/models/realistic-tree.glb,
// CREDITS.md — CC-BY-4.0, attribution required) instead of procedural
// geometry — two cheaper approaches were tried and both rejected on
// sight: a low-poly pack (Kenney's Nature Kit) baked an unnaturally
// teal/turquoise canopy color into its material, and a bark/leaf-photo-
// on-procedural-cylinders hybrid (extracting just this same model's own
// textures rather than its mesh) still read as "árboles cutres" up
// close — no amount of procedural tuning matched the real geometry.
// ~20k triangles/tree × a forest tile's 1-2 trees × dozens of forest
// tiles on a map is a real cost, accepted per explicit request to use
// the actual downloaded model over a cheaper approximation; SkeletonUtils
// clone (below) keeps each instance to just a new Object3D hierarchy,
// not a duplicated geometry/texture upload.
const TREE_MODEL_URL = '/models/realistic-tree.glb'

// The model's own bounding-box height, normalized to 1 — computed once
// from the shared source scene (not per clone/per tile). Box3
// .setFromObject walks every vertex, and a map can have dozens of
// forest tiles; doing that dozens of times per map load isn't worth it
// when every tree instance is a clone of this same one source anyway.
let treeUnitScale: number | null = null
let treeRawOffset: { x: number; minY: number; z: number } | null = null

// The source .glb's own materials ("trunk", "normal_leaves") carry no
// baseColorTexture three.js's GLTFLoader recognizes — confirmed by
// inspecting the loaded materials directly (mat.map was null on every
// mesh despite the file visibly having real bark/leaf photos baked in,
// however Sketchfab wired them — some non-standard slot/extension
// GLTFLoader doesn't surface as .map). Rather than chase that further,
// wire on the exact same diffuse images already extracted from this
// same .glb for the earlier procedural-tree approach (public/textures/
// CREDITS.md) directly by material name.
const treeTextureLoader = new THREE.TextureLoader()
function loadTreeTexture(url: string): THREE.Texture {
  const tex = treeTextureLoader.load(url)
  tex.colorSpace = THREE.SRGBColorSpace
  // Same anisotropy fix as terrain.ts's own loadPhotoTexture, same
  // reason (three.js defaults this to 1/off on every texture).
  tex.anisotropy = 16
  return tex
}
const barkTexture = loadTreeTexture('/textures/bark-branch.jpg')
const leafTexture = loadTreeTexture('/textures/leaf-sprig.png')

function normalizeTreeSceneOnce(scene: THREE.Group) {
  if (treeUnitScale !== null) return
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  treeUnitScale = size.y > 0 ? 1 / size.y : 1
  const center = new THREE.Vector3()
  box.getCenter(center)
  // Rest the trunk base on the local origin, centered on X/Z — same
  // "don't assume the source model's own pivot" defensiveness Mech3D.tsx
  // applies to its own curated assets, rather than trusting this one
  // Sketchfab export to already be authored that way. Stashed raw (NOT
  // baked into scene.position at this module scale of 1) — RealTree
  // scales each clone by its own per-tile sizeMultiplier, and Three.js
  // doesn't itself scale an object's position by its own scale, so an
  // offset baked in here would only cancel out correctly for a scale of
  // exactly 1 (see RealRock's near-identical bug/fix below for the full
  // explanation — a real user report on rocks, not (yet) trees, but the
  // same latent bug either way).
  treeRawOffset = { x: center.x, minY: box.min.y, z: center.z }
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      // NOT castShadow — a forest-biome map can put 1-2 of these
      // ~20k-triangle trees on nearly every one of its ~100 tiles (all of
      // it real, playable geometry, not a test artifact); shadow-mapping
      // that many overlapping high-poly casters is what actually froze
      // rendering during testing, not the plain (lit but shadowless)
      // draw. Every other decoration in this file keeps its own
      // castShadow — this is the one deliberate exception, and only
      // because of how much geometry a single tree now carries.
      const mat = obj.material as THREE.MeshStandardMaterial
      if (mat.name === 'trunk') {
        mat.map = barkTexture
      } else if (mat.name === 'normal_leaves') {
        mat.map = leafTexture
      }
      mat.needsUpdate = true
      // The model's own leaf material uses real alpha BLEND, which needs
      // correct back-to-front triangle order to look right — three.js
      // only sorts per-OBJECT, not per-triangle, so a forest of
      // overlapping tree instances in BLEND mode showed real "wrong leaf
      // drawn in front of a nearer one" artifacts. alphaTest is a hard
      // cutout instead — same trade this file's own (now-retired)
      // procedural leaf cards already made.
      if (mat.transparent) {
        mat.transparent = false
        mat.alphaTest = 0.5
        mat.depthWrite = true
      }
    }
  })
}

// Normalized-to-1-unit-tall → world-unit conversion, tuned to roughly
// match this game's own hex/mech scale (Mech3D's MODEL_SCALE is its
// equivalent for the mech model) — MECH-factor scaled.
const TREE_BASE_SCALE = 2.2 * MECH_FACTOR

/** One real tree instance. `sizeMultiplier` varies the final height per
 * tile (see the two TerrainDecor call sites below) so a forest doesn't
 * read as one model copy-pasted at a single fixed size. */
function RealTree({ sizeMultiplier }: { sizeMultiplier: number }) {
  const { scene } = useGLTF(TREE_MODEL_URL)
  normalizeTreeSceneOnce(scene)
  const instance = useMemo(() => {
    const clone = SkeletonUtils.clone(scene) as THREE.Group
    const finalScale = (treeUnitScale ?? 1) * TREE_BASE_SCALE * sizeMultiplier
    clone.scale.setScalar(finalScale)
    if (treeRawOffset) {
      clone.position.set(-treeRawOffset.x * finalScale, -treeRawOffset.minY * finalScale, -treeRawOffset.z * finalScale)
    }
    return clone
  }, [scene, sizeMultiplier])
  return <primitive object={instance} />
}
useGLTF.preload(TREE_MODEL_URL)

// Real .glb rock/debris-chunk models (public/models, CREDITS.md — Poly
// Haven, CC0, no attribution required) for 'rough' and 'rubble' tiles'
// decoration, per explicit request for "modelos de rocas"/"modelos 3d de
// trozos grandes de escombros" rather than another procedural shape —
// same reasoning the tree model above already established (a real scanned
// mesh reads as genuinely rocky/ruined in a way procedural geometry
// hasn't). Each already simplified offline (gltf-transform weld +
// simplify) from a much heavier photogrammetry source down to roughly
// 2.5k-5k triangles — a single rock/debris instance or two per tile,
// scattered across however many 'rough'/'rubble' tiles a map has, not
// the "dozens of trees per forest tile" scale that made the tree's own
// cost (shadows, colliders) worth trimming so aggressively.
const ROCK_BOULDER_URL = '/models/rock-boulder.glb' // Poly Haven "Rock 09" — rounded natural boulder
const ROCK_FACE_URL = '/models/rock-face.glb' // Poly Haven "Rock Face 01" — angular broken-looking chunk; reused untinted for 'rough' and grey-tinted for 'rubble' (see RUBBLE_CHUNK_TINT below)
const RUBBLE_BLOCK_URL = '/models/rubble-block.glb' // Poly Haven "Concrete Road Barrier" — an actual man-made concrete slab, the clearest "urban debris" read of the three

// Per-model-URL cache (unlike the tree's single module-level variable —
// three different rock models here, each with its own bounding box) of
// the bounding-box-normalized-to-1-unit-tall scale factor AND the raw
// (unscaled) centering offset, computed once from each model's own
// shared source scene, not per clone/per tile.
const rockUnitScale = new Map<string, number>()
const rockRawOffset = new Map<string, { x: number; minY: number; z: number }>()
function normalizeRockSceneOnce(url: string, scene: THREE.Group) {
  if (rockUnitScale.has(url)) return
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  rockUnitScale.set(url, size.y > 0 ? 1 / size.y : 1)
  const center = new THREE.Vector3()
  box.getCenter(center)
  // NOT baked into scene.position here (that was the bug — see RealRock's
  // own comment below). Stashed raw so each instance can scale it by its
  // OWN final scale instead.
  rockRawOffset.set(url, { x: center.x, minY: box.min.y, z: center.z })
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
}

const ROCK_BASE_SCALE = 0.5 * MECH_FACTOR

/** One real rock/debris-chunk instance. `tint`, when given, clones (never
 * mutates the shared source material in place — every other instance of
 * the same model, tinted or not, would otherwise shift too) and recolors
 * it, the same "same geometry, different story" reuse rock-face.glb gets
 * between 'rough' (its own natural stone color) and 'rubble' (dusty grey
 * concrete).
 *
 * The centering offset is computed HERE, scaled by THIS instance's own
 * final scale — not once on the shared scene at module scale 1, the
 * earlier (buggy) version's approach. Three.js composes an object's
 * transform as `world = position + rotation·(scale⊙localVertex)`: the
 * position offset is NOT itself multiplied by the object's own scale, so
 * baking a raw/unscaled offset into the shared source scene only
 * happened to cancel out correctly for a scale of exactly 1. Every
 * instance here uses a per-tile sizeMultiplier != 1, so the old approach
 * left a real, scale-dependent residual offset in both X/Z (rocks
 * drifting off their own tile, sometimes onto a neighbor's) and Y (rocks
 * floating above or sinking below the ground) — real user report, with
 * screenshots showing both. */
function RealRock({ url, sizeMultiplier, tint }: { url: string; sizeMultiplier: number; tint?: string }) {
  const { scene } = useGLTF(url)
  normalizeRockSceneOnce(url, scene)
  const instance = useMemo(() => {
    const clone = scene.clone(true)
    const finalScale = (rockUnitScale.get(url) ?? 1) * ROCK_BASE_SCALE * sizeMultiplier
    clone.scale.setScalar(finalScale)
    const offset = rockRawOffset.get(url)
    if (offset) {
      clone.position.set(-offset.x * finalScale, -offset.minY * finalScale, -offset.z * finalScale)
    }
    if (tint) {
      clone.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mat = (obj.material as THREE.MeshStandardMaterial).clone()
          mat.color = new THREE.Color(tint)
          obj.material = mat
        }
      })
    }
    return clone
  }, [scene, sizeMultiplier, tint, url])
  return <primitive object={instance} />
}
useGLTF.preload(ROCK_BOULDER_URL)
useGLTF.preload(ROCK_FACE_URL)
useGLTF.preload(RUBBLE_BLOCK_URL)

// Real .glb building model (public/models, CREDITS.md — Sketchfab
// "Skyscraper") for standing 'building' tiles (buildingKind 0-2 —
// ruined kinds 3/4 reuse the same model with a scorch tint below).
// Originally three DIFFERENT real models, one per kind (a highrise, this
// skyscraper, and a hotel) — the other two were ~13.6MB/~100k-vertex and
// ~34.7MB/~250k-vertex respectively, CAD exports whose geometry
// (thousands of per-face split vertices from hard-faceted normals)
// resisted `gltf-transform simplify` even at very loose error tolerances
// (confirmed directly: barely a 10% file-size drop, vertex count nearly
// unchanged). With up to 50-70 building tiles on a city-biome map, that
// was a severe, real stuttering cost ("me va a tirones", direct user
// report) — replaced with this one already-simplified model (1.57MB,
// ~18.5k vertices) for all three kind slots, differentiated by
// BUILDING_KIND_TINT and a per-kind size range below instead of by
// distinct geometry. A straight performance/variety tradeoff the user
// explicitly chose over the alternatives (distance-based LOD, real GPU
// instancing) when asked.
const BUILDING_MODEL_URLS: Record<number, string> = {
  0: '/models/building-skyscraper.glb',
  1: '/models/building-skyscraper.glb',
  2: '/models/building-skyscraper.glb',
}

// Subtle multiply-tints (near-white, so they shift hue without visibly
// darkening) giving the three "kinds" distinct material tones despite
// sharing one mesh now — kind 0 stays the model's own natural color.
const BUILDING_KIND_TINT: Record<number, string | undefined> = {
  0: undefined,
  1: '#dfe6f0',
  2: '#f2e8d6',
}

// Per-kind size-class range (min, spread) applied to the shared jitter()
// below — a real footprint/height range difference (not just color) so
// the three kinds still read as distinct building sizes on the board:
// kind 0 smaller, kind 1 the tallest ("skyscraper"), kind 2 mid-sized.
const BUILDING_KIND_SIZE: Record<number, { min: number; spread: number }> = {
  0: { min: 0.65, spread: 0.3 },
  1: { min: 1.05, spread: 0.45 },
  2: { min: 0.85, spread: 0.35 },
}

// Per-model-URL cache of the bounding-box-normalized-to-1-unit-FOOTPRINT
// scale factor and raw centering offset — footprint (the larger of X/Z),
// not height like RealRock/RealTree use, and deliberately so: these
// three source models are wildly different real-world scales (a ~2-unit
// scan next to a ~100-unit one), and normalizing to a fixed HEIGHT would
// have let the two much-wider-relative-to-their-height ones blow their
// footprint far past a single hex tile's own 0.95 radius — precisely
// the "aparece fuera de su tile" bug a real user report already caught
// once on RealRock (see its own comment above) before this component
// was even written, so it's designed around from the start here instead
// of needing the same fix twice. Height is left to vary naturally per
// model instead — a real building's own proportions, not a forced
// uniform box.
const buildingUnitScale = new Map<string, number>()
const buildingRawOffset = new Map<string, { x: number; minY: number; z: number }>()
function normalizeBuildingSceneOnce(url: string, scene: THREE.Group) {
  if (buildingUnitScale.has(url)) return
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  const footprint = Math.max(size.x, size.z)
  buildingUnitScale.set(url, footprint > 0 ? 1 / footprint : 1)
  const center = new THREE.Vector3()
  box.getCenter(center)
  buildingRawOffset.set(url, { x: center.x, minY: box.min.y, z: center.z })
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      // NOT castShadow — up to 50-70 building tiles can exist on one
      // city-biome map, and shadow-mapping that many instances adds up
      // even for an individually-cheap (~18.5k vertex) model; not worth
      // it for a shadow on a building that's already mostly shadow-toned
      // itself.
      obj.castShadow = false
      obj.receiveShadow = true
    }
  })
}

// Target footprint WIDTH in world units — a hex tile's own radius is
// ~0.98 * HEX_SIZE (diameter ~1.96 * HEX_SIZE), so 1.3 * HEX_SIZE leaves
// a visible margin on a model's longer horizontal axis without needing
// per-model tuning; the shorter axis (these are all rectangular
// footprints, not square) ends up with even more room. HEX-factor scaled
// (explicitly tied to the hex's own radius, unlike TREE_BASE_SCALE/
// ROCK_BASE_SCALE above, which are tuned against the mech instead).
// Height is NOT set directly — it falls out of each model's own real
// aspect ratio once its footprint is pinned to this, which is the whole
// point (see the cache comment above).
const BUILDING_FOOTPRINT_SCALE = 1.3 * HEX_SIZE

/** One real building/skyscraper instance. `tint`, when given, clones
 * (never mutates the shared source material in place) and darkens every
 * material's own color — same "same geometry, different story" reuse
 * RealRock's rock-face.glb already does between 'rough' and 'rubble' —
 * used for ruined buildings (kind 3/4 below) to get a scorched/damaged
 * look on the SAME real detailed mesh, rather than falling back to a
 * plain procedural box next to the other, real-modeled buildings on the
 * same map ("hay algunos tiles de edificio que aun tienen modelos viejos
 * cutres", real user report, screenshot showing exactly that mismatch —
 * no real ruined-building model was available to source instead). */
function RealBuilding({ url, sizeMultiplier, tint }: { url: string; sizeMultiplier: number; tint?: string }) {
  const { scene } = useGLTF(url)
  normalizeBuildingSceneOnce(url, scene)
  const instance = useMemo(() => {
    const clone = scene.clone(true)
    const finalScale = (buildingUnitScale.get(url) ?? 1) * BUILDING_FOOTPRINT_SCALE * sizeMultiplier
    clone.scale.setScalar(finalScale)
    const offset = buildingRawOffset.get(url)
    if (offset) {
      clone.position.set(-offset.x * finalScale, -offset.minY * finalScale, -offset.z * finalScale)
    }
    if (tint) {
      const tintColor = new THREE.Color(tint)
      clone.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mat = (obj.material as THREE.MeshStandardMaterial).clone()
          mat.color = mat.color.clone().multiply(tintColor)
          obj.material = mat
        }
      })
    }
    return clone
  }, [scene, sizeMultiplier, tint, url])
  return <primitive object={instance} />
}
useGLTF.preload(BUILDING_MODEL_URLS[0])

// A handful of cached, canvas-baked leaf silhouettes (alpha-cutout PNG-
// style textures, same "bake it once, no external asset" approach as
// terrain.ts's procedural patterns) — each a distinct outline (oak-ish
// lobed, simple oval, maple-ish pointed) so fallen leaves actually read
// as leaves instead of the flat solid-colour rectangles ("cuadrados
// amarillos") this replaces. Baked once per shape at module load and
// reused by every LeafLitter instance; only the plane's own tint
// (vertex-free — meshStandardMaterial's own `color`) varies per leaf, so
// one shape serves every autumn hue without rebaking the canvas per colour.
type LeafShape = 'oval' | 'lobed' | 'maple'
const leafTextureCache = new Map<LeafShape, THREE.Texture>()
function drawLeafPath(ctx: CanvasRenderingContext2D, size: number, shape: LeafShape) {
  const c = size / 2
  ctx.beginPath()
  if (shape === 'oval') {
    ctx.ellipse(c, c, size * 0.28, size * 0.46, 0, 0, Math.PI * 2)
  } else if (shape === 'lobed') {
    // A simple 3-lobe oak-ish outline via alternating wide/narrow radii.
    const lobes = 6
    for (let i = 0; i <= lobes; i++) {
      const t = i / lobes
      const ang = -Math.PI / 2 + t * Math.PI
      const wobble = i % 2 === 0 ? 1 : 0.72
      const x = c + Math.sin(ang) * size * 0.32 * wobble
      const y = c - Math.cos(ang) * size * 0.46
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    for (let i = lobes; i >= 0; i--) {
      const t = i / lobes
      const ang = -Math.PI / 2 + t * Math.PI
      const wobble = i % 2 === 0 ? 1 : 0.72
      const x = c - Math.sin(ang) * size * 0.32 * wobble
      const y = c - Math.cos(ang) * size * 0.46
      ctx.lineTo(x, y)
    }
    ctx.closePath()
  } else {
    // Pointed maple-ish diamond-with-shoulders silhouette.
    ctx.moveTo(c, c - size * 0.46)
    ctx.lineTo(c + size * 0.3, c - size * 0.05)
    ctx.lineTo(c + size * 0.16, c + size * 0.12)
    ctx.lineTo(c, c + size * 0.46)
    ctx.lineTo(c - size * 0.16, c + size * 0.12)
    ctx.lineTo(c - size * 0.3, c - size * 0.05)
    ctx.closePath()
  }
}
function getLeafTexture(shape: LeafShape): THREE.Texture {
  const cached = leafTextureCache.get(shape)
  if (cached) return cached
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  drawLeafPath(ctx, size, shape)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  // A faint center vein reads well even at this tiny on-screen size,
  // and costs nothing extra since it's baked into the same texture.
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(size / 2, size * 0.1)
  ctx.lineTo(size / 2, size * 0.9)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(canvas)
  leafTextureCache.set(shape, tex)
  return tex
}

// Fallen-leaf litter (forest) / grass tufts (plains) — thin, cheap,
// scattered by a per-decal hash so they land at a different spot/angle
// each time without needing per-tile state. Deliberately sparse (most
// calls return nothing) per the "sin mucha densidad, desperdigado" ask —
// a light dusting of personality, not a lawn's worth of geometry.
const LEAF_SHAPES: LeafShape[] = ['oval', 'lobed', 'maple']
function LeafLitter({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'leaf-litter')
  if (seed % 100 >= 45) return null
  const count = 1 + (seed % 2)
  const colors = ['#a8702f', '#c78a35', '#8a5a26', '#b5893a', '#d9a441', '#7a4a1f']
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `leaf-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        // dist is a position offset (HEX-factor); size/y-clearance are the
        // leaf's own visible size (MECH-factor) — same split as the tree/
        // rock scatter above.
        const dist = (0.12 + ((s >>> 8) % 100) / 100 * 0.6) * HEX_SIZE
        const size = (0.08 + ((s >>> 16) % 100) / 100 * 0.07) * MECH_FACTOR
        const shape = LEAF_SHAPES[s % LEAF_SHAPES.length]
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, 0.015 * MECH_FACTOR, Math.sin(angle) * dist]}
            rotation={[-Math.PI / 2, 0, (s % 628) / 100]}
          >
            <planeGeometry args={[size, size]} />
            <meshStandardMaterial
              map={getLeafTexture(shape)} color={colors[s % colors.length]}
              transparent alphaTest={0.4} side={THREE.DoubleSide}
            />
          </mesh>
        )
      })}
    </group>
  )
}

// Small scattered rocks/gravel — plains' answer to "piedrecitas", also
// used lightly on bare-dirt-variant plains tiles where they read
// naturally as part of the ground. Cheap low-poly icosahedra (never a
// perfect sphere — a rock silhouette needs visible facets), tinted from
// a narrow grey/tan range so a cluster still reads as "stones", not
// confetti.
function Pebbles({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'pebbles')
  if (seed % 100 >= 35) return null
  const count = 1 + (seed % 3)
  const colors = ['#8b8378', '#6f6a62', '#a39a8a', '#5f5b54']
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `pebble-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = (0.08 + ((s >>> 8) % 100) / 100 * 0.7) * HEX_SIZE
        const size = (0.02 + ((s >>> 16) % 100) / 100 * 0.035) * MECH_FACTOR
        const flat = 0.55 + ((s >>> 20) % 100) / 100 * 0.3
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, size * flat * 0.5, Math.sin(angle) * dist]}
            rotation={[(s % 628) / 100, ((s >>> 4) % 628) / 100, ((s >>> 9) % 628) / 100]}
            scale={[1, flat, 1]}
            castShadow
          >
            <icosahedronGeometry args={[size, 0]} />
            <meshStandardMaterial color={colors[s % colors.length]} roughness={0.95} flatShading />
          </mesh>
        )
      })}
    </group>
  )
}

// Two visually distinct "species" instead of one repeated blade cluster
// — a fine three-blade tuft (as before) and a bushier, rounder clump —
// each with its own small colour range so a field doesn't read as one
// model copy-pasted. A dirt-variant plains tile (see
// terrain.ts::plainsGroundVariant) gets noticeably sparser grass, since
// bare earth patches shouldn't be as overgrown as the grass tiles around
// them.
// Three visually distinct "species" — a fine three-blade tuft, a
// bushier rounder clump, and a tall sparse dry-grass pair — each with
// its own colour range so a field doesn't read as one model
// copy-pasted. Threshold/count bumped well up from the original "light
// dusting" density per direct feedback ("hay pocas, variedad y
// cantidad") — most plains tiles now carry several clusters, not a
// minority carrying one. A dirt-variant plains tile (see
// terrain.ts::plainsGroundVariant) still gets noticeably sparser grass,
// since bare earth patches shouldn't be as overgrown as the grass tiles
// around them.
function GrassTufts({ q, r, sparse }: { q: number; r: number; sparse: boolean }) {
  const seed = hashTile(q, r, 'grass-tuft')
  const threshold = sparse ? 45 : 92
  if (seed % 100 >= threshold) return null
  const count = (sparse ? 1 : 2) + (seed % 4)
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `tuft-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        // dist (position offset) is HEX-factor; bladeScale feeds every
        // species' own group `scale` below, so folding MECH_FACTOR in
        // here scales each blade's own geometry without touching their
        // individual local constants.
        const dist = (0.08 + ((s >>> 8) % 100) / 100 * 0.7) * HEX_SIZE
        const bladeScale = (0.7 + ((s >>> 16) % 100) / 100 * 0.5) * MECH_FACTOR
        const px = Math.cos(angle) * dist
        const pz = Math.sin(angle) * dist
        const species = (s >>> 24) % 3
        if (species === 0) {
          // Bushy round clump — several short blades fanned around a
          // center point.
          const palette = ['#5c8a3f', '#4a7332', '#6b9748']
          const blades = 5
          return (
            <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale * 0.85}>
              {Array.from({ length: blades }, (_, b) => {
                const bAng = (b / blades) * Math.PI * 2
                return (
                  <mesh
                    key={b}
                    position={[Math.cos(bAng) * 0.02, 0.045, Math.sin(bAng) * 0.02]}
                    rotation={[Math.sin(bAng) * 0.3, 0, Math.cos(bAng) * 0.3]}
                    castShadow
                  >
                    <coneGeometry args={[0.012, 0.09, 3]} />
                    <meshStandardMaterial color={palette[b % palette.length]} />
                  </mesh>
                )
              })}
            </group>
          )
        }
        if (species === 1) {
          // Tall, sparse dry-grass pair — thinner and taller than the
          // other two species, pale straw tones instead of green, reads
          // as a different plant entirely rather than the same blade
          // recoloured.
          const palette = ['#a89a4e', '#8f8240', '#b8ab63']
          return (
            <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale * 1.15}>
              {[-1, 1].map((lean) => (
                <mesh key={lean} position={[lean * 0.012, 0.09, 0]} rotation={[0, 0, lean * 0.22]} castShadow>
                  <coneGeometry args={[0.007, 0.18, 3]} />
                  <meshStandardMaterial color={palette[lean === -1 ? 0 : 1]} />
                </mesh>
              ))}
            </group>
          )
        }
        // Fine three-blade tuft — the original species.
        const palette = ['#4d7a3d', '#3f6b34', '#5a8a44']
        return (
          <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale}>
            {[-1, 0, 1].map((lean) => (
              <mesh key={lean} position={[lean * 0.015, 0.055, 0]} rotation={[0, 0, lean * 0.35]} castShadow>
                <coneGeometry args={[0.01, 0.11, 3]} />
                <meshStandardMaterial color={palette[lean === 0 ? 0 : 1]} />
              </mesh>
            ))}
          </group>
        )
      })}
    </group>
  )
}

// Absolute world height (not an offset — every tile group sits at y=0,
// see HexMap.tsx's Tile, so this is already world-space) a liquid/mud
// surface's TOP sits at — shared by water's WaterSurface AND swamp's
// MudSurface below, since both are the same underlying idea: a real
// surface is one flat plane at "ground level", never rising above the
// land it borders, however deep any one patch of its own bed happens to
// be. Earlier versions raised WaterSurface's top a fixed amount ABOVE
// each water tile's own (elevation-dependent) height, which for
// 'water_deep' — a lower-elevation tile to begin with — pushed the
// surface well above neighboring land, reading as a solid glass block
// sticking up out of the ground (real user report, with screenshot: "El
// agua no debe salir hacia arriba de la tierra, la superficie debe estar
// a ras de suelo"). Pinning the top to plain ground level (elevation 0's
// own height, 0.3 + 0*0.22) fixes that. Actual depth (see SINK_DEPTH
// below) is then carved DOWNWARD from this fixed line instead of raising
// it — the bottom of the column can sink as far as it needs to without
// ever pushing the top above the shoreline. Whatever lies below y=0 (the
// tile's own groove ring, then the wood table, see HexMap.tsx's Tile /
// TableBackground.tsx) is opaque and sits in front of that sunken
// portion from every normal camera angle, so it's never actually seen —
// there's no visible seam or gap to give away that the column extends
// past where the solid ground physically ends.
//
// +0.002 * HEX_SIZE, not a bare GROUND_BASE_HEIGHT: a plain 'water' (or
// 'swamp') tile (elevation 0) has its OWN underlying floor mesh
// (HexMap.tsx's Tile terrainMesh) top at that exact same height —
// coplanar with this surface's own top cap on the very same tile. Two
// coincident faces at an identical height is a textbook z-fighting
// setup: the GPU can't consistently resolve which one is in front, so it
// flickers pixel-by-pixel into visible banding ("¿Porque se ven esas
// rayas en el agua...?", real user report, screenshot showing exactly
// that striping on plain water tiles specifically — 'water_deep' was
// unaffected, since ITS own floor sits lower, nowhere near this line). A
// couple millimeters of world space is nowhere near enough to read as
// "poking up out of the ground" again, but it's enough to give the depth
// buffer an unambiguous winner — scaled by HEX_SIZE alongside it since
// depth-buffer precision at a given screen depth is relative to the
// scene's own overall distances (camera/shadow frustums all scaled the
// same way — see HexMap.tsx's own shadow-camera-far), not an absolute
// world-unit amount.
export const GROUND_FLUSH_TOP = GROUND_BASE_HEIGHT + 0.002 * HEX_SIZE

// How deep each terrain's surface column reads below that fixed line —
// MECH-factor scaled (tuned by eye against how deep a mech visibly wades,
// same family as HexMap.tsx's own FOG_HEIGHT), against the model's old
// scale (1.65) so the wading depth stays proportionate to the now-much-
// taller mech. water/water_deep tuned by eye per direct user feedback:
// 'water_deep' at 3x plain 'water', a real "wading in deep water" look
// instead of a faint wetting. swamp is shallower than either — "que el
// mech se hunda un poco" (explicitly asked to reuse water's sinking
// effect, but only a little) — bumped once already (see git history) and
// paired with a lighter, glossier mud material (see MudSurface below) so
// the boundary itself is legible, not just technically present.
const SINK_DEPTH: Record<string, number> = {
  water: 0.27 * MECH_FACTOR,
  water_deep: 0.81 * MECH_FACTOR,
  swamp: 0.24 * MECH_FACTOR,
}

/** How far a standing unit's feet should sink for a given terrain — the
 * mirror image of the surface geometry above (GROUND_FLUSH_TOP minus
 * that terrain's SINK_DEPTH), so a mech visually wades in exactly as
 * deep as the water/mud column itself claims to be, rather than standing
 * on an invisible "floor" at the old dry-land elevation height while a
 * much deeper-looking surface surrounds its ankles. `null` for anything
 * that doesn't sink — HexMap.tsx falls back to the normal elevation-based
 * resting height in that case. */
export function terrainSinkY(terrain: string): number | null {
  const depth = SINK_DEPTH[terrain]
  return depth == null ? null : GROUND_FLUSH_TOP - depth
}

/** A water tile's moving surface. Solid geometry spanning the full
 * WATER_DEPTH below WATER_SURFACE_TOP, not a thin floating disc — a
 * thin-disc version left a visible gap between it and the (real photo,
 * water-bed.jpg) lake-bed tile underneath, reading as "floating". Filling
 * that gap with more of the same translucent material instead means the
 * tile's outer rim shows a believable tinted "looking into the water"
 * wall from any angle, including from the side, rather than an empty
 * void. Only the TOP face's texture actually scrolls (see the useFrame
 * below) — the side walls stay a static tint, which is fine, they're
 * rarely the focus. */
function WaterSurface({ terrain, q, r }: { terrain: string; q: number; r: number }) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null)
  const texture = useMemo(() => {
    // Cloned (not the shared base tile texture terrainTexture() itself
    // returns) — cloning shares the same underlying image/canvas (cheap)
    // but gives this surface its own `.offset`, so scrolling it doesn't
    // drag the still lake-bed texture on the tile underneath along with it.
    const tex = terrainTexture('water', q, r).clone()
    tex.needsUpdate = true
    return tex
  }, [q, r])
  // Seeded per-tile phase/direction (hashTile, not Math.random) so a
  // whole lake's tiles don't all ripple in obvious lockstep unison.
  const seed = hashTile(q, r, 'water-flow')
  const dirX = ((seed >>> 4) % 100) / 100 - 0.5
  const dirY = ((seed >>> 12) % 100) / 100 - 0.5
  const phase = ((seed >>> 20) % 628) / 100
  useFrame((state) => {
    const t = state.clock.elapsedTime
    texture.offset.set(dirX * t * 0.05, dirY * t * 0.05)
    // Gentle brightness flicker — real water's surface isn't uniformly
    // lit, it glints as ripples catch the light.
    if (matRef.current) matRef.current.emissiveIntensity = 0.08 + Math.sin(t * 1.3 + phase) * 0.05
  })
  const depth = SINK_DEPTH[terrain] ?? SINK_DEPTH.water
  const bottomY = GROUND_FLUSH_TOP - depth
  return (
    <mesh position={[0, (GROUND_FLUSH_TOP + bottomY) / 2, 0]}>
      <cylinderGeometry args={[0.98 * HEX_SIZE, 0.98 * HEX_SIZE, depth, 6]} />
      <meshStandardMaterial
        ref={matRef}
        map={texture}
        transparent
        opacity={terrain === 'water_deep' ? 0.72 : 0.6}
        color={terrain === 'water_deep' ? '#1c4152' : '#3f7f92'}
        emissive="#bfe8f0"
        emissiveIntensity={0.08}
        roughness={0.25}
        metalness={0.1}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

const BUBBLE_COUNT = 2
// Seconds a single rise-and-pop takes — short and sudden, like a real gas
// bubble breaking the surface, not a slow balloon.
const BUBBLE_RISE_SECONDS = 1.1

/** A couple of small bubbles that rise from the mud and pop at the
 * surface, each on its own long, seeded cycle so a marsh's tiles don't
 * all bubble in visible unison — "a veces se vea burbujas" (sometimes,
 * not a constant fizz) was the explicit ask. */
function MudBubbles({ q, r }: { q: number; r: number }) {
  const meshRefs = useRef<(THREE.Mesh | null)[]>([])
  const seeds = useMemo(
    () => Array.from({ length: BUBBLE_COUNT }, (_, i) => hashTile(q, r, `bubble-${i}`)),
    [q, r],
  )
  const bottomY = GROUND_FLUSH_TOP - SINK_DEPTH.swamp
  const riseFrom = bottomY + SINK_DEPTH.swamp * 0.2
  const riseTo = GROUND_FLUSH_TOP + 0.015 * MECH_FACTOR
  useFrame((state) => {
    const t = state.clock.elapsedTime
    seeds.forEach((seed, i) => {
      const mesh = meshRefs.current[i]
      if (!mesh) return
      const cycle = 4 + (seed % 400) / 100 // 4-8s between bubbles, per slot
      const phase = ((seed >>> 8) % 1000) / 100 // 0-10s stagger so slots desync
      const localT = (t + phase) % cycle
      if (localT > BUBBLE_RISE_SECONDS) {
        mesh.visible = false
        return
      }
      mesh.visible = true
      const p = localT / BUBBLE_RISE_SECONDS
      mesh.position.y = riseFrom + p * (riseTo - riseFrom)
      const growIn = Math.min(p / 0.2, 1)
      const popFade = p > 0.82 ? Math.max(0, (1 - p) / 0.18) : 1
      const maxRadius = (0.013 + ((seed >>> 16) % 100) / 100 * 0.011) * MECH_FACTOR
      mesh.scale.setScalar(maxRadius * growIn * popFade)
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.opacity = 0.75 * popFade
    })
  })
  return (
    <>
      {seeds.map((seed, i) => {
        const angle = (seed % 360) * (Math.PI / 180)
        const dist = ((seed >>> 4) % 100) / 100 * 0.55 * HEX_SIZE
        return (
          <mesh
            key={i}
            ref={(el) => { meshRefs.current[i] = el }}
            position={[Math.cos(angle) * dist, riseFrom, Math.sin(angle) * dist]}
            visible={false}
          >
            <sphereGeometry args={[1, 8, 8]} />
            <meshStandardMaterial color="#8a9a72" transparent opacity={0} roughness={0.15} metalness={0.05} />
          </mesh>
        )
      })}
    </>
  )
}

/** Swamp's answer to WaterSurface — the same flush-to-ground-level,
 * sunk-downward-for-depth geometry (GROUND_FLUSH_TOP/SINK_DEPTH above),
 * but opaque murky mud instead of a translucent scrolling ripple: real
 * mud doesn't let you see through it. Per explicit request to reuse
 * water's sinking effect ("mismo efecto que el agua... que el mech se
 * hunda un poco") plus a real texture and occasional bubbles, rather
 * than inventing a different mechanic from scratch.
 *
 * Two materials (the cylinder's own side vs top/bottom cap groups), not
 * one: a flat single dark tone technically sank a standing mech in by
 * the right amount (confirmed with a direct debug readout) but read as
 * "no se hunde" anyway — real mud's own tone was too close to a typical
 * mech's own dark chassis to leave any visible "line" where one met the
 * other, unlike water's brightly-tinted translucent surface. A lighter,
 * glossier top face (a "wet sheen" the flat sides don't get) gives that
 * boundary a real visual edge to read, at any angle a mech pokes through
 * it — not just a technically-correct number nobody can actually see. */
function MudSurface({ q, r }: { q: number; r: number }) {
  const depth = SINK_DEPTH.swamp
  const bottomY = GROUND_FLUSH_TOP - depth
  return (
    <group>
      <mesh position={[0, (GROUND_FLUSH_TOP + bottomY) / 2, 0]}>
        <cylinderGeometry args={[0.98 * HEX_SIZE, 0.98 * HEX_SIZE, depth, 6]} />
        <meshStandardMaterial attach="material-0" color="#2e2c1f" roughness={0.9} metalness={0} side={THREE.DoubleSide} />
        <meshStandardMaterial
          attach="material-1" color="#6f6b47" roughness={0.3} metalness={0.08}
          emissive="#4a4930" emissiveIntensity={0.1} side={THREE.DoubleSide}
        />
        <meshStandardMaterial attach="material-2" color="#2e2c1f" roughness={0.9} metalness={0} side={THREE.DoubleSide} />
      </mesh>
      <MudBubbles q={q} r={r} />
    </group>
  )
}

/** Cheap procedural "models" for terrain worth a 3D shape beyond flat
 * colour/texture — forest gets a tree (+ scattered fallen leaves),
 * plains gets scattered grass tufts, building gets a rooftop block,
 * rough/rubble get real rock/debris-chunk models (RealRock above),
 * water/water_deep and swamp get a surface over their own (still) bed
 * texture (WaterSurface/MudSurface). Everything else reads fine from the
 * texture alone; a mesh for those would be decoration without a mechanism.
 * Shape/size/tint vary per tile via a coordinate hash (deterministic —
 * same tile always looks the same, unlike Math.random which would
 * reshuffle on every re-render) so a cluster of trees or buildings
 * doesn't look like one model copy-pasted. */
export function TerrainDecor({
  terrain, height, q, r, physics,
}: {
  terrain: string
  height: number
  q: number
  r: number
  /** Real user request: dice should bounce off trees/buildings, not pass
   * straight through them. The full .glb models here are tens of
   * thousands of triangles each — a real hull collider per instance was
   * already tried and rejected on cost (see the comment this replaced,
   * still in HexMap.tsx's own Tile). A cheap PRIMITIVE approximation
   * (one cylinder for a tree trunk, one box for a building footprint)
   * gets the same "solid obstacle" result for a fraction of the cost,
   * and — unlike an auto "hull" collider on the async-loaded model
   * itself — never depends on the .glb finishing its own Suspense load
   * to exist. Only TableView passes this (its embedded HexMap is the
   * only one with real Physics/dice at all); omitted everywhere else,
   * same as HexMap's own `physics` prop convention. */
  physics?: boolean
}) {
  if (terrain === 'forest' || terrain === 'light_forest') {
    const dense = terrain === 'forest'
    const seed = hashTile(q, r, 'forest-decor')
    // Dense forest reads visibly bigger than light_forest, same
    // proportions the earlier procedural trunk/canopy sizing used.
    const sizeMultiplier = (dense ? 1.15 : 0.9) + ((seed >>> 3) % 100) / 100 * (dense ? 0.35 : 0.25)
    // Position offsets from tile center — HEX-factor scaled (has to stay
    // proportionate to the hex's own radius so a tree never jitters into
    // a neighboring tile), NOT the MECH-factor the tree's own size uses.
    const jitterX = (((seed >>> 8) % 100) / 100 - 0.5) * 0.3 * HEX_SIZE
    const jitterZ = (((seed >>> 14) % 100) / 100 - 0.5) * 0.3 * HEX_SIZE
    const rotY = ((seed >>> 20) % 628) / 100

    // Dense forest gets a second, smaller tree offset from the first —
    // the clearest way to read as genuinely denser canopy rather than
    // "the same single tree, just bigger" like light_forest's one tree.
    const seed2 = hashTile(q, r, 'forest-decor-2')
    const sizeMultiplier2 = 0.55 + ((seed2 >>> 3) % 100) / 100 * 0.25
    const jitterX2 = (((seed2 >>> 8) % 100) / 100 - 0.5) * 0.65 * HEX_SIZE
    const jitterZ2 = (((seed2 >>> 14) % 100) / 100 - 0.5) * 0.65 * HEX_SIZE
    const rotY2 = ((seed2 >>> 20) % 628) / 100

    // Rough trunk approximation — TREE_BASE_SCALE is the model's own
    // normalized-to-1-unit-tall → world-unit factor, so a tree's real
    // height is ~TREE_BASE_SCALE * sizeMultiplier; the trunk itself only
    // fills a fraction of that (the rest is canopy, which a die should be
    // able to graze/tumble through same as it would real branches), so the
    // collider itself is deliberately much shorter than the full model.
    // MECH-factor scaled, same family as TREE_BASE_SCALE itself.
    const trunkHalfHeight = 0.9 * MECH_FACTOR * sizeMultiplier
    const trunkRadius = 0.18 * MECH_FACTOR * sizeMultiplier
    return (
      <>
        <group position={[jitterX, height, jitterZ]} rotation={[0, rotY, 0]}>
          <RealTree sizeMultiplier={sizeMultiplier} />
        </group>
        {dense && (
          <group position={[jitterX2, height, jitterZ2]} rotation={[0, rotY2, 0]}>
            <RealTree sizeMultiplier={sizeMultiplier2} />
          </group>
        )}
        <group position={[0, height, 0]}>
          <LeafLitter q={q} r={r} />
        </group>
        {physics && (
          <RigidBody type="fixed" position={[jitterX, height + trunkHalfHeight, jitterZ]} colliders={false}>
            <CylinderCollider args={[trunkHalfHeight, trunkRadius]} />
          </RigidBody>
        )}
        {physics && dense && (
          <RigidBody
            type="fixed"
            position={[jitterX2, height + trunkHalfHeight * 0.7, jitterZ2]}
            colliders={false}
          >
            <CylinderCollider args={[trunkHalfHeight * 0.7, trunkRadius * 0.7]} />
          </RigidBody>
        )}
      </>
    )
  }
  if (terrain === 'plains') {
    const dirt = plainsGroundVariant(q, r) === 'dirt'
    return (
      <group position={[0, height, 0]}>
        <GrassTufts q={q} r={r} sparse={dirt} />
        <Pebbles q={q} r={r} />
      </group>
    )
  }
  if (terrain === 'building') {
    const kind = buildingKind(q, r)
    const seed = hashTile(q, r, 'building-decor')
    const jitter = (shift: number, spread: number) => ((seed >>> shift) % 100) / 100 * spread

    // A full 0-2π rotation spread, not a small clamped jitter — a real
    // building has an actual "front" a repeated fixed orientation would
    // make obvious across many tiles.
    const rotY = ((seed >>> 10) % 1000) / 1000 * Math.PI * 2

    // Approximate footprint box — same reasoning as the tree trunk
    // collider above (real user request: dice should bounce off
    // buildings too, but a hull off the real multi-thousand-triangle
    // model is the exact cost HexMap.tsx's own Tile comment already
    // rejected). Sized to roughly fill a hex tile's own footprint
    // (radius ~1) regardless of sizeMultiplier — a building's actual
    // footprint reads as "fills its tile" visually even as the model
    // itself scales, so the collider doesn't need to track sizeMultiplier
    // precisely to feel right.
    // Horizontal extents HEX-factor scaled (roughly fills the hex
    // footprint, same family as BUILDING_FOOTPRINT_SCALE above); vertical
    // extent MECH-factor scaled (a building's height reads against the
    // mech, not the hex width).
    const buildingCollider = physics && (
      <RigidBody type="fixed" position={[0, height + 1.5 * MECH_FACTOR, 0]} colliders={false}>
        <CuboidCollider args={[0.8 * HEX_SIZE, 1.5 * MECH_FACTOR, 0.8 * HEX_SIZE]} />
      </RigidBody>
    )

    if (kind < 3) {
      // Real model (BUILDING_MODEL_URLS above — one shared mesh for all
      // three kinds now) — replaces the earlier procedural box per
      // explicit request for realistic buildings/skyscrapers. Kind still
      // drives a distinct size class + tint (BUILDING_KIND_SIZE/_TINT)
      // so the three read as different buildings despite sharing geometry.
      const { min, spread } = BUILDING_KIND_SIZE[kind]
      const sizeMultiplier = min + jitter(4, spread)
      return (
        <>
          <group position={[0, height, 0]} rotation={[0, rotY, 0]}>
            <RealBuilding url={BUILDING_MODEL_URLS[kind]} sizeMultiplier={sizeMultiplier} tint={BUILDING_KIND_TINT[kind]} />
          </group>
          {buildingCollider}
        </>
      )
    }

    // kind 3/4: ruined — one of the same three real models, reused (see
    // RealBuilding's own tint comment) with a dark scorched tint, plus a
    // couple of small plain debris chunks scattered at its base. No real
    // ruined-building model was available to source — falling back to
    // the old procedural box here specifically read as visibly "cutre"
    // once real models existed for every OTHER building on the same map
    // (real user report, with screenshot showing exactly that mismatch).
    // Same size range as the standing kind (an explicit follow-up
    // request — an earlier version shrank ruins to suggest partial
    // collapse, but a real building doesn't get physically smaller when
    // damaged, so that read as wrong rather than "ruined").
    const ruinUrl = BUILDING_MODEL_URLS[(seed >>> 14) % 3]
    const ruinSizeMultiplier = 0.85 + jitter(18, 0.4)
    return (
      <group>
        <group position={[0, height, 0]} rotation={[0, rotY, 0]}>
          <RealBuilding url={ruinUrl} sizeMultiplier={ruinSizeMultiplier} tint="#4a4038" />
        </group>
        <mesh position={[0.3 * MECH_FACTOR, height + 0.08 * MECH_FACTOR, 0.2 * MECH_FACTOR]} rotation={[0.15, 0.4, 0.1]} castShadow>
          <boxGeometry args={[0.3 * MECH_FACTOR, 0.16 * MECH_FACTOR, 0.3 * MECH_FACTOR]} />
          <meshStandardMaterial color="#4a4038" />
        </mesh>
        <mesh position={[-0.25 * MECH_FACTOR, height + 0.06 * MECH_FACTOR, -0.25 * MECH_FACTOR]} rotation={[-0.1, 0.8, 0.2]} castShadow>
          <boxGeometry args={[0.25 * MECH_FACTOR, 0.12 * MECH_FACTOR, 0.25 * MECH_FACTOR]} />
          <meshStandardMaterial color="#443a34" />
        </mesh>
        {buildingCollider}
      </group>
    )
  }
  if (terrain === 'rough') {
    const seed = hashTile(q, r, 'rough-decor')
    const count = 1 + (seed % 2)
    return (
      <group position={[0, height, 0]}>
        {Array.from({ length: count }, (_, i) => {
          const s = hashTile(q, r, `rough-rock-${i}`)
          const angle = (s % 360) * (Math.PI / 180)
          // HEX-factor scaled — a position offset, same reasoning as the
          // tree jitterX/jitterZ above.
          const dist = ((s >>> 8) % 100) / 100 * 0.45 * HEX_SIZE
          const sizeMultiplier = 0.55 + ((s >>> 16) % 100) / 100 * 0.55
          const rotY = ((s >>> 20) % 628) / 100
          const url = (s >>> 2) % 2 === 0 ? ROCK_BOULDER_URL : ROCK_FACE_URL
          return (
            <group key={i} position={[Math.cos(angle) * dist, 0, Math.sin(angle) * dist]} rotation={[0, rotY, 0]}>
              <RealRock url={url} sizeMultiplier={sizeMultiplier} />
            </group>
          )
        })}
      </group>
    )
  }
  if (terrain === 'rubble') {
    // rock-face.glb reused from 'rough' above, dusty-grey-tinted here so
    // it reads as a broken masonry/concrete shard rather than a natural
    // stone — paired with rubble-block.glb (an actual concrete barrier
    // model) for the "trozos grandes" a lone rock chunk wouldn't sell on
    // its own.
    const seed = hashTile(q, r, 'rubble-decor')
    const count = 1 + (seed % 3)
    return (
      <group position={[0, height, 0]}>
        {Array.from({ length: count }, (_, i) => {
          const s = hashTile(q, r, `rubble-chunk-${i}`)
          const angle = (s % 360) * (Math.PI / 180)
          // HEX-factor scaled — a position offset, same reasoning as the
          // tree jitterX/jitterZ above.
          const dist = ((s >>> 8) % 100) / 100 * 0.5 * HEX_SIZE
          const sizeMultiplier = 0.45 + ((s >>> 16) % 100) / 100 * 0.5
          const rotY = ((s >>> 20) % 628) / 100
          const useBlock = (s >>> 2) % 2 === 0
          return (
            <group key={i} position={[Math.cos(angle) * dist, 0, Math.sin(angle) * dist]} rotation={[0, rotY, 0]}>
              {useBlock ? (
                <RealRock url={RUBBLE_BLOCK_URL} sizeMultiplier={sizeMultiplier} />
              ) : (
                <RealRock url={ROCK_FACE_URL} sizeMultiplier={sizeMultiplier} tint="#8a8478" />
              )}
            </group>
          )
        })}
      </group>
    )
  }
  if (terrain === 'water' || terrain === 'water_deep') {
    return <WaterSurface terrain={terrain} q={q} r={r} />
  }
  if (terrain === 'swamp') {
    return <MudSurface q={q} r={r} />
  }
  return null
}
