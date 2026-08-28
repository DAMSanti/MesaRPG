import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { HexTileData } from '../api'
import { HEX_SIZE, hexToWorld } from '../hexMath'
import { groundVariant, hashTile, type GroundVariant } from '../terrain'
import { makeGrassDensitySampler } from '../grassPatches'
import { tileSurfaceAt } from '../tileHeightField'

/** Real user request: "necesito que encuentres y descargues packs de
 * vegetacion, plantas, arbustos, decoracion para estas tiles, ten en cuenta
 * que ahora son hexes de 30m de lado... esa vegetacion debe moverse como
 * movida por el viento... predominaran hierbas y arbustos... quiero que sean
 * procedurales y que sean pequeños dioramas."
 *
 * Real scanned plants (Poly Haven, CC0 — see public/textures/CREDITS.md),
 * scattered over every plains/hills tile.
 *
 * ONE component for the whole board rather than a per-tile one like
 * TerrainDecor, because the only way this is affordable is instancing: a
 * 30m hex is big enough to want dozens of plants, and a map has hundreds of
 * tiles, so the honest count is tens of thousands of plants. As separate
 * meshes that is tens of thousands of draw calls and a certain freeze (this
 * project has already had one, from far fewer trees). Grouped into one
 * InstancedMesh per plant variant it is a couple of dozen draw calls total,
 * no matter how many tiles the map has.
 *
 * The triangle budget is what actually shapes the mix below, and it is why
 * the species are split into tiers rather than scattered evenly:
 * `grass_bermuda_01` is ~45 triangles per variant, so it can carry the dense
 * ground cover at forty-odd per tile for almost nothing, while a real shrub
 * is ~2.7k and has to be counted in ones and twos. Spreading the same number
 * of every species would cost roughly thirty times as much for a worse
 * result. */

const VEG = '/models/vegetation/'

/** Plains and hills only — "empecemos con llanuras y colinas, que salvo la
 * altura seran iguales". Everything else keeps whatever TerrainDecor already
 * gives it. */
const VEGETATED = new Set(['plains', 'hills'])

type Tier = 'cover' | 'grass' | 'herb' | 'shrub' | 'prop' | 'sapling'

interface Species {
  /** Model file. Each holds several named variants (Poly Haven ships them
   * laid out side by side in one scene), all sharing one material — which is
   * exactly the shape instancing wants: one material, many geometries. */
  url: string
  tier: Tier
  /** Target height in metres. The board is 1 unit = 1 metre (HEX_SIZE 30 is
   * a 30m hex side), and every instance is scaled so the model reaches this
   * height whatever it measured in the scan.
   *
   * Sizing by target rather than by a multiplier is not tidiness: these
   * models range from 3cm of moss to a 1.26m rock, so one "scale" number
   * means something completely different per species — guessing them by eye
   * put half the set at invisible sizes on the first attempt. Everything
   * stays at real BattleTech scale, per "todo debe estar a escala
   * battletech asi que tiene sentido que sea pequeño". */
  height: number
  /** Per-instance size spread, as a fraction of `height`. */
  spread: number
  /** How far the top of the plant travels in the wind, in world units. 0
   * for anything rigid (rocks, stumps, dead wood). */
  sway: number
}

const SPECIES: Record<string, Species> = {
  // --- sparse 3D ground detail. The dense carpet is NOT made of these (see
  // GrassCarpet below): at 45 triangles a tuft, covering ground with them
  // costs an order of magnitude more than it is worth. These sit on top of
  // the carpet as occasional real, lit, three-dimensional clumps.
  bermuda: { url: `${VEG}grass_bermuda_01.glb`, tier: 'cover', height: 0.30, spread: 0.5, sway: 0.05 },
  moss: { url: `${VEG}moss_01.glb`, tier: 'cover', height: 0.16, spread: 0.5, sway: 0 },
  grassMedium: { url: `${VEG}grass_medium_01.glb`, tier: 'grass', height: 0.85, spread: 0.45, sway: 0.16 },
  grassTufts: { url: `${VEG}grass_medium_02.glb`, tier: 'grass', height: 0.75, spread: 0.45, sway: 0.15 },
  weeds: { url: `${VEG}weed_plant_02.glb`, tier: 'herb', height: 0.55, spread: 0.4, sway: 0.12 },
  celandine: { url: `${VEG}celandine_01.glb`, tier: 'herb', height: 0.5, spread: 0.4, sway: 0.11 },
  dandelion: { url: `${VEG}dandelion_01.glb`, tier: 'herb', height: 0.55, spread: 0.4, sway: 0.13 },
  shrubLow: { url: `${VEG}shrub_03.glb`, tier: 'shrub', height: 1.1, spread: 0.35, sway: 0.10 },
  shrubMid: { url: `${VEG}shrub_02.glb`, tier: 'shrub', height: 1.6, spread: 0.35, sway: 0.12 },
  shrubBig: { url: `${VEG}shrub_04.glb`, tier: 'shrub', height: 2.1, spread: 0.3, sway: 0.10 },
  sapling: { url: `${VEG}pine_sapling_small.glb`, tier: 'sapling', height: 4.5, spread: 0.3, sway: 0.08 },
  stump: { url: `${VEG}tree_stump_01.glb`, tier: 'prop', height: 1.3, spread: 0.25, sway: 0 },
  branches: { url: `${VEG}dry_branches_medium_01.glb`, tier: 'prop', height: 0.6, spread: 0.3, sway: 0 },
  stone: { url: `${VEG}stone_01.glb`, tier: 'prop', height: 0.7, spread: 0.4, sway: 0 },
  rocks: { url: `${VEG}rock_moss_set_01.glb`, tier: 'prop', height: 1.5, spread: 0.45, sway: 0 },
}

