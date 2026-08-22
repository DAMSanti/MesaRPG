import { useState } from 'react'
import type { Mech, Unit, WeaponStats } from '../api'
import './WeaponVolleyPanel.css'

/** Replaces the old "pick one weapon, confirm, repeat" AttackPanel flow
 * for the real ranged/melee-phase path — GMView's "Atacar" and
 * PlayerView's own "Objetivos a la vista" card list both open this
 * (FirstPersonView's cockpit HUD has its own equivalent, WeaponHud, in
 * the same visual language as the rest of that HUD instead of this
 * desktop-styled panel — same underlying per-weapon /attack loop
 * though). Attacker/target are already fixed by whatever picked them (a
 * map click, a card click), so this only asks which of the attacker's
 * own weapons to fire this turn — one toggle per mounted weapon, all
 * the ones left on fire together when "Fire!" is pressed.
 * Range/LOS/minimum-range/side/movement are no longer typed in here at
 * all — app/combat.py's resolve_attack computes every one of those
 * itself from the real attacker_unit_id/target_unit_id now, and rejects
 * (422) whichever weapon can't actually reach; a rejected weapon is
 * reported back per-toggle rather than blocking the rest of the volley
 * (see onFire's own caller). */
export function WeaponVolleyPanel({
  attackerMech, target, targetMech, weaponCatalog, onFire, onClose, firing,
}: {
  attackerMech: Mech
  target: Unit
  targetMech: Mech | null
  weaponCatalog: Record<string, WeaponStats>
  onFire: (weaponIds: number[]) => void
  onClose: () => void
  /** True while a previously-confirmed volley is still resolving
   * (sequential /attack calls) — disables Fire!/toggles so a second
   * click can't start an overlapping volley. */
  firing?: boolean
}) {
  const weapons = attackerMech.weapons
  const [selected, setSelected] = useState<Set<number>>(() => new Set(weapons.filter((w) => w.ammo_remaining !== 0).map((w) => w.id)))

  const toggle = (weaponId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(weaponId)) next.delete(weaponId)
      else next.add(weaponId)
      return next
    })
  }

  return (
    <>
      <div className="weapon-volley-backdrop" onClick={onClose} />
      <div className="weapon-volley-panel">
        <div className="weapon-volley-title">
          {attackerMech.chassis} → {targetMech?.chassis ?? `#${target.id}`}
        </div>

        {weapons.length === 0 ? (
          <div className="weapon-volley-empty">Este mech no lleva armas montadas.</div>
        ) : (
          <ul className="weapon-volley-list">
            {weapons.map((w) => {
              const stats = weaponCatalog[w.weapon_name]
              const outOfAmmo = w.ammo_remaining === 0
              const on = selected.has(w.id) && !outOfAmmo
              return (
                <li key={w.id} className={`weapon-volley-row${outOfAmmo ? ' out-of-ammo' : ''}`}>
                  <span className="weapon-volley-name">{w.weapon_name}</span>
                  <span className="weapon-volley-stats">
                    {stats ? `${stats.heat} calor · ${stats.short}/${stats.medium}/${stats.long}` : '—'}
                    {w.ammo_remaining != null && ` · ${w.ammo_remaining} rondas`}
                  </span>
                  <button
                    type="button"
                    className={`weapon-toggle${on ? ' on' : ''}`}
                    role="switch"
                    aria-checked={on}
                    disabled={outOfAmmo || firing}
                    onClick={() => toggle(w.id)}
                  >
                    <span className="weapon-toggle-thumb" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="weapon-volley-actions">
          <button
            className="weapon-volley-fire"
            disabled={selected.size === 0 || firing}
            onClick={() => onFire([...selected])}
          >
            {firing ? 'Disparando…' : 'Fire!'}
          </button>
          <button onClick={onClose} disabled={firing}>Cancelar</button>
        </div>
      </div>
    </>
  )
}
