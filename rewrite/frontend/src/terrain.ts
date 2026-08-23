import * as THREE from 'three'

/** Shared by MapEditorView (authoring) and HexMap (table display) so the
 * two never drift into showing terrain differently.
 *
 * A handful of terrains (plains, forest/light_forest, hills, road,
 * water/water_deep, rough, rubble, swamp, snow, building — see
 * ROTATED_PHOTO_TERRAINS below) use a real CC0 photo (public/textures/
 * CREDITS.md) for a genuinely realistic look; everything else still gets
 * a procedural texture (canvas-drawn, no external assets — same approach
 * as the dice pips), which bakes in its own full color. Either way
 * `terrainColor()` is white for every terrain except forest (a fixed
 * darkening — dense canopy shadow) and water_deep (a darker tint), so
 * texture and material color multiply cleanly instead of double-tinting.
 * Procedural terrains get a few variants picked deterministically per
 * tile (a hash of its coordinates, not Math.random — stays stable across
 * re-renders) so neighboring tiles of the same type don't look identical;
 * the photo terrains get `terrainRotation()` instead (see below) since
 * there's only one photo each to vary. */

const SIZE = 512
const VARIANTS = 3

// Real CC0 photos instead of the procedural canvas pattern every other
// terrain still uses. Each loaded once and shared (RepeatWrapping tiles
// it across every tile's own UV space); repeat is tuned by eye so
// detail stays crisp up close without the seams repeating often enough
// to be obvious at table-wide zoom. Only one photo per terrain (unlike
// the procedural VARIANTS below) — terrainRotation() gives each tile a
// different apparent orientation of the same tiling photo instead, so a
// whole field of plains doesn't look like one image pasted in a grid.
const GRASS_REPEAT = 3
const FOREST_FLOOR_REPEAT = 4
const DIRT_REPEAT = 3
const ROAD_REPEAT = 2
const photoTextures = new Map<string, THREE.Texture>()
function loadPhotoTexture(url: string, repeat: number): THREE.Texture {
  const cached = photoTextures.get(url)
  if (cached) return cached
  const tex = new THREE.TextureLoader().load(url)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(repeat, repeat)
  photoTextures.set(url, tex)
  return tex
}
const getGrassTexture = () => loadPhotoTexture('/textures/grass.jpg', GRASS_REPEAT)
const getForestFloorTexture = () => loadPhotoTexture('/textures/forest-floor.jpg', FOREST_FLOOR_REPEAT)
const getDirtTexture = () => loadPhotoTexture('/textures/dirt.jpg', DIRT_REPEAT)
// No baked-in centerline (that's RoadMarkings.tsx's job, painted per-tile
// from real neighbor connections) — plain worn asphalt only.
const getRoadTexture = () => loadPhotoTexture('/textures/road.jpg', ROAD_REPEAT)
const HILL_GRASS_REPEAT = 3
const getHillGrassTexture = () => loadPhotoTexture('/textures/hill-grass.jpg', HILL_GRASS_REPEAT)
const WATER_BED_REPEAT = 2
const getWaterBedTexture = () => loadPhotoTexture('/textures/water-bed.jpg', WATER_BED_REPEAT)
const ROUGH_REPEAT = 2
const getRoughTexture = () => loadPhotoTexture('/textures/rough.jpg', ROUGH_REPEAT)
const RUBBLE_REPEAT = 2
const getRubbleTexture = () => loadPhotoTexture('/textures/rubble.jpg', RUBBLE_REPEAT)
const SWAMP_REPEAT = 3
const getSwampTexture = () => loadPhotoTexture('/textures/swamp.jpg', SWAMP_REPEAT)
const SNOW_REPEAT = 3
const getSnowTexture = () => loadPhotoTexture('/textures/snow.jpg', SNOW_REPEAT)
const SIDEWALK_REPEAT = 2
const getSidewalkTexture = () => loadPhotoTexture('/textures/sidewalk.jpg', SIDEWALK_REPEAT)

// Not every plains tile is a uniform lawn — a minority (roughly 1 in 5)
// render as bare, pebbly earth instead (dirt.jpg), so a field reads as
// patchy ground rather than one photo tiled everywhere. Exported so
// terrainColor()'s brightness-jitter tint and any decoration logic that
// cares (fewer grass tufts on a dirt patch, say) can agree with the
// texture on which tiles are which, instead of re-deriving the same
// hash independently and risking the two disagreeing.
export function plainsGroundVariant(q: number, r: number): 'grass' | 'dirt' {
  return hashTile(q, r, 'plains-ground') % 5 === 0 ? 'dirt' : 'grass'
}

/** Per-tile Y rotation (radians) for the photo terrains — cheap stand-in
 * for the procedural terrains' multiple baked variants: rotating the
 * whole tile mesh shows a different apparent crop/orientation of the
 * same repeating photo, breaking up the obvious grid-alignment a shared
 * texture would otherwise show across many tiles, without needing
 * multiple source images or cloning a Texture before its image has
 * actually loaded (a real hazard — a clone made too early never picks
 * up the async load, leaving that tile blank). Zero for every other
 * terrain, which already gets variety from its own baked variants.
 *
 * Snapped to 60° steps — the tile mesh is a 6-sided cylinder, so only
 * multiples of its own rotational symmetry keep its hex silhouette
 * aligned edge-to-edge with its neighbors; anything finer would open
 * visible gaps/overlaps at tile borders despite the texture itself
 * tiling seamlessly. */
