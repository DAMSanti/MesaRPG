import { useState } from 'react'
import { MECH_LOCATIONS, type Mech, type WeaponStats } from '../api'

interface Props {
  mech: Mech
  weaponCatalog: Record<string, WeaponStats>
  onAdd: (weaponName: string, location: string) => void | Promise<void>
  onRemove: (weaponId: number) => void | Promise<void>
}

/** Mount/remove weapons on an already-created mech — shared between the
 * GM's loadout step and the player's own direct-fill sheet
 * (ROADMAP.md Fase R3). */
export function WeaponLoadoutEditor({ mech, weaponCatalog, onAdd, onRemove }: Props) {
  const [weaponName, setWeaponName] = useState('')
  const [location, setLocation] = useState<string>(MECH_LOCATIONS[0])

  const submit = async () => {
    if (!weaponName) return
    await onAdd(weaponName, location)
    setWeaponName('')
  }

  return (
    <div>
      <div className="row">
        <select value={weaponName} onChange={(e) => setWeaponName(e.target.value)}>
          <option value="">arma…</option>
          {Object.entries(weaponCatalog).map(([name, stats]) => (
            <option key={name} value={name}>{name} ({stats.damage} dmg, {stats.short}/{stats.medium}/{stats.long})</option>
          ))}
        </select>
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          {MECH_LOCATIONS.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
        </select>
        <button type="button" onClick={submit} disabled={!weaponName}>Montar arma</button>
      </div>
      <ul className="chips">
        {mech.weapons.map((w) => (
          <li key={w.id}>
            {w.weapon_name} ({w.location}){w.ammo_remaining != null && ` — munición: ${w.ammo_remaining}`}
            <button type="button" onClick={() => onRemove(w.id)}>Quitar</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
