import * as THREE from 'three'
import { stampedDepthAt, terrainReliefAt } from './terrainRelief'

/** Real user request: "vamos a eliminar los saltos entre hexes" — but
 * NOT by flattening the map ("no suavices demasiado... se tiene que
 * notar que son hexes de diferentes alturas aunque sus fronteras
 * coincidan en altura"): each tile keeps its own true elevation-band
 * height across almost all of its own area, and only RAMPS during a
 * narrow strip near a border shared with a differently-elevated
 * neighbor, meeting that neighbor's own height exactly at the shared
 * edge instead of stepping down a vertical cliff there. Pure CPU/JS
 * geometry (no vertex shader) — computed once per tile from its own +
 * its 6 neighbors' heights, baked directly into the BufferGeometry's
 * position attribute. A first attempt at the WITHIN-hex orography (see
 * `terrainReliefAt`'s own doc comment) used a vertex-shader displacement
 * and rendered visibly broken once live-tested (real user report, with
 * screenshot) — `terrainReliefAt` itself survived that revert (it was
 * always plain, already-correct JS/math, never the buggy part) and gets
 * reused here too, just evaluated in JS per baked vertex instead of in a
 * shader, same "plain per-vertex JS math is far easier to reason about
 * and verify" reasoning the between-hex ramp above already used.
 *
 * Corner convention matches `cylinderGeometry(radius, radius, height,
 * 6)`'s own real default EXACTLY (verified against three.js's own
 * source, same convention `fogHexCorner`/`FOG_HEX_NEIGHBORS` in
 * HexMap.tsx already document): `thetaStart=0`, corner i at
 * `theta = i * 60°`, position `(radius*sin(theta), radius*cos(theta))`.
 * Neighbor k's shared edge is between corner (k+1)%6 and corner
 * (k+2)%6 — the exact same convention `fogEdgeCornerIndices` already
 * uses, so `neighborHeights[k]` lines up with the SAME `FOG_HEX_
 * NEIGHBORS[k]` offset table HexMap.tsx's own fog code already exports.
 *
 * Coherence with the ADJACENT tile's own independently-built geometry
 * (critical — a mismatch here would just trade the old hard cliff for a
 * new, subtler seam) comes from both tiles ramping toward the exact
 * SAME two endpoints: this tile's edge k ramps from `ownHeight` toward
 * `neighborHeights[k]`, while the neighbor's own geometry (built
 * independently, from ITS OWN perspective) ramps from ITS `ownHeight`
 * (== this tile's `neighborHeights[k]`) toward ITS neighbor height in
 * that direction (== this tile's own `ownHeight`) — both curves are
 * evaluated as a function of perpendicular distance to the SAME
 * physical edge line, so they agree at every point along it, not just
 * at the two endpoints. */
/** Corner/edge-normal geometry `buildBlendedHexGeometry` needs — split out
 * of `makeHexHeightAt` below purely to keep that function's own body
 * readable, not because anything else currently calls it directly. */
export interface HexEdgeGeometry {
  corner: (i: number) => [number, number]
  edgeNormal: [number, number][]
  apothem: number
}

function hexEdgeGeometry(radius: number): HexEdgeGeometry {
  const corner = (i: number): [number, number] => {
    const theta = (i * Math.PI) / 3
    return [radius * Math.sin(theta), radius * Math.cos(theta)]
  }
  const edgeNormal: [number, number][] = []
  let apothem = 0
  for (let k = 0; k < 6; k++) {
    const [c1x, c1z] = corner(k + 1)
    const [c2x, c2z] = corner(k + 2)
    const mx = (c1x + c2x) / 2
    const mz = (c1z + c2z) / 2
    const len = Math.hypot(mx, mz)
    edgeNormal.push([mx / len, mz / len])
    apothem = len
  }
  return { corner, edgeNormal, apothem }
}

/** The per-vertex height formula `buildBlendedHexGeometry` bakes into its
 * own geometry, factored out into its own callable purely for
 * readability. Same parameters, same doc comments — see
 * `buildBlendedHexGeometry`'s own for what each one means. */
