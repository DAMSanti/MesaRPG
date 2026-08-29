import { useState } from 'react'
import type { Mech, MovementType, Unit } from '../api'
import { DropdownMenu } from './DropdownMenu'
import './UnitContextMenu.css'

/** The four limbs a mech can lose, in the order they read on a record
 * sheet. Labels rather than codes because this is a menu a person reads —
 * real user request: "un desplegable a la derecha que ponga brazo derecho
 * brazo izquierdo pierna derecha pierna izquierda." */
const DEBUG_LIMBS = [
  { location: 'RA', label: 'Brazo derecho' },
  { location: 'LA', label: 'Brazo izquierdo' },
  { location: 'RL', label: 'Pierna derecha' },
  { location: 'LL', label: 'Pierna izquierda' },
] as const

/** Opens at the mouse position when a unit is clicked on the GM's map.
 * Atacar is gated by `canAct` — see rounds.ts's activeAttackPilotIds for
 * what that means (initiative order, skipping anyone without a real
 * target); app/systems/battletech/turns.py itself stays advisory/non-
 * blocking, this is a stricter frontend UX layered on the same data,
 * not a backend behavior change.
 *
 * There's deliberately no unrestricted "Mover" here anymore — Caminar/
 * Correr/Saltar (showPhaseMovement below) are the only way to move a
 * unit from this menu now, so a move always goes through the real
 * range/cost check and always advances the movement phase; the old
 * free-form button let the GM (or a confused click) reposition a unit
 * with neither, which is exactly what silently stalled the phase for
 * that pilot until they happened to use Caminar/Correr instead. Dragging
 * the miniature is still unrestricted (main.py's /move endpoint records
 * it as this round's move regardless of how the position changed), just
 * this menu button specifically is gone. */
