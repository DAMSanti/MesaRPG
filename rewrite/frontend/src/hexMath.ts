import type { WeaponStats } from './api'

export interface HexCoord {
  q: number
  r: number
}

// Mirrors app/hexgrid.py's distance() exactly — axial → cube coordinates,
// Chebyshev distance in cube space. Keep in sync if that changes.
export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ax = a.q, az = a.r, ay = -ax - az
  const bx = b.q, bz = b.r, by = -bx - bz
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz))
}

export type RangeBracket = 'short' | 'medium' | 'long'

// Buckets a hex distance into the weapon's own short/medium/long
// thresholds (each is the bracket's upper bound, same convention
// app/weapons.py's WEAPON_CATALOG already uses) — null if out of range
// entirely. No minimum-range penalty modeling, matching combat.py's
// resolve_attack, which doesn't check it either.
export function rangeBracket(distance: number, weapon: WeaponStats): RangeBracket | null {
  if (distance <= weapon.short) return 'short'
  if (distance <= weapon.medium) return 'medium'
  if (distance <= weapon.long) return 'long'
  return null
}

// Axial (pointy-top) → world x/z. The one authoritative copy — HexMap.tsx
// imports this instead of keeping its own (used to be duplicated there,
// in MapEditorView.tsx, and mirrored in Python in app/units.py's
// _world_delta; this file is now the frontend's single copy other frontend
// code should import rather than re-deriving).
const SQRT3 = Math.sqrt(3)
export function hexToWorld(q: number, r: number): [number, number] {
  return [SQRT3 * (q + r / 2), 1.5 * r]
}

// Inverse of hexToWorld: nearest hex to a raw world (x, z) point — needed
// once a position comes from something continuous (a raycast hit) rather
// than an existing tile/unit's own q/r. Standard cube-round algorithm:
// convert to fractional cube coords, round each, then fix up whichever
// component's rounding error was largest so x+y+z stays 0.
export function worldToHex(x: number, z: number): HexCoord {
  const rFrac = z / 1.5
  const qFrac = x / SQRT3 - rFrac / 2
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

export type AttackSide = 'front' | 'left' | 'right' | 'rear'

// Mirrors hexToWorld above so the attack-direction angle means the same
// thing the facing convention already uses elsewhere (units.py's
// _world_delta/_within_facing_arc: 0° = world +X, counter-clockwise).
function worldDelta(from: HexCoord, to: HexCoord): [number, number] {
  const [fx, fz] = hexToWorld(from.q, from.r)
  const [tx, tz] = hexToWorld(to.q, to.r)
  return [tx - fx, tz - fz]
}

// New v1 heuristic — there's no backend equivalent to mirror (only a
// 180° front/rear LoS arc exists server-side, not a 4-way hit-location
// side). Four 90° quadrants centered on the target's own facing_deg:
// front/right/rear/left, in that clockwise order. Treated as a suggested
// default in AttackPanel, not gospel — the GM can override it.
export function attackSide(attacker: HexCoord, target: HexCoord & { facing_deg: number }): AttackSide {
  const [dx, dz] = worldDelta(target, attacker)
  if (dx === 0 && dz === 0) return 'front'
  const angleDeg = (Math.atan2(dz, dx) * 180) / Math.PI
  const relative = ((angleDeg - target.facing_deg + 180) % 360 + 360) % 360 - 180
  const abs = Math.abs(relative)
  if (abs <= 45) return 'front'
  if (abs >= 135) return 'rear'
  return relative > 0 ? 'left' : 'right'
}
