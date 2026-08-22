import { useState } from 'react'
import type { AttackIn, Mech, Pilot, RoundState, Unit, WeaponStats } from '../api'
import { attackSide, hexDistance, rangeBracket, type AttackSide, type RangeBracket } from '../hexMath'
import './AttackPanel.css'

// app/combat.py's ATTACKER_MOVEMENT_MOD keys, keyed here by the
// movement-phase's own 'walk'/'run'/'jump' type (api.ts's MovementType)
// so a real recorded move can pre-fill this dropdown automatically.
const MOVEMENT_TYPE_TO_ATTACKER_MOVEMENT: Record<string, string> = { walk: 'walked', run: 'ran', jump: 'jumped' }

/** Opened after the GM picks "Atacar" from a unit's context menu and then
 * clicks a target unit on the map. Attacker/target are already fixed by
 * those two clicks — this only asks for the remaining inputs the old
 * (now-removed) Ataque section used to ask for, with range/side
 * pre-suggested from the two units' real hex positions and facing
 * (hexMath.ts) rather than typed in blind, and attacker/target movement
 * pre-filled from this round's real recorded movement (roundState.moves
 * — see the movement phase) instead of the GM guessing them. Every
 * suggestion is still editable, not silently trusted — same "GM can
 * override" model attack() already had. */
export function AttackPanel({
  attacker, attackerMech, target, targetMech, pilots, weaponCatalog, roundState, onConfirm, onClose,
}: {
  attacker: Unit
  attackerMech: Mech | null
  target: Unit
  targetMech: Mech | null
  pilots: Pilot[]
  weaponCatalog: Record<string, WeaponStats>
  roundState: RoundState | null
  onConfirm: (body: AttackIn) => void
  onClose: () => void
}) {
  const attackerPilot = pilots.find((p) => p.id === attacker.pilot_id)
  const weapons = attackerMech?.weapons ?? []

  const attackerMove = roundState?.moves.find((m) => m.pilot_id === attacker.pilot_id)
  const targetMove = roundState?.moves.find((m) => m.pilot_id === target.pilot_id)

  const [weaponId, setWeaponId] = useState<number | ''>(weapons[0]?.id ?? '')
  const [gunnery, setGunnery] = useState(attackerPilot?.gunnery ?? 4)
  const [damage, setDamage] = useState(10)
  const [attackerMovement, setAttackerMovement] = useState(
    attackerMove ? MOVEMENT_TYPE_TO_ATTACKER_MOVEMENT[attackerMove.movement_type] : 'stationary',
  )
  const [targetHexesMoved, setTargetHexesMoved] = useState(targetMove?.hexes_moved ?? 0)

  const distance = hexDistance(attacker, target)
  const selectedWeapon = weapons.find((w) => w.id === weaponId)
  const suggestedRange = selectedWeapon ? rangeBracket(distance, weaponCatalog[selectedWeapon.weapon_name]) : null
  const [range, setRange] = useState<RangeBracket>(suggestedRange ?? 'short')
  const [side, setSide] = useState<AttackSide>(attackSide(attacker, target))

  const confirm = () => {
    if (target.mech_id == null) return
    onConfirm({
      target_mech_id: target.mech_id,
      gunnery,
      ...(weaponId !== '' ? { weapon_id: weaponId } : { damage }),
      attacker_movement: attackerMovement,
      target_hexes_moved: targetHexesMoved,
      range_bracket: range,
      side,
    })
  }

  return (
    <>
      <div className="attack-panel-backdrop" onClick={onClose} />
      <div className="attack-panel">
        <div className="attack-panel-title">
          {attackerMech?.chassis ?? `#${attacker.id}`} → {targetMech?.chassis ?? `#${target.id}`}
          <span className="attack-panel-distance">{distance} hex</span>
        </div>

        <div className="row">
          {weapons.length > 0 ? (
            <select value={weaponId} onChange={(e) => setWeaponId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">arma…</option>
              {weapons.map((w) => (
                <option key={w.id} value={w.id} disabled={w.ammo_remaining === 0}>
                  {w.weapon_name} — {weaponCatalog[w.weapon_name]?.heat ?? '?'} calor
                  {w.ammo_remaining != null ? ` — ${w.ammo_remaining} rondas` : ''}
                </option>
              ))}
            </select>
          ) : (
            <label>daño <input type="number" value={damage} onChange={(e) => setDamage(Number(e.target.value))} style={{ width: 56 }} /></label>
          )}
          <label>gunnery <input type="number" value={gunnery} onChange={(e) => setGunnery(Number(e.target.value))} style={{ width: 48 }} /></label>
        </div>

        <div className="row">
          <select value={attackerMovement} onChange={(e) => setAttackerMovement(e.target.value)}>
            <option value="stationary">quieto</option>
            <option value="walked">anduvo</option>
            <option value="ran">corrió</option>
            <option value="jumped">saltó</option>
          </select>
          <label>hex. objetivo <input type="number" value={targetHexesMoved} onChange={(e) => setTargetHexesMoved(Number(e.target.value))} style={{ width: 48 }} /></label>
        </div>

        <div className="row">
          <select value={range} onChange={(e) => setRange(e.target.value as RangeBracket)}>
            <option value="short">corto{suggestedRange === 'short' ? ' (sugerido)' : ''}</option>
            <option value="medium">medio{suggestedRange === 'medium' ? ' (sugerido)' : ''}</option>
            <option value="long">largo{suggestedRange === 'long' ? ' (sugerido)' : ''}</option>
          </select>
          <select value={side} onChange={(e) => setSide(e.target.value as AttackSide)}>
            <option value="front">frontal</option>
            <option value="left">izquierda</option>
            <option value="right">derecha</option>
            <option value="rear">trasera</option>
          </select>
        </div>
        {suggestedRange == null && selectedWeapon && (
          <div className="attack-panel-hint">fuera de alcance de este arma a {distance} hexes</div>
        )}

        <div className="row">
          <button onClick={confirm} disabled={target.mech_id == null}>Atacar</button>
          <button onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </>
  )
}
