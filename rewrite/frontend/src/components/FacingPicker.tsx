import { useEffect } from 'react'
import './FacingPicker.css'

// The 6 natural hex-grid facings (60° apart), not a free dial — matches
// BattleTech's own 6-sided facing convention and units.py's
// _within_facing_arc/HexMap's rotation math (0° = world +X). Under the
// map's fixed top-down camera, increasing facing_deg reads as clockwise
// on screen, so each button's screen offset is a plain (cos, sin) of
// its own degree value.
const DIRECTIONS = [0, 60, 120, 180, 240, 300]
const RADIUS = 34

/** Opens where a unit was just dropped — dragging on the map, or
 * dragging a mech in from the sidebar, no longer silently keeps
 * whatever facing the unit already had (or defaults a brand-new one to
 * 0°); the GM picks one of the 6 hex facings here instead. Dismissing
 * (Escape/click outside) still completes the move, just without
 * changing facing — picking a direction is optional polish, not a
 * blocking step.
 *
 * allowedFacings (movement-phase moves only — see ReachableHex.facings)
 * disables whichever of the 6 directions the remaining MP budget
 * couldn't actually afford at this specific hex, instead of only
 * discovering that when execute_move 422s after the pick. Free-form
 * moves (drag/place, no MP budget to check against) omit it — every
 * direction is always free there, same as before this existed. */
export function FacingPicker({
  x, y, onPick, onDismiss, allowedFacings,
}: {
  x: number
  y: number
  onPick: (facingDeg: number) => void
  onDismiss: () => void
  allowedFacings?: number[]
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <>
      <div className="facing-picker-backdrop" onClick={onDismiss} />
      <div className="facing-picker" style={{ left: x, top: y }}>
        <div className="facing-picker-hub" />
        {DIRECTIONS.map((deg) => {
          const rad = (deg * Math.PI) / 180
          const dx = Math.cos(rad) * RADIUS
          const dy = Math.sin(rad) * RADIUS
          const allowed = allowedFacings == null || allowedFacings.includes(deg)
          return (
            <button
              key={deg}
              type="button"
              className="facing-picker-dir"
              disabled={!allowed}
              style={{ transform: `translate(${dx}px, ${dy}px) rotate(${deg + 90}deg)` }}
              onClick={() => onPick(deg)}
              title={allowed ? `${deg}°` : `${deg}° — no queda MP suficiente para girar hasta ahí`}
            >
              ▲
            </button>
          )
        })}
      </div>
    </>
  )
}
