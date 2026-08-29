import * as THREE from 'three'

/** Limbs that have been blown off, and where they landed.
 *
 * Real user report: "el Jenner ha perdido la extremidad, pero esta no ha
 * colisionado con el suelo y se ha quedado ahi... tiene que quedarse ahi
 * permanentemente durante la partida."
 *
 * Hiding the mesh was only half of it. An arm that comes off has to fall,
 * and then it has to STAY on the ground for the rest of the match — the
 * mech walks on, the wreckage does not follow it. So this cannot live in
 * the unit's own component: a limb belongs to the PLACE it fell, not to the
 * mech it fell off.
 *
 * Module-level, like terrainRelief's own stamp store and for the same
 * reasons: every view of the same board sees the same wreckage without
 * passing it around, and it survives a component remounting — which the
 * views do on every session poll.
 *
 * NOT persisted to the server. A limb on the ground is scenery, and the
 * server already knows the fact that matters (the location's structure is
 * zero). A reload rebuilds them from that fact, at the mech's position
 * then rather than where they originally fell, and that is the right
 * trade: no schema, no migration, no writes during a fight. */

export interface DroppedLimb {
  key: string
  /** Where it fell, in the same space hexToWorld returns — the board's own
   * coordinates, not the offset ones the map group renders in. */
  x: number
  z: number
  /** Ground height at that point, filled in by whoever knows the terrain. */
  y: number
  /** The mech's facing when it lost the limb, so the piece starts out
   * oriented the way it was attached rather than snapping to north. */
  facing: number
  /** Shared straight from the model's own GLTF cache — these are the very
   * geometry and material the mech was drawing, so a severed arm looks
   * exactly like the arm that was there a moment ago. */
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Height it came off at, which is where the fall starts. */
  dropY: number
  /** performance.now() at the moment it was severed, so the fall plays
   * once and every later render finds it already at rest. */
  droppedAt: number
  /** Stable per limb: which way it tumbles and how it ends up lying. Kept
   * here rather than rolled at render time so a remount does not reshuffle
   * wreckage that is supposed to be lying still. */
  seed: number
}

const limbs = new Map<string, DroppedLimb>()
let version = 0

/** Bumped whenever the set changes, so a component can watch one number
 * instead of subscribing to a store. */
export function droppedLimbVersion(): number {
  return version
}

export function droppedLimbList(): DroppedLimb[] {
  return [...limbs.values()]
}

/** Records a limb where it came off. Ignores a limb already on the ground,
 * which is what makes this safe to call from a render-driven effect that
 * may run more than once for the same event. */
export function dropLimb(limb: Omit<DroppedLimb, 'droppedAt' | 'seed'>): void {
  if (limbs.has(limb.key)) return
  let hash = 0
  for (let i = 0; i < limb.key.length; i++) hash = (hash * 31 + limb.key.charCodeAt(i)) | 0
  limbs.set(limb.key, {
    ...limb,
    droppedAt: performance.now(),
    seed: Math.abs(hash),
  })
  version++
}

/** Clears everything — for switching to a different board, where another
 * map's wreckage would simply be wrong. */
export function clearDroppedLimbs(): void {
  if (limbs.size === 0) return
  limbs.clear()
  version++
}
