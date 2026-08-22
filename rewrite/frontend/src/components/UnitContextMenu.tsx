import type { Mech, MovementType, Unit } from '../api'
import { DropdownMenu } from './DropdownMenu'
import './UnitContextMenu.css'

/** Opens at the mouse position when a unit is clicked on the GM's map.
 * Atacar is gated by `canAct` — see rounds.ts's activeTurnPilotIds for
 * what that means; app/systems/battletech/turns.py itself stays
 * advisory/non-blocking, this is a stricter frontend UX layered on the
 * same data, not a backend behavior change.
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
  showRollInitiative, canRollInitiative, onRollInitiative,
  showPhaseMovement, canPhaseMove, onPhaseMove,
}: {
  unit: Unit
  mech: Mech | null
  canAct: boolean
  x: number
  y: number
  onAttack: () => void
  onClose: () => void
  /** Individual initiative mode + this unit's pilot is an enemy (the GM
   * rolls for their own side; players roll their own from PlayerView) —
   * see GMView's needsInitiative/rollInitiativeForPilot. */
  showRollInitiative?: boolean
  canRollInitiative?: boolean
  onRollInitiative?: () => void
  /** This pilot is somewhere in this round's movement_order at all —
   * see GMView's roundState.movement_order. */
  showPhaseMovement?: boolean
  /** It's specifically this pilot's turn to move right now — see
   * rounds.ts's activeMoverPilotId. */
  canPhaseMove?: boolean
  onPhaseMove?: (type: MovementType) => void
}) {
  const label = mech ? `${mech.chassis} ${mech.model ?? ''}`.trim() : `unidad #${unit.id}`

  return (
    <DropdownMenu x={x} y={y} title={label} onClose={onClose}>
      {showRollInitiative && (
        <button disabled={!canRollInitiative} onClick={onRollInitiative}>Tirar iniciativa</button>
      )}
      {!canAct && <div className="unit-menu-hint">no es su turno</div>}
      <button disabled={!canAct} onClick={onAttack}>Atacar</button>
      {showPhaseMovement && (
        <>
          {!canPhaseMove && <div className="unit-menu-hint">no es su turno de moverse</div>}
          <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('walk')}>Caminar</button>
          <button disabled={!canPhaseMove} onClick={() => onPhaseMove?.('run')}>Correr</button>
          <button disabled={!canPhaseMove || !mech?.jump_mp} onClick={() => onPhaseMove?.('jump')}>Saltar</button>
        </>
      )}
    </DropdownMenu>
  )
}
