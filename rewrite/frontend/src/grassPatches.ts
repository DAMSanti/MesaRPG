import { HEX_SIZE } from './hexMath'
import { worldNoise01 } from './terrainRelief'

/** How thickly grass grows at any point on the board, 0 (bare) to 1 (fully
 * matted over), as one continuous function of world position.
 *
 * Real user request: "quiero que forme parches coherentes... tiene que haber
 * zonas donde no se vea la textura de debajo." Uniform random scatter is
 * what makes grass read as noise — every square metre treated alike, so the
 * ground ends up evenly stubbled and never actually covered anywhere. Real
 * grassland is thick mats with bare ground between them, so this field is
 * what decides where a mat is, and everything that cares about grass reads
 * the answer from HERE rather than deciding for itself.
 *
 * That sharing is the whole point of the module. GroundVegetation.tsx uses it
 * to accept or reject each candidate plant; the ground mesh uses it to shade
 * the soil under a mat darker (real user request: "podemos hacer alguna
 * trampa en tableview y gmview para que los parches de hierba se vean mejor?
 * que pinte ligeramente del verde mas oscuro las zonas por densidad de
 * hierba"). If those two derived their own version of "where is the grass
 * thick", the tint would drift away from the plants it is supposed to be
 * under, and a tint that disagrees with the grass looks far worse than no
 * tint at all.
 *
 * World-space, like every other coherent field in this project (ground
 * relief, texture patches), which is what makes a mat run across a tile
 * border instead of stopping at it. */

/** Feature size of a mat. Deliberately shorter than a hex, so a single tile
 * holds several thick and thin areas rather than being uniformly one or the
 * other. */
const PATCH_WAVELENGTH = HEX_SIZE * 0.45
/** A finer field that frays the edge of every mat so it does not read as a
 * smooth blob. */
const FRAY_WAVELENGTH = HEX_SIZE * 0.14
/** Below LO nothing grows, above HI the mat is at full density. The gap is
 * the only part that looks scattered, so it is kept narrow — most of the
 * board is either properly covered or properly bare. */
const PATCH_LO = 0.34
const PATCH_HI = 0.56
/** Never let a bare area go completely bald: a thin scatter still catches the
 * light and keeps bare ground reading as short-cropped rather than as a hole
 * where the grass failed to load. */
const PATCH_FLOOR = 0.06

/** The raw field, before any threshold. Both responses below read it, so the
 * plants and the shading are always talking about the same mats. */
