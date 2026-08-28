import { ELEVATION_STEP, HEX_SIZE, hexToWorld, worldToHex } from './hexMath'

/** Real user request: "quiero que tengan pequeñas variaciones de altura
 * representando terreno real... siempre en las constraints generales del
 * hex" — and critically: "si un hex tiene el comienzo de un montículo, y
 * se corta el hex de al lado continuará con el montículo." A per-tile
 * random pattern can never satisfy that second part; sampling one
 * continuous noise field by WORLD-space X/Z instead of per-tile-local
 * coordinates does, for free — two neighboring tiles evaluating the same
 * world point at their shared edge always get the same answer, no
 * stitching logic needed. Same technique HexMap.tsx's own fog shader
 * already uses for its turbulence (`fogFbm`/`fogNoiseGLSL`) — this file
 * is a fresh, numerically self-contained twin (not a re-export) since it
 * needs a JS-callable copy too (mechs sample this directly for their own
 * resting Y — see this file's own `terrainReliefAt`), which the fog
 * shader's GLSL-only version can't provide.
 *
 * JS and GLSL below MUST stay numerically identical (same hash, same fbm
 * shape, same frequency/amplitude) — `terrainReliefGLSL` is generated
 * FROM the JS constants via template-literal interpolation specifically
 * so there's exactly one source of truth for those numbers, not two
 * hand-copies that could quietly drift apart. That consistency is what
 * lets the visual mesh, a mech's own feet, and a die's physics collider
 * all agree on the exact same ground height at any given point. */

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123
  return s - Math.floor(s)
}

function valueNoise2(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return a + (b - a) * ux + (c - a) * uy * (1 - ux) + (d - b) * ux * uy
}

function fbm2(x: number, y: number, octaves: number): number {
  let value = 0
  let amplitude = 0.55
  let px = x
  let py = y
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise2(px, py)
    px *= 2.05
    py *= 2.05
    amplitude *= 0.5
  }
  return value
}

// Wavelength ~1.4 hex-widths — gentle rolling character readable across
// a couple of tiles, not a fine-grained speckle. Real user follow-up:
// "la orografia dentro de los hex de misma altura" should plausibly use
// a whole elevation BAND's own range (hexMath.ts's elevationBandRange —
// 5-6m) — amplitude bumped so it can comfortably reach a band's own
// edges once hexTileGeometry.ts clamps the result there; the clamp
// itself (not this number) is what guarantees relief never crosses into
// a DIFFERENT level's own range.
export const RELIEF_AMPLITUDE = ELEVATION_STEP * 0.6
const RELIEF_FREQUENCY = 1 / (HEX_SIZE * 1.4)
const RELIEF_OCTAVES = 3
// Hard clamp on any single stamp's depth — keeps the "wall tall enough
// to hide the biggest possible bump" assumption (HexMap.tsx's own
// terrainSideWalls) true regardless of what a caller passes in.
export const MAX_STAMP_DEPTH = RELIEF_AMPLITUDE * 2

/** Continuous, world-space-coherent height offset (world units, signed)
 * for plain dry terrain — mounds/irregularities. NOT applied to "flush"
 * terrains (water/swamp/building platforms), same as everywhere else
 * that already special-cases those (see hexMath.ts's elevationToY /
 * TerrainDecor.tsx's terrainSinkY) — callers check that themselves. */
export function terrainReliefAt(worldX: number, worldZ: number): number {
  const n = fbm2(worldX * RELIEF_FREQUENCY, worldZ * RELIEF_FREQUENCY, RELIEF_OCTAVES)
  return (n - 0.5) * 2 * RELIEF_AMPLITUDE
}

/** Terrains that stay perfectly flat — same "flush surface" terrains
 * `terrainSinkY` (TerrainDecor.tsx) and `elevationToY`'s own building
 * override already special-case, for the same visual reasons documented
 * there (a water/mud surface or a building's sidewalk platform must
 * read as one flat plane, not textured ground). Checked by both the
 * Tile's own shader gating (HexMap.tsx) and `combinedReliefAt` below, so
 * a mech's feet and the visual mesh always agree on which tiles get
 * relief at all. */
