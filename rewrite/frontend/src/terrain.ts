import * as THREE from 'three'
import { hexToWorld, HEX_SIZE } from './hexMath'
import { worldNoise01 } from './terrainRelief'

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
 * re-renders) so neighboring tiles of the same type don't look identical.
 * The photo terrains need no such trick: hexTileGeometry.ts maps every
 * tile's texture by TRUE WORLD POSITION (`worldTextureUV`), so one photo
 * covers the whole board as a continuous carpet — each tile shows a
 * different part of it, and same-terrain neighbors join seamlessly. */

const SIZE = 512
const VARIANTS = 3

// Real CC0 photos instead of the procedural canvas pattern every other
// terrain still uses. Each loaded once and shared (RepeatWrapping tiles
// it across every tile's own UV space); repeat is tuned by eye so
// detail stays crisp up close without the seams repeating often enough
// to be obvious at table-wide zoom. Only one photo per terrain (unlike
// the procedural VARIANTS below) — world-space UVs (see this file's own
// header) give each tile a different part of the same tiling photo
// instead, so a whole field of plains doesn't look like one image pasted
// in a grid.
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
  // Real user report: dark speckled/glitchy blotches across whole tile
  // faces, worse zoomed out — three.js defaults `anisotropy` to 1 (off)
  // on every texture, and NOTHING in this file ever raised it. A
  // repeat-tiled photo texture (every one of these is — GRASS_REPEAT,
  // FOREST_FLOOR_REPEAT, etc.) viewed from a distance/steep-ish angle
  // with no anisotropic filtering is a textbook cause of moiré/aliasing
  // that reads as exactly this kind of speckled noise, worsening as
  // zoom-out increases minification with nothing compensating for it.
  // 16 is the conventional safe max (three.js clamps to whatever the
  // GPU actually supports either way).
  tex.anisotropy = 16
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

/** Real user request: "ahora mismo tenemos dos texturas asignadas a
 * llanuras y 1 textura a colinas, quiero poner las 3 texturas tanto para
 * colinas como llanuras... deberan ser parches coherentes" — plains and
 * hills are the same ground, only at different heights, so they now draw
 * from one shared pool of three photos instead of hills being locked to
 * a single one.
 *
 * `grassDark` is grass.jpg (deep, dense turf), `grassLight` is
 * hill-grass.jpg (paler, coarser) and `earth` is dirt.jpg (bare pebbly
 * soil).
 *
 * "Coherente" is the whole point of how they are picked. A per-tile hash
 * (what plains used to use for its 1-in-5 dirt) makes an even, uncorrelated
 * sprinkle — every tile an independent coin flip, which reads as noise, not
 * as terrain. These sample the SAME kind of continuous world-space noise
 * field the ground relief already uses, at a wavelength of a few hexes, so
 * neighbouring tiles tend to agree and the variants come out as real
 * patches that sprawl across several tiles: a meadow running over a ridge,
 * a worn earth scar, and lawn between them. The two fields are independent
 * (different offsets), so an earth patch can sit inside either grass type
 * rather than only ever appearing at their boundary.
 *
 * Also what stops the texture blending from having to work everywhere at
 * once: patches mean most borders now have MATCHING ground on both sides
 * and no transition to draw at all, and the ones that remain are the real
 * edges of a patch. */
// Named for how they read on the board, which is how the user refers to
// them ("las verdes claras... las verdes oscuras... las de tierra") and the
// only naming that cannot be misread: grass.jpg measures notably DARKER than
// hill-grass.jpg (mean brightness 67 vs 84), the opposite of what the file
// names suggest, and getting that backwards puts every density in this
// project's vegetation on the wrong ground.
export type GroundVariant = 'grassDark' | 'grassLight' | 'earth'

// Wavelengths in world units. PATCH is the lawn/meadow split — a few hexes
// across, so a patch covers a small group of tiles rather than one. EARTH is
// tighter: bare soil reads as a scar or a worn spot, something smaller than
// the grassland it interrupts.
const GROUND_PATCH_WAVELENGTH = HEX_SIZE * 3.4
const GROUND_EARTH_WAVELENGTH = HEX_SIZE * 2.2
// Thresholds on the two [0,1] fields. MEADOW_AT below 0.5 keeps lawn the
// more common of the two grasses; EARTH_AT high keeps bare soil a minority,
// close to the old 1-in-5 rate but clustered instead of scattered.
const GROUND_MEADOW_AT = 0.46
const GROUND_EARTH_AT = 0.62