const ROTATED_PHOTO_TERRAINS = new Set(['plains', 'forest', 'light_forest', 'road', 'hills', 'water', 'water_deep', 'rough', 'rubble', 'swamp', 'snow', 'building'])
export function terrainRotation(terrain: string, q: number, r: number): number {
  if (!ROTATED_PHOTO_TERRAINS.has(terrain)) return 0
  return (hashTile(q, r, 'photo-rotation') % 6) * (Math.PI / 3)
}

function mulberry32(seed: number) {
  let s = seed | 0
  return function rng() {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** Deterministic per-tile hash — same inputs always give the same output,
 * so texture/decor variety is stable across re-renders and reloads. */
export function hashTile(q: number, r: number, salt: number | string = 0): number {
  const s = typeof salt === 'string' ? hashString(salt) : salt
  let h = Math.imul(q, 374761393) ^ Math.imul(r, 668265263) ^ Math.imul(s, 2246822519)
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  h ^= h >>> 13
  return h >>> 0
}

/** Forest gets a fixed dark multiply — the moss photo (public/textures/
 * CREDITS.md) is a bright lawn-like green on its own; darkening it reads
 * as canopy shadow seen from directly above, matching the moody/dense
 * look the old procedural forest texture had. Every other photo terrain
 * (plains, hills) bakes its full color into the texture itself, so the
 * material color stays white there (multiplying by white is a no-op) —
 * hills used to get its own elevation-based color ramp instead of a real
 * texture (no photo existed yet), but keeping that tint now that
 * hill-grass.jpg exists would just wash the real photo out unnaturally,
 * the same reasoning already applied to plains/forest.
 *
 * These photo terrains additionally get a small per-tile brightness
 * jitter (±6%) folded into this same color, since they only have one
 * source photo each (see terrainRotation above) — without it, every
 * plains/hills tile would be lit exactly alike despite sharing one
 * image; every non-photo terrain already varies via its own baked
 * texture variant, so no jitter is added there. */
export function terrainColor(terrain: string, q = 0, r = 0): string {
  if (terrain === 'plains' || terrain === 'forest' || terrain === 'light_forest' || terrain === 'hills') {
    // light_forest gets a lighter multiply than forest's dense-canopy
    // shadow — thinner canopy, more daylight reaching the ground — while
    // still reading as the same photo terrain, not a distinct texture.
    const base =
      terrain === 'forest' ? { r: 0x4a, g: 0x5c, b: 0x46 } :
      terrain === 'light_forest' ? { r: 0x7a, g: 0x8c, b: 0x70 } :
      { r: 0xff, g: 0xff, b: 0xff }
    const jitter = 0.94 + (hashTile(q, r, 'photo-tint') % 1000 / 1000) * 0.12
    const scale = (c: number) => Math.max(0, Math.min(255, Math.round(c * jitter)))
    return `rgb(${scale(base.r)}, ${scale(base.g)}, ${scale(base.b)})`
  }
  if (terrain === 'water_deep') return '#0c2530'
  return '#ffffff'
}

// ---- per-terrain procedural drawers ---------------------------------------
// Light near-white base = detail multiplier over the elevation-tinted
// material color (hills only now — plains uses a real photo, see
// getGrassTexture above). Everything else bakes its own full color.

function drawHazards(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#3a2c18'
  ctx.fillRect(0, 0, size, size)
  ctx.save()
  ctx.translate(size / 2, size / 2)
  ctx.rotate(Math.PI / 4)
  ctx.translate(-size / 2, -size / 2)
  for (let x = -size; x < size * 2; x += size * 0.14) {
    ctx.fillStyle = 'rgba(220,160,40,0.35)'
    ctx.fillRect(x, -size, size * 0.07, size * 3)
  }
  ctx.restore()
  for (let i = 0; i < 12; i++) {
    const x = rng() * size
    const y = rng() * size
    const rad = size * (0.04 + rng() * 0.08)
    ctx.fillStyle = `rgba(${90 + rng() * 60 | 0},${140 + rng() * 60 | 0},${30 + rng() * 30 | 0},0.25)`
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
}

const DRAW: Record<string, (ctx: CanvasRenderingContext2D, size: number, rng: () => number) => void> = {
  hazards: drawHazards,
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

const baseCache = new Map<string, THREE.CanvasTexture>()

function buildBaseTexture(terrain: string, variant: number): THREE.CanvasTexture {
  const key = `${terrain}:${variant}`
  const existing = baseCache.get(key)
  if (existing) return existing
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  const draw = DRAW[terrain]
  if (draw) {
    draw(ctx, SIZE, mulberry32(hashString(terrain) * 97 + variant * 131 + 7))
  } else {
    ctx.fillStyle = '#888888'
    ctx.fillRect(0, 0, SIZE, SIZE)
  }
  const tex = finish(canvas)
  baseCache.set(key, tex)
  return tex
}

// Building gets 5 looks — 3 standing (real models, one of
// BUILDING_MODEL_URLS in TerrainDecor.tsx, picked by this same kind) + 2
// ruined (one of the same 3 models reused with a scorched tint and
// smaller size — see RealBuilding's own comment) — since "some
// standing, some ruined" is the whole point here.
const BUILDING_VARIANTS = 5

/** Which of the 5 building looks a tile gets — exported so TerrainDecor's
 * 3D shape (clean tower vs collapsed rubble) picks the SAME one
 * consistently, instead of re-deriving the hash independently and
 * risking drift. */
export function buildingKind(q: number, r: number): number {
  return hashTile(q, r, 'building-kind') % BUILDING_VARIANTS
}

/** Deterministic per-tile variant (stable across renders) of a terrain's
 * texture — same terrain, different tiles look slightly different. */
export function terrainTexture(terrain: string, q: number, r: number): THREE.Texture {
  if (terrain === 'plains') return plainsGroundVariant(q, r) === 'dirt' ? getDirtTexture() : getGrassTexture()
  if (terrain === 'forest' || terrain === 'light_forest') return getForestFloorTexture()
  if (terrain === 'road') return getRoadTexture()
  // Real photo instead of the flat procedural pattern every other
  // non-photo terrain still uses — per explicit request for "alguna
  // textura realista" once the tapered-mound geometry fix (see
  // HexMap.tsx's own hillTopRadius) made hills actually worth looking
  // closely at instead of reading as a flat-topped block.
  if (terrain === 'hills') return getHillGrassTexture()
  // The tile's own ground, not the building on top of it — a real
  // sidewalk photo, per explicit request ("quiero que la base tenga la
  // textura como de una acera"). The building itself is a real .glb
  // model with its own materials (TerrainDecor.tsx's RealBuilding).
  if (terrain === 'building') return getSidewalkTexture()
  // Real riverbed photo — this is the tile's own floor, seen through the
  // separate translucent WaterSurface TerrainDecor.tsx renders above it.
  // water_deep reuses the same photo; the darker terrainColor() multiply
  // (and its own deeper WaterSurface tint) is what distinguishes it, not
  // a separate texture.
  if (terrain === 'water' || terrain === 'water_deep') return getWaterBedTexture()
  // Real rocky-ground / rubble-strewn-ground photos — replacing the flat
  // procedural stroke/speckle patterns (drawRough/drawRubble, both now
  // deleted) per explicit request for "textura realista" on both, paired
  // with real 3D rock/debris-chunk models (TerrainDecor's RealRock) so
  // the terrain reads as genuinely rocky/ruined rather than a flat tint.
  if (terrain === 'rough') return getRoughTexture()
  if (terrain === 'rubble') return getRubbleTexture()
  // Real murky mud-and-leaf-litter / fluffy-snow photos — replacing the
  // flat procedural patterns (drawSwamp/drawSnow, both now deleted). This
  // is swamp's own STILL floor, seen through the separate translucent
  // MudSurface TerrainDecor.tsx renders above it, the same
  // floor/surface split water/water_deep already use.
  if (terrain === 'swamp') return getSwampTexture()
  if (terrain === 'snow') return getSnowTexture()
  const key = terrain
  const variant = hashTile(q, r, terrain) % VARIANTS
  return buildBaseTexture(key, variant)
}

export function neighborCoords(q: number, r: number, gridType: 'hex' | 'square'): [number, number][] {
  const offsets: [number, number][] =
    gridType === 'hex'
      ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]
      : [[1, 0], [-1, 0], [0, 1], [0, -1]]
  return offsets.map(([dq, dr]) => [q + dq, r + dr])
}

/**
 * World-space angle (radians, atan2 convention: 0 = +x, increasing toward
 * +z) toward each *actual* neighboring road tile — one entry per real
 * connection, not a single guessed "average" orientation. `RoadMarkings`
 * draws a short dashed mark along each of these angles, so a straight
 * segment, a bend, a dead end and a crossroads all just fall out of however
 * many connections a tile happens to have, instead of needing a separate
 * texture variant per shape. Since both tiles on either side of a
 * connection compute their angle from the same real coordinates, their
 * marks always point straight at each other — no rotation guesswork that
 * can end up misaligned.
 */
export function roadConnections(
  q: number,
  r: number,
  lookup: Map<string, { terrain: string }>,
  gridType: 'hex' | 'square',
  worldPos: (q: number, r: number) => [number, number],
): number[] {
  const [tx, tz] = worldPos(q, r)
  return neighborCoords(q, r, gridType)
    .filter(([nq, nr]) => lookup.get(`${nq},${nr}`)?.terrain === 'road')
    .map(([nq, nr]) => {
      const [nx, nz] = worldPos(nq, nr)
      return Math.atan2(nz - tz, nx - tx)
    })
}
