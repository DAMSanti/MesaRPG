import type { Faction } from './factions'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8124'

export type InitiativeMode = 'team' | 'individual'

export interface Campaign {
  id: number
  name: string
  created_at: string
  active_map_id: number | null
  system: string
  grid_type: 'hex' | 'square'
  initiative_mode: InitiativeMode
  pilot_count: number
  mech_count: number
}

export interface GameSystem {
  name: string
  grid_type: 'hex' | 'square'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`)
  return res.json()
}

// Character sheet approval (ROADMAP.md Fase R3) — a pending/rejected
// sheet can only be edited/reviewed by the device that submitted it,
// proven with this header (see src/deviceToken.ts). Approved sheets stay
// open to anyone, same as before this existed.
const tokenHeaders = (token?: string): HeadersInit | undefined =>
  token ? { 'X-Device-Token': token } : undefined

export const listSystems = () => request<Record<string, GameSystem>>('/api/systems')

export const listCampaigns = () => request<Campaign[]>('/api/campaigns')

export const createCampaign = (name: string, system: string = 'battletech') =>
  request<Campaign>('/api/campaigns', { method: 'POST', body: JSON.stringify({ name, system }) })

export interface TableSession {
  active_campaign_id: number | null
}

export const getTableSession = () => request<TableSession>('/api/table-session')

export const activateTableSession = (campaignId: number) =>
  request<TableSession>('/api/table-session/activate', {
    method: 'POST',
    body: JSON.stringify({ campaign_id: campaignId }),
  })

export const deactivateTableSession = () =>
  request<TableSession>('/api/table-session/deactivate', { method: 'POST' })

export interface HexTileData {
  q: number
  r: number
  elevation: number
  blocks_los: boolean
  /** Woods/jungle LoS-accumulation weight (app/hexgrid.py's has_los) —
   * 0 for every terrain except forest (2, heavy) and light_forest (1) —
   * see app/mapgen.py's TERRAIN_DEFAULTS for the full rationale. */
  los_points: number
  terrain: string
}

export interface MapData {
  id: number
  campaign_id: number
  name: string
  width: number
  height: number
  grid_type: 'hex' | 'square'
  tiles: HexTileData[]
}

export interface Unit {
  id: number
  campaign_id: number
  map_id: number
  mech_id: number | null
  pilot_id: number | null
  pilot_faction: Faction | null
  q: number
  r: number
  facing_deg: number
  is_ghost: boolean
  revealed: boolean
  /** This unit's mech chassis/model, joined server-side — null when
   * mech_id is null. Used to pick a curated 3D asset (mechAssets.ts) for
   * this specific mech instead of the generic placeholder. */
  mech_chassis: string | null
  mech_model: string | null
  /** D&D 5e equivalent of mech_id/pilot_id above (ROADMAP.md Fase R4) —
   * a unit has exactly one of mech_id or dnd_character_id set, never
   * both, depending on the owning campaign's system. dnd_name/_ac/
   * _hp_current/_hp_max are joined server-side, same pattern as
   * mech_chassis/mech_model. */
  dnd_character_id: number | null
  dnd_name: string | null
  dnd_ac: number | null
  dnd_hp_current: number | null
  dnd_hp_max: number | null
}

export interface Visibility {
  visible: Record<string, number[]>
  newly_revealed: number[]
}

export const listMaps = (campaignId: number) =>
  request<MapData[]>(`/api/campaigns/${campaignId}/maps`)

export const createMap = (campaignId: number, name: string, width: number, height: number) =>
  request<MapData>(`/api/campaigns/${campaignId}/maps`, {
    method: 'POST',
    body: JSON.stringify({ name, width, height }),
  })

export const getMap = (mapId: number) => request<MapData>(`/api/maps/${mapId}`)

export interface TerrainInfo {
  elevation: number
  blocks_los: boolean
}

export const getTerrainTypes = () => request<Record<string, TerrainInfo>>('/api/terrain-types')

export const BIOMES = [
  'grasslands', 'forest', 'river', 'city', 'ruins', 'desert', 'mountains',
  'swamp', 'lake', 'arctic', 'volcanic',
] as const
export type Biome = (typeof BIOMES)[number]

export const generateMap = (campaignId: number, name: string, width: number, height: number, biome: Biome) =>
  request<MapData>(`/api/campaigns/${campaignId}/maps/generate`, {
    method: 'POST',
    body: JSON.stringify({ name, width, height, biome }),
  })

export const getUnits = (mapId: number) => request<Unit[]>(`/api/maps/${mapId}/units`)

export const moveUnit = (unitId: number, q: number, r: number, facingDeg?: number) =>
  request<Unit>(`/api/units/${unitId}/move`, {
    method: 'POST',
    body: JSON.stringify({ q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}) }),
  })

export const getVisibility = (mapId: number) =>
  request<Visibility>(`/api/maps/${mapId}/visibility`)

export interface VisibleHex {
  q: number
  r: number
}

// Raw LoS debug view for one unit (ignores pilot ownership, unlike
// getVisibility) — see app/units.py's visible_hexes_from_unit.
export const getUnitVisibleHexes = (unitId: number) =>
  request<VisibleHex[]>(`/api/units/${unitId}/visible-hexes`)

export interface VisibleEnemy {
  unit_id: number
  mech_id: number
  chassis: string | null
  model: string | null
  q: number
  r: number
  distance: number
}

// Enemy units inside this unit's own facing cone + LoS — the
// unit-vs-unit sibling of getUnitVisibleHexes, used by FirstPersonView's
// HUD. See app/units.py's visible_enemies_from_unit.
export const getUnitVisibleEnemies = (unitId: number) =>
  request<VisibleEnemy[]>(`/api/units/${unitId}/visible-enemies`)

export const updateTile = (
  mapId: number,
  q: number,
  r: number,
  body: Partial<{ elevation: number; blocks_los: boolean; terrain: string; los_points: number }>,
) =>
  request<MapData>(`/api/maps/${mapId}/tiles/${q}/${r}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const setActiveMap = (campaignId: number, mapId: number) =>
  request<Campaign>(`/api/campaigns/${campaignId}/active-map`, {
    method: 'POST',
    body: JSON.stringify({ map_id: mapId }),
  })

export const MECH_LOCATIONS = ['HD', 'CT', 'LT', 'RT', 'LA', 'RA', 'LL', 'RL'] as const
export const REAR_ARMOR_LOCATIONS = new Set(['CT', 'LT', 'RT'])

export type SheetStatus = 'pending' | 'approved' | 'rejected'

export interface Pilot {
  id: number
  campaign_id: number
  name: string
  callsign: string | null
  gunnery: number
  piloting: number
  faction: Faction
  hits: number
  status: SheetStatus
  review_note: string | null
  color: string
  is_own: boolean
}

export interface MechLocation {
  location: string
  armor_current: number
  armor_max: number
  armor_rear_current: number | null
  armor_rear_max: number | null
  structure_current: number
  structure_max: number
}

export interface MechWeapon {
  id: number
  weapon_name: string
  location: string
  ammo_remaining: number | null
}

export interface MechEquipment {
  id: number
  equipment_name: string
  location: string
}

export interface Mech {
  id: number
  campaign_id: number
  pilot_id: number | null
  chassis: string
  model: string | null
  tonnage: number
  walk_mp: number
  run_mp: number
  jump_mp: number
  heat_sinks: number
  heat_current: number
  locations: MechLocation[]
  weapons: MechWeapon[]
  equipment: MechEquipment[]
  criticals: Record<string, MechCriticalSlot[]>
  status: SheetStatus
  review_note: string | null
  is_own: boolean
}

export interface MechCriticalSlot {
  slot_index: number
  item_name: string
  hit: boolean
}

export const listPilots = (campaignId: number, token?: string) =>
  request<Pilot[]>(`/api/campaigns/${campaignId}/pilots`, { headers: tokenHeaders(token) })

export const createPilot = (
  campaignId: number,
  body: {
    name: string
    callsign?: string
    gunnery?: number
    piloting?: number
    faction?: Faction
    status?: SheetStatus
    owner_token?: string
    color?: string
  },
) =>
  request<Pilot>(`/api/campaigns/${campaignId}/pilots`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const reviewPilot = (pilotId: number, decision: 'approved' | 'rejected', note?: string) =>
  request<Pilot>(`/api/pilots/${pilotId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  })

export const resubmitPilot = (pilotId: number, token: string) =>
  request<Pilot>(`/api/pilots/${pilotId}/resubmit`, { method: 'POST', headers: tokenHeaders(token) })

export const listMechs = (campaignId: number, token?: string) =>
  request<Mech[]>(`/api/campaigns/${campaignId}/mechs`, { headers: tokenHeaders(token) })

export interface MechLocationIn {
  location: string
  armor_max: number
  structure_max: number
  armor_rear_max?: number
}

export const createMech = (
  campaignId: number,
  body: {
    chassis: string
    model?: string
    tonnage: number
    walk_mp: number
    run_mp: number
    jump_mp?: number
    pilot_id?: number
    heat_sinks?: number
    locations: MechLocationIn[]
    status?: SheetStatus
    owner_token?: string
    criticals?: Record<string, string[]>
  },
) =>
  request<Mech>(`/api/campaigns/${campaignId}/mechs`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

// Import a real mech from the public MegaMek-format unit database
// (ROADMAP.md Fase R3 — requested directly by the user) — search
// returns candidates, the second call fetches one's full stats to
// pre-fill the creation form. Never creates anything server-side by
// itself; the caller still goes through createMech/addMechWeapon.
export interface MechImportResult {
  name: string
  file: string
}

export interface MechImportData {
  chassis: string
  model: string
  tonnage: number
  walk_mp: number
  run_mp: number
  jump_mp: number
  heat_sinks: number
  locations: MechLocationIn[]
  weapons: { weapon_name: string; location: string }[]
  equipment: { equipment_name: string; location: string }[]
  criticals: Record<string, string[]>
}

export const searchMechImport = (q: string) =>
  request<MechImportResult[]>(`/api/mech-import/search?q=${encodeURIComponent(q)}`)

export const getMechImport = (filename: string) =>
  request<MechImportData>(`/api/mech-import/${encodeURIComponent(filename)}`)

// The GM's two cascading dropdowns (chassis, then model) over the same
// local catalog searchMechImport reads — pick a real mech instead of
// typing tonnage/armor/structure by hand.
export const listMechChassis = () => request<string[]>('/api/mech-catalog/chassis')

export interface MechModelResult {
  name: string
  file: string
  model: string
}

export const listMechModels = (chassis: string) =>
  request<MechModelResult[]>(`/api/mech-catalog/chassis/${encodeURIComponent(chassis)}/models`)

export const updateMech = (
  mechId: number,
  body: Partial<{
    chassis: string
    model: string
    tonnage: number
    walk_mp: number
    run_mp: number
    jump_mp: number
    heat_sinks: number
    pilot_id: number
  }>,
  token?: string,
) =>
  request<Mech>(`/api/mechs/${mechId}`, { method: 'PATCH', body: JSON.stringify(body), headers: tokenHeaders(token) })

export const reviewMech = (mechId: number, decision: 'approved' | 'rejected', note?: string) =>
  request<Mech>(`/api/mechs/${mechId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  })

export const resubmitMech = (mechId: number, token: string) =>
  request<Mech>(`/api/mechs/${mechId}/resubmit`, { method: 'POST', headers: tokenHeaders(token) })

export const deleteMech = (mechId: number) =>
  request<{ deleted: boolean }>(`/api/mechs/${mechId}`, { method: 'DELETE' })

// Weapon catalog (ROADMAP.md Fase R2 follow-up) — stats verified against
// Sarna.net individual weapon pages, see app/weapons.py for the caveat.
export interface WeaponStats {
  damage: number
  heat: number
  min_range: number
  short: number
  medium: number
  long: number
  ammo_per_ton: number | null
}

export const getWeaponCatalog = () => request<Record<string, WeaponStats>>('/api/weapons')

export const addMechWeapon = (mechId: number, weaponName: string, location: string, token?: string) =>
  request<Mech>(`/api/mechs/${mechId}/weapons`, {
    method: 'POST',
    body: JSON.stringify({ weapon_name: weaponName, location }),
    headers: tokenHeaders(token),
  })

export const removeMechWeapon = (mechId: number, weaponId: number, token?: string) =>
  request<Mech>(`/api/mechs/${mechId}/weapons/${weaponId}`, { method: 'DELETE', headers: tokenHeaders(token) })

// Non-weapon equipment catalog (app/equipment.py) — same shape as the
// weapon catalog above, minus attack stats.
export interface EquipmentStats {
  slots: number
  heat_dissipation: number | null
  jump_bonus: number | null
}

export const getEquipmentCatalog = () => request<Record<string, EquipmentStats>>('/api/equipment')

export const addMechEquipment = (mechId: number, equipmentName: string, location: string, token?: string) =>
  request<Mech>(`/api/mechs/${mechId}/equipment`, {
    method: 'POST',
    body: JSON.stringify({ equipment_name: equipmentName, location }),
    headers: tokenHeaders(token),
  })

export const removeMechEquipment = (mechId: number, equipmentId: number, token?: string) =>
  request<Mech>(`/api/mechs/${mechId}/equipment/${equipmentId}`, { method: 'DELETE', headers: tokenHeaders(token) })

export const createUnit = (
  mapId: number,
  body: {
    q: number
    r: number
    mech_id?: number
    pilot_id?: number
    facing_deg?: number
    is_ghost?: boolean
    dnd_character_id?: number
  },
) => request<Unit>(`/api/maps/${mapId}/units`, { method: 'POST', body: JSON.stringify(body) })

// ---- D&D 5e (ROADMAP.md Fase R4 — segundo sistema, slice mínimo) --------

export interface DndCharacter {
  id: number
  campaign_id: number
  name: string
  str: number
  dex: number
  con: number
  int: number
  wis: number
  cha: number
  ac: number
  hp_current: number
  hp_max: number
  proficiency_bonus: number
  created_at: string
}

export const abilityModifier = (score: number) => Math.floor((score - 10) / 2)

export const createDndCharacter = (
  campaignId: number,
  body: {
    name: string
    str?: number
    dex?: number
    con?: number
    int?: number
    wis?: number
    cha?: number
    ac?: number
    hp_max?: number
    proficiency_bonus?: number
  },
) => request<DndCharacter>(`/api/campaigns/${campaignId}/dnd/characters`, { method: 'POST', body: JSON.stringify(body) })

export const listDndCharacters = (campaignId: number) =>
  request<DndCharacter[]>(`/api/campaigns/${campaignId}/dnd/characters`)

export interface DndAttackResult {
  attacker_id: number
  target_id: number
  roll: number
  attack_mod: number
  total: number
  hit: boolean
  damage: number
}

export const dndAttack = (
  campaignId: number,
  body: { attacker_id: number; target_id: number; attack_mod: number; damage_dice: string },
) => request<DndAttackResult>(`/api/campaigns/${campaignId}/dnd/attack`, { method: 'POST', body: JSON.stringify(body) })

export interface DndRoundState {
  campaign_id: number
  round_number: number
  rolls: { character_id: number; roll: number; name: string }[]
  acted_character_ids: number[]
}

export const getDndRound = (campaignId: number) => request<DndRoundState>(`/api/campaigns/${campaignId}/dnd/round`)

export const startDndRound = (campaignId: number) =>
  request<DndRoundState>(`/api/campaigns/${campaignId}/dnd/round/start`, { method: 'POST' })

export const markDndRoundActed = (campaignId: number, characterId: number) =>
  request<DndRoundState>(`/api/campaigns/${campaignId}/dnd/round/act`, {
    method: 'POST',
    body: JSON.stringify({ character_id: characterId }),
  })

export interface AttackIn {
  // Derived server-side from the attacker's own pilot when
  // attacker_unit_id is given and this is omitted — see
  // app/combat.py's resolve_attack docstring. Only needed explicitly for
  // the legacy manual (no unit ids) path.
  gunnery?: number
  // attacker_unit_id/target_unit_id (both, or neither) switch on real
  // server-side validation — LOS, weapon range, real side/movement all
  // computed from actual game state, ignoring range_bracket/side/
  // attacker_movement/target_hexes_moved/target_jumped even if sent (see
  // app/combat.py's resolve_attack docstring). Omitting both keeps the
  // legacy fully-manual path, which DOES trust those fields as-is.
  attacker_unit_id?: number
  target_unit_id?: number
  target_mech_id?: number
  // Either damage (legacy/manual) or weapon_id (looks damage up from the
  // catalog and consumes ammo) — see app/combat.py's resolve_attack.
  damage?: number
  weapon_id?: number
  attacker_movement?: string
  target_hexes_moved?: number
  target_jumped?: boolean
  range_bracket?: string
  side?: string
  other_modifiers?: number
}

export interface AttackResult {
  target_mech_id: number
  // Only populated for real board attacks (attacker_unit_id/target_unit_id
  // both given) — used purely for client-side attack VFX to resolve real
  // attacker/target positions, absent for legacy narrative attacks.
  attacker_unit_id: number | null
  target_unit_id: number | null
  attacker_mech_id: number | null
  weapon_id: number | null
  weapon_name: string | null
  target_number: number
  roll: number
  hit: boolean
  location: string | null
  critical: boolean
  mech_destroyed: boolean
}

export const attack = (campaignId: number, body: AttackIn) =>
  request<AttackResult>(`/api/campaigns/${campaignId}/attack`, { method: 'POST', body: JSON.stringify(body) })

export const undoLastAction = (campaignId: number) =>
  request(`/api/campaigns/${campaignId}/undo`, { method: 'POST' })

// Round/initiative tracking (ROADMAP.md S2) — simplified v1: rolls
// initiative once per round and tracks which pilots have activated, but
// doesn't gate movement/attacks behind whose turn it is (advisory, not
// enforced — see app/systems/battletech/turns.py for why). Two modes: a
// "team" roll (the real rule — one 2d6 per side) or "individual" (one 2d6
// per combat pilot, GM-selectable, not from the rulebook).
export interface InitiativeModifier {
  label: string
  value: number
}

export interface InitiativeRoll {
  kind: 'faction' | 'pilot'
  faction: string
  pilot_id: number | null
  pilot_name: string | null
  roll: number
  modifiers: InitiativeModifier[]
  modifier_total: number
  /** roll + modifier_total — turn/movement order use this, not the raw roll. */
  total: number
}

export interface RoundState {
  campaign_id: number
  round_number: number
  mode: InitiativeMode
  rolls: InitiativeRoll[]
  acted_pilot_ids: number[]
  /** Every combat pilot who's rolled this round, lowest total first —
   * empty until everyone who's going to roll has. See turns.py's
   * _movement_order. */
  movement_order: number[]
  moved_pilot_ids: number[]
  /** Real recorded movement per pilot this round — app/combat.py's
   * resolve_attack derives attacker_movement/target_hexes_moved from
   * this same data server-side now (see its own docstring); kept here
   * too since the GM's round-state chips still surface it. */
  moves: { pilot_id: number; unit_id: number; movement_type: MovementType; hexes_moved: number }[]
  /** Pilot ids who, right now, have some mounted+loaded weapon in real
   * range+LoS of some visible enemy — [] until movement has fully
   * finished (see turns.py's own _get), and live-recomputed every fetch
   * after that (mechs move/die during these phases too). */
  ranged_target_pilot_ids: number[]
  /** Same idea as ranged_target_pilot_ids but for adjacency (distance 1)
   * — no weapon/ammo/range involved, physical attacks only need
   * proximity. */
  melee_target_pilot_ids: number[]
}

export const getRound = (campaignId: number) => request<RoundState>(`/api/campaigns/${campaignId}/round`)

export const startRound = (campaignId: number) =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/start`, { method: 'POST' })

export const setInitiativeMode = (campaignId: number, mode: InitiativeMode) =>
  request<Campaign>(`/api/campaigns/${campaignId}/initiative-mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })

export const markRoundActed = (campaignId: number, pilotId: number) =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/act`, {
    method: 'POST',
    body: JSON.stringify({ pilot_id: pilotId }),
  })

// Individual-mode only — team mode rolls both sides atomically inside
// startRound, no per-pilot call. The actual 2d6 value now comes from
// real physics dice on the shared table (TableView), not a server-side
// random number — this two-step split reflects that:
//
// 1. requestInitiative (GMView/PlayerView's "Tirar iniciativa" button):
//    just validates the pilot may roll and asks every connected client
//    to physically throw dice for them (`initiative_roll_requested`
//    broadcast) — does not touch the round's rolls itself.
// 2. reportInitiative (TableView only, once its two dice land): records
//    whatever value the dice actually landed on. Idempotent server-side
//    — reporting again for a pilot who already has a roll this round
//    just returns the unchanged state.
export interface InitiativeRollRequest {
  pilot_id: number
  pilot_name: string
  color: string
}

export const requestInitiative = (campaignId: number, pilotId: number) =>
  request<InitiativeRollRequest>(`/api/campaigns/${campaignId}/round/roll-initiative`, {
    method: 'POST',
    body: JSON.stringify({ pilot_id: pilotId }),
  })

// `dice` — each individual d6 face the physics dice actually landed on
// — gets logged server-side into the same history GET /api/campaigns/
// {id}/rolls already serves, purely so the real distribution can be
// checked later (are they actually landing ~1/6 each?).
export const reportInitiative = (campaignId: number, pilotId: number, roll: number, dice: number[]) =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/report-initiative`, {
    method: 'POST',
    body: JSON.stringify({ pilot_id: pilotId, roll, dice }),
  })