function patchFieldAt(worldX: number, worldZ: number): number {
  const broad = worldNoise01(worldX / PATCH_WAVELENGTH, worldZ / PATCH_WAVELENGTH, 2)
  const fray = worldNoise01(worldX / FRAY_WAVELENGTH + 11.3, worldZ / FRAY_WAVELENGTH - 5.7, 1)
  return broad * 0.82 + fray * 0.18
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

export function grassDensityAt(worldX: number, worldZ: number): number {
  return PATCH_FLOOR + (1 - PATCH_FLOOR) * smoothstep(PATCH_LO, PATCH_HI, patchFieldAt(worldX, worldZ))
}

/** How far either side of the plants' own threshold the SHADING keeps
 * ramping, in units of the raw field.
 *
 * Real user request: "me gustaria desenfocar y difuminar el borde con las
 * zonas sin hierba, de modo que el cambio de color no sea tan brusco."
 *
 * The plants want a narrow band — that is what makes a mat read as a mat
 * with real bare ground beside it, rather than as an even stubble. But the
 * shading underneath has no such need, and inheriting that same narrow band
 * gave the soil a hard colour edge with nothing on the ground to justify it:
 * a painted outline around every patch.
 *
 * So the two now respond differently to the SAME field. The tint peaks where
 * the grass is thick and fades out over a band several times wider, which is
 * also what really happens — ground near a mat is partly shaded by it, and
 * the shadow does not stop where the last blade does. */
const SHADE_SOFTEN = 0.16

export function grassShadeDensityAt(worldX: number, worldZ: number): number {
  return smoothstep(PATCH_LO - SHADE_SOFTEN, PATCH_HI + SHADE_SOFTEN, patchFieldAt(worldX, worldZ))
}

/** Resolution of the per-tile grid below. 20 spans a 30m hex at 3m steps,
 * finer than the field's own features. */
const PATCH_GRID = 20

/** The same field, precomputed on a grid over one tile and answered by
 * interpolation.
 *
 * Not an optimisation for its own sake: a tile offers many thousands of
 * candidate plant positions, and evaluating two octaves of noise at each one
 * directly runs into millions of trigonometric calls and seconds of frozen
 * page on load. 441 evaluations answer all of them, and the field changes
 * over metres so the interpolation loses nothing. Callers that only need a
 * few samples (the ground mesh's own vertices) can use `grassDensityAt`
 * directly instead. */
export function makeGrassDensitySampler(tileWorldX: number, tileWorldZ: number) {
  const step = (HEX_SIZE * 2) / PATCH_GRID
  const grid = new Float32Array((PATCH_GRID + 1) * (PATCH_GRID + 1))
  for (let j = 0; j <= PATCH_GRID; j++) {
    for (let i = 0; i <= PATCH_GRID; i++) {
      grid[j * (PATCH_GRID + 1) + i] = grassDensityAt(
        tileWorldX - HEX_SIZE + i * step,
        tileWorldZ - HEX_SIZE + j * step,
      )
    }
  }
  return (x: number, z: number): number => {
    const fx = Math.min(PATCH_GRID - 0.0001, Math.max(0, (x + HEX_SIZE) / step))
    const fz = Math.min(PATCH_GRID - 0.0001, Math.max(0, (z + HEX_SIZE) / step))
    const i = fx | 0
    const j = fz | 0
    const tx = fx - i
    const tz = fz - j
    const row = j * (PATCH_GRID + 1) + i
    const a = grid[row]
    const b = grid[row + 1]
    const c = grid[row + PATCH_GRID + 1]
    const d = grid[row + PATCH_GRID + 2]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
  }
}

/** What the soil is multiplied by where grass is at full density — darker,
 * and pushed toward green, which is what ground under a thick mat actually
 * looks like from above (shaded by the blades, and picking up their bounce
 * light). Green is held back least so the shading reads as vegetation rather
 * than as a grey shadow.
 *
 * Applied in every view, not only the two the request named. The reason it
 * was asked for is that the mats are hard to make out from a distant camera,
 * but the effect is not a trick: soil under thick grass IS darker, and a
 * ground that shaded differently depending on which camera was looking at it
 * would be a real inconsistency to maintain forever in exchange for nothing. */
export const GRASS_SHADE = { r: 0.46, g: 0.68, b: 0.36 }

/** How much of that shading to actually apply. Held under 1 so the mats read
 * as ground that happens to be shaded rather than as paint, but a first pass
 * at 0.55 with a milder GRASS_SHADE came back as "demasiado sutil" from a
 * table-height camera, which is exactly the distance this exists to serve. */
export const GRASS_SHADE_STRENGTH = 0.8

/** Terrain whose ground is carpeted, and how completely.
 *
 * Real user request: "tenemos que extender los parches de hierba a bosque y
 * bosque denso... los parches de bosque denso 100% cubiertos de hierba,
 * bosque normal como las casillas verde oscuro de llanura."
 *
 * `full` means the patch field is ignored and the ground is covered
 * everywhere — a dense forest floor has no bare stretches, it is undergrowth
 * wall to wall. Everything else takes the field's own mats and gaps.
 *
 * Living here rather than in the vegetation component because the ground
 * SHADING has to agree with it exactly: if the floor of a dense forest is
 * fully covered, its soil has to be fully shaded too, and a second copy of
 * this rule somewhere else would eventually disagree with this one. */
export const GRASS_COVER: Record<string, { full: boolean }> = {
  plains: { full: false },
  hills: { full: false },
  // "bosque normal como las casillas verde oscuro de llanura"
  light_forest: { full: false },
  // "bosque denso 100% cubierto"
  forest: { full: true },
}

export function isGrassTerrain(terrain: string): boolean {
  return terrain in GRASS_COVER
}

/** How covered this exact spot is, taking the terrain's own rule into
 * account. The single answer both the plants and the soil shading read. */
export function grassCoverAt(terrain: string, worldX: number, worldZ: number): number {
  const rule = GRASS_COVER[terrain]
  if (!rule) return 0
  return rule.full ? 1 : grassDensityAt(worldX, worldZ)
}

/** The same question, answered for the SOIL SHADING — same mats, softer
 * edges. See grassShadeDensityAt. */
export function grassShadeAt(terrain: string, worldX: number, worldZ: number): number {
  const rule = GRASS_COVER[terrain]
  if (!rule) return 0
  return rule.full ? 1 : grassShadeDensityAt(worldX, worldZ)
}

/** How likely a tree is at a given spot, 0 to 1.
 *
 * Real user request: "quiero los arboles en grupos como lo que hicimos con la
 * hierba." Scattering trees evenly over a forest hex gives an orchard —
 * regular spacing, no clearings, nothing to move through or hide behind. Real
 * woodland is stands and gaps.
 *
 * Same idea as the grass mats and, importantly, the same world-space
 * sampling, so a stand runs across a tile border into the next hex instead of
 * stopping at it. Its own wavelength is longer than the grass's: a grove is a
 * feature of the wood, not of the square metre.
 *
 * No floor, and a wavelength well under a hex. Real user correction: "no me
 * hace falta que haya arboles EN TODA LA HEX, lo que quiero es que los
 * patches de arboles esten JUNTOS." A floor puts a thin scatter of trees
 * everywhere, which is the opposite of a stand -- it spreads the same trees
 * so evenly that no clump ever forms. Dropping it to zero, tightening the
 * threshold and shortening the wavelength gives several real clumps per hex
 * with genuinely open ground between them, which is what a wood looks like
 * and also what a mech can move and hide in. */
// Wavelength around one hex: long enough that a high patch is a stand of
// several trees rather than a single tree standing alone (which is what a
// half-hex wavelength gave -- clumps too small to hold more than one crown),
// short enough that a hex holds more than one stand and its own clearings.
const GROVE_WAVELENGTH = HEX_SIZE * 1.05
const GROVE_DETAIL_WAVELENGTH = HEX_SIZE * 0.3
const GROVE_LO = 0.42
const GROVE_HI = 0.58
const GROVE_FLOOR = 0

export function treeGroveAt(worldX: number, worldZ: number): number {
  const broad = worldNoise01(worldX / GROVE_WAVELENGTH + 5.1, worldZ / GROVE_WAVELENGTH - 2.7, 2)
  const detail = worldNoise01(worldX / GROVE_DETAIL_WAVELENGTH - 9.4, worldZ / GROVE_DETAIL_WAVELENGTH + 3.3, 1)
  const n = broad * 0.78 + detail * 0.22
  return GROVE_FLOOR + (1 - GROVE_FLOOR) * smoothstep(GROVE_LO, GROVE_HI, n)
}