type SpeciesKey = keyof typeof SPECIES

/** One drawable variant: a single plant's geometry, recentred so its base
 * sits at the origin, plus which species it came from. */
interface Variant {
  species: SpeciesKey
  index: number
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Model-space height, needed by the wind shader to know how far up a
   * given vertex is and therefore how much it should lean. */
  height: number
}

/** Pulls every mesh out of a loaded model as an independent variant.
 *
 * Two things have to be undone from the source file. Poly Haven lays its
 * variants out in a ROW in one scene, so each carries a translation that has
 * to be baked out or every instance would render metres away from where it
 * was placed; and the pieces sit on their own local origins, so each is
 * recentred in XZ and dropped to y=0 at its base, which is what lets a
 * placement be "put this at this point on the ground" rather than needing to
 * know each model's own quirks. */
function extractVariants(scene: THREE.Object3D, species: SpeciesKey): Variant[] {
  const out: Variant[] = []
  scene.updateWorldMatrix(true, true)
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    geometry.computeBoundingBox()
    const bb = geometry.boundingBox!
    geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
    geometry.computeBoundingBox()
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    out.push({ species, index: out.length, geometry, material, height: Math.max(0.01, bb.max.y - bb.min.y) })
  })
  return out
}

/** Wind, as a small vertex displacement patched into the plant's own
 * material rather than a hand-written replacement for it.
 *
 * Deliberately `onBeforeCompile` on the real scanned material, NOT a custom
 * ShaderMaterial: these are photogrammetry plants whose whole value is their
 * real albedo/normal/roughness maps under the scene's real lights, and
 * rewriting the shader would mean reimplementing all of that (an earlier
 * hand-rolled terrain shader in this project shipped visibly broken for
 * exactly this kind of reason). This only adds a few lines to the vertex
 * stage and leaves the lighting untouched.
 *
 * The lean is proportional to `y` over the plant's own height, raised to a
 * power so the base stays planted and the motion concentrates in the tips —
 * a stalk bending, not a whole plant sliding. Phase comes from the INSTANCE's
 * own world position (`instanceMatrix`'s translation column), so twenty
 * thousand plants sharing one material still each move on their own beat;
 * without it the entire field would sway as one rigid sheet. Two different
 * frequencies on x and z keep it from reading as a flat back-and-forth. */
