export interface HexCoord {
  q: number
  r: number
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

