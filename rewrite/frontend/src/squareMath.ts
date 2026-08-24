export interface SquareCoord {
  q: number
  r: number
}

// Trivial compared to hexMath.ts's axial math — a square grid's own
// (q, r) IS its world position, one world unit per tile, no shear/
// offset conversion needed anywhere.
export function squareToWorld(q: number, r: number): [number, number] {
  return [q, r]
}

export function worldToSquare(x: number, z: number): SquareCoord {
  return { q: Math.round(x), r: Math.round(z) }
}

/** Same bounding-box-midpoint centering hexMath.ts's mapCenter does —
 * SquareMap.tsx offsets its scene by this so a width x height map frames
 * under the fixed cenital camera instead of sitting in a corner. */
export function mapCenter(tiles: SquareCoord[]): [number, number] {
  if (tiles.length === 0) return [0, 0]
  const xs = tiles.map((t) => squareToWorld(t.q, t.r)[0])
  const zs = tiles.map((t) => squareToWorld(t.q, t.r)[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]
}
