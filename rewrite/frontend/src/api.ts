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
  gm_die_style: string | null
  /** Real user request: TableView shows a 360°-orbit cinematic modal
   * the instant an enemy enters the team's LOS — this campaign-wide
   * toggle (default on) lets the GM turn it off from their own Ajustes
   * modal. */
  enemy_reveal_cinematic: boolean
  /** Real user request/correction: "el GM también tiene que poder
   * escoger entre dados físicos o tiradas automáticas... O TODOS SUS
   * PILOTOS TIRAN AUTOMATICO O TODOS TIRAN FISICO" — one campaign-wide
   * switch (not per-pilot, unlike a player's own dice_mode) governing
   * every enemy/npc pilot's rolls at once. */
  gm_dice_mode: 'physical' | 'auto'
  pilot_count: number
  mech_count: number
}

export interface GameSystem {
  name: string
  grid_type: 'hex' | 'square'
}

// Carries the HTTP status so a caller can distinguish e.g. a 409 "can't
// be done" from a generic failure (GMView's undo button uses this to
// show a specific message for a not-undoable event — see events.py's
// NotUndoable) instead of every non-2xx response looking the same.
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new ApiError(res.status, `${init?.method ?? 'GET'} ${path} → ${res.status}`)
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
  /** Every hex at least one 'player'-faction unit can currently see
   * (facing cone + LoS, unioned across the whole team) — real user
   * request: "niebla de guerra real en el table view... casillas que el
   * equipo jugador no ve". See app/units.py's _team_visible_hexes. */
  visible_hexes: VisibleHex[]
}

export const listMaps = (campaignId: number) =>
  request<MapData[]>(`/api/campaigns/${campaignId}/maps`)

/** Something left lying on a map. One shape for severed limbs, weapon
 * craters and mech footprints alike — see the backend's board_marks.py on
 * why those three share a table. `data` carries whatever that kind needs. */
export interface BoardMark {
  id: number
  map_id: number
  kind: 'limb' | 'crater' | 'footprint'
  /** Board coordinates, the same space hexToWorld returns. Real positions,
   * not hex centres: a limb falls where it falls. */
  x: number
  z: number
  data: Record<string, unknown>
  created_at: string
}

export const listBoardMarks = (mapId: number, kind?: BoardMark['kind']) =>
  request<BoardMark[]>(`/api/maps/${mapId}/marks${kind ? `?kind=${kind}` : ''}`)

export const addBoardMark = (
  mapId: number,
  kind: BoardMark['kind'],
  x: number,
  z: number,
  data?: Record<string, unknown>,
) =>
  request<BoardMark>(`/api/maps/${mapId}/marks`, {
    method: 'POST',
    body: JSON.stringify({ kind, x, z, data }),
  })

export const clearBoardMarks = (mapId: number, kind?: BoardMark['kind']) =>
  request<{ removed: number }>(`/api/maps/${mapId}/marks${kind ? `?kind=${kind}` : ''}`, {
    method: 'DELETE',
  })

export const createMap = (campaignId: number, name: string, width: number, height: number) =>
  request<MapData>(`/api/campaigns/${campaignId}/maps`, {
    method: 'POST',
    body: JSON.stringify({ name, width, height }),
  })

export const getMap = (mapId: number) => request<MapData>(`/api/maps/${mapId}`)

export const deleteMap = (mapId: number) => request<{ ok: boolean }>(`/api/maps/${mapId}`, { method: 'DELETE' })

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

