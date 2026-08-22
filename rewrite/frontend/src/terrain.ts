import * as THREE from 'three'

/** Shared by MapEditorView (authoring) and HexMap (table display) so the
 * two never drift into showing terrain differently.
 *
 * Most terrain gets a procedural texture (canvas-drawn, no external
 * assets — same approach as the dice pips) that bakes in its own full
 * color; plains and forest instead use a real CC0 photo (public/textures/
 * CREDITS.md) for a genuinely realistic look those two benefit from most
 * (open ground and canopy read unmistakably as what they are). Either
 * way `terrainColor()` is white for every terrain except hills
 * (continuous elevation tint) and forest (a fixed darkening — dense
 * canopy shadow, not hills' gradient), so texture and material color
 * multiply cleanly instead of double-tinting. Procedural terrains get a
 * few variants picked deterministically per tile (a hash of its
 * coordinates, not Math.random — stays stable across re-renders) so
 * neighboring tiles of the same type don't look identical; the two
 * photo terrains get `terrainRotation()` instead (see below) since
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
const ROTATED_PHOTO_TERRAINS = new Set(['plains', 'forest', 'light_forest', 'road'])
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

/** Open hills ground keeps the elevation colour ramp as the material's
 * base color, multiplied by a light detail texture below. Forest gets a
 * fixed dark multiply instead — the moss photo (public/textures/
 * CREDITS.md) is a bright lawn-like green on its own; darkening it
 * reads as canopy shadow seen from directly above, matching the
 * moody/dense look the old procedural forest texture had. Every other
 * terrain (plains' real grass photo included) bakes its full color into
 * the texture itself, so the material color stays white there
 * (multiplying by white is a no-op) — an elevation tint would just
 * wash out a real photo unnaturally, and forest doesn't vary by
 * elevation the way hills does.
 *
 * The two photo terrains (plains/forest) additionally get a small
 * per-tile brightness jitter (±6%) folded into this same color, since
 * they only have one source photo each (see terrainRotation above) —
 * without it, every plains tile would be lit exactly alike despite
 * sharing one image; every other terrain already varies via its own
 * baked texture variant, so no jitter is added there. */
