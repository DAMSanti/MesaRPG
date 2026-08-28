import type { HexTileData } from './api'
import { elevationBandRange, elevationToY, HEX_SIZE, hexToWorld } from './hexMath'
import { RELIEF_SKIP_TERRAINS } from './terrainRelief'
import { GROUND_FLUSH_TOP, terrainSinkY } from './components/TerrainDecor'
import { makeHexHeightAt } from './hexTileGeometry'

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
    ? GROUND_FLUSH_TOP - 0.05
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