// Movement phase (requested directly — activates automatically once
// everyone's rolled initiative, lowest total moves first; see
// rounds.ts's activeMoverPilotId and app/systems/battletech/movement.py).
export type MovementType = 'walk' | 'run' | 'jump'

export interface ReachableHex {
  q: number
  r: number
  mp_cost: number
  hexes: number
  /** The real hex-by-hex route to get here (terrain-following, not a
   * straight line to the destination) — origin excluded, this hex
   * included, in travel order. Jump's is just [{q, r}] (no route to
   * walk through mid-air). */
  path: { q: number; r: number }[]
  /** Every ending facing (degrees) actually affordable at this hex
   * within the remaining budget — a hex can be reachable at all yet
   * only affordable at *some* facings (see movement.py's own doc
   * comment). Jump always lists all six (free landing direction). */
  facings: number[]
}

export const getReachableHexes = (unitId: number, movementType: MovementType) =>
  request<ReachableHex[]>(`/api/units/${unitId}/reachable-hexes?movement_type=${movementType}`)

export const moveUnitWithMp = (unitId: number, q: number, r: number, movementType: MovementType, facingDeg?: number) =>
  request<Unit>(`/api/units/${unitId}/move-with-mp`, {
    method: 'POST',
    body: JSON.stringify({ q, r, movement_type: movementType, facing_deg: facingDeg ?? null }),
  })