export function makeHexHeightAt(
  radius: number,
  ownHeight: number,
  neighborHeights: (number | null)[],
  blendFraction: number,
  tileWorldX: number,
  tileWorldZ: number,
  bandLow: number,
  bandHigh: number,
): { heightAt: (x: number, z: number) => number } & HexEdgeGeometry {
  const { corner, edgeNormal, apothem } = hexEdgeGeometry(radius)
  const blendZoneWidth = apothem * blendFraction

  const heightAt = (x: number, z: number): number => {
    let deltaSum = 0
    let weightSum = 0
    for (let k = 0; k < 6; k++) {
      const nh = neighborHeights[k]
      if (nh == null || nh === ownHeight) continue
      const [nx, nz] = edgeNormal[k]
      const distToEdge = apothem - (x * nx + z * nz)
      if (distToEdge >= blendZoneWidth) continue
      const t = Math.max(0, Math.min(1, distToEdge / blendZoneWidth))
      const smooth = t * t * (3 - 2 * t)
      const w = 1 - smooth
      if (w <= 0) continue
      deltaSum += w * (nh - ownHeight) * 0.5
      weightSum += w
    }
    if (weightSum > 1) deltaSum /= weightSum
    const rampWeight = Math.min(1, weightSum)
    const base = ownHeight + deltaSum
    const noise = terrainReliefAt(tileWorldX + x, tileWorldZ + z) * (1 - rampWeight)
    const withNoise = base + noise
    const clamped = rampWeight > 0 ? withNoise : Math.max(bandLow, Math.min(bandHigh, withNoise))
    const result = clamped - stampedDepthAt(tileWorldX + x, tileWorldZ + z)
    // Last-line defense: a real user report of actual HOLES in the
    // terrain mesh at a distance ("veo cosas de debajo del tablero")
    // traces to a NaN/non-finite vertex Y — WebGL quietly refuses to
    // draw any triangle touching one, a real hole, not just dark
    // shading. stampDeformation now guards its own inputs at the
    // source, but this is the one place every one of this tile's own
    // baked vertices funnels through regardless of where a bad number
    // could ever originate — falling back to the tile's own flat
    // `ownHeight` is always a safe, sane value to render instead of a
    // hole.
    return Number.isFinite(result) ? result : ownHeight
  }

  return { heightAt, corner, edgeNormal, apothem }
}

