/** Limbs that have been blown off, and where they landed.
 *
 * Real user report: "el Jenner ha perdido la extremidad, pero esta no ha
 * colisionado con el suelo y se ha quedado ahi... tiene que quedarse ahi
 * permanentemente durante la partida", and then: "las piezas se tienen que
 * guardar en el servidor y quedarse donde caen toda la partida."
 *
 * A limb belongs to the PLACE it fell, not to the mech it fell off — the
 * mech walks on, the arm stays — so it cannot live in the unit's own
 * component. Module-level, like terrainRelief's own stamp store and for the
 * same reasons: every view of the same board sees the same wreckage without
 * passing it around, and it survives a component remounting, which the
 * views do on every session poll.
 *
 * What is stored is deliberately NOT the geometry: a record holds the model
 * it came from and which limb it was, and the piece resolves its own mesh
 * out of the GLTF cache when it draws. That is what makes a limb something
 * the server can hold — the same handful of numbers describe one that just
 * fell and one that fell in a session last week — and it means a live drop
 * and a restored one take exactly the same path through the code.
 */

export interface DroppedLimb {
  /** `${unitId}:${location}` — one limb can only come off once. */
  key: string
  /** Where it fell, in the same space hexToWorld returns: the board's own
   * coordinates, not the offset ones the map group renders in. Real
   * positions rather than hex centres, because a limb falls where it
   * falls. */
  x: number
  z: number
  /** Height it came off at, which is where the fall starts. */
  dropY: number
  /** The mech's facing when it lost the limb, so the piece starts out
   * oriented the way it was attached rather than snapping to north. */
  facing: number
  /** The .glb it belongs to, and which mesh inside it — enough to find the
   * geometry again without storing it. */
  modelUrl: string
  location: string
  /** performance.now() when it was severed, so the fall plays once and
   * every later render finds it already at rest. */
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

function seedOf(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return Math.abs(hash)
}

type LimbInput = Omit<DroppedLimb, 'droppedAt' | 'seed'>

/** Records a limb where it just came off, and reports whether it was new.
 *
 * Ignoring one that is already down is what makes this safe to call from a
 * render-driven effect that may run more than once for the same event —
 * and the return value is how the caller knows whether to tell the server.
 */
export function dropLimb(limb: LimbInput): boolean {
  if (limbs.has(limb.key)) return false
  limbs.set(limb.key, { ...limb, droppedAt: performance.now(), seed: seedOf(limb.key) })
  version++
  return true
}

/** Puts back a limb the server already knew about.
 *
 * `droppedAt` is pushed far enough into the past that its fall is already
 * over. This one landed in an earlier session, or on somebody else's
 * screen; replaying the arc on load would rain arms every time anyone
 * opened the map. */
export function adoptSavedLimb(limb: LimbInput): boolean {
  if (limbs.has(limb.key)) return false
  limbs.set(limb.key, {
    ...limb,
    droppedAt: performance.now() - 60_000,
    seed: seedOf(limb.key),
  })
  version++
  return true
}

/** Clears everything — on switching to a different board, where another
 * map's wreckage would simply be wrong. */
export function clearDroppedLimbs(): void {
  if (limbs.size === 0) return
  limbs.clear()
  version++
}