export const moveUnit = (unitId: number, q: number, r: number, facingDeg?: number, movementType?: MovementType) =>
  request<Unit>(`/api/units/${unitId}/move`, {
    method: 'POST',
    body: JSON.stringify({
      q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}),
      // Debug-only (real user request: "forzar salto" must work no
      // matter what — no MP check) — this endpoint enforces zero
      // rules already, this is purely an animation tag on the resulting
      // unit_walked broadcast.
      ...(movementType != null ? { movement_type: movementType } : {}),
    }),
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
  heat_current: number
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
  /** A DIE_STYLES id (../dieStyles.ts) or null if this pilot hasn't
   * picked one — exclusive across the whole campaign (see
   * setPilotDieStyle). */
  die_style: string | null
  /** Real user request: "cada jugador puede escoger en opciones si
   * quiere dados físicos siempre o tiradas automáticas" — only
   * meaningful for individual-mode initiative (team mode already
   * auto-rolls both sides server-side regardless). 'physical' is the
   * default. */
  dice_mode: 'physical' | 'auto'
  is_own: boolean
  /** True if SOME device (any device, not necessarily this one) has
   * claimed this pilot — i.e. it has an owner_token set. Combined with
   * is_own, a pilot claimed by someone else is is_claimed && !is_own:
   * PlayerView's picker hides those (real user request: a pilot already
   * in use by another device shouldn't be pickable by a second one). */
  is_claimed: boolean
  /** A Cockpit critical (criticals.py's apply_critical_effects) kills the
   * pilot outright — permanent, unlike the ordinary wound track (`hits`),
   * which a pilot can recover from. Real user request: mech destruction
   * needed a distinct "the pilot actually died" signal, not just
   * "knocked out by wounds". */
  is_dead: boolean
  /** Whether this pilot has a 4-digit PIN set (never the PIN/hash
   * itself, which never leaves the server) — a pilot without one is
   * freely selectable from PlayerView's shared list, no prompt. */
  has_pin: boolean
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
  /** Heat Scale shutdown (systems/battletech/turns.py's resolve_heat_phase)
   * — can't move or attack until it restarts (heat drops below 14, or a
   * later Heat Phase's 2d6 restart roll succeeds). */
  is_shutdown: boolean
  /** Fell (psr.py's apply_fall) — can't move/attack except attempting to
   * stand back up (api.ts's standUp). */
  is_prone: boolean
  /** Fase D — persisted once, never cleared: 'structural' (CT/HD
   * structure or the 3rd engine hit — explodes) or 'pilot_killed' (a
   * Cockpit critical, mech otherwise structurally intact — falls limp
   * instead). null means still standing. Distinct from is_shutdown/
   * is_prone, which are both recoverable; this never is. */
  destroyed_reason: 'structural' | 'pilot_killed' | null
  gyro_hits: number
  engine_hits: number
  sensor_hits: number
  life_support_hit: boolean
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
    pin?: string
  },
) =>
  request<Pilot>(`/api/campaigns/${campaignId}/pilots`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** Returns false for a wrong PIN (an expected, handle-able outcome —
 * show "PIN incorrecto" and let the player retry) rather than throwing;
 * still throws for a genuine connectivity/server failure, same as every
 * other function here. */
export async function verifyPilotPin(pilotId: number, pin: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/api/pilots/${pilotId}/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  if (res.status === 403) return false
  if (!res.ok) throw new Error(`POST /api/pilots/${pilotId}/verify-pin → ${res.status}`)
  return true
}

/** Claims a pilot for this device before PlayerView finalizes picking
 * it — throws (with a 409) if another device already claimed it, which
 * callers should handle as "someone beat you to it, pick again" rather
 * than silently proceeding as if it succeeded. */
export const claimPilot = (pilotId: number, token: string) =>
  request<Pilot>(`/api/pilots/${pilotId}/claim`, { method: 'POST', headers: tokenHeaders(token) })

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

// The GM's/player's two cascading dropdowns (chassis, then model) over
// the same local catalog searchMechImport reads — pick a real mech
// instead of typing tonnage/armor/structure by hand. tonnage rides
// along per chassis (real user request: group this dropdown by
// Light/Medium/Heavy/Assault — see weightClass.ts) instead of a second
// round trip to look it up.
export interface MechChassisResult {
  chassis: string
  tonnage: number
}

export const listMechChassis = () => request<MechChassisResult[]>('/api/mech-catalog/chassis')

export interface MechModelResult {
  name: string
  file: string
  model: string
}

export const listMechModels = (chassis: string) =>
  request<MechModelResult[]>(`/api/mech-catalog/chassis/${encodeURIComponent(chassis)}/models`)

// MechLab (real user request: "una pequeña vista dentro de nuestra app
// donde seleccione el modelo del mech que quiero... y que yo tenga una
// forma de decirte a ti donde esta cada cosa") — dev-only 3D annotation
// tool. Points live in Mech3D.tsx's own normalized local space (1 unit
// tall, centered on X/Z, resting on y=0), BEFORE MODEL_SCALE/facing_deg —
// see MechLabView.tsx's own top comment for the full pipeline.
// Only arms/legs are ever a detachable "limb" — losing a Head or Torso
// location is mech death outright under the real rules this app already
// follows elsewhere, not a part that visually falls off a still-standing
// mech. Same set app/mech_annotations.py's own LIMB_LOCATIONS validates.
export const LIMB_LOCATIONS = ['LA', 'RA', 'LL', 'RL'] as const

export interface MechAnnotation {
  id: number
  model_url: string
  // 'hit' = where an incoming attack on this location should visually land
  // on the model (real user request: "vamos a seleccionar las diferentes
  // partes del cuerpo del mech, para que cuando reciba ataques en sitios
  // especificos, podamos mostrar esos ataques golpeando donde deben") —
  // one per location (any of the 8, including HD/CT), unlike 'weapon'
  // which can have several per location.
  kind: 'weapon' | 'cockpit' | 'limb' | 'hit'
  location: (typeof MECH_LOCATIONS)[number] | null
  x: number
  y: number
  z: number
  /** kind='limb' only — the glTF node names (SkinnedMesh/Mesh/Object3D
   * names, as they came out of the source file) making up that limb, so
   * a future "lose an arm" VFX knows exactly what to hide/detach. null
   * for 'weapon'/'cockpit'. */
  mesh_names: string[] | null
  updated_at: string
}

export interface MechAnnotationPoint {
  kind: 'weapon' | 'cockpit' | 'limb' | 'hit'
  location: (typeof MECH_LOCATIONS)[number] | null
  x: number
  y: number
  z: number
  mesh_names?: string[] | null
}

export const listMechAnnotations = () => request<MechAnnotation[]>('/api/mech-annotations')

export const saveMechAnnotations = (modelUrl: string, points: MechAnnotationPoint[]) =>
  request<MechAnnotation[]>('/api/mech-annotations', {
    method: 'PUT',
    body: JSON.stringify({ model_url: modelUrl, points }),
  })

/** Per-model, per-track review state for MechLab (real user request: "poder
 * ver a simple vista en que estado se encuentra el anotar armas,
 * extremidades y rig"). `'accepted'` is only ever set by an explicit user
 * action in MechLabView — never inferred here or on the backend. A model
 * with no row for a track is implicitly `'not_started'`. */
export type MechAnnotationTrack = 'weapons' | 'limbs' | 'rig' | 'texture'
export type MechAnnotationReviewStatus = 'not_started' | 'done' | 'accepted'

export interface MechAnnotationReview {
  model_url: string
  track: MechAnnotationTrack
  status: MechAnnotationReviewStatus
  updated_at: string
}

export const listMechAnnotationReview = () => request<MechAnnotationReview[]>('/api/mech-annotations/review')

export const setMechAnnotationReview = (modelUrl: string, track: MechAnnotationTrack, status: MechAnnotationReviewStatus) =>
  request<MechAnnotationReview>('/api/mech-annotations/review', {
    method: 'PUT',
    body: JSON.stringify({ model_url: modelUrl, track, status }),
  })

/** MechLabView's Textura tab (real user request: "quiero poder guardarlo
 * desde el mechlab y como lo demas, 3 estados y un marcador en el
 * desplegable") — persists the live PBR tuning sliders (see Mech3D.tsx's
 * own MechPbrSettings) per model_url. Review status for this tab reuses
 * MechAnnotationTrack='texture' above via the existing review endpoints;
 * this is only the actual slider VALUES. Wire format is snake_case (the
 * backend's own column names); the frontend's own MechPbrSettings type
 * (Mech3D.tsx) is camelCase — callers convert at the boundary. */
export interface MechPbrSettingsRecord {
  model_url: string
  repeat: number
  normal_scale: number
  roughness: number
  metalness: number
  color_boost: number
  ao_intensity: number
  updated_at: string
}

export const listMechPbrSettings = () => request<MechPbrSettingsRecord[]>('/api/mech-pbr-settings')

export const saveMechPbrSettings = (record: Omit<MechPbrSettingsRecord, 'updated_at'>) =>
  request<MechPbrSettingsRecord>('/api/mech-pbr-settings', {
    method: 'PUT',
    body: JSON.stringify(record),
  })

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

// "Quitar del mapa" — removes the token, not the mech/pilot it
// represents (that's deleteMech/deletePilot above).
export const deleteUnit = (unitId: number) =>
  request<{ deleted: boolean }>(`/api/units/${unitId}`, { method: 'DELETE' })

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

// Fase B: a pilot with dice_mode='physical' makes the server pause
// mid-resolution instead of returning a finished AttackResult — attack()
// (and reportPendingRoll below) can return either shape, and every
// caller (GMView's weapon volley, FirstPersonView's own fire flow) needs
// to branch on isPendingRollResult before treating the response as a
// finished shot. TableView is the one that actually drives the physical-
// dice loop (see its own physical_roll_requested handling) — a caller
// submitting an attack just needs to know to WAIT rather than assume it
// already has a result.
export interface PendingRollResult {
  pending: true
  pending_roll_id: number
}

export type AttackOutcome = AttackResult | PendingRollResult

// Generic over T so this accepts any *Outcome union (AttackOutcome,
// MeleeAttackOutcome, ...) rather than just AttackOutcome specifically —
// every one of those unions is "some real result shape, or
// PendingRollResult". A plain `{ pending?: boolean }` parameter type
// looked simpler but TS treats an all-optional-properties type as
// "weak" and refuses to match it structurally against a real result
// shape with no properties in common at all.
export function isPendingRollResult<T>(x: T | PendingRollResult): x is PendingRollResult {
  return typeof x === 'object' && x !== null && 'pending' in x && (x as PendingRollResult).pending === true
}

export const attack = (campaignId: number, body: AttackIn) =>
  request<AttackOutcome>(`/api/campaigns/${campaignId}/attack`, { method: 'POST', body: JSON.stringify(body) })

// TableView calls this once the real physical die/dice it spawned for a
// physical_roll_requested broadcast have settled — `dice` is each die's
// own face, in the order dice_spec asked for (length 1 or 2). May itself
// return ANOTHER pending result if the resolution needs yet another
// roll (e.g. impact hit, now waiting on the hit-location roll) — the
// caller loops the same way until it gets a real AttackResult back.
export const reportPendingRoll = (campaignId: number, pendingRollId: number, dice: number[]) =>
  request<AttackOutcome>(`/api/campaigns/${campaignId}/pending-rolls/${pendingRollId}/report`, {
    method: 'POST', body: JSON.stringify({ dice }),
  })

export const undoLastAction = (campaignId: number) =>
  request(`/api/campaigns/${campaignId}/undo`, { method: 'POST' })

// Persistent campaign history (real user request: "el registro debe
// guardar todo... TODO!!!") — every pilot/mech/map/round/unit/attack
// mutation logs one of these server-side (see app/events.py). undoable
// is what "Deshacer última acción" actually checks before reverting.
export interface CampaignEvent {
  id: number
  campaign_id: number
  event_type: string
  summary: string
  payload: Record<string, unknown>
  undoable: boolean
  undone: boolean
  created_at: string
}

export const listCampaignEvents = (campaignId: number) =>
  request<CampaignEvent[]>(`/api/campaigns/${campaignId}/events`)

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
  /** Pilot ids who explicitly "Pasar turno"-ed the ranged/melee phase
   * (api.ts's passPhase) — deliberately separate from acted_pilot_ids:
   * a real attack blocks BOTH phases (acted_pilot_ids), but an explicit
   * pass with nothing to shoot/punch only satisfies THAT phase, so the
   * same pilot can still melee an adjacent enemy after passing on a
   * target-less ranged turn (real user report). */
  ranged_passed_pilot_ids: number[]
  melee_passed_pilot_ids: number[]
  /** Whether turns.py's resolve_heat_phase has already run for this
   * round — False the instant ranged/melee both empty out is exactly
   * when GMView calls resolveHeatPhase itself (rounds.ts's currentPhase
   * reaching 'other'), no GM button needed. */
  heat_resolved: boolean
  /** Every combat pilot present when THIS round's start_round ran
   * (turns.py's bt_round_participants snapshot) — a pilot/mech added
   * mid-round isn't in here, and can't move/attack/roll meaningfully
   * until the NEXT round (real user request: "si se mete un nuevo mech
   * en mitad de un combate... debe empezar a actuar en el siguiente
   * turno"). rounds.ts's pilotsNeedingInitiative uses this to stop
   * flagging a just-joined pilot as "missing a roll" they were never
   * going to get a turn from anyway this round. */
  participant_pilot_ids: number[]
}

