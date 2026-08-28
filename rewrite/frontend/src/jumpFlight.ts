import { MODEL_SCALE } from './components/Mech3D'
import { HEX_SIZE } from './hexMath'

/** Real user request: real Saltar animation (Despegar→Saltar→Aterrizar)
 * wired into actual gameplay, with the miniature genuinely rising and
 * falling — not just sliding along the ground like a walk. Pure math, no
 * React/Three dependency, so both HexMap.tsx's UnitMarker (the board) and
 * FirstPersonView.tsx's WalkingFirstPersonCam (the cockpit camera) can
 * call the exact same function instead of re-diverging into two more
 * copies of the same arc — see this module's own git history/PR for why
 * that duplication already exists for the plain walk-stepping logic and
 * wasn't worth unwinding here too.
 *
 * The backend's own jump resolution (movement.py's reachable_hexes, jump
 * branch) never computes a real route — a jump's own `path` is just the
 * landing hex, no intermediate terrain/height data at all (RAW: a jumping
 * 'Mech arcs over whatever's in between, terrain-blind). So there is
 * nothing to avoid mid-arc — this is a purely cosmetic origin→peak→
 * destination parabola, not a real physics/collision simulation. */

export type JumpPhase = 'takeoff' | 'flight' | 'landing' | 'done'

export interface JumpFlightResult {
  phase: JumpPhase
  position: [number, number, number]
  /** 0..1 within the CURRENT phase. */
  progress: number
}

// Short enough that Despegar/Aterrizar (real, short anticipation/landing
// clips) fit inside them without looking rushed or dragging; long enough
// to actually read as distinct beats rather than an instant snap.
const TAKEOFF_DURATION = 0.35
const LANDING_DURATION = 0.35
// A one-hex jump still needs to look like a real leap, not a blink;
// distance is in WORLD units (not hex count — this module doesn't know
// about hex spacing, callers already convert to world-space before
// calling), scaled up from there.
const MIN_FLIGHT_DURATION = 0.5
// Inversely scaled by HEX_SIZE (not multiplied, like the spatial
// constants elsewhere) — this is seconds of flight PER world-unit of
// horizontal distance, and a hex-to-hex jump now covers HEX_SIZE times
// more world units for the exact same real-world jump, so the per-unit
// rate has to shrink by that same factor to keep the actual jump
// duration unchanged.
const FLIGHT_DURATION_PER_WORLD_UNIT = 0.22 / HEX_SIZE
// Peak arc height above a straight line between origin and destination,
// in world units — scaled by MODEL_SCALE so it stays proportionate if
// that ever changes.
const PEAK_HEIGHT = MODEL_SCALE * 0.4

export function jumpFlightDuration(origin: [number, number, number], destination: [number, number, number]): number {
  const dx = destination[0] - origin[0]
  const dz = destination[2] - origin[2]
  const horizontalDistance = Math.hypot(dx, dz)
  const flight = Math.max(MIN_FLIGHT_DURATION, horizontalDistance * FLIGHT_DURATION_PER_WORLD_UNIT)
  return TAKEOFF_DURATION + flight + LANDING_DURATION
}

export function jumpFlight(
  origin: [number, number, number],
  destination: [number, number, number],
  elapsed: number,
): JumpFlightResult {
  const dx = destination[0] - origin[0]
  const dz = destination[2] - origin[2]
  const horizontalDistance = Math.hypot(dx, dz)
  const flightDuration = Math.max(MIN_FLIGHT_DURATION, horizontalDistance * FLIGHT_DURATION_PER_WORLD_UNIT)

  if (elapsed < TAKEOFF_DURATION) {
    return { phase: 'takeoff', position: origin, progress: elapsed / TAKEOFF_DURATION }
  }

  const flightElapsed = elapsed - TAKEOFF_DURATION
  if (flightElapsed < flightDuration) {
    const t = flightElapsed / flightDuration
    const arc = PEAK_HEIGHT * 4 * t * (1 - t)
    return {
      phase: 'flight',
      position: [
        origin[0] + dx * t,
        origin[1] + (destination[1] - origin[1]) * t + arc,
        origin[2] + dz * t,
      ],
      progress: t,
    }
  }

  const landingElapsed = flightElapsed - flightDuration
  if (landingElapsed < LANDING_DURATION) {
    return { phase: 'landing', position: destination, progress: landingElapsed / LANDING_DURATION }
  }

  return { phase: 'done', position: destination, progress: 1 }
}
