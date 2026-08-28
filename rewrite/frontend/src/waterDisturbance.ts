/** Things currently standing in the water, for the surface to react to.
 *
 * Real user request: "el agua debe interactuar y colisionar con un mech
 * hundido." A mech wading in a river is not a mech drawn on top of a river —
 * it displaces the water, and the water shows it.
 *
 * A plain module-level registry rather than React props on purpose. These
 * positions change while a unit walks, and threading them down through the
 * tile tree as props would re-render every water tile on the board on every
 * frame of a walk animation. The water surface reads this in its own
 * per-frame loop instead, which touches nothing React knows about. Same
 * pattern (and the same reason) as terrainRelief.ts's footprint/crater
 * registry. */

export interface WaterDisturber {
  /** World position of whatever is in the water. */
  x: number
  z: number
  /** How hard it pushes the surface around, 0..1 — scales with how much of
   * the thing is actually in the water, so a mech wading a deep channel
   * throws more of a disturbance than one splashing through the shallows. */
  strength: number
}

let disturbers: readonly WaterDisturber[] = []

export function setWaterDisturbers(next: readonly WaterDisturber[]) {
  disturbers = next
}

export function getWaterDisturbers(): readonly WaterDisturber[] {
  return disturbers
}

/** How many disturbers one water tile can show at once.
 *
 * The shader loops over a fixed-size array (GLSL cannot size a loop from a
 * uniform), and each one costs work on every fragment of every water tile,
 * so this is a real budget rather than a limit for its own sake. Four is
 * more than enough: the surface only picks the nearest few to ITS OWN tile,
 * and a fifth mech close enough to matter to the same tile is not a
 * situation worth paying for on every other tile. */
export const MAX_WATER_DISTURBERS = 4

/** Beyond this many world units a disturber contributes nothing visible, so
 * a tile can ignore it entirely. Keeps a mech at the far end of a long river
 * from costing every tile in it. */
export const WATER_DISTURB_RANGE = 26