export const getRound = (campaignId: number) => request<RoundState>(`/api/campaigns/${campaignId}/round`)

export const resolveHeatPhase = (campaignId: number) =>
  request<{ campaign_id: number; results: HeatPhaseMechResult[]; already_resolved?: boolean }>(
    `/api/campaigns/${campaignId}/round/resolve-heat`, { method: 'POST' },
  )

export interface HeatPhaseMechResult {
  mech_id: number
  heat_current: number
  shutdown: boolean | null
  restarted: boolean | null
  ammo_explosion: { mech_id: number; damage: number } | null
  pilot_wound: number | null
}

export type MeleeAttackType = 'punch' | 'kick' | 'charge' | 'dfa'

export interface MeleeAttackResult {
  attack_type: MeleeAttackType
  attacker_unit_id: number
  target_unit_id: number
  attacker_mech_id: number
  target_mech_id: number
  target_number: number
  roll: number
  hit: boolean
  damage: number | null
  hit_results: { location: string; amount: number }[]
  self_damage_results: { location: string; amount: number }[]
  mech_destroyed: boolean
  /** Charge/DFA's own recoil damage can destroy the ATTACKER's mech too
   * (Fase A gap fix — see melee.py's own _mech_destroyed on self_damage_
   * results) — a separate flag from mech_destroyed (which always means
   * "the target died") since a real attack can trigger both at once. */
  attacker_mech_destroyed: boolean
  fall: Record<string, unknown> | null
  self_fall: Record<string, unknown> | null
  target_psr?: { success: boolean }
}