export function buildBlendedHexGeometry(
  radius: number,
  ownHeight: number,
  /** One entry per neighbor direction (k = 0..5, `FOG_HEX_NEIGHBORS`'s
   * own order) — that neighbor's own flat height to ramp toward, or
   * `null` for "no ramp here" (no neighbor tile, either side is a flush
   * terrain that opts out of blending entirely, OR the two tiles are too
   * far apart in elevation for a mech to ever walk directly between them
   * — real user request: "para aquellas hexes juntas que no puedan
   * caminar los mechs... puedes hacer un barranco" instead of a
   * misleadingly-walkable-looking ramp; callers decide all of this, see
   * HexMap.tsx's own Tile). A `null` edge gets a plain vertical wall
   * instead, same as every edge used to have. */
  neighborHeights: (number | null)[],
  subdivisions: number,
  /** Fraction of the hex's own apothem (center-to-edge distance) the
   * ramp occupies, starting from the edge inward — real user request:
   * keep this SMALL, most of the tile should still read at its own true
   * height. */
  blendFraction: number,
  /** This tile's own world-space center (hexToWorld(q,r)) — the within-
   * hex orography below samples `terrainReliefAt` by TRUE world
   * position (tileWorldX+x, tileWorldZ+z), not tile-local x/z, for the
   * exact same cross-tile coherence reason the fog shader/this file's
   * own between-hex ramp both already rely on. */
  tileWorldX: number,
  tileWorldZ: number,
  /** Real user request: "la orografia dentro de los hex de misma
   * altura... de 0 a 5m, de 5 a 11, de 11 a 17..." (hexMath.ts's own
   * elevationBandRange) — the interior noise below is clamped to this
   * range so a tile's own within-hex variation can never drift into a
   * DIFFERENT level's real range, only ramps (above) legitimately cross
   * that boundary. */
  bandLow: number,
  bandHigh: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const { heightAt, corner } = makeHexHeightAt(
    radius, ownHeight, neighborHeights, blendFraction, tileWorldX, tileWorldZ, bandLow, bandHigh,
  )

  const N = Math.max(1, Math.floor(subdivisions))
  let vertCount = 0
  const pushVertex = (x: number, y: number, z: number): number => {
    positions.push(x, y, z)
    uvs.push(x / radius * 0.5 + 0.5, z / radius * 0.5 + 0.5)
    return vertCount++
  }

  const outerRings: number[][] = []
  for (let w = 0; w < 6; w++) {
    const [ax, az] = corner(w)
    const [bx, bz] = corner(w + 1)
    const rowIndices: number[][] = []
    for (let i = 0; i <= N; i++) {
      const row: number[] = []
      for (let j = 0; j <= N - i; j++) {
        const px = ax * (i / N) + bx * (j / N)
        const pz = az * (i / N) + bz * (j / N)
        row.push(pushVertex(px, heightAt(px, pz), pz))
      }
      rowIndices.push(row)
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        const v0 = rowIndices[i][j]
        const v1 = rowIndices[i + 1][j]
        const v2 = rowIndices[i][j + 1]
        indices.push(v0, v1, v2)
        if (j < N - i - 1) {
          const v3 = rowIndices[i + 1][j + 1]
          indices.push(v1, v3, v2)
        }
      }
    }
    const outerEdge: number[] = []
    for (let i = N; i >= 0; i--) outerEdge.push(rowIndices[i][N - i])
    outerRings.push(outerEdge)
  }

  // Plain vertical wall, only for edges with no ramp (no real neighbor,
  // or one that opted out — see this function's own `neighborHeights`
  // doc comment) — those stay perfectly flat at `ownHeight` along their
  // whole span (heightAt never blends toward a null neighbor), so a
  // straight drop to y=0 (world-local base) is always seamless there.
  for (let w = 0; w < 6; w++) {
    if (neighborHeights[w] != null) continue
    const outerEdge = outerRings[w]
    const droppedEdge: number[] = []
    for (const vi of outerEdge) {
      const idx = vi * 3
      droppedEdge.push(pushVertex(positions[idx], 0, positions[idx + 2]))
    }
    for (let k = 0; k < outerEdge.length - 1; k++) {
      const t0 = outerEdge[k]
      const t1 = outerEdge[k + 1]
      const b0 = droppedEdge[k]
      const b1 = droppedEdge[k + 1]
      indices.push(t0, b0, t1)
      indices.push(t1, b0, b1)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  // Real per-vertex normals from the actual baked (possibly ramped)
  // positions — cheap and correct now that there's no shader to hijack
  // this; `normals` above (all straight up) get thrown away here.
  geometry.computeVertexNormals()
  return geometry
}

/** Real user correction, after a first fix attempt just raised a FLAT
 * disc higher: "no quiero que simplemente eleves un overlay plano...
 * quiero que el overlay se ajuste al terreno, no debe parecer que
 * levita sobre el punto mas alto del hex, si no que debe parecer que lo
 * cubre como 'una sabana'" — a real draped surface that follows the
 * tile's own actual bumpy/ramped shape, not a flat plate floating above
 * its highest point. Same wedge-cap triangulation `buildBlendedHexGeometry`
 * itself uses for its own top surface (no walls — a highlight overlay
 * never needs one, it only ever covers the top), sampling the SAME
 * `heightAt` a caller already built via `makeHexHeightAt` (typically the
 * exact same call already used for that tile's own base mesh, so the
 * drape and the real ground it's covering are guaranteed to agree) plus
 * a small `liftY` just enough to clear it without a visible gap. */
export function buildDrapedHexCap(
  heightAt: (x: number, z: number) => number,
  corner: (i: number) => [number, number],
  subdivisions: number,
  liftY: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  const N = Math.max(1, Math.floor(subdivisions))
  let vertCount = 0
  const pushVertex = (x: number, y: number, z: number): number => {
    positions.push(x, y, z)
    return vertCount++
  }
  for (let w = 0; w < 6; w++) {
    const [ax, az] = corner(w)
    const [bx, bz] = corner(w + 1)
    const rowIndices: number[][] = []
    for (let i = 0; i <= N; i++) {
      const row: number[] = []
      for (let j = 0; j <= N - i; j++) {
        const px = ax * (i / N) + bx * (j / N)
        const pz = az * (i / N) + bz * (j / N)
        row.push(pushVertex(px, heightAt(px, pz) + liftY, pz))
      }
      rowIndices.push(row)
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        const v0 = rowIndices[i][j]
        const v1 = rowIndices[i + 1][j]
        const v2 = rowIndices[i][j + 1]
        indices.push(v0, v1, v2)
        if (j < N - i - 1) {
          const v3 = rowIndices[i + 1][j + 1]
          indices.push(v1, v3, v2)
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
