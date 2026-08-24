import type { Mech, MovementType, Unit } from '../api'
import { DropdownMenu } from './DropdownMenu'
import './UnitContextMenu.css'

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
  showAttack,
  showRollInitiative, canRollInitiative, onRollInitiative,
  showPhaseMovement, canPhaseMove, onPhaseMove, onRotate, onSkipMovement,
  acted, onMarkActed,
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
  /** Whether this pilot has already ended their activation this round —
   * shown regardless of phase, unlike the movement/attack actions above
   * (marking acted is a GM utility, not tied to one specific phase). */
  acted?: boolean
  onMarkActed?: () => void
}) {
  const label = mech ? `${mech.chassis} ${mech.model ?? ''}`.trim() : `unidad #${unit.id}`

  return (
    <DropdownMenu x={x} y={y} title={label} onClose={onClose}>
      {showRollInitiative && (
        <button disabled={!canRollInitiative} onClick={onRollInitiative}>Tirar iniciativa</button>
      )}
      {showAttack && (
        <>
          {!canAct && <div className="unit-menu-hint">no es su turno</div>}
          <button disabled={!canAct} onClick={onAttack}>Atacar</button>
        </>
      )}
      {showPhaseMovement && (
        <>
          {!canPhaseMove && <div className="unit-menu-hint">no es su turno de moverse</div>}
          <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('walk')}>Caminar</button>
          <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('run')}>Correr</button>
          <button disabled={!canPhaseMove || !mech?.jump_mp} onClick={() => onPhaseMove?.('jump')}>Saltar</button>
          <button disabled={!canPhaseMove} onClick={onRotate}>Cambiar dirección</button>
          <button disabled={!canPhaseMove} onClick={onSkipMovement}>Saltar movimiento</button>
        </>
      )}
      <button disabled={acted} onClick={onMarkActed}>{acted ? '✓ Ya actuó' : 'Marcar activación'}</button>
    </DropdownMenu>
  )
}