export function UnitContextMenu({
  unit, mech, canAct, x, y, onAttack, onClose,
  showAttack, onSkipAttack,
  showRollInitiative, canRollInitiative, onRollInitiative,
  showPhaseMovement, canPhaseMove, onPhaseMove, onRotate, onSkipMovement, onStandUp,
  onFallOver, forceJump, onForceJumpChange,
  onDebugPilotHit, onDebugSeverLimb,
}: {
  unit: Unit
  mech: Mech | null
  canAct: boolean
  x: number
  y: number
  onAttack: () => void
  onClose: () => void
  /** The round is actually in the ranged or melee phase right now — real
   * user request: an action that doesn't correspond to the current
   * phase should be gone from the menu, not just greyed out. `canAct`
   * still gates whether THIS pilot specifically may act within that
   * phase (initiative order / has a target — rounds.ts's
   * activeAttackPilotIds), shown as disabled+hint same as before. */
  showAttack?: boolean
  /** Counts this pilot as having acted this ranged/melee phase without
   * attacking anyone — same "record a skip" pattern as onSkipMovement
   * below (real user request: "en el menu de ataque a distancia haya
   * una opcion de pasar turno"), so a pilot with nothing worth shooting
   * at (or who just doesn't want to) can free up the phase for everyone
   * else instead of the GM being stuck waiting on them. */
  onSkipAttack?: () => void
  /** Individual initiative mode + this unit's pilot is an enemy (the GM
   * rolls for their own side; players roll their own from PlayerView) —
   * see GMView's needsInitiative/rollInitiativeForPilot. Also requires
   * the round to actually be in its initiative phase (same reasoning
   * as showAttack above). */
  showRollInitiative?: boolean
  canRollInitiative?: boolean
  onRollInitiative?: () => void
  /** This pilot is somewhere in this round's movement_order AND the
   * round is actually in its movement phase right now — see GMView's
   * roundState.movement_order (same phase-match reasoning as
   * showAttack above). */
  showPhaseMovement?: boolean
  /** It's specifically this pilot's turn to move right now — see
   * rounds.ts's activeMoverPilotId. */
  canPhaseMove?: boolean
  onPhaseMove?: (type: MovementType) => void
  /** Rotate in place — opens FacingPicker at this same menu's position,
   * no hex to pick, just a new facing (real user request). */
  onRotate?: () => void
  /** Counts this pilot as having moved this round without changing
   * position or facing at all — same "record a 0-hex move" backend path
   * as onRotate, just with no facing change either (real user request:
   * "saltar movimiento"). */
  onSkipMovement?: () => void
  /** The mech is prone (psr.py's stand_up — a PSR that spends this
   * pilot's movement action) — shown alongside Caminar/Correr/Saltar
   * since standing back up IS this round's movement action for a
   * fallen mech, not a separate one. */
  onStandUp?: () => void
  /** Debug-only (real user request: "una opcion de tirarse... en el menu
   * de movimiento") — sets is_prone directly (no PSR/fall damage), to
   * preview Caerse/Levantarse without waiting for a real failed PSR.
   * Undefined hides the button entirely (callers that don't wire debug
   * tooling never show it). */
  onFallOver?: () => void
  /** Debug-only (real user request: "activar temporalmente... el salto
   * siempre", then, after the FIRST version of this gated the phase-move
   * buttons behind the mech's own real jump_mp and broke for anyone
   * testing on a mech without jets: "no quiero que dependa de que tenga
   * nada, quiero darle, probarle y si funciona quitarlo y punto") — while
   * true, dragging THIS unit (the ordinary unrestricted GM reposition,
   * already ignoring MP/rules entirely) tags the resulting move as a
   * jump for animation purposes, completely independent of the mech's
   * own stats. Purely client-side (the caller owns the flag, keyed by
   * unit id); undefined hides the checkbox. */
  forceJump?: boolean
  onForceJumpChange?: (value: boolean) => void
  /** Debug-only (real user request: "quiero una forma de debuggear la
   * pérdida de extremidades y el splatter de sangre en la cabina... deberá
   * aparecer sección debug, daño piloto, pérdida extremidad").
   *
   * Both effects are normally reachable only by playing until the dice go
   * a particular way -- the cockpit only bleeds when a real attack gets
   * through to the pilot, and a limb only drops when a location's
   * structure is actually shot to zero -- which makes them close to
   * untestable while you are working on how they LOOK. These two put the
   * game in that state directly.
   *
   * Deliberately outside the phase-gated block above: this section is not
   * a move or an attack and has no turn to wait for. Undefined hides the
   * whole section, so callers with no debug tooling never show it. */
  onDebugPilotHit?: () => void
  /** Takes ONE limb off, by location. Real user request: individually
   * selectable rather than all four at once. */
  onDebugSeverLimb?: (location: string) => void
}) {
  const label = mech ? `${mech.chassis} ${mech.model ?? ''}`.trim() : `unidad #${unit.id}`
  const [limbsOpen, setLimbsOpen] = useState(false)

  return (
    <DropdownMenu x={x} y={y} title={label} onClose={onClose}>
      {showRollInitiative && (
        <button disabled={!canRollInitiative} onClick={onRollInitiative}>Tirar iniciativa</button>
      )}
      {showAttack && (
        <>
          {!canAct && <div className="unit-menu-hint">no es su turno</div>}
          <button disabled={!canAct} onClick={onAttack}>Atacar</button>
          <button disabled={!canAct} onClick={onSkipAttack}>Pasar turno</button>
        </>
      )}
      {showPhaseMovement && (
        <>
          {!canPhaseMove && <div className="unit-menu-hint">no es su turno de moverse</div>}
          {mech?.is_prone ? (
            <button disabled={!canPhaseMove} onClick={onStandUp}>Levantarse</button>
          ) : (
            <>
              <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('walk')}>Caminar</button>
              <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('run')}>Correr</button>
              <button disabled={!canPhaseMove || !mech?.jump_mp} onClick={() => onPhaseMove?.('jump')}>Saltar</button>
              <button disabled={!canPhaseMove} onClick={onRotate}>Cambiar dirección</button>
            </>
          )}
          <button disabled={!canPhaseMove} onClick={onSkipMovement}>Saltar movimiento</button>
          {onFallOver && !mech?.is_prone && (
            <button disabled={!canPhaseMove} onClick={onFallOver}>Tirarse (debug)</button>
          )}
          {onForceJumpChange && (
            <label className="unit-menu-debug-toggle">
              <input
                type="checkbox" checked={forceJump ?? false}
                onChange={(e) => onForceJumpChange(e.target.checked)}
              />
              {' '}Forzar salto al arrastrar (debug)
            </label>
          )}
        </>
      )}
      {(onDebugPilotHit || onDebugSeverLimb) && (
        <>
          <div className="unit-menu-section">debug</div>
          {onDebugPilotHit && (
            <button onClick={onDebugPilotHit}>Daño piloto</button>
          )}
          {onDebugSeverLimb && (
            <div className="unit-menu-flyout-host">
              <button
                className="unit-menu-flyout-trigger"
                aria-expanded={limbsOpen}
                onClick={() => setLimbsOpen((open) => !open)}
              >
                Perder extremidad
                <span aria-hidden>›</span>
              </button>
              {limbsOpen && (
                <div className="unit-menu-flyout">
                  {DEBUG_LIMBS.map(({ location, label: limbLabel }) => {
                    // What the chassis actually has, and what it has left.
                    // structure_max 0 means the location does not exist on
                    // this mech at all, which is not the same as having
                    // already been blown off — neither is something you can
                    // take off again.
                    const side = mech?.locations?.find((l) => l.location === location)
                    const missing = side == null
                      || side.structure_max <= 0
                      || side.structure_current <= 0
                    return (
                      <button
                        key={location}
                        disabled={missing}
                        onClick={() => onDebugSeverLimb(location)}
                      >
                        {limbLabel}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </DropdownMenu>
  )
}
