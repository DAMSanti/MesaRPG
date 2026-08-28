import * as THREE from 'three'
import { TERRAIN_FLOOR_Y } from './hexMath'
import { RELIEF_AMPLITUDE, stampedDepthAt, terrainReliefAt, worldNoise01 } from './terrainRelief'

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
  /** The tile CAP's own outline, which is NOT the bare hexagon `corner`
   * describes — see `capBoundary` below. `w` is the edge index, `t` runs
   * 0..1 from corner w to corner w+1. */
  capBoundary: (w: number, t: number) => [number, number]
  edgeNormal: [number, number][]
  apothem: number
}

/** How far each tile's top surface is pulled in from the true hex edge, as
 * a fraction of the apothem — this is what leaves the dark groove visible
 * between neighbors. Real user requests, in order: "el espacio entre tiles
 * debe ser mucho mas pequeño... un 40% o asi" (5% -> 2%), then "la grid se
 * va a quedar, no me importa las lineas negras" (so it stays at all), then
 * the same trim again on the narrower line: "haz mas estrecha la frontera
 * entre hexes, como menos de la mitad que ahora", and then "reducelo algo
 * mas, la mitad que ahora" (2% -> 0.8% -> 0.4%, taking the gap from ~1.04 to
 * ~0.21 world units at HEX_SIZE 30). It used to live in HexMap.tsx as a bare `HEX_SIZE *
 * 0.98` repeated at every call site; it belongs here, next to the outline
 * math that is the only thing which actually cares. */
const CAP_EDGE_INSET = 0.004
/* A corner TAPER on that inset was tried here and reverted at the user's
 * request: "reviertas lo que has hecho con las esquinas... has tocado algo
 * que no arregla el problema y deja la apariencia de las tiles peor."
 *
 * The theory behind it was that three tiles falling short of a shared
 * corner leave an uncovered triangle wider than the groove line itself, so
 * the grid appeared to swell at every junction. That was a misreading of
 * the screenshot: the junction was fine, and easing the tiles back toward
 * the corner only made the grid line visibly thin out at every vertex for
 * nothing. The straight, undegraded lines the user was actually pointing at
 * were the blend patches' own ends, not the tile outlines — see
 * buildEdgeBlendPatch. The inset stays uniform, which for a regular hexagon
 * is exactly a uniform scale about the center. */
/** Real user request: "quiero que los cambios de textura no se aprecien
 * tan bruscos... quiero que mejore el realismo del mapa" — the single
 * biggest offender was NOT the cross-terrain border at all, it was that
 * every tile mapped its texture in TILE-LOCAL space (`x / radius * 0.5 +
 * 0.5`), so all 400+ tiles of a given terrain rendered the byte-for-byte
 * IDENTICAL crop of the same photo, restarting at every hex edge: a
 * visible repeating stamp AND a real discontinuity at every single
 * border, even between two tiles of the very same terrain.
 *
 * Mapping by TRUE world position instead makes the photo one continuous
 * carpet across the whole board — two same-texture neighbors now line up
 * exactly (their shared edge stops existing visually), and no two tiles
 * ever show the same crop. `2 * radius` keeps the on-screen texel
 * density byte-identical to the old formula (which spanned uv 0→1 across
 * one tile's own 2*radius width), so every terrain's own hand-tuned
 * `repeat` value in terrain.ts still means exactly what it meant before.
 *
 * This is also why `terrainRotation()` (terrain.ts) is no longer applied
 * to the ground mesh: it existed purely to hide that per-tile repetition
 * by rotating each tile's own crop, and rotating a world-continuous
 * mapping would REINTRODUCE a seam at every border instead. */
export function worldTextureUV(worldX: number, worldZ: number, radius: number): [number, number] {
  const span = radius * 2
  return [worldX / span, worldZ / span]
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
  // Insetting every edge of a REGULAR hexagon by the same perpendicular
  // distance is identical to scaling the whole hexagon about its center,
  // so the cap outline is just the bare hexagon at `capScale` — which is
  // the `HEX_SIZE * 0.98` this used to be written as at each call site.
  const capScale = 1 - CAP_EDGE_INSET
  const capBoundary = (w: number, t: number): [number, number] => {
    const [ax, az] = corner(w)
    const [bx, bz] = corner(w + 1)
    return [(ax + (bx - ax) * t) * capScale, (az + (bz - az) * t) * capScale]
  }
  return { corner, capBoundary, edgeNormal, apothem }
}

