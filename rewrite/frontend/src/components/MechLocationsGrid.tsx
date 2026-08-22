import { MECH_LOCATIONS, REAR_ARMOR_LOCATIONS } from '../api'
import type { LocationsFormState } from '../characterSheet'

interface Props {
  locations: LocationsFormState
  onChange: (locations: LocationsFormState) => void
}

/** Armor/rear-armor/structure per location — same 8-row grid used by the
 * GM's mech form and the player's own direct-fill sheet, extracted so
 * they can never quietly diverge (ROADMAP.md Fase R3). */
export function MechLocationsGrid({ locations, onChange }: Props) {
  const setField = (loc: string, field: 'armor' | 'rear' | 'structure', value: string) =>
    onChange({ ...locations, [loc]: { ...locations[loc], [field]: value } })

  return (
    <div className="loc-grid">
      {MECH_LOCATIONS.map((loc) => (
        <div key={loc} className="loc-row">
          <span className="loc-label">{loc}</span>
          <input
            placeholder="armadura"
            value={locations[loc].armor}
            onChange={(e) => setField(loc, 'armor', e.target.value)}
          />
          {REAR_ARMOR_LOCATIONS.has(loc) && (
            <input
              placeholder="arm. trasera"
              value={locations[loc].rear}
              onChange={(e) => setField(loc, 'rear', e.target.value)}
            />
          )}
          <input
            placeholder="estructura"
            value={locations[loc].structure}
            onChange={(e) => setField(loc, 'structure', e.target.value)}
          />
        </div>
      ))}
    </div>
  )
}