export const RELIEF_SKIP_TERRAINS = new Set(['water', 'water_deep', 'swamp', 'building'])

/** GLSL twin of the JS functions above, generated from the exact same
 * constants — include once per shader (vertex only needs it; nothing
 * here reads varyings/uniforms besides its own literal constants, so
 * it's safe to drop into any vertex shader that has `position`/
 * `modelMatrix` in scope, same inclusion pattern as HexMap.tsx's own
 * `fogNoiseGLSL`). `terrainReliefAt(vec2 worldXZ)` mirrors the JS
 * function of the same name 1:1. */
export const terrainReliefGLSL = /* glsl */ `
  float terrainHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float terrainValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = terrainHash(i);
    float b = terrainHash(i + vec2(1.0, 0.0));
    float c = terrainHash(i + vec2(0.0, 1.0));
    float d = terrainHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float terrainFbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.55;
    for (int i = 0; i < ${RELIEF_OCTAVES}; i++) {
      value += amplitude * terrainValueNoise(p);
      p *= 2.05;
      amplitude *= 0.5;
    }
    return value;
  }
  float terrainReliefAt(vec2 worldXZ) {
    float n = terrainFbm(worldXZ * ${RELIEF_FREQUENCY.toFixed(10)});
    return (n - 0.5) * 2.0 * ${RELIEF_AMPLITUDE.toFixed(6)};
  }
`

// ---------------------------------------------------------------------
// Stamped local deformation — footprints/craters. Discrete, tile-local
// events layered ON TOP of the continuous relief above, unlike it these
// deliberately do NOT need cross-tile coherence (a footprint/crater is
// an inherently local, one-off event — nothing requires it to "continue"
// into the next hex the way natural terrain relief does).
//
// Real user correction: "NO! HUELLAS Y CRATERES 3D... NADA DE DECALS!" —
// an earlier version of this file also kept a per-tile canvas/texture so
// a vertex shader could sample it. That whole shader approach was
// reverted (see hexTileGeometry.ts's own doc comment); the geometry is
// now baked in plain JS, which means the ONLY thing anything needs from
// a stamp is this analytic depth query — no canvas, no texture, no GPU
// upload. `stampedDepthAt` was always plain math and never the buggy
// part, so it survives unchanged; the canvas machinery around it doesn't.

interface TileStampData {
  /** Tile-local, normalized to STAMP_RADIUS on each axis; halfWidth/
   * halfDepth/depth in world units, angle in radians (three.js Y-rotation
   * convention — see `stampDeformation`'s own doc comment). A plain
   * circular stamp (weapon craters, the old footprint approximation) is
   * just `halfWidth === halfDepth, angle === 0`. */
  stamps: { lx: number; lz: number; halfWidth: number; halfDepth: number; angle: number; depth: number }[]
  lastTouchedMs: number
}

// Tile-local stamp coordinates are normalized to this same radius —
// matches Tile's own terrain-cylinder radius (HexMap.tsx: HEX_SIZE*0.98)
// so a stamp's world position always resolves to the same tile its
// visual geometry actually occupies.
const STAMP_RADIUS = HEX_SIZE * 0.98

const tileStamps = new Map<string, TileStampData>()
// Bumped every time ANY stamp touches a given tile — HexMap.tsx's own
// Tile polls this (cheap Map.get, same pattern its earlier shader
// attempt already used for texture-arrival detection) to know when to
// rebuild that one tile's own baked geometry, since `stampedDepthAt` is
// plain data a memoized geometry build has no other way to react to.
const stampVersions = new Map<string, number>()

// Real user request: huellas and cráteres both need a budget so a long
// session doesn't grow this store forever — same "cap it, evict the
// coldest" reasoning the old flat-decal system's own MAX_FOOTPRINTS/
// MAX_IMPACT_MARKS already established.
const MAX_STAMPED_TILES = 80

function tileKey(q: number, r: number): string {
  return `${q},${r}`
}