function makeWindMaterial(source: THREE.Material, height: number, sway: number) {
  const material = (source as THREE.MeshStandardMaterial).clone()
  const uniforms = { uTime: { value: 0 }, uPlantHeight: { value: height }, uSway: { value: sway } }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.uniforms.uPlantHeight = uniforms.uPlantHeight
    shader.uniforms.uSway = uniforms.uSway
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uPlantHeight;
        uniform float uSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 instOrigin = instanceMatrix[3].xyz;
        #else
          vec3 instOrigin = vec3(0.0);
        #endif
        float lean = pow(clamp(transformed.y / uPlantHeight, 0.0, 1.0), 1.6);
        // Hashed per instance, not a linear ramp — see the carpet material
        // for why a linear phase is a plane wave and shows up as scrolling
        // stripes rather than as decorrelated plants.
        float phase = fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        // Two crossing waves rather than one plane wave — see the carpet's
        // own material for why a single one shows up as a straight bar
        // sweeping the board from a top-down camera.
        float g1 = sin(uTime * 0.37 + instOrigin.x * 0.0027 + instOrigin.z * 0.0019);
        float g2 = sin(uTime * 0.24 - instOrigin.x * 0.0016 + instOrigin.z * 0.0034);
        float gust = 0.68 + 0.28 * (g1 * 0.6 + g2 * 0.4);
        transformed.x += sin(uTime * 1.7 + phase) * lean * uSway * gust;
        transformed.z += cos(uTime * 1.3 + phase * 0.7) * lean * uSway * gust * 0.6;`)
  }
  // Scanned foliage has no business looking wet or plastic, and these
  // materials arrive with whatever the scan pipeline defaulted to.
  material.roughness = Math.min(1, (material.roughness ?? 1) * 1.15)
  material.metalness = 0
  // Real scanned plants are thin, single-sided shells; without this the
  // blades vanish from whichever side the camera happens to be on.
  material.side = THREE.DoubleSide
  return { material, uniforms }
}

/** How many of each tier a tile gets, by which ground patch it is (see
 * terrain.ts's groundVariant). Bare earth is not bare of everything — it
 * gets the weeds and stones that colonise a worn patch, just very little
 * grass; a meadow is the lush end. */
/** Real user spec, per ground patch: "las verdes claras tendran algo de
 * hierba con alguna roca, las verdes oscuras estaran practicamente tapadas
 * con alguna roca, y las de tierra tendran poco arbusto disperso y mas
 * rocas." */
const DENSITY: Record<GroundVariant, Record<Tier, number>> = {
  grassDark: { cover: 22, grass: 30, herb: 12, shrub: 2.6, prop: 0.8, sapling: 0.12 },
  grassLight: { cover: 10, grass: 11, herb: 5, shrub: 1.6, prop: 1.0, sapling: 0.10 },
  earth: { cover: 2, grass: 1.5, herb: 1.5, shrub: 1.2, prop: 2.6, sapling: 0.03 },
}

/** Grass cards per tile — the layer that actually makes the ground "tupido".
 *
 * A 30m hex is ~2340 m². Genuinely covering that with scanned grass geometry
 * is tens of thousands of clumps PER TILE, which no amount of instancing
 * reaches; the base coverage keeps coming from the ground photo underneath.
 * What these buy is what a photo cannot do — real silhouettes breaking the
 * ground line, parallax as the camera moves, and wind. At four triangles a
 * card they are affordable in the thousands per tile, where a scanned clump
 * is affordable in the dozens. */
const CARPET_DENSITY: Record<GroundVariant, number> = { grassDark: 15000, grassLight: 6500, earth: 900 }

/** Where the grass actually grows is decided by the shared patch field in
 * grassPatches.ts, not here — the ground mesh shades the soil under a mat
 * from the very same field, and two independent versions of "where is the
 * grass thick" would drift apart and put the tint under nothing. The number
 * above is therefore CANDIDATES, most of which that field rejects. */
const CARPET_MEAN_KEEP = 0.45

/** Hard ceiling on carpet cards for the WHOLE board, whatever the map size.
 * Per-tile density is scaled down uniformly if a map would blow through it,
 * so a huge map degrades to thinner grass instead of to an unusable frame
 * rate — this layer's cost stops depending on how big a map someone builds.
 * 520k cards is ~2M triangles, in ONE draw call. */
const CARPET_MAX_CARDS = 900000

const TIER_SPECIES: Record<Tier, SpeciesKey[]> = {
  cover: ['bermuda', 'moss'],
  grass: ['grassMedium', 'grassTufts'],
  herb: ['weeds', 'celandine', 'dandelion'],
  shrub: ['shrubLow', 'shrubMid', 'shrubBig'],
  prop: ['stone', 'rocks', 'branches', 'stump'],
  sapling: ['sapling'],
}

/** Bare earth's props are stone, not deadfall — "las de tierra tendran poco
 * arbusto disperso y mas rocas". Weighted by repetition rather than by a
 * separate weight table, which keeps the pick a plain modulo. */
const EARTH_PROPS: SpeciesKey[] = ['rocks', 'rocks', 'stone', 'stone', 'branches']

/** Real user request: "quiero que sean procedurales y que sean pequeños
 * dioramas."
 *
 * Scattering every species independently gives an even, soup-like mix where
 * nothing means anything. A diorama is the opposite: a small number of tiles
 * get one COMPOSED scene instead — a rotting stump with dead branches, moss
 * and weeds crowding it; a mossy rock outcrop; a thicket; a patch in bloom.
 * Each is a recipe of what to place, how many, and how tightly clustered,
 * dropped at one spot on the tile with the ordinary scatter carrying on
 * around it. That contrast (a dense, deliberate little scene inside an
 * otherwise loose field) is what makes it read as a place rather than as
 * decoration. */
interface DioramaPart { species: SpeciesKey; count: number; radius: number; scale?: number }
const DIORAMAS: { key: string; weight: number; parts: DioramaPart[] }[] = [
  {
    key: 'deadfall',
    weight: 3,
    parts: [
      { species: 'stump', count: 1, radius: 0, scale: 1.25 },
      { species: 'branches', count: 2, radius: 3.2 },
      { species: 'moss', count: 7, radius: 3.6 },
      { species: 'weeds', count: 3, radius: 3.8 },
      { species: 'grassMedium', count: 3, radius: 4.4 },
    ],
  },
  {
    key: 'outcrop',
    weight: 3,
    parts: [
      { species: 'rocks', count: 3, radius: 2.6, scale: 1.3 },
      { species: 'stone', count: 1, radius: 1.6, scale: 1.2 },
      { species: 'moss', count: 8, radius: 3.4 },
      { species: 'grassTufts', count: 4, radius: 4.2 },
    ],
  },
  {
    key: 'thicket',
    weight: 3,
    parts: [
      { species: 'shrubBig', count: 1, radius: 0.8, scale: 1.2 },
      { species: 'shrubMid', count: 3, radius: 3.0 },
      { species: 'shrubLow', count: 3, radius: 3.6 },
      { species: 'grassMedium', count: 4, radius: 4.4 },
    ],
  },
  {
    key: 'bloom',
    weight: 2,
    parts: [
      { species: 'dandelion', count: 7, radius: 3.6 },
      { species: 'celandine', count: 6, radius: 4.0 },
      { species: 'grassTufts', count: 5, radius: 4.4 },
    ],
  },
  {
    key: 'lonetree',
    weight: 2,
    parts: [
      { species: 'sapling', count: 1, radius: 0, scale: 1.35 },
      { species: 'grassMedium', count: 5, radius: 4.0 },
      { species: 'shrubLow', count: 2, radius: 4.4 },
      { species: 'moss', count: 4, radius: 3.0 },
    ],
  },
]
const DIORAMA_TOTAL_WEIGHT = DIORAMAS.reduce((n, d) => n + d.weight, 0)
/** Roughly one tile in eight. Often enough to find them while looking around
 * a map, rare enough that they stay a find rather than a pattern. */
const DIORAMA_CHANCE = 0.13

/** Placement radius for the ordinary scatter, as a fraction of the apothem —
 * kept inside the tile so nothing ever straddles a border and floats over a
 * neighbour that sits at a different height. */
const SCATTER_RADIUS = HEX_SIZE * 0.72

interface Placement { species: SpeciesKey; variantPick: number; x: number; z: number; rotY: number; scale: number }

/** A deterministic 0..1 stream from a tile's own coordinates — same tile
 * always grows the same plants in the same spots, across reloads and
 * re-renders alike (Math.random would reshuffle the whole map on every
 * React re-render). */
function rand(q: number, r: number, salt: string, i: number): number {
  return (hashTile(q, r, `${salt}-${i}`) % 100000) / 100000
}

function placeTile(tile: HexTileData): Placement[] {
  const { q, r } = tile
  const variant = groundVariant(q, r)
  const density = DENSITY[variant]
  const out: Placement[] = []
  let n = 0

  const push = (species: SpeciesKey, x: number, z: number, scaleMul: number) => {
    const s = SPECIES[species]
    const j = rand(q, r, 'veg-size', n)
    out.push({
      species,
      variantPick: hashTile(q, r, `veg-pick-${n}`),
      x,
      z,
      rotY: rand(q, r, 'veg-rot', n) * Math.PI * 2,
      // Target height; the variant's own measured height turns it into a
      // real scale factor when the matrix is built.
      scale: s.height * (1 - s.spread / 2 + j * s.spread) * scaleMul,
    })
    n++
  }

  // Ordinary scatter. Fractional densities are a real probability, not a
  // rounding error: 1.4 shrubs means one for sure and a 40% chance of a
  // second, which across a map is what stops every tile looking equally
  // populated.
  for (const tier of Object.keys(TIER_SPECIES) as Tier[]) {
    const want = density[tier]
    const count = Math.floor(want) + (rand(q, r, `veg-frac-${tier}`, 0) < want % 1 ? 1 : 0)
    const pool = tier === 'prop' && variant === 'earth' ? EARTH_PROPS : TIER_SPECIES[tier]
    for (let i = 0; i < count; i++) {
      // Square root on the radius spreads points evenly over the disc
      // instead of bunching them at the centre, which is what a plain
      // uniform radius would do.
      const angle = rand(q, r, `veg-a-${tier}`, i) * Math.PI * 2
      const dist = Math.sqrt(rand(q, r, `veg-d-${tier}`, i)) * SCATTER_RADIUS
      const species = pool[hashTile(q, r, `veg-s-${tier}-${i}`) % pool.length]
      push(species, Math.cos(angle) * dist, Math.sin(angle) * dist, 1)
    }
  }

  // ...and, on a minority of tiles, one composed diorama on top of it.
  if (rand(q, r, 'diorama-roll', 0) < DIORAMA_CHANCE) {
    let pickWeight = rand(q, r, 'diorama-kind', 0) * DIORAMA_TOTAL_WEIGHT
    const diorama = DIORAMAS.find((d) => (pickWeight -= d.weight) < 0) ?? DIORAMAS[0]
    const centreAngle = rand(q, r, 'diorama-pos', 0) * Math.PI * 2
    const centreDist = rand(q, r, 'diorama-pos', 1) * SCATTER_RADIUS * 0.5
    const cx = Math.cos(centreAngle) * centreDist
    const cz = Math.sin(centreAngle) * centreDist
    for (const part of diorama.parts) {
      for (let i = 0; i < part.count; i++) {
        const a = rand(q, r, `${diorama.key}-a-${part.species}`, i) * Math.PI * 2
        const d = Math.sqrt(rand(q, r, `${diorama.key}-d-${part.species}`, i)) * part.radius
        push(part.species, cx + Math.cos(a) * d, cz + Math.sin(a) * d, part.scale ?? 1)
      }
    }
  }
  return out
}


/** Resolution of the per-tile height grid below. 12 spans a 30m hex at ~5m
 * steps, which is finer than any real slope changes over. */
const HEIGHT_GRID = 12

/** The tile's real ground height, sampled from a small precomputed grid
 * instead of evaluated directly.
 *
 * `tileSurfaceAt` is not cheap — six edge ramps, three octaves of noise and a
 * stamp lookup per call — and the carpet asks for hundreds of thousands of
 * heights. Done directly that is tens of millions of trigonometric calls and
 * several seconds of frozen page on load. A 13x13 grid per tile costs 169
 * evaluations and answers every one of them by interpolation, and the error
 * is centimetres on a surface whose own features are metres wide: invisible
 * under a plant, and the exact same surface the tile's mesh draws at the
 * points that matter. */
function makeTileHeightSampler(tile: HexTileData, lookup: Map<string, HexTileData>) {
  const heightAt = tileSurfaceAt(tile, lookup)
  const span = HEX_SIZE * 2
  const step = span / HEIGHT_GRID
  const grid = new Float32Array((HEIGHT_GRID + 1) * (HEIGHT_GRID + 1))
  for (let j = 0; j <= HEIGHT_GRID; j++) {
    for (let i = 0; i <= HEIGHT_GRID; i++) {
      grid[j * (HEIGHT_GRID + 1) + i] = heightAt(-HEX_SIZE + i * step, -HEX_SIZE + j * step)
    }
  }
  return (x: number, z: number): number => {
    const fx = Math.min(HEIGHT_GRID - 0.0001, Math.max(0, (x + HEX_SIZE) / step))
    const fz = Math.min(HEIGHT_GRID - 0.0001, Math.max(0, (z + HEX_SIZE) / step))
    const i = fx | 0
    const j = fz | 0
    const tx = fx - i
    const tz = fz - j
    const row = j * (HEIGHT_GRID + 1) + i
    const a = grid[row]
    const b = grid[row + 1]
    const c = grid[row + HEIGHT_GRID + 1]
    const d = grid[row + HEIGHT_GRID + 2]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
  }
}

/** A fast deterministic 0..1 stream for one tile. xorshift rather than a
 * fresh hash per draw, because the carpet pulls five numbers per card and
 * hashing each one turns into real time at half a million cards. */
function makeTileRng(q: number, r: number, salt: string) {
  let state = hashTile(q, r, salt) | 0
  if (state === 0) state = 0x6d2b79f5
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1000000) / 1000000
  }
}


// ---------------------------------------------------------------------------
// The dense layer: grass cards
// ---------------------------------------------------------------------------

/** A tuft of blades painted into an alpha texture, drawn on two crossed
 * quads. Four triangles per tuft against a scanned clump's forty-five, which
 * is the entire reason the ground can be thick with grass at all: the same
 * triangle budget buys roughly ten times as many plants.
 *
 * Painted procedurally rather than shipped as an image — same approach the
 * project's other alpha-mapped foliage already uses — so it costs no download
 * and its colours can be tuned against the ground photo directly. */
let grassCardTexture: THREE.CanvasTexture | null = null
function getGrassCardTexture(): THREE.CanvasTexture {
  if (grassCardTexture) return grassCardTexture
  const W = 128
  const H = 128
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  // Deterministic: the same tuft image every load, so nothing about the
  // board's look depends on when it was opened.
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return ((seed >>> 0) % 100000) / 100000
  }
  const BLADES = 11
  for (let i = 0; i < BLADES; i++) {
    // Blades fan out from a base clustered near the middle of the card, so a
    // tuft reads as one plant rather than as a hedge of parallel strips.
    const baseX = W * (0.5 + (rnd() - 0.5) * 0.62)
    const tipX = baseX + (rnd() - 0.5) * W * 0.55
    const tipY = H * (0.06 + rnd() * 0.42)
    const halfWidth = W * (0.018 + rnd() * 0.022)
    // Greens picked around the ground photo's own mean (68,92,40) and spread
    // either side of it, so the geometry and the texture underneath read as
    // the same species of grass rather than two different plants.
    const shade = 0.72 + rnd() * 0.55
    ctx.fillStyle = `rgb(${Math.round(74 * shade)}, ${Math.round(104 * shade)}, ${Math.round(44 * shade)})`
    ctx.beginPath()
    ctx.moveTo(baseX - halfWidth, H)
    ctx.quadraticCurveTo(baseX - halfWidth * 0.6, H * 0.55, tipX, tipY)
    ctx.quadraticCurveTo(baseX + halfWidth * 0.6, H * 0.55, baseX + halfWidth, H)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  // Same anisotropy fix every other texture in this project needed — without
  // it, thousands of these at a distance alias into speckle.
  tex.anisotropy = 16
  grassCardTexture = tex
  return tex
}

/** Two quads crossed at right angles, base at y=0, one unit tall and one unit
 * wide, so an instance matrix can scale it straight into metres.
 *
 * Normals point straight UP rather than out of each quad's face. That is
 * deliberate and standard for foliage cards: with real face normals the two
 * quads light completely differently from each other and a field of them
 * turns into a patchwork of bright and black slivers. Borrowing the ground's
 * own normal makes every blade take light the way the ground under it does. */
let grassCardGeometry: THREE.BufferGeometry | null = null
function getGrassCardGeometry(): THREE.BufferGeometry {
  if (grassCardGeometry) return grassCardGeometry
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let quad = 0; quad < 2; quad++) {
    const dx = quad === 0 ? 0.5 : 0
    const dz = quad === 0 ? 0 : 0.5
    const base = quad * 4
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz)
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0)
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  grassCardGeometry = g
  return g
}

/** Card height range in metres — real grass, at the board's real 1 unit = 1
 * metre scale. Small on purpose ("tiene sentido que sea pequeño"); density,
 * not size, is what makes it read as thick. */
const CARD_MIN_HEIGHT = 0.34
const CARD_MAX_HEIGHT = 0.95
/** Cards are wider than they are tall, which is what lets a manageable number
 * of them close up the gaps between each other seen from above. */
const CARD_WIDTH_RATIO = 1.9

function makeCarpetMaterial() {
  const uniforms = { uTime: { value: 0 } }
  const material = new THREE.MeshStandardMaterial({
    map: getGrassCardTexture(),
    // alphaTest instead of transparency: a transparent material would have to
    // be depth-sorted, and half a million cards cannot be sorted per frame.
    // Cut-out alpha renders in the ordinary opaque pass, no sorting at all.
    alphaTest: 0.42,
    transparent: false,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying float vTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 instOrigin = instanceMatrix[3].xyz;
        // Only the top edge moves; the base is rooted. transformed.y is
        // already 0..1 by construction, so it doubles as the lean factor.
        float lean = transformed.y * transformed.y;
        // Per-instance RANDOM phase, hashed from the instance's position.
        //
        // This used to be x * 0.7 + z * 0.9, meant to decorrelate
        // neighbouring plants — but a linear function of position is a plane
        // wave, and that one had a 5.5m wavelength, so instead of
        // decorrelating anything it locked the whole field into fine
        // diagonal corduroy that scrolled across the board. Real user report
        // from the table view, twice: "se ven como unas lineas moviendose
        // sobre la hierba... sigue viendose MUY claramente."
        //
        // Hashing breaks the correlation completely: two plants a metre
        // apart get unrelated phases, so no crest can form anywhere and
        // there is nothing left to read as a line, at any camera angle.
        float phase = fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        // The gust — how hard the wind is blowing — is deliberately almost
        // uniform in SPACE and varies in TIME. Any spatial term here is a
        // travelling wave, and a travelling wave seen from directly above is
        // a bar sweeping the board; wavelengths this long (hundreds of
        // metres, well past the size of a map) mean neighbouring tiles gust
        // together, which is what real wind does anyway. The strength rises
        // and falls, and because every blade's own phase is random the field
        // reads as picking up and dying down rather than as a front passing
        // through.
        float g1 = sin(uTime * 0.42 - instOrigin.x * 0.0032 - instOrigin.z * 0.0021);
        float g2 = sin(uTime * 0.27 + instOrigin.x * 0.0018 - instOrigin.z * 0.0039);
        float gust = 0.58 + 0.32 * (g1 * 0.58 + g2 * 0.42);
        transformed.x += sin(uTime * 2.1 + phase) * lean * 0.16 * gust;
        transformed.z += cos(uTime * 1.6 + phase * 0.6) * lean * 0.11 * gust;
        // Per-instance shade, hashed from the instance's own position rather
        // than stored per instance: half a million colours would be another
        // 6MB of buffer for something a single sine can produce for free.
        vTint = 0.80 + 0.34 * fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTint;`)
  }
  return { material, uniforms }
}