export function terrainColor(terrain: string, elevation: number, q = 0, r = 0): string {
  if (terrain === 'hills') {
    const t = Math.max(0, Math.min(1, elevation / 4))
    const from = { r: 0x1f, g: 0x3a, b: 0x2f }
    const to = { r: 0x9a, g: 0x8f, b: 0x74 }
    const lerp = (a: number, b: number) => Math.round(a + (b - a) * t)
    return `rgb(${lerp(from.r, to.r)}, ${lerp(from.g, to.g)}, ${lerp(from.b, to.b)})`
  }
  if (terrain === 'plains' || terrain === 'forest' || terrain === 'light_forest') {
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

function speckles(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: () => number,
  opts: { count: number; radius: [number, number]; color: string; alpha: [number, number] },
) {
  for (let i = 0; i < opts.count; i++) {
    const x = rng() * size
    const y = rng() * size
    const rad = opts.radius[0] + rng() * (opts.radius[1] - opts.radius[0])
    ctx.globalAlpha = opts.alpha[0] + rng() * (opts.alpha[1] - opts.alpha[0])
    ctx.fillStyle = opts.color
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ---- per-terrain procedural drawers ---------------------------------------
// Light near-white base = detail multiplier over the elevation-tinted
// material color (hills only now — plains uses a real photo, see
// getGrassTexture above). Everything else bakes its own full color.

function drawHills(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#dfe1d6'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 30; i++) {
    const x = rng() * size
    const y = rng() * size
    const rad = size * (0.02 + rng() * 0.06)
    ctx.fillStyle = rng() < 0.5 ? 'rgba(120,110,90,0.16)' : 'rgba(255,255,255,0.26)'
    ctx.beginPath()
    ctx.ellipse(x, y, rad, rad * 0.6, rng() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  speckles(ctx, size, rng, { count: 160, radius: [2, 5], color: 'rgba(70,65,55,0.2)', alpha: [0.3, 0.7] })
}

function drawWater(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  const grad = ctx.createLinearGradient(0, 0, 0, size)
  grad.addColorStop(0, '#1a4152')
  grad.addColorStop(1, '#215a70')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(190,225,235,0.32)'
  for (let y = 12; y < size; y += 26 + rng() * 10) {
    ctx.lineWidth = 2 + rng() * 1.5
    ctx.beginPath()
    for (let x = 0; x <= size; x += 12) {
      const wave = Math.sin((x / size) * Math.PI * (3 + rng() * 2) + y) * (size * (0.008 + rng() * 0.006))
      if (x === 0) ctx.moveTo(x, y + wave)
      else ctx.lineTo(x, y + wave)
    }
    ctx.stroke()
  }
  speckles(ctx, size, rng, { count: 50, radius: [2, 5], color: 'rgba(255,255,255,0.25)', alpha: [0.2, 0.4] })
}

function drawSwamp(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#3a3f2c'
  ctx.fillRect(0, 0, size, size)
  // murky mud patches
  for (let i = 0; i < 22; i++) {
    const x = rng() * size
    const y = rng() * size
    const rad = size * (0.03 + rng() * 0.07)
    ctx.fillStyle = `rgba(${30 + rng() * 20 | 0},${28 + rng() * 18 | 0},${18 + rng() * 12 | 0},0.5)`
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  // reeds/reflections near waterlogged ground
  for (let i = 0; i < 60; i++) {
    const x = rng() * size
    const y = rng() * size
    const len = size * (0.01 + rng() * 0.02)
    ctx.strokeStyle = rng() < 0.5 ? 'rgba(120,140,90,0.3)' : 'rgba(60,90,80,0.25)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y - len)
    ctx.stroke()
  }
  speckles(ctx, size, rng, { count: 90, radius: [1.5, 4], color: 'rgba(15,20,14,0.3)', alpha: [0.3, 0.5] })
}

function drawSnow(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#eef3f6')
  grad.addColorStop(1, '#d7e2e8')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  // wind-carved drift shadows
  for (let i = 0; i < 16; i++) {
    const x = rng() * size
    const y = rng() * size
    const w = size * (0.08 + rng() * 0.14)
    const h = size * (0.02 + rng() * 0.03)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rng() * Math.PI)
    ctx.fillStyle = 'rgba(150,170,185,0.22)'
    ctx.beginPath()
    ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  speckles(ctx, size, rng, { count: 130, radius: [1, 2.5], color: 'rgba(200,215,225,0.5)', alpha: [0.3, 0.6] })
}

function drawRough(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#5c5648'
  ctx.fillRect(0, 0, size, size)
  speckles(ctx, size, rng, { count: 100, radius: [6, 16], color: 'rgba(90,84,68,0.3)', alpha: [0.3, 0.6] })
  ctx.strokeStyle = 'rgba(30,26,20,0.35)'
  ctx.lineWidth = 2.5
  for (let i = 0; i < 16; i++) {
    let x = rng() * size
    let y = rng() * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let j = 0; j < 5; j++) {
      x += (rng() - 0.5) * size * 0.12
      y += (rng() - 0.5) * size * 0.12
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

function drawRubble(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#5c4a42'
  ctx.fillRect(0, 0, size, size)
  for (let i = 0; i < 80; i++) {
    const x = rng() * size
    const y = rng() * size
    const w = size * (0.015 + rng() * 0.045)
    const h = size * (0.015 + rng() * 0.045)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rng() * Math.PI)
    ctx.fillStyle = `rgba(${70 + rng() * 40 | 0},${55 + rng() * 35 | 0},${45 + rng() * 30 | 0},${0.5 + rng() * 0.4})`
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }
  speckles(ctx, size, rng, { count: 140, radius: [1, 3], color: 'rgba(20,15,12,0.3)', alpha: [0.3, 0.5] })
}

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

/** Rooftop, since the camera in this app is locked top-down (see TableView
 * / MapEditorView's OrbitControls) — walls are never actually seen, so
 * "windows" are represented as roof-level skylights/glazing rather than
 * side windows nobody would ever see. `style` picks a cosmetic base tint
 * so standing buildings don't all read as one uniform grey block. */
function drawBuildingStanding(ctx: CanvasRenderingContext2D, size: number, rng: () => number, style: number) {
  ctx.fillStyle = style === 2 ? '#565b5e' : style === 1 ? '#4e5457' : '#4a4f52'
  ctx.fillRect(0, 0, size, size)
  // parapet — a darker inset border reading as the raised edge wall of a
  // flat roof, the clearest "this is a rooftop" cue from directly above
  const parapet = size * 0.045
  ctx.strokeStyle = 'rgba(15,17,19,0.55)'
  ctx.lineWidth = parapet
  ctx.strokeRect(parapet / 2, parapet / 2, size - parapet, size - parapet)
  // rooftop terrace — a lighter walkway strip along one edge
  if (rng() < 0.7) {
    const along = rng() < 0.5
    const t = size * (0.14 + rng() * 0.08)
    ctx.fillStyle = 'rgba(150,145,130,0.28)'
    if (along) ctx.fillRect(parapet, parapet, size - parapet * 2, t)
    else ctx.fillRect(parapet, parapet, t, size - parapet * 2)
  }
  const cell = size / (4 + Math.floor(rng() * 3))
  ctx.strokeStyle = 'rgba(20,22,24,0.4)'
  ctx.lineWidth = 2
  for (let x = 0; x <= size; x += cell) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size)
    ctx.stroke()
  }
  for (let y = 0; y <= size; y += cell) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size, y)
    ctx.stroke()
  }
  // skylights/glazed roof sections — the "windows" visible from directly above
  const skylights = 7 + Math.floor(rng() * 6)
  for (let i = 0; i < skylights; i++) {
    const x = rng() * size
    const y = rng() * size
    const w = cell * (0.4 + rng() * 0.3)
    const h = cell * (0.3 + rng() * 0.25)
    ctx.fillStyle = `rgba(${90 + rng() * 40 | 0},${140 + rng() * 50 | 0},${170 + rng() * 50 | 0},0.5)`
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(20,24,26,0.5)'
    ctx.lineWidth = 1
    ctx.strokeRect(x, y, w, h)
  }
  // rooftop AC/vent units
  for (let i = 0; i < 4 + Math.floor(rng() * 4); i++) {
    const x = rng() * size
    const y = rng() * size
    const s = size * (0.03 + rng() * 0.04)
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.fillRect(x, y, s, s)
  }
  speckles(ctx, size, rng, { count: 90, radius: [1, 2.5], color: 'rgba(0,0,0,0.15)', alpha: [0.2, 0.4] })
}

/** Collapsed/damaged roof — cracked panel remnants, scorch marks, rubble
 * chunks. Paired with a broken 3D silhouette in TerrainDecor (not a clean
 * box), so a "ruined" building reads as ruined from both texture and shape. */
function drawBuildingRuined(ctx: CanvasRenderingContext2D, size: number, rng: () => number) {
  ctx.fillStyle = '#4b433d'
  ctx.fillRect(0, 0, size, size)
  const cell = size / (4 + Math.floor(rng() * 3))
  ctx.strokeStyle = 'rgba(15,12,10,0.35)'
  ctx.lineWidth = 2
  for (let x = 0; x <= size; x += cell) {
    if (rng() < 0.55) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, size)
      ctx.stroke()
    }
  }
  for (let y = 0; y <= size; y += cell) {
    if (rng() < 0.55) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(size, y)
      ctx.stroke()
    }
  }
  for (let i = 0; i < 10; i++) {
    const x = rng() * size
    const y = rng() * size
    const rad = size * (0.05 + rng() * 0.1)
    ctx.fillStyle = `rgba(${20 + rng() * 15 | 0},${16 + rng() * 12 | 0},${14 + rng() * 10 | 0},${0.35 + rng() * 0.3})`
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = 0; i < 45; i++) {
    const x = rng() * size
    const y = rng() * size
    const w = size * (0.02 + rng() * 0.05)
    const h = size * (0.02 + rng() * 0.05)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rng() * Math.PI)
    ctx.fillStyle = `rgba(${75 + rng() * 35 | 0},${65 + rng() * 30 | 0},${55 + rng() * 25 | 0},0.6)`
    ctx.fillRect(-w / 2, -h / 2, w, h)
    ctx.restore()
  }
}