/** The per-vertex height formula `buildBlendedHexGeometry` bakes into its
 * own geometry, factored out into its own callable purely for
 * readability. Same parameters, same doc comments — see
 * `buildBlendedHexGeometry`'s own for what each one means. */
export function makeHexHeightAt(
  radius: number,
  ownHeight: number,
  neighborHeights: (number | null)[],
  neighborBands: ([number, number] | null)[],
  blendFraction: number,
  tileWorldX: number,
  tileWorldZ: number,
  bandLow: number,
  bandHigh: number,
): { heightAt: (x: number, z: number) => number } & HexEdgeGeometry {
  const { corner, capBoundary, edgeNormal, apothem } = hexEdgeGeometry(radius)
  const blendZoneWidth = apothem * blendFraction
  // Scale the within-hex relief to whatever room its own band actually
  // gives it, instead of running at full amplitude and being clipped.
  //
  // Clipping is not a gentle failure. Where the noise exceeds the band it
  // flattens against it, so the surface becomes a plateau whose EDGE is
  // wherever the noise happens to cross the limit — and since the mesh is
  // only subdivided so far, that edge follows triangle boundaries and comes
  // out as hard straight steps. Harmless on dry land, whose band is several
  // metres and swallows the noise whole; ruinous on a riverbed, whose band
  // is a fraction of a metre, where a real user saw exactly that: "se ve una
  // forma diferente en el fondo de mi agua y no una textura continua...
  // algo esta entorpeciendo, se glitchea."
  //
  // Scaled instead, nothing ever reaches the clamp, so there is no plateau
  // and no edge to facet. A riverbed gets a gentle, continuous floor and dry
  // ground is untouched (its scale works out to 1).
  const bandRoom = Math.max(0, bandHigh - bandLow)
  const noiseScale = Math.min(1, bandRoom / (2 * RELIEF_AMPLITUDE))

  const heightAt = (x: number, z: number): number => {
    let deltaSum = 0
    let weightSum = 0
    // The tile's own elevation band, travelling along with the ramp under
    // exactly the same weights as the height itself — see `bandLowAt` below.
    let lowSum = 0
    let highSum = 0
    for (let k = 0; k < 6; k++) {
      const nh = neighborHeights[k]
      if (nh == null || nh === ownHeight) continue
      const [nx, nz] = edgeNormal[k]
      const distToEdge = apothem - (x * nx + z * nz)
      if (distToEdge >= blendZoneWidth) continue
      const t = Math.max(0, Math.min(1, distToEdge / blendZoneWidth))
      // Real user report, from the ground, pointing straight at a border:
      // "continua la pendiente pero inmediatamente hace como un escalon...
      // pasa en todas las fronteras entre tiles de alturas diferentes."
      //
      // `1 - smoothstep(t)` has ZERO derivative at t=0 — which is exactly
      // AT the shared edge. Both tiles therefore arrived at the border
      // dead flat and only picked the slope back up once inside
      // themselves: a level shelf straight across every boundary between
      // different elevations, with the hillside resuming right after it.
      // Measured on a 6-unit level step: slope 0.0022 at the border
      // against 0.2165 at its steepest, a few metres away.
      //
      // Reading the SAME smoothstep across the whole two-tile crossing
      // fixes it. `u` is how far along that crossing this point is — 0 at
      // the far side of our own ramp zone, 0.5 at the border — with the
      // neighbour covering 0.5..1 by mirror symmetry. smoothstep is
      // steepest at its midpoint, so the slope now PEAKS at the border
      // (0.2165, the maximum) and eases off toward each tile's own middle:
      // one continuous S-curve over the two tiles. Doubling keeps the
      // weight on its old 0..1 scale, so w is still exactly 1 at the edge
      // and the two tiles still meet at the midpoint height.
      //
      // This was tried once before and wrongly discarded as useless: at the
      // time the within-hex noise was still being faded out across ramps,
      // and the glassy smooth band THAT produced was a far bigger artifact
      // sitting on top of this one, so fixing this changed nothing visible.
      // With the noise restored (see below) it is the whole remaining bug.
      // What it does NOT fix, and was mistakenly blamed for once, is the
      // flat plateau every tile has at its own centre: that comes from
      // blendFraction being under 1.0, and the restored noise is what
      // covers it. Setting blendFraction to 1.0 to remove it as well turns
      // every summit into a sharp pyramid — measured, and much worse.
      const u = 0.5 * (1 - t)
      const w = 2 * (u * u * (3 - 2 * u))
      if (w <= 0) continue
      deltaSum += w * (nh - ownHeight) * 0.5
      weightSum += w
      const nb = neighborBands[k]
      if (nb) {
        lowSum += w * (nb[0] - bandLow) * 0.5
        highSum += w * (nb[1] - bandHigh) * 0.5
      }
    }
    if (weightSum > 1) {
      deltaSum /= weightSum
      lowSum /= weightSum
      highSum /= weightSum
    }
    const base = ownHeight + deltaSum
    // Full strength, everywhere — including across ramps, where it used to
    // be faded out by `* (1 - rampWeight)`. That fade is what a real user
    // spotted from the ground: hills inside one elevation level looked
    // right ("una colina la hace perfecta") because they are pure
    // world-space noise, while any level CHANGE turned the ground glassy
    // smooth over the whole ramp and read as a step cut into rough terrain.
    // It costs nothing in cross-tile agreement: the noise is one continuous
    // function of world position, so both tiles sampling the same point
    // always get the same number, fade or no fade.
    const noise = terrainReliefAt(tileWorldX + x, tileWorldZ + z) * noiseScale
    const withNoise = base + noise
    // Real user report (with screenshots): black blobs on the map, "siempre
    // en las mismas zonas, parecen como depresiones... puede ser que bajen
    // por debajo de la altura de las tiles." They did. This clamp used to be
    // SKIPPED outright whenever `rampWeight > 0` — meaning on any tile with
    // even one different-height neighbour, across the whole 80%-of-apothem
    // ramp zone. Out near the inner end of that zone the ramp contributes
    // almost nothing (base stays ~ownHeight) but `rampWeight` is still just
    // barely above zero, so the noise ran at nearly full amplitude with
    // nothing bounding it: a level-0 tile (own height 1, band 0..5, relief
    // amplitude 3.6) could reach y = -2.6, straight through the groove slab
    // underneath, whose dark top face is what was actually being seen. Same
    // spots every time, because the noise field is deterministic in world
    // space.
    //
    // The reason the clamp was conditional is real though: a ramp
    // legitimately crosses out of its own band, that is the entire point of
    // it. So rather than switching off, the bounds now WIDEN to admit the
    // ramp's own value and nothing else — the ramp may leave the band, the
    // noise on top of it may not.
    // ...which is only safe if the BAND travels with the ramp too. Clamping
    // ramped ground against the tile's own stationary band would shear the
    // restored noise off against a flat ceiling/floor partway up every
    // slope — a worse artifact than the one being fixed. Interpolating the
    // two bands with the same weights as the height keeps the noise the
    // same size all the way across, and keeps the two tiles in exact
    // agreement: at their shared edge both land on w=1, so both compute the
    // midpoint of the two bands and clamp against identical numbers.
    const bandLowAt = bandLow + lowSum
    const bandHighAt = bandHigh + highSum
    const clamped = Math.max(Math.min(bandLowAt, base), Math.min(Math.max(bandHighAt, base), withNoise))
    // Stamped craters/footprints are subtracted after the clamp on purpose
    // (a crater is meant to dig below the band's own floor), but they must
    // still stop short of the groove: a 1.2-deep impact crater on a level-0
    // tile that had already dipped would otherwise punch through it exactly
    // like the noise used to. Taking the MINIMUM means this floor can only
    // ever stop a surface going lower, never raise one that belongs lower —
    // a flush terrain's lake bed sets `bandLow` far below this and keeps
    // it.
    const floorY = Math.min(TERRAIN_FLOOR_Y, bandLow)
    const result = Math.max(floorY, clamped - stampedDepthAt(tileWorldX + x, tileWorldZ + z))
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

  return { heightAt, corner, capBoundary, edgeNormal, apothem }
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
  /** Each ramping neighbour's own elevation band, in the same order — see
   * `makeHexHeightAt`, which interpolates these alongside the heights so a
   * tile's within-hex noise can survive a ramp without being clamped flat
   * against a band that stayed behind. `null` wherever `neighborHeights`
   * is. */
  neighborBands: ([number, number] | null)[],
  subdivisions: number,
  /** Fraction of the hex's own apothem (center-to-edge distance) the ramp
   * occupies, starting from the edge inward. An earlier request ("no
   * suavices demasiado, se tiene que notar que son hexes de diferentes
   * alturas") had this deliberately small so most of a tile stayed at its
   * own flat height; a later one ("puedes hacer que la pendiente sea
   * constante? no quiero ese escalon") supersedes it, and the caller now
   * passes 1.0. Anything below 1.0 leaves a flat plateau in the middle of
   * every tile, which on a hillside reads as a terrace per hex — see the
   * weight in `heightAt` below, where the same fix has its other half.
   * Different hex heights still read perfectly well from the slope itself
   * and from the groove grid; what they no longer do is step. */
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
  /** Optional per-vertex ground tint, sampled by TRUE world position.
   *
   * Real user request: "podemos hacer alguna trampa en tableview y gmview
   * para que los parches de hierba se vean mejor? que pinte ligeramente del
   * verde mas oscuro las zonas por densidad de hierba" — from a distant
   * camera the grass geometry is only a few pixels tall and its mats barely
   * register, so the soil underneath carries the pattern instead. Passed in
   * rather than computed here because this file knows about hex geometry,
   * not about what grows on it; the caller supplies whatever field it wants
   * (and passes nothing at all for terrain that has no vegetation). */
  groundTint?: (worldX: number, worldZ: number) => [number, number, number],
): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const colors: number[] = []
  const indices: number[] = []

  const { heightAt, capBoundary } = makeHexHeightAt(
    radius, ownHeight, neighborHeights, neighborBands, blendFraction, tileWorldX, tileWorldZ, bandLow, bandHigh,
  )

  const N = Math.max(1, Math.floor(subdivisions))
  let vertCount = 0
  const pushVertex = (x: number, y: number, z: number): number => {
    positions.push(x, y, z)
    const [u, v] = worldTextureUV(tileWorldX + x, tileWorldZ + z, radius)
    uvs.push(u, v)
    // White when no tint is supplied, so the material can keep vertexColors
    // on unconditionally and every tile takes the same code path — a
    // material that only sometimes has the attribute it declares is a
    // reliable way to get a silently black mesh.
    if (groundTint) {
      const [cr, cg, cb] = groundTint(tileWorldX + x, tileWorldZ + z)
      colors.push(cr, cg, cb)
    } else {
      colors.push(1, 1, 1)
    }
    return vertCount++
  }

  const outerRings: number[][] = []
  for (let w = 0; w < 6; w++) {
    const rowIndices: number[][] = []
    for (let i = 0; i <= N; i++) {
      const row: number[] = []
      for (let j = 0; j <= N - i; j++) {
        // Each wedge is still a plain fan from the tile center out to one
        // edge; the only change from a bare `lerp(corner(w), corner(w+1))`
        // is that the OUTLINE it fans out to is `capBoundary` (the inset,
        // corner-tapered cap outline), with interior rings scaled down
        // toward the center along the same rays.
        const ring = (i + j) / N
        const t = i + j === 0 ? 0.5 : j / (i + j)
        const [bxr, bzr] = capBoundary(w, t)
        const px = bxr * ring
        const pz = bzr * ring
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
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
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
  /** The SAME `capBoundary` the base mesh was built from (both come out of
   * one `makeHexHeightAt` call), so the drape covers the tile's real
   * outline exactly instead of a slightly different hexagon. */
  capBoundary: (w: number, t: number) => [number, number],
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
    const rowIndices: number[][] = []
    for (let i = 0; i <= N; i++) {
      const row: number[] = []
      for (let j = 0; j <= N - i; j++) {
        const ring = (i + j) / N
        const t = i + j === 0 ? 0.5 : j / (i + j)
        const [bxr, bzr] = capBoundary(w, t)
        const px = bxr * ring
        const pz = bzr * ring
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

/** Real user request, and then the same request again in much blunter
 * terms after the first attempt at it: "quiero que las texturas de un
 * tile al otro vayan degradadas y no haya un cambio brusco... pasamos de
 * llanura, has hecho en el borde un degradado MUY brusco a bosque, sin
 * embargo despues esta la frontera de hex y en lugar de aprovechar el
 * degradado aqui le metes un cacho de llanura degradado muy brusco, y va
 * a bosque... en lugar de hacer un blend bien, estas haciendo 2
 * destrozando todo."
 *
 * That report is exactly right and names the real bug. Both earlier
 * versions had every tile paint its NEIGHBOR's texture inside its own
 * hex at alpha 1 AT the shared edge, fading to 0 inward — and the
 * neighbor did the identical thing back toward us. So the two textures
 * ended up SWAPPED along the border: walking plains -> forest you got
 * plains, an abrupt ramp to forest (inside the plains hex), the hex line,
 * then a slab of PLAINS again (inside the forest hex), then another ramp
 * back to forest. Two mirrored half-blends fighting each other instead of
 * one transition. Widening them or making them noisy only made a bigger
 * mess, because the discontinuity was never about width.
 *
 * The fix is a single blend factor `f` shared by both tiles:
 *
 *     f(p) = "how much of the CANONICALLY-SECOND tile's texture belongs
 *             at world point p" — 0 deep inside the first tile, 1 deep
 *             inside the second, 0.5 on the border itself.
 *
 * The first tile draws its neighbor's texture at alpha `f`; the second
 * draws its neighbor's texture at alpha `1 - f`. Composite them and the
 * two sides agree EXACTLY on the border line:
 *
 *     first side:  (1-f)*A + f*B
 *     second side: (1-(1-f))*B + (1-f)*A  =  (1-f)*A + f*B
 *
 * — the same pixels, from both directions, for any f whatsoever. So the
 * seam cannot come back no matter how the mask is tuned, and the whole
 * A -> B ramp is monotonic: A stays pure until the band starts, mixes
 * once, and arrives at pure B. One blend, not two. `flipped` is what
 * tells this function which side of the border it is building, decided
 * by a canonical ordering of the two tile coordinates so the two calls
 * can never both think they are the same side.
 *
 * Alpha therefore PEAKS AT 0.5 on the border, never 1 — a 50/50 mix of
 * the two real textures is the correct midpoint of a crossfade, and it is
 * also why no tile ever shows a slab of a neighbor's raw texture again.
 *
 * The boundary still wanders instead of tracing the hex outline, per
 * "no tiene por que ser justo en la frontera entre tiles, puedes hacer
 * degradados de diferentes formas en diferentes sitios": world-space
 * noise displaces `f`'s own midpoint back and forth along the transition
 * axis. Because it is one shared world-space field sampled at the same
 * point with the same per-border offset, BOTH tiles displace it
 * identically — the wander is a property of the border, not of either
 * tile, so it costs nothing in continuity. Its amplitude is deliberately
 * capped below the smoothstep's own edge (see COARSE_AMP/FINE_AMP/RAMP_EDGE) so
 * that alpha still reaches exactly 0 at the band's inner boundary; that
 * is what keeps the mesh from ending in a visible straight cut, with no
 * extra fudge factor needed.
 *
 * Shape: the true region of this hex within `blendWidth` of the edge. That
 * region WIDENS with depth — as you move inward from the edge, the strip
 * runs on until it hits the two ADJACENT hex edges, which at a hexagon's
 * 120-degree corner is `blendWidth / tan(60deg)` PAST each corner, not
 * short of it.
 *
 * Earlier versions had that backwards and narrowed the strip instead,
 * which is the bug behind a real user report (with screenshot) of
 * "lineas con texturas no degradadas y rectas a 135 grados" radiating
 * from every vertex, plus "el degradado a 3 no funciona": narrowing left
 * the strip's two slanted sides sitting in the middle of the tile, where
 * alpha was still around 0.5 and simply stopped — a hard cut, not a
 * gradient — and left the wedge right at each corner covered by neither
 * of the two strips meeting there. Widening puts every side of the strip
 * on the tile's own outline, where the neighbour's strip carries on, so
 * no edge of this mesh is ever visible as a line; the two strips at a
 * corner now overlap instead of leaving a gap, and that overlap is what
 * produces a three-way blend where three terrains meet.
 *
 * Rendering contract is deliberately shader-free (hand-rolled GLSL caused
 * a real, visibly broken regression earlier in this project): an ordinary
 * transparent vertex-colored mesh drawn over the base tile with the
 * NEIGHBOR's texture, RGB carrying the same ground tint as the mesh
 * underneath and alpha carrying the mask.
 * `heightAt`/`corner` come from the SAME `makeHexHeightAt` call the base
 * mesh used, so it sits flush on the real (ramped, bumpy, stamped)
 * surface; `liftY` is the small deliberate vertical gap that fixed a real
 * reported z-fighting/tearing artifact more reliably than
 * depthTest/polygonOffset tricks alone. */
export function buildEdgeBlendPatch(
  radius: number,
  heightAt: (x: number, z: number) => number,
  /** The tile's real cap outline (same `makeHexHeightAt` call as the base
   * mesh). Every corner of this strip is derived from it, so the strip
   * lands exactly on the visible tile rather than on the bare hexagon a
   * little outside it. */
  capBoundary: (w: number, t: number) => [number, number],
  edgeIndex: number,
  /** How far inward (world units) this tile's HALF of the transition
   * reaches. The full A-to-B crossfade is twice this, since the tile on
   * the other side contributes a mirror-image half of its own. */
  blendWidth: number,
  segmentsAlong: number,
  segmentsIn: number,
  liftY: number,
  /** This tile's own world-space center — the mask samples world
   * position (tileWorld + local), never tile-local, for cross-tile
   * continuity. */
  tileWorldX: number,
  tileWorldZ: number,
  /** Per-border offset into the noise field (the same value on both
   * sides of the border), so different borders get visibly different
   * transition shapes out of one shared field. */
  noiseOffsetX: number,
  noiseOffsetZ: number,
  /** Which side of this border we are building — false for the tile that
   * comes first in the caller's canonical ordering of the two tile
   * coordinates, true for the other one. The two tiles MUST disagree on
   * this and agree on everything else; that is the entire mechanism (see
   * this function's own doc comment) by which their two halves compose
   * into one continuous crossfade instead of two competing ones. */
  flipped: boolean,
): THREE.BufferGeometry {
  // This strip's own edge runs between cap corners `edgeIndex + 1` and
  // `edgeIndex + 2` (the neighbor-table convention documented at the top
  // of this file). Its two ends then slide along the ADJACENT cap edges —
  // the one arriving at A from corner `edgeIndex`, and the one leaving B
  // toward corner `edgeIndex + 3`.
  const [ax, az] = capBoundary(edgeIndex + 1, 0)
  const [bx, bz] = capBoundary(edgeIndex + 1, 1)
  const [prevX, prevZ] = capBoundary(edgeIndex, 0)
  const [nextX, nextZ] = capBoundary(edgeIndex + 3, 0)
  const unit = (dx: number, dz: number): [number, number] => {
    const len = Math.hypot(dx, dz) || 1
    return [dx / len, dz / len]
  }
  const [uax, uaz] = unit(prevX - ax, prevZ - az)
  const [ubx, ubz] = unit(nextX - bx, nextZ - bz)
  const edgeLen = Math.hypot(bx - ax, bz - az) || 1
  // Travelling `blendWidth / sin(60deg)` along an adjacent edge is what
  // gains `blendWidth` of perpendicular distance from THIS edge (the two
  // meet at 60 degrees), so that is how far the strip's ends run by the
  // time its inner boundary is a full `blendWidth` deep. Clamped so a
  // freakishly wide band could never run off the end of the adjacent edge
  // and fold the mesh over itself; `depthAt` below reads the real
  // perpendicular distance back out, so the mask stays correct even then.
  const SIN_60 = Math.sin(Math.PI / 3)
  const endRun = Math.min(blendWidth / SIN_60, edgeLen * 0.95)

  const positions: number[] = []
  const uvs: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  let vertCount = 0
  // Vertex color is RGBA: RGB is the ground tint (white when there is none),
  // alpha carries the mask. Relies on ordinary three.js material behavior
  // (`vertexColors` + a 4-component color attribute + `transparent`), no
  // custom shader involved.
  const pushVertex = (x: number, y: number, z: number, alpha: number): number => {
    positions.push(x, y, z)
    // The SAME world-space mapping the base mesh uses (see
    // worldTextureUV) — critical here, not just tidy: this patch is
    // pretending to be a piece of the NEIGHBOR tile's own surface, and
    // it only reads as one if the neighbor's texture lands on exactly
    // the pixels it would have if that tile really extended this far.
    const [u, v] = worldTextureUV(tileWorldX + x, tileWorldZ + z, radius)
    uvs.push(u, v)
    colors.push(1, 1, 1, alpha)
    return vertCount++
  }

  const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  // Feature sizes, as fractions of the hex radius, for the noise that
  // makes the boundary wander: COARSE decides the overall shape of the
  // transition, FINE frays its outline. FINE stays well above the vertex
  // spacing this grid can actually resolve (~radius/10 along the edge),
  // otherwise its detail just aliases into per-vertex speckle.
  const COARSE_WAVELENGTH = radius * 0.7
  const FINE_WAVELENGTH = radius * 0.32
  // How far (as a fraction of blendWidth) the noise may push the 50/50
  // line off the geometric border, in each direction. Their SUM must stay
  // below (1 - RAMP_EDGE) or alpha stops reaching exactly 0 at the band's
  // inner boundary and the mesh ends in a visible straight cut — the two
  // numbers are a pair, change them together.
  //
  // Real user report on the first working version of the crossfade: "el
  // degradado a poder ser que no sea en linea recta, queda muy
  // artificial." It was a true gradient by then, but a gradient whose
  // midline still ran parallel to the hex edge, because the wander budget
  // here was under a third of the band and the coarse feature size was
  // longer than the edge itself — one slow swell across a whole border
  // reads as a straight offset line. Half the band now goes to wander, at
  // a feature size shorter than an edge, so the boundary actually
  // meanders in and out several times along one border. `blendWidth` grew
  // to match (see TEXTURE_BLEND_MAX_WIDTH) so the ramp stayed just as
  // gradual in world units after giving up that budget.
  const COARSE_AMP = 0.36
  const FINE_AMP = 0.16
  // Half-width of the crossfade ramp itself, in the same units — literally
  // how gradual the transition is, so it takes everything the amplitude
  // budget above leaves.
  const RAMP_EDGE = 0.45
  const maskAt = (lx: number, lz: number, depth: number): number => {
    const wx = tileWorldX + lx + noiseOffsetX
    const wz = tileWorldZ + lz + noiseOffsetZ
    const coarse = worldNoise01(wx / COARSE_WAVELENGTH, wz / COARSE_WAVELENGTH, 2)
    const fine = worldNoise01(wx / FINE_WAVELENGTH + 37.13, wz / FINE_WAVELENGTH - 19.71, 2)
    const wander = (coarse - 0.5) * 2 * COARSE_AMP + (fine - 0.5) * 2 * FINE_AMP
    // Position along the border's own transition axis, normalized to
    // blendWidth and oriented CANONICALLY (negative on the first tile's
    // side, positive on the second's) — which is why `flipped` has to
    // flip the sign here and the result below, and why both tiles get the
    // same answer for the same physical point.
    const axis = (flipped ? depth : -depth) + wander
    const f = smoothstep(-RAMP_EDGE, RAMP_EDGE, axis)
    // ...and this is the crossfade: the first tile shows `f` of its
    // neighbor, the second shows `1 - f` of its own. Both land on 0.5 at
    // the border and on 0 at the far end of their own band.
    return flipped ? 1 - f : f
  }

  const nAlong = Math.max(1, Math.floor(segmentsAlong))
  const nIn = Math.max(1, Math.floor(segmentsIn))
  const rows: number[][] = []
  for (let j = 0; j <= nIn; j++) {
    const run = (j / nIn) * endRun
    // Both ends of the row slide down their own adjacent edge by the same
    // `run`, so the row stays parallel to this strip's edge and every
    // point on it is the same perpendicular distance away — which is what
    // lets one `depth` value below describe the whole row.
    const rax = ax + uax * run, raz = az + uaz * run
    const rbx = bx + ubx * run, rbz = bz + ubz * run
    const depth = (run * SIN_60) / blendWidth
    const row: number[] = []
    for (let i = 0; i <= nAlong; i++) {
      const t = i / nAlong
      const px = rax + (rbx - rax) * t
      const pz = raz + (rbz - raz) * t
      row.push(pushVertex(px, heightAt(px, pz) + liftY, pz, maskAt(px, pz, depth)))
    }
    rows.push(row)
  }
  for (let j = 0; j < nIn; j++) {
    for (let i = 0; i < nAlong; i++) {
      const a = rows[j][i], b = rows[j][i + 1]
      const c = rows[j + 1][i], d = rows[j + 1][i + 1]
      indices.push(a, c, b)
      indices.push(b, c, d)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** The dark groove between tiles — as a RING that exists only at the tile's
 * border, following the terrain's own height, instead of a slab under the
 * whole tile.
 *
 * Real user report: "lo que se glitchea es el borde negro de las tiles, ese
 * deberia estar SOLO en las fronteras, hasta la altura del terreno, pero no
 * debajo del cuerpo de las tiles."
 *
 * Exactly right, and it is the root of a whole family of bugs. The groove
 * used to be a solid hexagonal slab sitting under each tile at a FIXED
 * height, visible only through the narrow gap left by the tile's own inset
 * cap. That works right up until the ground goes lower than the slab —
 * which it does wherever the terrain dips, wherever a crater is stamped, and
 * always in water, whose bed sinks metres below it. Then the slab cuts up
 * through the ground and its near-black top face shows through: the "zonas
 * negras" reported on riverbeds, and the dark blotches reported across open
 * ground before that. Both were patched by pushing the slab further down for
 * particular terrain, which is treating symptoms of a slab that had no
 * business being under the tile at all.
 *
 * A ring cannot have that problem. There is nothing underneath the tile to
 * emerge from, and because its top is sampled from the SAME `heightAt` the
 * cap is built from, it sits just under the real ground everywhere along the
 * border however that ground ramps, bumps or is cratered.
 *
 * `dropBelow` is how far under the cap edge the visible top of the groove
 * sits (what makes it read as a groove rather than as a flush seam), and
 * `skirtDepth` how far its outer wall continues down, so the gap reads as a
 * slot with depth rather than as a ribbon floating in it. */
export function buildHexGrooveRing(
  radius: number,
  heightAt: (x: number, z: number) => number,
  capBoundary: (w: number, t: number) => [number, number],
  segments: number,
  dropBelow: number,
  skirtDepth: number,
): THREE.BufferGeometry {
  const { corner } = hexEdgeGeometry(radius)
  const positions: number[] = []
  const indices: number[] = []
  let vertCount = 0
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z)
    return vertCount++
  }
  const n = Math.max(1, Math.floor(segments))
  for (let w = 0; w < 6; w++) {
    const [ax, az] = corner(w)
    const [bx, bz] = corner(w + 1)
    const innerTop: number[] = []
    const outerTop: number[] = []
    const outerBottom: number[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const [ix, iz] = capBoundary(w, t)
      // The cap's own height at this point, so the groove tracks the real
      // surface instead of a flat guess and can never rise through it.
      const capY = heightAt(ix, iz)
      // The INNER lip meets the tile's own edge, near enough to touch. It
      // deliberately does NOT take the drop: doing that left a vertical hole
      // between the tile's edge and the groove, and what showed through it
      // was the lit inside of the tile — the grid came out as a pale line
      // instead of a dark seam. Only the outer edge drops, which makes the
      // groove a chamfer running down to the seam rather than a ledge with a
      // gap above it.
      innerTop.push(push(ix, capY - 0.02, iz))
      const y = capY - dropBelow
      // The outer edge is the TRUE hex corner line, which this tile shares
      // exactly with its neighbour, so the two tiles' rings meet along it
      // and the grid reads as one continuous groove rather than as six
      // separate ones per tile.
      const ox = ax + (bx - ax) * t
      const oz = az + (bz - az) * t
      outerTop.push(push(ox, y, oz))
      outerBottom.push(push(ox, y - skirtDepth, oz))
    }
    for (let i = 0; i < n; i++) {
      indices.push(innerTop[i], outerTop[i], innerTop[i + 1])
      indices.push(innerTop[i + 1], outerTop[i], outerTop[i + 1])
      indices.push(outerTop[i], outerBottom[i], outerTop[i + 1])
      indices.push(outerTop[i + 1], outerBottom[i], outerBottom[i + 1])
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}