function getOrCreateTileStamp(q: number, r: number): TileStampData {
  const key = tileKey(q, r)
  let data = tileStamps.get(key)
  if (data) {
    data.lastTouchedMs = Date.now()
    return data
  }
  if (tileStamps.size >= MAX_STAMPED_TILES) {
    let oldestKey: string | null = null
    let oldestMs = Infinity
    for (const [k, v] of tileStamps) {
      if (v.lastTouchedMs < oldestMs) { oldestMs = v.lastTouchedMs; oldestKey = k }
    }
    if (oldestKey) tileStamps.delete(oldestKey)
  }
  data = { stamps: [], lastTouchedMs: Date.now() }
  tileStamps.set(key, data)
  return data
}

/** Real user request: "quiero que JUSTO donde pisa el mech queden
 * huellas, quiero crateres de las armas" — 3D, no decals: this records a
 * soft depression (or rise, for a negative depth) for whichever tile
 * owns `(worldX, worldZ)` (resolved internally via `worldToHex`, so
 * callers never need to already know q/r themselves); `stampedDepthAt`
 * below and hexTileGeometry.ts's own baked mesh are what actually turn
 * it into real geometry. `halfWidth`/`halfDepth`/`depth` are world units
 * — same scale as everything else post-normalization (HEX_SIZE=30 real
 * meters/hex). Positive `depth` sinks (a footprint/crater); negative
 * raises.
 *
 * Generalized from a plain circle to an oriented ellipse for the real
 * per-chassis foot shape (Mech3D.tsx's own `onFootstep` — "Si las
 * huellas IK cogen la forma de la planta del pie de la malla, me
 * valen"): `halfDepth` defaults to `halfWidth` (a circle) and `angle`
 * defaults to 0, so every existing circular caller (weapon craters, the
 * geometric-fallback footprint path) is unchanged without touching its
 * own call site. `angle` is radians, same convention as a mounted
 * mech's own `group.rotation.y` (three.js Y-axis rotation) — the axis
 * `halfDepth` extends along. */
export function stampDeformation(
  worldX: number,
  worldZ: number,
  halfWidth: number,
  rawDepth: number,
  halfDepth: number = halfWidth,
  angle = 0,
): void {
  // Real user report: actual HOLES in the terrain mesh at a distance —
  // "veo cosas de debajo del tablero, se rompe la textura". A stamp with
  // a zero/non-finite half-size makes stampedDepthAt's own falloff
  // (`localX / s.halfWidth`) divide by zero — an Infinity or (worse, if
  // the query point is exactly on-center) NaN result poisons the whole
  // summed depth for that point, and a NaN vertex Y makes WebGL quietly
  // refuse to draw every triangle touching it — a real hole, not just
  // dark shading, exactly matching the report. A caller passing a bad
  // half-size shouldn't be possible today (every one clamps to a real
  // minimum already), but a stamp this cheap and this failure mode this
  // severe is worth guarding at the source rather than trusting every
  // future caller to get it right. Coordinates/depth get the same
  // treatment — any non-finite input just doesn't get stamped at all.
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ) || !Number.isFinite(rawDepth)) return
  const safeHalfWidth = Number.isFinite(halfWidth) && halfWidth > 0 ? halfWidth : 0.01
  const safeHalfDepth = Number.isFinite(halfDepth) && halfDepth > 0 ? halfDepth : 0.01
  const depth = Math.max(-MAX_STAMP_DEPTH, Math.min(MAX_STAMP_DEPTH, rawDepth))
  const { q, r } = worldToHex(worldX, worldZ)
  const [tileCenterX, tileCenterZ] = hexToWorld(q, r)
  const data = getOrCreateTileStamp(q, r)
  const lx = (worldX - tileCenterX) / STAMP_RADIUS
  const lz = (worldZ - tileCenterZ) / STAMP_RADIUS
  data.stamps.push({
    lx, lz, halfWidth: safeHalfWidth / STAMP_RADIUS, halfDepth: safeHalfDepth / STAMP_RADIUS, angle, depth,
  })
  const key = tileKey(q, r)
  stampVersions.set(key, (stampVersions.get(key) ?? 0) + 1)
}

