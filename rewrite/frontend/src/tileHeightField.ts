import type { HexTileData } from './api'
import { elevationBandRange, elevationToY, HEX_SIZE, hexToWorld } from './hexMath'
import { RELIEF_SKIP_TERRAINS } from './terrainRelief'
import { GROUND_FLUSH_TOP, terrainSinkY } from './components/TerrainDecor'
import { makeHexHeightAt } from './hexTileGeometry'

/** How much of a flush terrain's own depth its bed is allowed to vary over.
 *
 * This band used to run from the bed all the way up to just under the water
 * line, so the same within-hex relief noise that gives dry ground its bumps
 * was free to lift the riverbed to within centimetres of the surface across
 * half a tile, and to bottom out against the clamp across the other half.
 * Seen through the water that is not a bed at all — it is hard-edged blobs
 * of nearly-dry shallows against sudden deeps, which is exactly what a real
 * user reported: "se ve una forma diferente en el fondo de mi agua y no una
 * textura continua... tiene que ver algo con la profundidad seguro."
 *
 * Confining the variation to the bottom quarter of the depth keeps a real
 * uneven floor, at a scale you read as a floor rather than as shapes, and
 * makes the old "can never break the surface" guarantee hold by a wide
 * margin instead of by 5cm. */
const FLUSH_BED_RELIEF = 0.25

/** Axial neighbor offsets, in the order every piece of hex geometry in this
 * project indexes its edges by — offset k shares the edge between corners
 * (k+1)%6 and (k+2)%6. HexMap.tsx's own fog code and hexTileGeometry.ts both
 * document the derivation; this is the one copy they now share. */
export const HEX_NEIGHBORS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]

/** Everything `makeHexHeightAt` needs to reproduce ONE tile's real ground
 * surface, derived from that tile and its neighbours.
 *
 * Extracted so the tile mesh is not the only thing that can answer "how high
 * is the ground here?". Anything placed ON the ground — vegetation, props,
 * a diorama — has to land on the exact same surface, and the only way to
 * guarantee that is to build it from the same inputs rather than from a
 * simplified re-derivation that drifts the moment the real one is retuned
 * (which it has been, repeatedly). */
export function tileHeightInputs(tile: HexTileData, lookup: Map<string, HexTileData>) {
  const height = elevationToY(tile.terrain, tile.elevation)
  // Each edge ramps toward whatever REAL neighbor sits there. A flush
  // terrain (water/mud/building) on either side, the map's own edge, or an
  // elevation gap too big to walk opts that side out with `null`, which
  // gives it the flat vertical wall it always had — real user request:
  // "para aquellas hexes juntas que no puedan caminar los mechs, por
  // ejemplo altura 0 junto altura 4, puedes hacer un 'barranco'". Two
  // levels matches the common BattleTech read of "a mech can scramble up
  // this" vs "this needs a real cliff"; movement.py's own uncapped
  // `elevation_gain` step cost makes a big jump merely very expensive
  // rather than illegal, so there is no authoritative cutoff to import.
  const neighborHeights = HEX_NEIGHBORS.map(([dq, dr]) => {
    const neighbor = lookup.get(`${tile.q + dq},${tile.r + dr}`)
    if (!neighbor) return null
    if (RELIEF_SKIP_TERRAINS.has(tile.terrain) || RELIEF_SKIP_TERRAINS.has(neighbor.terrain)) return null
    if (Math.abs(tile.elevation - neighbor.elevation) > 2) return null
    return elevationToY(neighbor.terrain, neighbor.elevation)
  })
  // Each ramping neighbour's own elevation band travels with it, so
  // makeHexHeightAt can interpolate the clamp bounds by the same weights it
  // uses for the heights — without that, restoring the within-hex noise
  // across a ramp shears it flat against a band that stayed behind (see
  // that function for the whole story). A neighbour that ramps is never a
  // flush/skipped terrain, so its band is always the plain elevation band.
  const neighborBands = HEX_NEIGHBORS.map(([dq, dr], k) => {
    if (neighborHeights[k] == null) return null
    const neighbor = lookup.get(`${tile.q + dq},${tile.r + dr}`)
    return neighbor ? elevationBandRange(neighbor.elevation) : null
  })
  // A flush terrain's band becomes its REAL depth range instead of an
  // elevation band: from just under the water/mud surface line down to its
  // BattleTech-tuned bed depth, so its uneven floor can never break that
  // surface ("el agua nunca tiene que quedar por encima del agua").
  // 'building' has no SINK_DEPTH but is just as flush by design, and
  // collapses the clamp to a single value the same way.
  const flushSinkY = terrainSinkY(tile.terrain)
  const [elevBandLow, elevBandHigh] = elevationBandRange(tile.elevation)
  const meshOwnHeight = flushSinkY ?? height
  const bandLow = flushSinkY ?? (tile.terrain === 'building' ? height : elevBandLow)
  const bandHigh = flushSinkY != null
    ? flushSinkY + (GROUND_FLUSH_TOP - flushSinkY) * FLUSH_BED_RELIEF
    : (tile.terrain === 'building' ? height : elevBandHigh)
  return { height, meshOwnHeight, neighborHeights, neighborBands, bandLow, bandHigh }
}

/** How far in from the true hex edge the tile cap sits, and how much of the
 * apothem its edge ramps occupy — the two shape parameters every caller of
 * `makeHexHeightAt` has to pass identically or it gets a different surface
 * than the one actually drawn. */
export const TILE_CAP_RADIUS = HEX_SIZE
export const TILE_RAMP_FRACTION = 0.8

/** The tile's real ground surface as a plain function of TILE-LOCAL x/z
 * (the same space its mesh is built in, i.e. relative to the tile centre).
 * Same call the tile's own mesh makes, so anything sampling this is
 * guaranteed to sit exactly on what is drawn — ramps, within-hex relief and
 * stamped craters included. */
export function tileSurfaceAt(tile: HexTileData, lookup: Map<string, HexTileData>) {
  const { meshOwnHeight, neighborHeights, neighborBands, bandLow, bandHigh } = tileHeightInputs(tile, lookup)
  const [wx, wz] = hexToWorld(tile.q, tile.r)
  return makeHexHeightAt(
    TILE_CAP_RADIUS, meshOwnHeight, neighborHeights, neighborBands, TILE_RAMP_FRACTION, wx, wz, bandLow, bandHigh,
  ).heightAt
}

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
export function makeTileHeightSampler(tile: HexTileData, lookup: Map<string, HexTileData>) {
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
