import { MECH_LOCATIONS, REAR_ARMOR_LOCATIONS, type Mech, type MechLocation, type MechLocationIn } from './api'

export type LocationsFormState = Record<string, { armor: string; rear: string; structure: string }>

export function emptyLocationsForm(): LocationsFormState {
  return Object.fromEntries(
    MECH_LOCATIONS.map((loc) => [loc, { armor: '', rear: '', structure: '' }]),
  )
}

// The transform from the on-screen (string, possibly blank) form state to
// the numeric payload the API expects — shared so the GM's form and the
// player's own "rellenar la ficha directamente" form can't drift apart.
export function buildMechLocationsPayload(state: LocationsFormState): MechLocationIn[] {
  return MECH_LOCATIONS.map((loc) => ({
    location: loc,
    armor_max: Number(state[loc].armor || 0),
    structure_max: Number(state[loc].structure || 0),
    ...(REAR_ARMOR_LOCATIONS.has(loc) && state[loc].rear
      ? { armor_rear_max: Number(state[loc].rear) }
      : {}),
  }))
}

// Converts an imported mech's locations (see api.ts's getMechImport)
// back into the on-screen form shape MechLocationsGrid edits — the
// inverse of buildMechLocationsPayload, used to pre-fill the form after
// picking a result from the mech-import search.
export function locationsFormFromMechLocationIn(locations: MechLocationIn[]): LocationsFormState {
  const form = emptyLocationsForm()
  for (const loc of locations) {
    form[loc.location] = {
      armor: String(loc.armor_max),
      rear: loc.armor_rear_max != null ? String(loc.armor_rear_max) : '',
      structure: String(loc.structure_max),
    }
  }
  return form
}

// A stand-in "full health" Mech, built straight from the on-screen form
// state — lets MechRecordSheet render a live paper-sheet preview while
// filling in a new ficha, before it's ever actually created server-side.
export function previewMechFromLocationsForm(
  chassis: string,
  model: string,
  locationsState: LocationsFormState,
  movement?: { tonnage: number; walk_mp: number; run_mp: number; jump_mp: number },
  loadout?: { weapons: { weapon_name: string; location: string }[]; heat_sinks: number; criticals: Record<string, string[]> },
): Pick<
  Mech,
  | 'chassis' | 'model' | 'tonnage' | 'walk_mp' | 'run_mp' | 'jump_mp' | 'locations' | 'weapons'
  | 'heat_sinks' | 'heat_current' | 'criticals'
> {
  const locations: MechLocation[] = MECH_LOCATIONS.map((loc) => {
    const armorMax = Number(locationsState[loc].armor || 0)
    const structureMax = Number(locationsState[loc].structure || 0)
    const hasRear = REAR_ARMOR_LOCATIONS.has(loc) && locationsState[loc].rear
    const armorRearMax = hasRear ? Number(locationsState[loc].rear) : null
    return {
      location: loc,
      armor_current: armorMax,
      armor_max: armorMax,
      armor_rear_current: armorRearMax,
      armor_rear_max: armorRearMax,
      structure_current: structureMax,
      structure_max: structureMax,
    }
  })
  return {
    chassis, model, locations,
    tonnage: movement?.tonnage ?? 0,
    walk_mp: movement?.walk_mp ?? 0,
    run_mp: movement?.run_mp ?? 0,
    jump_mp: movement?.jump_mp ?? 0,
    weapons: (loadout?.weapons ?? []).map((w, i) => ({ id: -(i + 1), ammo_remaining: null, ...w })),
    heat_sinks: loadout?.heat_sinks ?? 0,
    heat_current: 0,
    criticals: Object.fromEntries(
      Object.entries(loadout?.criticals ?? {}).map(([loc, items]) => [
        loc,
        items.map((item_name, i) => ({ slot_index: i, item_name, hit: false })),
      ]),
    ),
  }
}