// Fase B: same pending/report shape as attack()/PendingRollResult above —
// punch/kick can pause for a physical-mode pilot (charge/DFA's own
// grouped damage stays instant, see melee.py's own documented scope
// limit). Callers must branch on isPendingRollResult the same way they
// already do for attack().
export type MeleeAttackOutcome = MeleeAttackResult | PendingRollResult

export const submitMeleeAttack = (unitId: number, targetUnitId: number, attackType: MeleeAttackType, arm?: 'left' | 'right') =>
  request<MeleeAttackOutcome>(`/api/units/${unitId}/melee`, {
    method: 'POST',
    body: JSON.stringify({ target_unit_id: targetUnitId, attack_type: attackType, arm }),
  })

export const standUp = (unitId: number) =>
  request<Record<string, unknown>>(`/api/units/${unitId}/stand-up`, { method: 'POST' })

/** Debug-only affordance (real user request: "una opcion de tirarse... en
 * el menu de movimiento") — sets is_prone directly, no PSR/fall damage,
 * purely to preview Caerse/Levantarse without waiting for a real failed
 * PSR to happen naturally. */
export const fallOver = (unitId: number) =>
  request<Record<string, unknown>>(`/api/units/${unitId}/fall-over`, { method: 'POST' })

export const startRound = (campaignId: number) =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/start`, { method: 'POST' })

export const setInitiativeMode = (campaignId: number, mode: InitiativeMode) =>
  request<Campaign>(`/api/campaigns/${campaignId}/initiative-mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })

// GM's own die-style pick (real user request) — GM has no `pilots` row,
// so this lives on the campaign itself. style=null clears it.
export const setGmDieStyle = (campaignId: number, style: string | null) =>
  request<Campaign>(`/api/campaigns/${campaignId}/gm-die-style`, {
    method: 'POST',
    body: JSON.stringify({ style }),
  })

export const setEnemyRevealCinematic = (campaignId: number, enabled: boolean) =>
  request<Campaign>(`/api/campaigns/${campaignId}/enemy-reveal-cinematic`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })

// GM's own campaign-wide switch (real user request/correction — see
// Campaign.gm_dice_mode's own doc comment) — no `pilots` row of its own,
// so this lives on the campaign itself, same as gm_die_style above.
export const setGmDiceMode = (campaignId: number, mode: 'physical' | 'auto') =>
  request<Campaign>(`/api/campaigns/${campaignId}/gm-dice-mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })

export const markRoundActed = (campaignId: number, pilotId: number) =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/act`, {
    method: 'POST',
    body: JSON.stringify({ pilot_id: pilotId }),
  })

// "Pasar turno" for ONE phase only — see RoundState's own
// ranged_passed_pilot_ids/melee_passed_pilot_ids doc comment for why
// this is a separate endpoint from markRoundActed above.
export const passRoundPhase = (campaignId: number, pilotId: number, phase: 'ranged' | 'melee') =>
  request<RoundState>(`/api/campaigns/${campaignId}/round/pass`, {
    method: 'POST',
    body: JSON.stringify({ pilot_id: pilotId, phase }),
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
    dice_mode: 'physical' | 'auto'
  }>,
  token?: string,
) => request<Pilot>(`/api/pilots/${pilotId}`, { method: 'PATCH', body: JSON.stringify(body), headers: tokenHeaders(token) })

// Separate from updatePilot above on purpose — that PATCH's `Partial<...>`
// body treats every omitted field as "leave unchanged", which can't
// express "clear my die style back to unset" (style: null). This
// dedicated endpoint always applies exactly what's sent.
export const setPilotDieStyle = (pilotId: number, style: string | null, token?: string) =>
  request<Pilot>(`/api/pilots/${pilotId}/die-style`, {
    method: 'POST',
    body: JSON.stringify({ style }),
    headers: tokenHeaders(token),
  })

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