/** The whole board's grass in ONE InstancedMesh.
 *
 * Matrices are composed by hand straight into the instance buffer instead of
 * through Object3D. At this count that is not micro-optimisation: half a
 * million Object3D updates allocate and cost seconds, while a rotation about
 * Y with a scale is nine multiplies written directly into the array. */
function GrassCarpet({ tiles, tilesKey, lookup }: {
  tiles: HexTileData[]
  tilesKey: string
  lookup: Map<string, HexTileData>
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const { material, uniforms } = useMemo(() => makeCarpetMaterial(), [])
  useEffect(() => () => material.dispose(), [material])

  const matrices = useMemo(() => {
    const live = tiles.filter((t) => VEGETATED.has(t.terrain))
    // How far the board is over budget, applied uniformly so a big map thins
    // out rather than dropping whole tiles (which would be visible as bald
    // hexes, where a uniform thinning just reads as shorter grass).
    // Candidates, before the patch field rejects most of them — its mean
    // over a large area is what actually lands on the board, so the budget
    // is measured against that rather than against the raw candidate count.
    const wanted = live.reduce((n, t) => n + CARPET_DENSITY[groundVariant(t.q, t.r)], 0) * CARPET_MEAN_KEEP
    const budget = wanted > CARPET_MAX_CARDS ? CARPET_MAX_CARDS / wanted : 1
    const total = Math.min(CARPET_MAX_CARDS, Math.ceil(wanted * budget))
    const array = new Float32Array(total * 16)
    const apothem = HEX_SIZE * Math.cos(Math.PI / 6)
    let n = 0
    for (const tile of live) {
      const count = Math.round(CARPET_DENSITY[groundVariant(tile.q, tile.r)] * budget)
      if (count <= 0) continue
      const [wx, wz] = hexToWorld(tile.q, tile.r)
      const sampleY = makeTileHeightSampler(tile, lookup)
      const patchAt = makeGrassDensitySampler(wx, wz)
      const rnd = makeTileRng(tile.q, tile.r, 'carpet')
      for (let i = 0; i < count && n < total; i++) {
        // Rejection-sample the real hexagon rather than settling for its
        // inscribed circle, which would leave a bare ring around every tile
        // exactly where two tiles meet and it would show most.
        //
        // A candidate that lands outside is DROPPED, never nudged or reused.
        // An earlier version kept the last try when all of them missed,
        // which put roughly one card in two thousand at a uniformly random
        // point of the bounding square instead of inside the hex — invisible
        // in the middle of the board, where it just lands on a neighbour,
        // and a real user report at its edge: "hay hierba que se sale del
        // tablero, eso no puede pasar."
        //
        // The test is the hexagon's own three edge-normal pairs. Corners sit
        // at angle i*60 with position (R sin, R cos), so the flats face +-x
        // at the apothem and the slanted edges give the second term. An
        // earlier bound on |z| was simply wrong for this orientation (the
        // hexagon reaches R, not the apothem, along z) and quietly shaved
        // the top and bottom tips off every tile's grass.
        const inHex = (px: number, pz: number) => Math.abs(px) <= apothem
          && Math.abs(px) * 0.5 + Math.abs(pz) * (Math.sqrt(3) / 2) <= apothem
        let x = 0
        let z = 0
        let placed = false
        for (let tryCount = 0; tryCount < 8 && !placed; tryCount++) {
          x = (rnd() - 0.5) * 2 * HEX_SIZE
          z = (rnd() - 0.5) * 2 * HEX_SIZE
          placed = inHex(x, z)
        }
        if (!placed) continue
        // The patch field decides whether this candidate becomes a plant at
        // all. Rejection sampling rather than a per-tile count, so the mats
        // land where the FIELD says and stay continuous across borders.
        if (rnd() > patchAt(x, z)) continue
        const h = CARD_MIN_HEIGHT + rnd() * (CARD_MAX_HEIGHT - CARD_MIN_HEIGHT)
        const w = h * CARD_WIDTH_RATIO
        const a = rnd() * Math.PI
        const c = Math.cos(a) * w
        const sn = Math.sin(a) * w
        const o = n * 16
        array[o] = c; array[o + 1] = 0; array[o + 2] = -sn; array[o + 3] = 0
        array[o + 4] = 0; array[o + 5] = h; array[o + 6] = 0; array[o + 7] = 0
        array[o + 8] = sn; array[o + 9] = 0; array[o + 10] = c; array[o + 11] = 0
        array[o + 12] = wx + x; array[o + 13] = sampleY(x, z); array[o + 14] = wz + z; array[o + 15] = 1
        n++
      }
    }
    return { array, count: n }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices.array, 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = matrices.count
    // Culled as one object against a single card's bounds at the origin
    // otherwise, which makes the entire board's grass vanish the moment the
    // camera looks away from its centre.
    mesh.frustumCulled = false
  }, [matrices])

  useFrame((state) => { uniforms.uTime.value = state.clock.elapsedTime })

  if (matrices.count === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[getGrassCardGeometry(), material, matrices.count]}
      receiveShadow
      castShadow={false}
    />
  )
}

