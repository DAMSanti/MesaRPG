import { useRef, useState } from 'react'
import { Die } from './Die'

// Extracted from TableView.tsx's own InitiativeDice (Fase B — real user
// request: every roll, not just initiative, should be a real physical
// throw for a pilot with dice_mode='physical') — generalized to 1 or 2
// dice instead of always 2, everything else byte-identical: same throw
// physics/timings/lane spacing, so initiative (still wired through its
// own dedicated request/report pair, deliberately untouched — see
// TableView.tsx's own InitiativeDice, now a thin dieCount=2 wrapper
// around this) looks and feels exactly as it did before this existed.

// Just off the board's edge (the board itself is centered on world
// origin — see hexMath's mapCenter/hexToWorld) — close enough that a
// modest toss speed still comfortably reaches and settles within a
// typical map instead of sailing across and off the far side. Exported
// so TableView's own BoardWalls (clearLeftOf) can clear space around the
// same spot without a second, possibly-drifting copy of this number.
export const THROW_ORIGIN_X = -5
// How long the dice sit still showing their result before vanishing.
const DICE_VISIBLE_MS = 5000
// Concurrent throws (everyone rolling at once) land in their own lateral
// lane instead of overlapping — a fixed, deterministic offset per lane
// index.
const LANE_SPACING = 2.2

export function PhysicalDiceThrow({
  rollId, dieCount, color, dieStyle, lane, onSettled, onDone,
}: {
  rollId: number | string
  /** How many dice this one throw needs — 2 for a 2d6 roll (to-hit,
   * hit-location, initiative...), 1 for a 1d6 roll (a critical-slot
   * placement roll). */
  dieCount: 1 | 2
  color: string
  /** The rolling pilot's own die-style pick (../dieStyles.ts), if any. */
  dieStyle: string | null
  /** Which concurrent throw this is (0, 1, 2…) — purely for spatial
   * separation on the board, not gameplay. */
  lane: number
  /** Fires once every die in this throw has settled — `dice` is each
   * one's own face, in throw order (length 1 or 2, matching dieCount). */
  onSettled: (total: number, dice: number[]) => void
  /** Fires once every die has fully vanished — the caller's cue to stop
   * rendering this <PhysicalDiceThrow> at all. */
  onDone: () => void
}) {
  const seed = typeof rollId === 'number' ? rollId : 0
  // One ref per mounted throw (a fresh instance per roll — see the call
  // site's own `key`) so each die can report in independently and the
  // total only fires once all of them are in.
  const valuesRef = useRef<(number | null)[]>(dieCount === 2 ? [null, null] : [null])
  const reportedRef = useRef(false)
  const [vanishing, setVanishing] = useState(false)
  const settle = (index: number) => (value: number) => {
    valuesRef.current[index] = value
    if (valuesRef.current.every((v) => v != null) && !reportedRef.current) {
      reportedRef.current = true
      const dice = valuesRef.current as number[]
      onSettled(dice.reduce((a, b) => a + b, 0), dice)
      setTimeout(() => {
        setVanishing(true)
      }, DICE_VISIBLE_MS)
    }
  }

  // Thrown in from just off the board's edge, low and at a real-toss
  // (not runaway) speed — small per-roll jitter (on top of the lane
  // offset) so two dice from the SAME throw don't land in the exact
  // same spot either.
  const laneZ = (lane - 1) * LANE_SPACING
  const jitterZ = ((seed % 5) - 2) * 0.5
  const speed = 3 + (seed % 3) * 0.4
  return (
    <>
      <Die
        rollId={seed} color={color} style={dieStyle}
        spawn={[THROW_ORIGIN_X, 1.1, laneZ + jitterZ - 0.4]}
        throwVelocity={[speed, 1.4, (seed % 3) * 0.4 - 0.4]}
        onSettled={settle(0)}
        vanishing={vanishing}
        onVanished={dieCount === 1 ? onDone : undefined}
      />
      {dieCount === 2 && (
        <Die
          rollId={seed} color={color} style={dieStyle}
          spawn={[THROW_ORIGIN_X, 1.3, laneZ + jitterZ + 0.4]}
          throwVelocity={[speed - 0.4, 1.7, (seed % 3) * 0.4 - 0.6]}
          onSettled={settle(1)}
          vanishing={vanishing}
          onVanished={onDone}
        />
      )}
    </>
  )
}