/** Cheap poll target for a tile's own React component (HexMap.tsx's
 * Tile) to detect "something stamped me since I last built my own
 * geometry" — see `stampVersions`' own doc comment above. 0 for a tile
 * that's never been stamped. */
export function getStampVersion(q: number, r: number): number {
  return stampVersions.get(tileKey(q, r)) ?? 0
}

/** Plain analytic query — sums every stamp on the tile owning
 * `(worldX, worldZ)` (there are never many per tile in practice — each
 * hex only ever accumulates a handful before its own visual density
 * makes new ones redundant). Used both by hexTileGeometry.ts (baking the
 * real 3D dent) and by a mech's own resting Y (`combinedReliefAt`
 * below), so what a mech stands on and what's actually drawn always
 * agree. */
export function stampedDepthAt(worldX: number, worldZ: number): number {
  const { q, r } = worldToHex(worldX, worldZ)
  const data = tileStamps.get(tileKey(q, r))
  if (!data || data.stamps.length === 0) return 0
  const [tileCenterX, tileCenterZ] = hexToWorld(q, r)
  const lx = (worldX - tileCenterX) / STAMP_RADIUS
  const lz = (worldZ - tileCenterZ) / STAMP_RADIUS
  let total = 0
  for (const s of data.stamps) {
    const dx = lx - s.lx
    const dz = lz - s.lz
    // Rotate the query offset into the stamp's own local frame (inverse
    // of the three.js Y-rotation the stamp was recorded with — see
    // `stampDeformation`'s own doc comment) so a non-zero `angle` reads
    // as a real oriented ellipse instead of an axis-aligned one.
    const localX = dx * Math.cos(s.angle) - dz * Math.sin(s.angle)
    const localZ = dx * Math.sin(s.angle) + dz * Math.cos(s.angle)
    const d = Math.hypot(localX / s.halfWidth, localZ / s.halfDepth)
    if (d >= 1) continue
    const falloff = 1 - d
    total += s.depth * falloff * falloff
  }
  // Defensive: each individual stamp is already clamped to
  // MAX_STAMP_DEPTH at creation (stampDeformation above), but several
  // overlapping stamps summed here are not — real overlap does happen
  // (repeated steps near the same spot, a footprint landing inside an
  // old crater) and a real bug once made THIS exact thing happen dozens
  // of times a frame (see Mech3D.tsx's own onFootstep doc comment on the
  // footfall-detection jitter it fixed) — the sum blew straight past any
  // plausible real depth, reading as a sheer-walled black pit instead of
  // a shallow dent. Clamping the TOTAL, not just each contributor, keeps
  // that impossible regardless of how a future caller manages to stack
  // stamps.
  return Math.max(-MAX_STAMP_DEPTH, Math.min(MAX_STAMP_DEPTH, total))
}

/** Real user request: mechs must stand exactly on the real terrain —
 * "que ni floten ni se hundan". Mechs are never Rapier bodies (their Y
 * is a plain lookup applied to a group, not physics-simulated — see
 * HexMap.tsx's UnitMarker), so "real footing" just means resolving the
 * SAME height a nearby vertex of the visual mesh would show: base
 * elevation (unchanged, still `elevationToY`, this file doesn't touch
 * that) + continuous relief + any stamped crater/footprint, at the
 * mech's own exact X/Z (mid-walk included, not just hex centers).
 * `terrain` gates out RELIEF_SKIP_TERRAINS exactly like the shader does,
 * so a mech standing in water/mud/on a building platform stays flush
 * with THAT surface instead of picking up rolling-terrain relief meant
 * for dry ground. Returns 0 for a skipped terrain (no relief, no
 * stamps — nothing stamps a flush surface either way today). */
export function combinedReliefAt(worldX: number, worldZ: number, terrain: string): number {
  if (RELIEF_SKIP_TERRAINS.has(terrain)) return 0
  return terrainReliefAt(worldX, worldZ) + stampedDepthAt(worldX, worldZ)
}