export function GroundVegetation({ tiles, lookup }: {
  tiles: HexTileData[]
  lookup: Map<string, HexTileData>
}) {
  /** Everything below is keyed on this rather than on `tiles` itself.
   *
   * Real user report, in the first-person view: "cuando termina el
   * movimiento, las decoraciones flickerean, desaparecen y vuelven a
   * aparecer." Finishing a move refetches the session, which hands HexMap a
   * NEW tiles array holding the very same terrain — a different object, so
   * every memo depending on the array identity threw away and rebuilt the
   * entire board's vegetation, hundreds of thousands of instances, for a map
   * that had not changed at all. Comparing what the tiles actually SAY costs
   * a few hundred string concatenations and skips all of it.
   *
   * Only the fields the vegetation genuinely depends on go in: where a tile
   * is, what grows there, and how high it sits. */
  const tilesKey = useMemo(
    () => tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|'),
    [tiles],
  )
  const urls = useMemo(() => [...new Set(Object.values(SPECIES).map((s) => s.url))], [])
  const gltfs = useGLTF(urls) as unknown as { scene: THREE.Group }[]

  // Keyed on the loaded scenes' own identities, NOT on the array `useGLTF`
  // returns. That array is rebuilt on every render even though the scenes
  // inside it are cached and stable, so depending on it made this memo (and
  // the placement memo below, which depends on this one) recompute every
  // single frame — rebuilding every plant on the board sixty times a second,
  // which measured at 1 fps and looked for all the world like a rendering
  // cost rather than the pure bookkeeping bug it was.
  const sceneKey = gltfs.map((g) => g?.scene?.uuid ?? '').join('|')
  // One entry per species, each a list of that model's own variants.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variants = useMemo(() => {
    const byUrl = new Map<string, { scene: THREE.Group }>()
    urls.forEach((u, i) => byUrl.set(u, gltfs[i]))
    const map = new Map<SpeciesKey, Variant[]>()
    for (const key of Object.keys(SPECIES) as SpeciesKey[]) {
      const gltf = byUrl.get(SPECIES[key].url)
      if (gltf?.scene) map.set(key, extractVariants(gltf.scene, key))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey])

  // Every plant on the board, bucketed by the exact variant that draws it —
  // one bucket becomes one InstancedMesh.
  const buckets = useMemo(() => {
    const out = new Map<string, { variant: Variant; matrices: THREE.Matrix4[] }>()
    const dummy = new THREE.Object3D()
    for (const tile of tiles) {
      if (!VEGETATED.has(tile.terrain)) continue
      const [wx, wz] = hexToWorld(tile.q, tile.r)
      // The tile's own real surface, so a plant sits ON the ground however
      // the ground is ramped, bumped or cratered — not on a flat guess.
      const surfaceAt = makeTileHeightSampler(tile, lookup)
      for (const p of placeTile(tile)) {
        const pool = variants.get(p.species)
        if (!pool || pool.length === 0) continue
        const variant = pool[p.variantPick % pool.length]
        const bucketKey = `${p.species}:${variant.index}`
        let bucket = out.get(bucketKey)
        if (!bucket) { bucket = { variant, matrices: [] }; out.set(bucketKey, bucket) }
        dummy.position.set(wx + p.x, surfaceAt(p.x, p.z), wz + p.z)
        dummy.rotation.set(0, p.rotY, 0)
        dummy.scale.setScalar(p.scale)
        dummy.updateMatrix()
        bucket.matrices.push(dummy.matrix.clone())
      }
    }
    return [...out.entries()].map(([key, b]) => ({ key, ...b }))
    // Deliberately keyed on the tiles' CONTENT, not on the array holding
    // them — see `tilesKey` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, variants])

  return (
    <>
      <GrassCarpet tiles={tiles} tilesKey={tilesKey} lookup={lookup} />
      {buckets.map((b) => (
        <VegetationBatch key={b.key} variant={b.variant} matrices={b.matrices} />
      ))}
    </>
  )
}

function VegetationBatch({ variant, matrices }: { variant: Variant; matrices: THREE.Matrix4[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const sway = SPECIES[variant.species].sway
  const { material, uniforms } = useMemo(
    () => makeWindMaterial(variant.material, variant.height, sway),
    [variant, sway],
  )
  useEffect(() => () => material.dispose(), [material])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
    // Instanced meshes are frustum-culled against the geometry of ONE
    // instance sitting at the origin, so the whole batch pops out of view as
    // soon as the camera looks away from the board's centre. The batch spans
    // the map by definition, so culling it as a unit is meaningless anyway.
    mesh.frustumCulled = false
  }, [matrices])

  useFrame((state) => { uniforms.uTime.value = state.clock.elapsedTime })

  if (matrices.length === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[variant.geometry, material, matrices.length]}
      receiveShadow
      // No castShadow on purpose. A shadow map re-renders every caster from
      // the light's point of view, so switching it on here would double the
      // cost of the single heaviest thing on the board for shadows that, at
      // grass scale, land almost entirely underneath the plant casting them.
      castShadow={false}
    />
  )
}

// Same preload convention the other .glb decor in this project uses — starts
// the fetch as soon as the module is imported rather than when the first
// tile that needs it renders.
Object.values(SPECIES).forEach((s) => useGLTF.preload(s.url))