export function groundVariant(q: number, r: number): GroundVariant {
  // Sampled at the tile's own world CENTRE, not per-pixel: a tile draws one
  // texture, so the field only has to answer once per tile. Neighbouring
  // centres are close together relative to the wavelengths above, which is
  // exactly why they tend to land on the same answer.
  const [wx, wz] = hexToWorld(q, r)
  if (worldNoise01(wx / GROUND_EARTH_WAVELENGTH + 61.7, wz / GROUND_EARTH_WAVELENGTH - 23.9, 2) > GROUND_EARTH_AT) {
    return 'earth'
  }
  return worldNoise01(wx / GROUND_PATCH_WAVELENGTH, wz / GROUND_PATCH_WAVELENGTH, 2) > GROUND_MEADOW_AT
    ? 'grassLight'
    : 'grassDark'
}

/** Kept as its own name because decoration logic asks a different question
 * than the texture does — "is this tile bare soil?", for thinner grass
 * cover — and should never re-derive it from a second, independent hash
 * that could disagree with what is actually drawn. */
export function plainsGroundVariant(q: number, r: number): 'grass' | 'dirt' {
  return groundVariant(q, r) === 'earth' ? 'dirt' : 'grass'
}

/* A per-tile Y rotation used to live here (`terrainRotation`), snapped to
 * 60 degree steps, as a cheap way to keep a whole field of one photo
 * terrain from reading as the same image pasted in a grid. It was
 * already dead — the ground mesh stopped being rotated once its own
 * vertices started encoding WHICH real edge ramps toward WHICH neighbor
 * (see HexMap.tsx's Tile) — and hexTileGeometry.ts's `worldTextureUV`
 * has now made the whole idea obsolete anyway: mapping every tile's
 * texture by true world position means no two tiles show the same crop
 * in the first place, AND same-terrain neighbors line up seamlessly,
 * which no amount of per-tile rotation could ever achieve. */

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
 * A small per-tile brightness jitter (±6%) used to be folded in here too,
 * back when every tile of a terrain rendered the byte-identical crop of
 * one photo and needed SOMETHING to tell them apart. Once
 * hexTileGeometry.ts's `worldTextureUV` made the texture continuous
 * across the board, that jitter inverted its own purpose: the crops
 * differ on their own now, and a per-tile multiplier is the one thing
 * left that still paints a visible hex-shaped brightness step across
 * ground that is otherwise seamless — the exact "se aprecia el cambio de
 * forma brusca" artifact this pass exists to remove. Real lighting and
 * the photo's own variation carry the variety instead. */
export function terrainColor(terrain: string): string {
  if (terrain === 'plains' || terrain === 'forest' || terrain === 'light_forest' || terrain === 'hills') {
    // light_forest gets a lighter multiply than forest's dense-canopy
    // shadow — thinner canopy, more daylight reaching the ground — while
    // still reading as the same photo terrain, not a distinct texture.
    // Dense forest takes the SAME tint as light forest, not a darker one.
    // Real user request: "quiero que las tiles de bosque denso tengan la
    // misma textura que bosque normal, con todos los cambios han quedado muy
    // oscuras." It was being darkened three times over — this canopy
    // multiply, then the grass shading at full coverage (a dense forest floor
    // is 100% carpeted), then the tree canopies themselves on top. Each of
    // those was reasonable alone; stacked, the tile went nearly black. What
    // now distinguishes a dense forest is what should distinguish it: how
    // many trees are standing on it.
    const base =
      terrain === 'forest' || terrain === 'light_forest' ? { r: 0x7a, g: 0x8c, b: 0x70 } :
      { r: 0xff, g: 0xff, b: 0xff }
    return `rgb(${base.r}, ${base.g}, ${base.b})`
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
  // Same anisotropy fix as loadPhotoTexture above, same reason.
  tex.anisotropy = 16
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
  // plains and hills share one pool of three ground photos — see
  // groundVariant above for why they are picked from a world-space field
  // rather than a per-tile hash.
  if (terrain === 'plains' || terrain === 'hills') {
    const v = groundVariant(q, r)
    return v === 'earth' ? getDirtTexture() : v === 'grassLight' ? getHillGrassTexture() : getGrassTexture()
  }
  if (terrain === 'forest' || terrain === 'light_forest') return getForestFloorTexture()
  if (terrain === 'road') return getRoadTexture()
  // The tile's own ground, not the building on top of it — a real
  // sidewalk photo, per explicit request ("quiero que la base tenga la
  // textura como de una acera"). The building itself is a real .glb
  // model with its own materials (TerrainDecor.tsx's RealBuilding).
  if (terrain === 'building') return getSidewalkTexture()
  // Real riverbed photo — this is the tile's own floor, seen through the
  // separate refracting WaterSurface TerrainDecor.tsx renders above it.
  // water_deep reuses the same photo; how much light its own greater depth
  // absorbs is what distinguishes it, not a separate texture.
  //
  // This was briefly swapped for the grey broken-stone photo on a report of
  // the riverbed looking like sand. That was a misdiagnosis on both sides:
  // the sandy thing showing through the water was the WOODEN TABLE, which
  // sits above the sunken bed and was hiding it entirely. The bed was never
  // the problem and the swap is reverted; see TableBackground.tsx.
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