// Computes the reachable set AND broadcasts it (`movement_started`) so
// the shared table always shows the highlight regardless of who picked
// the movement type — PlayerView (no map of its own) relies on the
// broadcast entirely; GMView uses the same call so its own embedded map
// AND TableView both light up from one request, instead of GM-initiated
// movement only ever showing on the GM's private screen.
export interface MovementStartedResponse {
  pilot_id: number | null
  unit_id: number
  movement_type: MovementType
  hexes: ReachableHex[]
}

export const requestMovement = (unitId: number, movementType: MovementType) =>
  request<MovementStartedResponse>(`/api/units/${unitId}/request-movement`, {
    method: 'POST',
    body: JSON.stringify({ movement_type: movementType }),
  })

// Editable digital sheet (ROADMAP.md Fase R3) — pencil-mark values directly,
// same as a paper record sheet, no combat roll involved.
export const updatePilot = (
  pilotId: number,
  body: Partial<{
    name: string; callsign: string; gunnery: number; piloting: number; faction: Faction; hits: number; color: string
  }>,
  token?: string,
) => request<Pilot>(`/api/pilots/${pilotId}`, { method: 'PATCH', body: JSON.stringify(body), headers: tokenHeaders(token) })

export const deletePilot = (pilotId: number) =>
  request<{ deleted: boolean }>(`/api/pilots/${pilotId}`, { method: 'DELETE' })

export const updateMechCritical = (
  mechId: number,
  location: string,
  slotIndex: number,
  hit: boolean,
  token?: string,
) =>
  request<Mech>(`/api/mechs/${mechId}/criticals/${location}/${slotIndex}`, {
    method: 'PATCH',
    body: JSON.stringify({ hit }),
    headers: tokenHeaders(token),
  })

export const updateMechLocation = (
  mechId: number,
  location: string,
  body: Partial<{
    armor_current: number
    armor_rear_current: number
    structure_current: number
    armor_max: number
    armor_rear_max: number
    structure_max: number
  }>,
  token?: string,
) =>
  request<Mech>(`/api/mechs/${mechId}/locations/${location}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: tokenHeaders(token),
  })