const DRAW: Record<string, (ctx: CanvasRenderingContext2D, size: number, rng: () => number) => void> = {
  hills: drawHills,
  water: drawWater,
  rough: drawRough,
  rubble: drawRubble,
  hazards: drawHazards,
  swamp: drawSwamp,
  snow: drawSnow,
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

// Building gets 5 looks instead of the usual 3 — 3 standing styles + 2
// ruined — since "some standing, some ruined" is the whole point here.
const BUILDING_VARIANTS = 5
const buildingCache = new Map<number, THREE.CanvasTexture>()

/** Which of the 5 building looks a tile gets — exported so TerrainDecor's
 * 3D shape (clean tower vs collapsed rubble) picks the SAME one the
 * texture did, instead of the two disagreeing about whether this building
 * is standing or ruined. */
export function buildingKind(q: number, r: number): number {
  return hashTile(q, r, 'building-kind') % BUILDING_VARIANTS
}

function buildBuildingTexture(kind: number): THREE.CanvasTexture {
  const cached = buildingCache.get(kind)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')!
  const rng = mulberry32(hashString('building') * 97 + kind * 131 + 7)
  if (kind < 3) drawBuildingStanding(ctx, SIZE, rng, kind)
  else drawBuildingRuined(ctx, SIZE, rng)
  const tex = finish(canvas)
  buildingCache.set(kind, tex)
  return tex
}

/** Deterministic per-tile variant (stable across renders) of a terrain's
 * texture — same terrain, different tiles look slightly different. */
export function terrainTexture(terrain: string, q: number, r: number): THREE.Texture {
  if (terrain === 'plains') return plainsGroundVariant(q, r) === 'dirt' ? getDirtTexture() : getGrassTexture()
  if (terrain === 'forest' || terrain === 'light_forest') return getForestFloorTexture()
  if (terrain === 'road') return getRoadTexture()
  if (terrain === 'building') return buildBuildingTexture(buildingKind(q, r))
  // water_deep reuses the same procedural drawWater pattern (DRAW lookup
  // below) as water — the darker terrainColor() multiply above is what
  // actually distinguishes it, not a separate texture.
  const key = terrain === 'water_deep' ? 'water' : terrain
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
