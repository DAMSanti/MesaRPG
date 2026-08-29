import { useEffect, useMemo, useRef } from 'react'
import {useThree} from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import { hashTile, buildingKind } from '../terrain'
import { GROUND_BASE_HEIGHT, HEX_SIZE } from '../hexMath'
import {
  getWaterDisturbers, MAX_WATER_DISTURBERS, WATER_DISTURB_RANGE,
} from '../waterDisturbance'
import { MODEL_SCALE } from './Mech3D'
import { useProfiledFrame } from './PerfProbe'

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
export type LeafShape = 'oval' | 'lobed' | 'maple'
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
export function getLeafTexture(shape: LeafShape): THREE.Texture {
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
export const LEAF_SHAPES: LeafShape[] = ['oval', 'lobed', 'maple']
// LeafLitter, Pebbles and GrassTufts used to live here, drawing their
// scatter as loose per-tile <mesh> elements. They are now batched across
// the whole board by GroundClutter.tsx — same placement hashes, same look,
// 733 draw calls down to 7. See that file for the measurements.

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
/** The lowest y any tile's ground can ever reach: the deepest sinking
 * terrain's own bed.
 *
 * Exported because anything drawn UNDER the board has to stay below it or it
 * hides the bed instead of backing it. Real user report, looking into a
 * river: the pale surface showing through the water was the wooden table,
 * which sat at y=-0.05 while a deep-water bed sinks to roughly -3.8 — so the
 * table was between the camera and the riverbed, and no amount of changing
 * the bed's texture was ever going to fix it (one was tried). Derived from
 * SINK_DEPTH rather than written down as a number so retuning how deep water
 * is cannot silently put the table back in the way.
 */
export const DEEPEST_SUNK_Y = GROUND_FLUSH_TOP - Math.max(...Object.values(SINK_DEPTH))

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
/** A seamless ripple normal map, drawn once and shared by every water tile.
 *
 * Real user request: "quiero tambien que la textura del agua sea AGUA y
 * condiciones." What was here before scrolled the RIVERBED PHOTO across the
 * surface, which is why it never read as water: a translucent sheet of
 * gravel sliding over gravel. Water does not have a colour texture worth
 * speaking of — what makes it look like water is how its SURFACE bends the
 * light, so what this paints is a normal map, not an image of water.
 *
 * Built from sine ridges at INTEGER frequencies across the canvas, which is
 * what makes it tile seamlessly: every wave completes a whole number of
 * cycles over the edge, so the left edge continues exactly into the right.
 * A few crossing directions at different scales give the interference that
 * makes real chop, and the whole thing costs one 256px canvas at startup
 * (no CC0 water material exists to download — the note in
 * public/textures/CREDITS.md already records that both ambientCG and Poly
 * Haven were checked, because a real-time water surface is animation and
 * lighting, not a photo). */
let waterNormalMap: THREE.CanvasTexture | null = null
function getWaterNormalMap(): THREE.CanvasTexture {
  if (waterNormalMap) return waterNormalMap
  const N = 256
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(N, N)
  // Frequency pairs are cycles-per-canvas, so integers keep it seamless.
  // Mixed scales and directions, none of them parallel, so no single wave
  // train dominates and the result reads as chop rather than as corduroy.
  const WAVES: [number, number, number][] = [
    [3, 1, 1.0], [1, 3, 0.85], [5, 2, 0.5], [2, -5, 0.45],
    [7, 4, 0.28], [4, -7, 0.25], [11, 3, 0.14], [3, -11, 0.12],
  ]

  // Real user report: "la corriente del agua me gusta, pero ahora se ven las
  // lineas rectas, podemos hacerlo algo mas turbulento y añadirle ruido para
  // que no se vean las lineas rectas?"
  //
  // Sines alone can only ever make straight crests — eight of them crossing
  // is still eight straight ridges, and scrolling that in one direction is
  // exactly the corduroy the grass wind had. So the sines get a turbulence
  // field laid over them, and it is the turbulence that decides where each
  // crest actually is: no straight edge survives.
  //
  // The noise has to TILE, or the seam shows up as a hard line every time
  // the map repeats across a hex — which would be trading one straight line
  // for a worse one. Wrapping the lattice coordinates modulo the grid size
  // is what makes it periodic; a plain hash of unbounded coordinates would
  // not be.
  const hash2 = (ix: number, iy: number, period: number) => {
    const px = ((ix % period) + period) % period
    const py = ((iy % period) + period) % period
    const v = Math.sin(px * 127.1 + py * 311.7) * 43758.5453123
    return v - Math.floor(v)
  }
  const valueNoise = (x: number, y: number, cells: number) => {
    // `cells` is how many noise cells span the whole canvas, so it is also
    // the period: an integer count means the right edge lands back on the
    // left one.
    const sx = (x / N) * cells
    const sy = (y / N) * cells
    const ix = Math.floor(sx)
    const iy = Math.floor(sy)
    const fx = sx - ix
    const fy = sy - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a = hash2(ix, iy, cells)
    const b = hash2(ix + 1, iy, cells)
    const c = hash2(ix, iy + 1, cells)
    const d = hash2(ix + 1, iy + 1, cells)
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy
  }
  const turbulence = (x: number, y: number) => (
    valueNoise(x, y, 4) * 0.5
    + valueNoise(x + 37, y + 11, 8) * 0.3
    + valueNoise(x + 71, y + 53, 16) * 0.15
    + valueNoise(x + 13, y + 97, 32) * 0.08
  )

  // Turbulence enters as a DOMAIN WARP as well as an added ripple: the sines
  // are evaluated at coordinates the noise has already pushed around, so the
  // ridges themselves bend and braid instead of being straight ridges with
  // bumps on top. That is the difference between water and corrugated iron.
  const WARP = 26
  const heightAt = (x: number, y: number) => {
    const wx = x + (turbulence(x, y) - 0.5) * WARP
    const wy = y + (turbulence(x + 101, y + 149) - 0.5) * WARP
    let h = 0
    for (let i = 0; i < WAVES.length; i++) {
      const [fx, fy, a] = WAVES[i]
      h += a * Math.sin((2 * Math.PI * (fx * wx + fy * wy)) / N + i * 1.7)
    }
    // Plus the noise's own fine chop on top of the warped swell.
    return h + (turbulence(x, y) - 0.5) * 2.6
  }
  // Slope by central difference, then the usual tangent-space encoding.
  // STRENGTH sets how steep the encoded normals are. Too high and calm water
  // turns into hammered metal; too low and the surface is effectively a
  // mirror, which is how the first version ended up with the sun's
  // reflection sitting on one hex as a single blown-out white blob instead
  // of being scattered across the chop.
  const STRENGTH = 0.2
  // Sampled with wrapped coordinates so the derivative at the very edge
  // reads across the seam rather than off the end of the pattern.
  const wrap = (v: number) => ((v % N) + N) % N
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (heightAt(wrap(x + 1), y) - heightAt(wrap(x - 1), y)) * STRENGTH
      const dy = (heightAt(x, wrap(y + 1)) - heightAt(x, wrap(y - 1))) * STRENGTH
      const len = Math.hypot(dx, dy, 1)
      const o = (y * N + x) * 4
      image.data[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255)
      image.data[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255)
      image.data[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255)
      image.data[o + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  // A normal map is data, not colour — decoding it through sRGB would bend
  // every normal it encodes.
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 16
  waterNormalMap = tex
  return tex
}

/** A prefiltered environment map built from the sky photo, for the water to
 * reflect.
 *
 * Real user request: "no parece agua, parece algo azul traslucido...
 * necesito corriente y reflexion, refraccion, todo el combo." Reflection is
 * most of what makes water read as water — a surface with nothing to reflect
 * can only ever look like tinted glass, whatever its roughness.
 *
 * Built here rather than relying on the scene's own environment because only
 * TableView has one (added for the dice), so water in GMView and the
 * first-person view would have had nothing to reflect at all. PMREM is the
 * prefiltering three.js needs to use an equirectangular photo as a real
 * roughness-aware reflection source; the raw texture cannot be used directly.
 * One per renderer, cached — it is a real GPU cost to build and none to
 * reuse. */
const waterEnvByRenderer = new WeakMap<THREE.WebGLRenderer, Promise<THREE.Texture>>()
function loadWaterEnvMap(renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const cached = waterEnvByRenderer.get(renderer)
  if (cached) return cached
  // Asynchronous, and it has to be: PMREM prefilters the IMAGE, and
  // TextureLoader.load returns its Texture immediately with `image` still
  // null. Calling PMREM on it synchronously throws ("Cannot read properties
  // of null (reading 'width')") and takes every water tile on the board down
  // with it — which is exactly what the first version of this did. The
  // material starts with no envMap and gets one the moment the sky is ready.
  const promise = new Promise<THREE.Texture>((resolve) => {
    new THREE.TextureLoader().load('/textures/sky.jpg', (sky) => {
      sky.mapping = THREE.EquirectangularReflectionMapping
      sky.colorSpace = THREE.SRGBColorSpace
      const pmrem = new THREE.PMREMGenerator(renderer)
      const env = pmrem.fromEquirectangular(sky).texture
      pmrem.dispose()
      sky.dispose()
      resolve(env)
    })
  })
  waterEnvByRenderer.set(renderer, promise)
  return promise
}

/** How many times the ripple pattern repeats across one hex, for each of the
 * two layers. Two different scales moving at two different speeds is what
 * stops the surface reading as one texture being dragged: the interference
 * between them never repeats, so the water keeps changing shape instead of
 * sliding. */
const WATER_RIPPLE_SCALE_A = 7
const WATER_RIPPLE_SCALE_B = 11
/** Metres per second the two layers travel. The slower, larger layer is the
 * swell; the faster, finer one is the chop riding on it. */
const WATER_SPEED_A = 0.055
const WATER_SPEED_B = 0.085
/** Multiplier on those speeds where there is a real current. Still water
 * only ever drifts. */
const WATER_CURRENT_SPEED = 3.4

/** The visible surface of a water tile.
 *
 * `flow` is the tile's own current direction in world XZ (riverFlow.ts), or
 * undefined for still water. It does two things: it aims both ripple layers
 * downstream so the whole river moves as one body rather than as a grid of
 * tiles each drifting its own way, and it drives the speed up, because a
 * current you cannot see the direction of is not a current. */
function WaterSurface({ terrain, q, r, flow }: {
  terrain: string
  q: number
  r: number
  flow?: [number, number]
}) {
  const uniforms = useMemo(() => ({
    uOffsetA: { value: new THREE.Vector2() },
    uOffsetB: { value: new THREE.Vector2() },
    uScaleA: { value: WATER_RIPPLE_SCALE_A },
    uScaleB: { value: WATER_RIPPLE_SCALE_B },
    uTime: { value: 0 },
    // xy = world position, z = strength, w unused. Zero strength means the
    // slot is empty, which is how the shader skips it without branching on a
    // separate count uniform.
    uDisturb: {
      value: Array.from({ length: MAX_WATER_DISTURBERS }, () => new THREE.Vector4()),
    },
  }), [])

  // Per-tile phase so neighbouring tiles do not start their ripples in step,
  // which would draw the hex grid onto the water.
  const seed = hashTile(q, r, 'water-flow')
  const phase = ((seed >>> 20) % 628) / 100

  const renderer = useThree((state) => state.gl)
  const deep = terrain === 'water_deep'
  const material = useMemo(() => {
    const mat = new THREE.MeshPhysicalMaterial({
      normalMap: getWaterNormalMap(),
      normalScale: new THREE.Vector2(1.5, 1.5),
      // Water is a smooth dielectric. Near-zero roughness is what gives it
      // sharp highlights and a real reflection instead of a haze; the old
      // values here (roughness 0.25, metalness 0.1) are most of why it read
      // as tinted plastic.
      // Not mirror-smooth. Real water at this scale is never optically flat,
      // and a perfect mirror concentrates the whole sky's brightest point
      // into one small area that blows out to white.
      roughness: deep ? 0.09 : 0.12,
      metalness: 0,
      // Real refraction: transmission renders what is behind the surface and
      // bends it through the material, so the riverbed distorts under the
      // ripples instead of just showing through a translucent sheet. This is
      // what `opacity` could never do — an opacity fade is a blend, it has no
      // idea there is a surface with a shape in front of it.
      transmission: 1,
      // Water's real index of refraction. Also what drives how strongly the
      // surface reflects at a glancing angle, so the Fresnel falloff comes
      // out right without being faked.
      ior: 1.33,
      // Colour comes from light being absorbed as it travels THROUGH the
      // water, which is why deep water is darker and bluer than shallow over
      // the same bed — not from painting the surface blue. `thickness` is how
      // far light travels inside, so it tracks the tile's own real depth.
      thickness: deep ? SINK_DEPTH.water_deep : SINK_DEPTH.water,
      attenuationColor: new THREE.Color(deep ? '#0e3a52' : '#2a7f8c'),
      attenuationDistance: deep ? 2.2 : 5.5,
      color: '#ffffff',
      // A thin, perfectly smooth coat over the top: real water has a
      // specular sheen sharper than its own body, and this is what puts the
      // sun glint on it.
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.3,
      // FrontSide, not DoubleSide. The water is a closed six-sided volume,
      // and with both sides drawn its own INTERIOR walls render too — seen
      // through the surface and refracted, they come out as hard-edged
      // polygons with straight, stepped boundaries sitting inside the tile.
      // A real user reported exactly that shape and could not name it ("no
      // se que mierda es"); it is the far wall of the water looking back at
      // the camera. `thickness` is what tells the material how deep the body
      // of water is, so nothing is lost by not drawing the inside of it.
      side: THREE.FrontSide,
    })
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      // The disturbance rings need to know where a fragment is in the WORLD,
      // which the standard material does not otherwise provide here.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterWorld;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vWaterWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec2 uOffsetA;
          uniform vec2 uOffsetB;
          uniform float uScaleA;
          uniform float uScaleB;
          uniform float uTime;
          uniform vec4 uDisturb[${MAX_WATER_DISTURBERS}];
          varying vec3 vWaterWorld;`)
        // Two independent samples of the same ripple map, at different
        // scales and travelling at different speeds, combined the standard
        // way for blending normal maps (add the tangential components, keep
        // the product of the vertical ones). One sample alone can only ever
        // slide; two interfering never repeat.
        .replace('#include <normal_fragment_maps>', `
          vec3 nA = texture2D( normalMap, vNormalMapUv * uScaleA + uOffsetA ).xyz * 2.0 - 1.0;
          vec3 nB = texture2D( normalMap, vNormalMapUv * uScaleB + uOffsetB ).xyz * 2.0 - 1.0;
          vec3 mapN = normalize( vec3( nA.xy + nB.xy, nA.z * nB.z ) );
          // Rings spreading from whatever is standing in the water. The wave
          // travels outward (distance MINUS time), decays with distance so it
          // dies out instead of ringing the whole river, and pushes the
          // normal along the outward direction, which is what makes it read
          // as a raised ring rather than as a stain.
          for ( int i = 0; i < ${MAX_WATER_DISTURBERS}; i ++ ) {
            vec4 d = uDisturb[ i ];
            if ( d.z <= 0.0 ) continue;
            vec2 rel = vWaterWorld.xz - d.xy;
            float dist = length( rel );
            if ( dist > ${WATER_DISTURB_RANGE}.0 ) continue;
            // Held off the very centre: right where the leg is there is no
            // ring, there is a leg, and a wave crest converging on a point
            // reads as a spike.
            float near = smoothstep( 1.2, 4.0, dist );
            float fade = exp( -dist * 0.16 );
            float wave = sin( dist * 1.15 - uTime * 3.4 ) * fade * near * d.z;
            mapN.xy += normalize( rel + 1e-5 ) * wave * 0.85;
          }
          mapN = normalize( mapN );
          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );`)
    }
    return mat
  }, [deep, uniforms, renderer])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => {
    let alive = true
    loadWaterEnvMap(renderer).then((env) => {
      if (!alive) return
      material.envMap = env
      material.needsUpdate = true
    })
    return () => { alive = false }
  }, [renderer, material])

  // The tile's own position in SCENE space, read off the mesh rather than
  // derived from q/r — the whole board sits inside an offset group, so a
  // q/r-derived position is in board space and would not compare against the
  // scene-space disturber list.
  const meshRef = useRef<THREE.Mesh>(null)
  const tileWorld = useMemo(() => new THREE.Vector3(), [])
  useProfiledFrame('agua', (state) => {
    if (meshRef.current) meshRef.current.getWorldPosition(tileWorld)
    const t = state.clock.elapsedTime + phase
    uniforms.uTime.value = state.clock.elapsedTime
    // Only the disturbers close enough to this tile to be seen, nearest
    // first — a river can hold more units than the shader has slots, and the
    // ones that matter to THIS tile are the ones next to it.
    const all = getWaterDisturbers()
    const near = all.length <= 1 ? all : [...all].sort((a, b) => (
      (a.x - tileWorld.x) ** 2 + (a.z - tileWorld.z) ** 2
      - ((b.x - tileWorld.x) ** 2 + (b.z - tileWorld.z) ** 2)
    ))
    for (let i = 0; i < MAX_WATER_DISTURBERS; i++) {
      const d = near[i]
      const slot = uniforms.uDisturb.value[i]
      const inRange = d != null
        && Math.hypot(d.x - tileWorld.x, d.z - tileWorld.z) < WATER_DISTURB_RANGE + HEX_SIZE
      if (inRange) slot.set(d.x, d.z, d.strength, 0)
      else slot.set(0, 0, 0, 0)
    }
    // Downstream if this tile is part of a river; otherwise a slow drift on
    // two different bearings, which is what still water does when the air
    // moves over it.
    const [fx, fz] = flow ?? [Math.cos(phase) * 0.35, Math.sin(phase) * 0.35]
    const speed = flow ? WATER_CURRENT_SPEED : 1
    // Texture space runs opposite to world travel: scrolling the sample
    // point one way moves the pattern the other.
    uniforms.uOffsetA.value.set(-fx * t * WATER_SPEED_A * speed, -fz * t * WATER_SPEED_A * speed)
    uniforms.uOffsetB.value.set(
      -fx * t * WATER_SPEED_B * speed + 0.37,
      -fz * t * WATER_SPEED_B * speed - 0.21,
    )
  })

  const depth = SINK_DEPTH[terrain] ?? SINK_DEPTH.water
  const bottomY = GROUND_FLUSH_TOP - depth
  return (
    <mesh ref={meshRef} position={[0, (GROUND_FLUSH_TOP + bottomY) / 2, 0]} material={material}>
      <cylinderGeometry args={[0.98 * HEX_SIZE, 0.98 * HEX_SIZE, depth, 6]} />
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
  useProfiledFrame('barro', (state) => {
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
  terrain, height, q, r, physics, riverFlow,
}: {
  terrain: string
  height: number
  q: number
  r: number
  /** Per-tile current directions for the whole board (riverFlow.ts). A
   * current is a property of the shape the water makes across the map, not
   * of one tile, so it has to be worked out once above and handed down. */
  riverFlow?: Map<string, [number, number]>
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
    // The trees themselves are GroundVegetation's job now: instanced across
    // the whole board, several species out of one consistent set, moving in
    // the wind. Rendering this file's own single tree as well put two
    // unrelated tree systems on the same hex.
    //
    // Their dice colliders went with them, and that is a real loss worth
    // naming: a die can now roll through a forest tile untouched. The
    // colliders that used to be here were placed at THIS file's own tree
    // positions, and those trees no longer exist, so keeping them would have
    // left invisible cylinders scattered across the board — worse than
    // nothing. Bringing collision back means having the component that
    // actually places the trees place them, since it is the only thing that
    // knows where they ended up.
    // The litter on the ground is GroundClutter's job now, batched across
    // the whole board, so a forest tile has nothing of its own to draw —
    // an empty <group> here would still be an object per tile.
    return null
  }
  // Plains tufts and pebbles likewise come from GroundClutter now, so a
  // plains tile has nothing of its own left to draw.
  if (terrain === 'plains') return null
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
      <group position={[0, height, 0]} userData={{ perfGroup: 'decoración' }}>
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
      <group position={[0, height, 0]} userData={{ perfGroup: 'decoración' }}>
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
    return <WaterSurface terrain={terrain} q={q} r={r} flow={riverFlow?.get(`${q},${r}`)} />
  }
  if (terrain === 'swamp') {
    return <MudSurface q={q} r={r} />
  }
  return null
}
