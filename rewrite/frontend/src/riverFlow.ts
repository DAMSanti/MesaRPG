import type { HexTileData } from './api'
import { hexToWorld } from './hexMath'
import { HEX_NEIGHBORS } from './tileHeightField'

/** Which way the water is moving, per tile.
 *
 * Real user request: "definimos rio como tiles de agua que empiezan y
 * terminan en el borde del mapa, y estan conectados entre ellos por otros
 * tiles de agua. En ese caso tenemos que decidir una direccion y habra
 * corriente en esa direccion."
 *
 * So a current is not a property a water tile has on its own — it is a
 * property of the SHAPE the water makes across the whole board, and the only
 * way to know it is to look at all of it at once. A pond has no current; the
 * same tile, joined to the map edge at both ends, does. */

const WATER_TERRAINS = new Set(['water', 'water_deep'])

export interface RiverFlow {
  /** Unit flow direction in world XZ, per `q,r` key. Absent for still water
   * (anything that is not part of a river), which is the difference between
   * "drifts gently" and "actually goes somewhere". */
  direction: Map<string, [number, number]>
  /** How far along its river a tile is, 0 at the source and 1 at the mouth.
   * Lets anything downstream of this (foam, speed, debris) vary along the
   * course instead of treating a river as uniform. */
  progress: Map<string, number>
}

const key = (q: number, r: number) => `${q},${r}`

/** Splits every water tile on the board into connected bodies, works out
 * which of those are rivers, and gives each river tile a flow direction.
 *
 * A body is a river when it reaches the map edge in at least two SEPARATE
 * places. One outlet is a cove or an inlet — water that stops. Two or more
 * means the water has somewhere to come from and somewhere to go, which is
 * exactly the user's own definition and, conveniently, also the physical
 * one.
 *
 * Direction comes from a breadth-first distance field rather than from a
 * straight line between the two ends. A river bends; a straight source-to-
 * mouth vector would have the current cutting across its own banks on every
 * curve, and pointing backwards on a sharp enough one. Distance measured
 * THROUGH the water follows the channel by construction, so the gradient of
 * that distance is the direction the water actually runs at each point. */
export function computeRiverFlow(tiles: HexTileData[]): RiverFlow {
  const direction = new Map<string, [number, number]>()
  const progress = new Map<string, number>()
  const water = new Map<string, HexTileData>()
  for (const t of tiles) if (WATER_TERRAINS.has(t.terrain)) water.set(key(t.q, t.r), t)
  if (water.size === 0) return { direction, progress }

  // Every tile the map actually has, water or not — a water tile is at the
  // map's edge when one of its six neighbours is missing from here. That is
  // a more honest test than comparing against the map's width/height, which
  // says nothing about maps that are not a filled rectangle.
  const present = new Set(tiles.map((t) => key(t.q, t.r)))

  const waterNeighbors = (q: number, r: number) => HEX_NEIGHBORS
    .map(([dq, dr]) => key(q + dq, r + dr))
    .filter((k) => water.has(k))

  const isOutlet = (q: number, r: number) => HEX_NEIGHBORS
    .some(([dq, dr]) => !present.has(key(q + dq, r + dr)))

  const seen = new Set<string>()
  for (const startKey of water.keys()) {
    if (seen.has(startKey)) continue
    // --- one connected body of water
    const body: string[] = []
    const stack = [startKey]
    seen.add(startKey)
    while (stack.length) {
      const k = stack.pop()!
      body.push(k)
      const t = water.get(k)!
      for (const n of waterNeighbors(t.q, t.r)) {
        if (seen.has(n)) continue
        seen.add(n)
        stack.push(n)
      }
    }

    const outlets = body.filter((k) => {
      const t = water.get(k)!
      return isOutlet(t.q, t.r)
    })
    if (outlets.length < 2) continue // a pond, or a dead-end inlet: still water

    // --- source and mouth: the two outlets furthest apart in the world, so
    // a river that touches the edge in several places still gets the
    // direction that runs along its full length rather than one that hops
    // between two outlets that happen to sit side by side.
    let source = outlets[0]
    let mouth = outlets[1]
    let best = -1
    for (let i = 0; i < outlets.length; i++) {
      for (let j = i + 1; j < outlets.length; j++) {
        const a = water.get(outlets[i])!
        const b = water.get(outlets[j])!
        const [ax, az] = hexToWorld(a.q, a.r)
        const [bx, bz] = hexToWorld(b.q, b.r)
        const d = (ax - bx) ** 2 + (az - bz) ** 2
        if (d > best) { best = d; source = outlets[i]; mouth = outlets[j] }
      }
    }
    // Deterministic which end is upstream. Nothing in the map data says
    // which way a river flows, so it has to be decided somehow; picking by
    // coordinate order means the same map always flows the same way instead
    // of reversing depending on iteration order.
    if (source > mouth) [source, mouth] = [mouth, source]

    // --- distance through the water from the source
    const dist = new Map<string, number>([[source, 0]])
    let frontier = [source]
    while (frontier.length) {
      const next: string[] = []
      for (const k of frontier) {
        const t = water.get(k)!
        const d = dist.get(k)!
        for (const n of waterNeighbors(t.q, t.r)) {
          if (dist.has(n)) continue
          dist.set(n, d + 1)
          next.push(n)
        }
      }
      frontier = next
    }
    const span = Math.max(1, dist.get(mouth) ?? 1)

    // --- direction = downhill gradient of that distance field
    for (const k of body) {
      const t = water.get(k)!
      const d = dist.get(k)
      if (d == null) continue
      const [cx, cz] = hexToWorld(t.q, t.r)
      let fx = 0
      let fz = 0
      for (const [dq, dr] of HEX_NEIGHBORS) {
        const nk = key(t.q + dq, t.r + dr)
        const nd = dist.get(nk)
        if (nd == null) continue
        const [nx, nz] = hexToWorld(t.q + dq, t.r + dr)
        // Neighbours further from the source pull the flow toward them,
        // nearer ones push it away; summing over all six averages out the
        // hex grid's own six-way bias and leaves a smooth direction that
        // follows the channel even where it bends.
        const w = nd - d
        fx += w * (nx - cx)
        fz += w * (nz - cz)
      }
      const len = Math.hypot(fx, fz)
      if (len < 1e-6) continue
      direction.set(k, [fx / len, fz / len])
      progress.set(k, Math.min(1, d / span))
    }
  }
  return { direction, progress }
}
