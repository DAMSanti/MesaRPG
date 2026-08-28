export interface HexCoord {
  q: number
  r: number
}

// Real user request: "vamos a seguir una escala real de juego... cada
// lado del hex son 30m" (real BattleTech canon: a mapsheet hex is ~30
// meters across — confirmed via Sarna/community sources, not assumed).
// 1 world/Three.js unit = 1 real meter everywhere in this app now (see
// Mech3D.tsx's own MODEL_SCALE for the OTHER half of this — mech height
// uses a separate factor, since it was never tuned relative to the hex
// grid in the first place, only to itself/nearby props — this file only
// owns the hex-grid-relative half of the rescale).
export const HEX_SIZE = 30

// Axial (pointy-top) → world x/z. The one authoritative copy — HexMap.tsx
// imports this instead of keeping its own (used to be duplicated there,
// in MapEditorView.tsx, and mirrored in Python in app/units.py's
// _world_delta; this file is now the frontend's single copy other frontend
// code should import rather than re-deriving). _world_delta's own angle-
// only use (atan2 of the delta, for facing/LOS-arc math) is scale-
// invariant, so HEX_SIZE only ever needed to exist on THIS side — the
// backend's own implicit radius-1 stayed correct with zero changes there.
const SQRT3 = Math.sqrt(3)
export function hexToWorld(q: number, r: number): [number, number] {
  return [HEX_SIZE * SQRT3 * (q + r / 2), HEX_SIZE * 1.5 * r]
}

// World units per second a unit visually walks between hexes at — hex
// center-to-center spacing is √3 * HEX_SIZE (hexToWorld above, and true
// for EVERY neighbor direction on a regular hex grid, not just an
// approximation), so this scales with HEX_SIZE too (was tuned as "hex
// every ~1.5s" against the old radius-1 grid; ×HEX_SIZE preserves that
// same real-world pace now that a hex is 30m across, not 1 world unit).
// Real user report: "el movimiento de los mechs ahora mismo es MUUUUY
// rapido" — cut to well under half its old value (was 3.5, ~one hex
// every 0.5s) so a multi-hex path actually reads as a mech stepping
// across the board instead of a blur.
//
// Moved here (was HexMap.tsx-local) so Mech3D.tsx can read it too
// without a circular import (HexMap.tsx itself imports Mech3D) — see
// WALK_CYCLE_TIME_SCALE below, its own reason for needing it.
export const WALK_SPEED = 1.4 * HEX_SIZE

// Real user report (with screenshot/description): a multi-hex walk only
// ever left ONE footprint pair, always right near the DESTINATION hex,
// nothing along the path in between — sometimes not even that
// ("y no lo hace siempre"). Root cause: the Walk animation clip plays at
// its own fixed authored pace (2 real seconds per full stride cycle,
// timeScale=1) completely decoupled from how fast/far the mech is
// ACTUALLY sliding across the board (WALK_SPEED, world units/second) —
// crossing several hexes in less real time than even one full stride
// cycle takes means the legs only ever get through a PARTIAL cycle (at
// most one real touchdown per foot) for the ENTIRE multi-hex move,
// landing wherever the animation happens to catch up, which is close to
// wherever the group has arrived by then (near the end of a fast move).
// Real per-foot bone data measured directly from the Jenner's own GLB
// (offline analysis, not a guess) confirmed one clean touchdown per foot
// per full 2s Walk-clip cycle — so speeding up the CLIP's own playback
// (not the movement itself, which is a deliberate gameplay-pacing
// choice, not a bug) to match how long it actually takes to cross one
// hex at WALK_SPEED is what makes roughly one stride happen per hex,
// like a real gait, instead of the animation lagging arbitrarily behind
// actual travel distance. `oneHexSeconds` = real time to cross one hex
// at WALK_SPEED; `timeScale` = how much faster than authored the clip
// needs to play so ITS OWN 2s duration matches that real duration.
const ONE_HEX_DISTANCE = HEX_SIZE * SQRT3
const ONE_HEX_SECONDS = ONE_HEX_DISTANCE / WALK_SPEED
const WALK_CLIP_AUTHORED_SECONDS = 2
export const WALK_CYCLE_TIME_SCALE = WALK_CLIP_AUTHORED_SECONDS / ONE_HEX_SECONDS

// Inverse of hexToWorld: nearest hex to a raw world (x, z) point — needed
// once a position comes from something continuous (a raycast hit) rather
// than an existing tile/unit's own q/r. Standard cube-round algorithm:
// convert to fractional cube coords, round each, then fix up whichever
// component's rounding error was largest so x+y+z stays 0.
export function worldToHex(x: number, z: number): HexCoord {
  const rFrac = z / (1.5 * HEX_SIZE)
  const qFrac = x / (SQRT3 * HEX_SIZE) - rFrac / 2
  const xFrac = qFrac, zFrac = rFrac, yFrac = -xFrac - zFrac
  let rx = Math.round(xFrac), ry = Math.round(yFrac), rz = Math.round(zFrac)
  const dx = Math.abs(rx - xFrac), dy = Math.abs(ry - yFrac), dz = Math.abs(rz - zFrac)
  if (dx > dy && dx > dz) rx = -ry - rz
  else if (dy > dz) ry = -rx - rz
  else rz = -rx - ry
  return { q: rx, r: rz }
}

/** Newer maps are laid out as a width x height rectangle starting near
 * (0,0), not centered on the origin like the old radius-based maps were
 * (ROADMAP.md S1 tercera pasada) — the table camera is fixed looking
 * straight down at world (0,0,0), so without centering, the map renders
 * tucked in a corner instead of framed. HexMap.tsx offsets its whole
 * scene by `[-x, 0, -z]` of this bounding-box midpoint (not an average of
 * tile centers, so it matches the visual rectangle regardless of the
 * odd-r row shear `_hex_rect` uses on the backend) so the map is centered
 * under that camera; anything computing a hex from a raw world-space
 * raycast hit (e.g. dragging a mech from the sidebar onto the map) needs
 * to add this back before calling worldToHex. */
