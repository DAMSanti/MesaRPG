import { useState } from 'react'
import type { Mech, MeleeAttackType, RoundState, Unit } from '../api'
import './WeaponVolleyPanel.css'
import './MeleeAttackPanel.css'

/** Melee phase's equivalent of WeaponVolleyPanel — same fixed
 * attacker/target (set by the same onUnitClick target pick), but melee
 * only ever resolves ONE physical attack per turn (no volley), so this
 * asks which type instead of which weapons. Carga/DFA are disabled
 * client-side unless the attacker's OWN movement already recorded this
 * round matches what combat.py's melee.py will require server-side
 * (walk/run with hexes_moved>0 for Carga, jump for DFA) — purely a UX
 * courtesy so the GM never gets a 422 for an attack the panel itself
 * offered. */
export function MeleeAttackPanel({
  attackerMech, attacker, target, targetMech, roundState, firing, onAttack, onClose,
}: {
  attackerMech: Mech
  attacker: Unit
  target: Unit
  targetMech: Mech | null
  roundState: RoundState | null
  onAttack: (attackType: MeleeAttackType, arm?: 'left' | 'right') => void
  onClose: () => void
  /** True while a previously-confirmed attack is still resolving. */
  firing?: boolean
}) {
  const [selectedType, setSelectedType] = useState<MeleeAttackType>('punch')
  const [arm, setArm] = useState<'left' | 'right'>('right')

  const move = roundState?.moves.find((m) => m.unit_id === attacker.id)
  const canCharge = move != null && (move.movement_type === 'walk' || move.movement_type === 'run') && move.hexes_moved > 0
  const canDfa = move != null && move.movement_type === 'jump'

  const options: { type: MeleeAttackType; label: string; enabled: boolean; hint?: string }[] = [
    { type: 'punch', label: 'Puñetazo', enabled: true },
    { type: 'kick', label: 'Patada', enabled: true },
    {
      type: 'charge', label: 'Carga', enabled: canCharge,
      hint: canCharge ? undefined : 'Requiere haber andado/corrido hasta el contacto esta ronda',
    },
    {
      type: 'dfa', label: 'DFA (salto)', enabled: canDfa,
      hint: canDfa ? undefined : 'Requiere haber saltado hasta el contacto esta ronda',
    },
  ]
  const selectedEnabled = options.find((o) => o.type === selectedType)?.enabled ?? false

  return (
    <>
      <div className="weapon-volley-backdrop" onClick={onClose} />
      <div className="weapon-volley-panel">
        <div className="weapon-volley-title">
          {attackerMech.chassis} → {targetMech?.chassis ?? `#${target.id}`}
        </div>

        <ul className="weapon-volley-list">
          {options.map((opt) => (
            <li key={opt.type} className="melee-type-row">
              <button
                type="button"
                className={`melee-type-option${selectedType === opt.type ? ' selected' : ''}`}
                disabled={!opt.enabled || firing}
                title={opt.hint}
                onClick={() => setSelectedType(opt.type)}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>

        {selectedType === 'punch' && (
          <div className="melee-arm-picker">
            <button
              type="button"
              className={`melee-arm-option${arm === 'left' ? ' selected' : ''}`}
              disabled={firing}
              onClick={() => setArm('left')}
            >
              Brazo izq.
            </button>
            <button
              type="button"
              className={`melee-arm-option${arm === 'right' ? ' selected' : ''}`}
              disabled={firing}
              onClick={() => setArm('right')}
            >
              Brazo dcho.
            </button>
          </div>
        )}

        <div className="weapon-volley-actions">
          <button
            className="weapon-volley-fire"
            disabled={!selectedEnabled || firing}
            onClick={() => onAttack(selectedType, selectedType === 'punch' ? arm : undefined)}
          >
            {firing ? 'Atacando…' : '¡Atacar!'}
          </button>
          <button onClick={onClose} disabled={firing}>Cancelar</button>
        </div>
      </div>
    </>
  )
}