export function mapCenter(tiles: HexCoord[]): [number, number] {
  if (tiles.length === 0) return [0, 0]
  const xs = tiles.map((t) => hexToWorld(t.q, t.r)[0])
  const zs = tiles.map((t) => hexToWorld(t.q, t.r)[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]
}

// FIXED, not a floor that yields to a taller natural elevation — two
// earlier versions of this (elevation 2's own 0.74, then elevation
// 0.5's 0.41) both still let the tile's own `elevation` data drive the
// platform's height, and mapgen.py/MapEditorView's 'Edificio' palette
// entry both default that to 2 — so in the common case the "floor" was
// never actually the limiting factor, the elevation value was, and the
// platform kept reading as a tall pedestal every real building model
// sat on top of instead of a sidewalk (real user report, twice, with
// screenshots — most recently blunt enough that a third guess wasn't
// worth risking). A real sidewalk doesn't get taller because a
// building's LOS-blocking elevation happens to be high — that height
// already reads from the real, now-dramatically-tall building model
// standing on it, not from the ground it stands on. Flush with plain
// ground level (elevation 0's own 0.3) settles it for good, unconditionally.
// Real user request: "vamos a seguir una escala real de juego... cada
// cambio de elevacion son 6 metros" (real BattleTech canon: each
// elevation level ≈ 2 floors, about 6m — this used to be an untuned 0.22
// per level, chosen purely by eye). GROUND_BASE_HEIGHT (was a bare 0.3
// literal above, same rendering-artifact role — how thick the
// elevation-0 ground slab reads, not a real "meters of soil" concept)
// picked as a small, deliberate plinth thickness rather than scaled by
// the same factor as everything else — the old 0.3 was never a
// meaningful distance to preserve the proportions of, unlike an
// elevation STEP or a mech's own height. Lives here (not HexMap.tsx,
// which re-exports it) so TerrainDecor.tsx's own GROUND_FLUSH_TOP can
// import the exact same value without a HexMap<->TerrainDecor import
// cycle (HexMap.tsx already imports TerrainDecor.tsx).
/** The dark slab every tile is inset into — HexMap.tsx's own `groove`
 * mesh — described by where its TOP face sits, which is the only part of
 * it anything else can ever see. TERRAIN_FLOOR_Y is the lowest a tile's
 * surface may ever end up, and the pair exists to make it structurally
 * impossible for the slab to show through the ground.
 *
 * Real user report (with screenshots): black blobs scattered over the map,
 * "siempre en las mismas zonas, parecen como depresiones... puede ser que
 * bajen por debajo de la altura de las tiles." They did, by up to ~2.6
 * units, and what was showing was this slab's own flat top face. The root
 * cause is fixed in hexTileGeometry's `heightAt` (the within-hex noise
 * escaped its elevation band on any tile that happened to be ramping toward
 * a different-height neighbour); the floor here is the belt-and-braces half,
 * and it also stops a stamped impact crater from doing the same thing.
 *
 * The slab CANNOT simply be dropped further out of the way to buy margin:
 * TableBackground.tsx's wooden table sits at y = -0.05, so anything below
 * that stops being the dark groove between tiles and starts being a view
 * straight through to the table — tried, and the whole grid turned pale
 * wood-coloured. The 0.025 of clearance between them is therefore all there
 * is, and has always been enough in practice; if depth-buffer flicker ever
 * shows up along the grid at a very far zoom, the fix is to move the table
 * and this slab down TOGETHER, not this one alone. */
export const GROOVE_TOP_Y = -0.025
export const GROOVE_THICKNESS = 0.15
export const TERRAIN_FLOOR_Y = 0

export const GROUND_BASE_HEIGHT = 1
export const ELEVATION_STEP = 6
export const BUILDING_MIN_HEIGHT = GROUND_BASE_HEIGHT

/** The one shared formula every caller used to duplicate inline
 * (`0.3 + elevation * 0.22`, `'building'` overridden to the flat
 * BUILDING_MIN_HEIGHT) — factored out here so ELEVATION_STEP/
 * GROUND_BASE_HEIGHT only ever need to change in one place. */
export function elevationToY(terrain: string, elevation: number): number {
  return terrain === 'building' ? BUILDING_MIN_HEIGHT : GROUND_BASE_HEIGHT + elevation * ELEVATION_STEP
}

/** Real user request: "las hexes de altura 0 podran tener elevacion de 0
 * a 5m, las de altura 1 de 5 a 11, las de altura 2 de 11 a 17..." — each
 * BattleTech elevation LEVEL is really a real-world height BAND, not one
 * exact number; `elevationToY` above stays the single flat reference
 * point gameplay/most rendering still uses (LOS, movement, the base a
 * mech rests on), but the deformable terrain's own within-hex orography
 * (hexTileGeometry.ts) is allowed to vary anywhere inside its tile's own
 * band — bounded so it can never drift into a DIFFERENT level's own
 * range (that would silently break the LOS/elevation rules the discrete
 * `elevation` number itself still governs). Level 0's own band is 5m
 * (0-5) instead of a full ELEVATION_STEP (6m) — a deliberate asymmetry
 * from the user's own stated numbers, not a rounding slip. */
export function elevationBandRange(elevation: number): [number, number] {
  if (elevation <= 0) return [0, 5]
  return [5 + ELEVATION_STEP * (elevation - 1), 5 + ELEVATION_STEP * elevation]
}

