import { Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import { useMapState } from '../useMapState'
import { useTableSocket } from '../ws'
import { NavBar, type NavLink } from '../components/NavBar'
import { PilotForm } from '../components/PilotForm'
import { MechRecordSheet } from '../components/MechRecordSheet'
import { HexMap, useAttackVfxQueue } from '../components/HexMap'
import { SquareMap } from '../components/SquareMap'
import { DndCharacterSheet } from '../components/DndCharacterSheet'
import { TableBackground } from '../components/TableBackground'
import { UnitContextMenu } from '../components/UnitContextMenu'
import { FacingPicker } from '../components/FacingPicker'
import { DropdownMenu } from '../components/DropdownMenu'
import { WeaponVolleyPanel } from '../components/WeaponVolleyPanel'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Tooltip } from '../components/Tooltip'
import { CameraBridge } from '../components/CameraBridge'
import { MECH_CHASSIS_ASSETS } from '../mechAssets'
import { FACTION_COLORS, FACTION_LABELS, NEUTRAL_UNIT_COLOR, type Faction } from '../factions'
import { suggestPilotColor } from '../pilotColors'
import {
  activeAttackPilotIds, activeMoverPilotId, currentPhase, formatRoll, PHASE_LABELS, pilotsNeedingInitiative,
} from '../rounds'
import { mapCenter, worldToHex } from '../hexMath'
import {
  buildMechLocationsPayload, emptyLocationsForm, locationsFormFromMechLocationIn,
} from '../characterSheet'
import {
  addMechEquipment,
  addMechWeapon,
  attack,
  createMech,
  createPilot,
  createUnit,
  deleteMech,
  deletePilot,
  getMechImport,
  getUnitVisibleEnemies,
  getWeaponCatalog,
  listCampaigns,
  listDndCharacters,
  listMechChassis,
  listMechModels,
  listMechs,
  listPilots,
  markRoundActed,
  moveUnit,
  moveUnitWithMp,
  reviewMech,
  requestInitiative,
  requestMovement,
  reviewPilot,
  setInitiativeMode,
  startRound,
  undoLastAction,
  updateMech,
  updatePilot,
  type Campaign,
  type DndCharacter,
  type InitiativeMode,
  type Mech,
  type MechImportData,
  type MechModelResult,
  type MovementType,
  type Pilot,
  type ReachableHex,
  type Unit,
  type VisibleEnemy,
  type WeaponStats,
} from '../api'
import './GMView.css'

// GM's own nav is trimmed to just this page and the map editor — Mesa and
// Jugador are the shared-table/player-facing views, not places a GM
// mid-session needs to jump to from here.
const GM_NAV_LINKS: NavLink[] = [
  { path: '/gm', label: 'GM', icon: '🎛️' },
  { path: '/mapeditor', label: 'Creación de Mapas', icon: '🗺️' },
]

/** The BattleTech GM screen — everything this file did before Fase R4
 * (D&D 5e as a second system). Renamed, otherwise untouched: see the
 * real `GMView` export at the bottom of this file, which just decides
 * whether to mount this or GMViewDnd based on the campaign's system. */
function GMViewBattletech() {
  const campaignId = useCampaignId()
  const { activeMapId, roundState, visibility, lastAttack } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)
  const { map, units, setUnits } = useMapState(mapId, visibility ?? lastAttack)
  const [pilots, setPilots] = useState<Pilot[]>([])
  const [mechs, setMechs] = useState<Mech[]>([])
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const [log, setLog] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = async () => {
    if (campaignId == null) return
    try {
      setPilots(await listPilots(campaignId))
      setMechs(await listMechs(campaignId))
      const all = await listCampaigns()
      setCampaign(all.find((c) => c.id === campaignId) ?? null)
    } catch {
      setError('No se pudo conectar con el servidor. Reintentando en la próxima acción.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refetch()
    getWeaponCatalog().then(setWeaponCatalog).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId])

  // useMapState's own map/units already refetch on every visibility_update
  // (broadcast on every unit move — see its own doc comment), but `mechs`
  // is separate local state here, only ever refreshed at explicit GM
  // action points otherwise. That left the mech sheet (heat, armor,
  // MP penalties) showing stale data after anything that changes a mech
  // without the GM personally triggering a refetch — a movement-phase
  // move generating heat, most visibly (the sheet's HeatScale/penalties
  // never moved off 0 until some unrelated click happened to refetch).
  // PlayerView already refetches its own mechs on this same trigger.
  // lastAttack is ALSO a trigger here, not just visibility — a hit
  // updates armor/heat, but a MISS still changes heat (see combat.py's
  // resolve_attack: heat is added whether the shot lands or not) with no
  // damage at all, meaning attack_result can arrive with no accompanying
  // visibility_update semantically tied to armor (visibility_update
  // fires on every attack regardless, but relying on a single trigger
  // for two different reasons this state needs refreshing was fragile).
  // PlayerView's own equivalent effect already includes both — this
  // brings GMView in line with it.
  useEffect(() => {
    if (visibility || lastAttack) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility, lastAttack])

  const pushLog = (line: string) => setLog((l) => [line, ...l].slice(0, 12))

  // Every resolved attack, logged from the attack_result broadcast
  // itself rather than from whichever local flow happened to fire it —
  // the GM's own submitWeaponVolley used to push this line directly,
  // which meant an attack a PLAYER made (PlayerView's own volley, or the
  // 1st-person HUD's) never showed up in the GM's registry at all, since
  // nothing here ran for a shot GMView didn't personally initiate. This
  // fires for literally every attack in the campaign, GM or player.
  useEffect(() => {
    if (!lastAttack) return
    const targetChassis = mechs.find((m) => m.id === lastAttack.target_mech_id)?.chassis ?? `mech #${lastAttack.target_mech_id}`
    if (lastAttack.hit) {
      pushLog(
        `${lastAttack.weapon_name ?? 'Ataque'} → ${targetChassis}: impacto en ${lastAttack.location}${lastAttack.critical ? ' (¡crítico!)' : ''} — tirada ${lastAttack.roll} vs ${lastAttack.target_number}` +
          (lastAttack.mech_destroyed ? ' — MECH DESTRUIDO' : ''),
      )
    } else {
      pushLog(`${lastAttack.weapon_name ?? 'Ataque'} → ${targetChassis}: fallo — tirada ${lastAttack.roll} vs ${lastAttack.target_number}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttack])

  // Attack VFX (laser/PPC/tracer/missile/flamer) — only real board shots
  // carry attacker_unit_id/target_unit_id (see combat.py's
  // resolve_attack), so a narrative/manual attack with no real units
  // just plays no animation. Queued (see useAttackVfxQueue's own doc
  // comment) so a fast attack resolving while a slower one is still
  // animating doesn't cut the first one's VFX off mid-flight.
  const { activeAttack: activeAttackVfx, onAttackEffectDone } = useAttackVfxQueue(lastAttack, units)

  // ---- pilot form (now lives inside a modal opened from the sidebar's
  // "+" button, not an always-visible inline section) ----
  const [showPilotModal, setShowPilotModal] = useState(false)
  const [pilotName, setPilotName] = useState('')
  const [pilotCallsign, setPilotCallsign] = useState('')
  const [gunnery, setGunnery] = useState(4)
  const [piloting, setPiloting] = useState(5)
  const [pilotFaction, setPilotFaction] = useState<Faction>('player')
  const [pilotColor, setPilotColor] = useState(suggestPilotColor(0))

  const submitPilot = async () => {
    if (!campaignId || !pilotName) return
    try {
      const p = await createPilot(campaignId, {
        name: pilotName,
        callsign: pilotCallsign || undefined,
        gunnery,
        piloting,
        faction: pilotFaction,
        color: pilotColor,
      })
      pushLog(`Piloto creado: ${p.name} (${FACTION_LABELS[p.faction]}, gunnery ${p.gunnery}/piloting ${p.piloting})`)
      setPilotName('')
      setPilotCallsign('')
      setShowPilotModal(false)
      refetch()
    } catch {
      setError('No se pudo crear el piloto.')
    }
  }

  // ---- mech form: chassis → model → pilot, three dropdowns over the
  // local catalog (app/mech_templates.py) instead of typing tonnage/
  // armor/structure by hand — everything else is derived from the
  // chosen model. Lives inside a modal opened from the sidebar's "+"
  // button; a pilot is mandatory here (unlike the old inline form's
  // "sin piloto" default) since the whole point of this modal is
  // pairing a chassis with a pilot in one step. ----
  const [showMechModal, setShowMechModal] = useState(false)
  const [chassis, setChassis] = useState('')
  const [model, setModel] = useState('')
  const [tonnage, setTonnage] = useState(50)
  const [walkMp, setWalkMp] = useState(4)
  const [runMp, setRunMp] = useState(6)
  const [heatSinks, setHeatSinks] = useState(10)
  const [mechPilotId, setMechPilotId] = useState<number | ''>('')
  const [locations, setLocations] = useState(emptyLocationsForm())
  const [pendingWeapons, setPendingWeapons] = useState<{ weapon_name: string; location: string }[]>([])
  const [pendingEquipment, setPendingEquipment] = useState<{ equipment_name: string; location: string }[]>([])
  const [pendingCriticals, setPendingCriticals] = useState<Record<string, string[]>>({})

  const [chassisOptions, setChassisOptions] = useState<string[]>([])
  const [selectedChassis, setSelectedChassis] = useState('')
  const [modelOptions, setModelOptions] = useState<MechModelResult[]>([])
  const [selectedModelFile, setSelectedModelFile] = useState('')

  useEffect(() => {
    listMechChassis().then(setChassisOptions).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedChassis) {
      setModelOptions([])
      return
    }
    listMechModels(selectedChassis).then(setModelOptions).catch(() => setModelOptions([]))
    setSelectedModelFile('')
  }, [selectedChassis])

  const importMech = (data: MechImportData) => {
    setChassis(data.chassis)
    setModel(data.model)
    setTonnage(data.tonnage)
    setWalkMp(data.walk_mp)
    setRunMp(data.run_mp)
    setHeatSinks(data.heat_sinks)
    setLocations(locationsFormFromMechLocationIn(data.locations))
    setPendingWeapons(data.weapons)
    setPendingEquipment(data.equipment)
    setPendingCriticals(data.criticals)
  }

  useEffect(() => {
    if (!selectedModelFile) return
    getMechImport(selectedModelFile).then(importMech).catch(() => setError('No se pudo cargar ese modelo del catálogo.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModelFile])

  const submitMech = async () => {
    if (!campaignId || !chassis || mechPilotId === '') return
    try {
      const locs = buildMechLocationsPayload(locations)
      const m = await createMech(campaignId, {
        chassis,
        model: model || undefined,
        tonnage,
        walk_mp: walkMp,
        run_mp: runMp,
        heat_sinks: heatSinks,
        pilot_id: mechPilotId,
        locations: locs,
        criticals: Object.keys(pendingCriticals).length > 0 ? pendingCriticals : undefined,
      })
      pushLog(`Mech creado: ${m.chassis} ${m.model ?? ''} (#${m.id})`)
      for (const w of pendingWeapons) {
        await addMechWeapon(m.id, w.weapon_name, w.location).catch(() => {
          pushLog(`No se pudo montar ${w.weapon_name} (¿arma no soportada?)`)
        })
      }
      if (pendingWeapons.length > 0) pushLog(`${pendingWeapons.length} armas montadas desde la importación`)
      for (const eq of pendingEquipment) {
        await addMechEquipment(m.id, eq.equipment_name, eq.location).catch(() => {
          pushLog(`No se pudo montar ${eq.equipment_name} (¿equipo no soportado?)`)
        })
      }
      if (pendingEquipment.length > 0) pushLog(`${pendingEquipment.length} piezas de equipo montadas desde la importación`)
      // Not placed on the map here — the mech now shows up as a sidebar
      // card the GM drags onto the map whenever they're ready for it (see
      // startSidebarMechDrag/placeMechOnMap).
      setChassis('')
      setModel('')
      setSelectedChassis('')
      setSelectedModelFile('')
      setMechPilotId('')
      setPendingWeapons([])
      setPendingEquipment([])
      setPendingCriticals({})
      setShowMechModal(false)
      refetch()
    } catch {
      setError('No se pudo crear el mech. Revisa que armadura/estructura sean números válidos.')
    }
  }

  // ---- revisión de fichas pendientes ----
  const [rejectingPilotId, setRejectingPilotId] = useState<number | null>(null)
  const [rejectingMechId, setRejectingMechId] = useState<number | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const approvePilot = async (id: number) => {
    await reviewPilot(id, 'approved')
    refetch()
  }
  const submitRejectPilot = async (id: number) => {
    await reviewPilot(id, 'rejected', rejectNote || undefined)
    setRejectingPilotId(null)
    setRejectNote('')
    refetch()
  }
  const approveMech = async (id: number) => {
    await reviewMech(id, 'approved')
    refetch()
  }
  const submitRejectMech = async (id: number) => {
    await reviewMech(id, 'rejected', rejectNote || undefined)
    setRejectingMechId(null)
    setRejectNote('')
    refetch()
  }

  const pendingPilots = pilots.filter((p) => p.status === 'pending')
  const pendingMechs = mechs.filter((m) => m.status === 'pending')

  const submitUndo = async () => {
    if (!campaignId) return
    try {
      await undoLastAction(campaignId)
      pushLog('Última acción deshecha')
      refetch()
    } catch {
      pushLog('No hay nada que deshacer')
    }
  }

  const submitStartRound = async () => {
    if (!campaignId) return
    try {
      const r = await startRound(campaignId)
      // Individual mode starts every round with zero rolls now (manual
      // per-pilot rolling) — nothing to list yet, unlike team mode which
      // still rolls both sides atomically right here.
      pushLog(
        r.mode === 'individual'
          ? `Ronda ${r.round_number} — esperando iniciativas`
          : `Ronda ${r.round_number} — ${r.rolls.map(formatRoll).join(', ')}`,
      )
    } catch {
      setError('No se pudo empezar la ronda.')
    }
  }

  const submitInitiativeMode = async (mode: InitiativeMode) => {
    if (!campaignId) return
    try {
      const c = await setInitiativeMode(campaignId, mode)
      setCampaign(c)
    } catch {
      setError('No se pudo cambiar el modo de iniciativa.')
    }
  }

  const submitMarkActed = async (pilotId: number) => {
    if (!campaignId) return
    try {
      await markRoundActed(campaignId, pilotId)
    } catch {
      setError('No se pudo marcar la activación.')
    }
  }

  // ---- mapa interactivo: clic en un mech → menú (Atacar, solo si ese
  // piloto todavía tiene un objetivo real esta fase — rounds.ts's
  // activeAttackPilotIds, NO el orden de iniciativa: un piloto sin
  // objetivo (sin alcance/LoS/munición) nunca bloquea el turno de nadie,
  // ver su propio comentario), o arrastrarlo libremente (sin gating — el
  // GM siempre puede reposicionar la miniatura). ----
  const canAct = (unit: Unit) =>
    unit.pilot_id != null && roundState != null && activeAttackPilotIds(roundState).has(unit.pilot_id)
  const mechForUnit = (unit: Unit) => mechs.find((m) => m.id === unit.mech_id) ?? null

  // ---- iniciativa manual por piloto (modo individual únicamente — modo
  // equipo sigue tirando ambos bandos automáticamente al empezar ronda,
  // sin botón ni resaltado). El GM tira la de sus enemigos; cada jugador
  // tira la suya propia desde su ficha (PlayerView). ----
  const rolledPilotIds = new Set((roundState?.rolls ?? []).map((r) => r.pilot_id).filter((id): id is number => id != null))
  const needsInitiative = (pilotId: number | null) =>
    campaign?.initiative_mode === 'individual'
    && (roundState?.round_number ?? 0) > 0
    && pilotId != null
    && !rolledPilotIds.has(pilotId)
  // Tile highlight — every pilot still waiting to roll, not just the
  // enemies the GM personally rolls for (needsInitiative above stays
  // enemy-scoped, that's still only about which "Tirar iniciativa"
  // button is enabled).
  const needsInitiativePilotIds = pilotsNeedingInitiative(roundState, units)
  // Doesn't roll anything here — asks the shared table (TableView) to
  // physically throw dice for this pilot; the real value comes back
  // later over WS (round_updated), landing in roundState.rolls the same
  // way any other roll does, and the chips list below already renders
  // that reactively — no separate log line needed for the request itself.
  const rollInitiativeForPilot = async (pilotId: number) => {
    if (!campaignId) return
    const p = pilots.find((pl) => pl.id === pilotId)
    try {
      await requestInitiative(campaignId, pilotId)
      if (p) pushLog(`${p.callsign || p.name}: tira los dados en la Vista de Mesa…`)
    } catch {
      setError('No se pudo pedir la tirada de iniciativa.')
    }
  }
  const mechFactionColor = (m: Mech) => {
    const faction = pilots.find((p) => p.id === m.pilot_id)?.faction
    return faction ? FACTION_COLORS[faction] : NEUTRAL_UNIT_COLOR
  }
  // Once a mech has a pilot, the sidebar card names the pilot flying it
  // (callsign if they have one, else their name) rather than the chassis
  // — "who's in it" reads faster than "what it is" once that's decided.
  const mechCardName = (m: Mech) => {
    const pilot = pilots.find((p) => p.id === m.pilot_id)
    const chassisModel = `${m.chassis} ${m.model ?? ''}`.trim()
    return pilot ? `${pilot.callsign || pilot.name} - ${chassisModel}` : chassisModel
  }

  const [menu, setMenu] = useState<{ unit: Unit; x: number; y: number } | null>(null)
  const [isDraggingUnit, setIsDraggingUnit] = useState(false)
  const [pickingTargetFor, setPickingTargetFor] = useState<number | null>(null)
  // Every enemy this specific attacker can currently detect (facing cone
  // + LOS — same data FirstPersonView's own HUD already fetches), before
  // narrowing to which of those are actually valid targets (real weapon
  // range for ranged, adjacency for melee — see targetableHexes below).
  // Refetched fresh each time a new attacker starts picking a target.
  const [targetableEnemies, setTargetableEnemies] = useState<VisibleEnemy[]>([])
  useEffect(() => {
    if (pickingTargetFor == null) {
      setTargetableEnemies([])
      return
    }
    let cancelled = false
    getUnitVisibleEnemies(pickingTargetFor).then((enemies) => {
      if (!cancelled) setTargetableEnemies(enemies)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pickingTargetFor])
  // Danger-red tile wash (HexMap's targetableHexes prop) — narrows
  // targetableEnemies down to whoever's actually reachable: real weapon
  // long-range (any mounted weapon still carrying ammo) during the
  // ranged phase, plain adjacency during melee. The server is still the
  // real authority (a rejected shot still 422s) — this is a preview, not
  // a second source of truth.
  const targetableHexes = (() => {
    if (pickingTargetFor == null || !roundState) return new Set<string>()
    const attackerMech = mechs.find((m) => m.id === units.find((u) => u.id === pickingTargetFor)?.mech_id)
    const phase = currentPhase(roundState)
    const filtered =
      phase === 'melee'
        ? targetableEnemies.filter((e) => e.distance <= 1)
        : targetableEnemies.filter((e) => {
            const longRanges = (attackerMech?.weapons ?? [])
              .filter((w) => w.ammo_remaining !== 0)
              .map((w) => weaponCatalog[w.weapon_name]?.long ?? 0)
            const maxRange = longRanges.length > 0 ? Math.max(...longRanges) : 0
            return e.distance <= maxRange
          })
    return new Set(filtered.map((e) => `${e.q},${e.r}`))
  })()
  const [attackPanel, setAttackPanel] = useState<{ attacker: Unit; target: Unit } | null>(null)
  // A unit was just dropped (dragged on the map, or dragged in from the
  // sidebar) — before actually committing the move, let the GM pick
  // which way it ends up facing instead of it silently keeping whatever
  // facing it had before (or defaulting to 0° for a brand-new unit).
  // movementType present = this drop came from the movement-phase
  // Caminar/Correr/Saltar flow (moveUnitWithMp, MP-restricted); absent =
  // the free-form drag/"Mover" flow (submitMoveUnit, unrestricted) —
  // resolvePendingFacing below branches on it.
  // path/allowedFacings (movement-phase moves only, from the ReachableHex
  // the GM actually clicked) let resolvePendingFacing hand the real route
  // to walkPaths for HexMap to walk, and FacingPicker disables whichever
  // final facings the remaining MP budget couldn't actually afford at
  // this destination — see ReachableHex's own doc comment in api.ts.
  type PendingFacing =
    | ({ kind: 'move'; unit: Unit; movementType?: MovementType; path?: { q: number; r: number }[]; allowedFacings?: number[] } & { q: number; r: number; x: number; y: number })
    | ({ kind: 'place'; mech: Mech } & { q: number; r: number; x: number; y: number })
    | null
  const [pendingFacing, setPendingFacing] = useState<PendingFacing>(null)
  // The real route for whichever unit(s) currently have a movement-phase
  // move in flight, keyed by unit id — threaded to HexMap's walkPaths so
  // the mech walks the actual calculated path instead of a straight line.
  const [walkPaths, setWalkPaths] = useState<Map<number, { q: number; r: number }[]>>(new Map())

  const submitMoveUnit = async (unit: Unit, q: number, r: number, markActed: boolean, facingDeg?: number) => {
    // Optimistic: the marker already visually followed the drag to (q, r)
    // while dragging — patch local state to match immediately instead of
    // letting it snap back to the stale fetched position and wait for the
    // move request + WS-triggered refetch to catch up a moment later.
    setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}) } : u)))
    try {
      await moveUnit(unit.id, q, r, facingDeg)
      pushLog(`#${unit.id} movido a (${q}, ${r})`)
      if (markActed && unit.pilot_id != null) await submitMarkActed(unit.pilot_id)
    } catch {
      setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q: unit.q, r: unit.r } : u)))
      setError('No se pudo mover la unidad.')
    }
  }

  const submitPhaseMove = async (unit: Unit, q: number, r: number, movementType: MovementType, facingDeg?: number, path?: { q: number; r: number }[]) => {
    // Populate walkPaths BEFORE the optimistic q/r update lands, so the
    // very first render with the new position already has the route to
    // walk instead of a straight line for one frame.
    if (path && path.length > 0) {
      setWalkPaths((prev) => new Map(prev).set(unit.id, path))
    }
    setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}) } : u)))
    try {
      await moveUnitWithMp(unit.id, q, r, movementType, facingDeg)
      pushLog(`#${unit.id} se movió (${movementType}) a (${q}, ${r})`)
    } catch {
      setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q: unit.q, r: unit.r } : u)))
      setError('No se pudo mover la unidad.')
    }
  }

  const resolvePendingFacing = (facingDeg?: number) => {
    if (!pendingFacing) return
    if (pendingFacing.kind === 'move') {
      if (pendingFacing.movementType) submitPhaseMove(pendingFacing.unit, pendingFacing.q, pendingFacing.r, pendingFacing.movementType, facingDeg, pendingFacing.path)
      else submitMoveUnit(pendingFacing.unit, pendingFacing.q, pendingFacing.r, false, facingDeg)
    } else placeMechOnMap(pendingFacing.mech, pendingFacing.q, pendingFacing.r, facingDeg)
    setPendingFacing(null)
  }

  // ---- sidebar mech cards: click opens a small menu (Ver Ficha/Editar/
  // Eliminar); click-and-drag onto the map places (or repositions) it
  // there. The drag itself is plain window mouse tracking (the card is a
  // normal DOM element, not something r3f's canvas raycasting ever sees)
  // — a CameraBridge rendered inside the Canvas hands back a
  // screen→ground raycast function once r3f's camera is ready. ----
  // An id, not a snapshot Mech object — "Ver ficha" used to stash the
  // Mech object itself, which then never picked up later changes (heat,
  // armor/structure from an attack) since it kept pointing at the stale
  // object even after `mechs` refetched with fresh data under a new
  // array reference. Deriving the live mech from `mechs` on every render
  // (viewingMech below) means the open sheet modal always reflects
  // whatever `mechs` currently holds.
  const [viewingMechId, setViewingMechId] = useState<number | null>(null)
  const viewingMech = viewingMechId != null ? mechs.find((m) => m.id === viewingMechId) ?? null : null
  const [pilotMenu, setPilotMenu] = useState<{ pilot: Pilot; x: number; y: number } | null>(null)
  const [mechMenu, setMechMenu] = useState<{ mech: Mech; x: number; y: number } | null>(null)
  const [draggingSidebarMech, setDraggingSidebarMech] = useState<Mech | null>(null)
  const [sidebarDragPos, setSidebarDragPos] = useState<{ x: number; y: number } | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const raycastToGroundRef = useRef<((clientX: number, clientY: number) => [number, number] | null) | null>(null)

  // ---- editar/eliminar (from the pilot/mech menus above) ----
  const [editingPilot, setEditingPilot] = useState<Pilot | null>(null)
  const [editPilotName, setEditPilotName] = useState('')
  const [editPilotCallsign, setEditPilotCallsign] = useState('')
  const [editGunnery, setEditGunnery] = useState(4)
  const [editPiloting, setEditPiloting] = useState(5)
  const [editPilotFaction, setEditPilotFaction] = useState<Faction>('player')
  const [editPilotColor, setEditPilotColor] = useState('#9aa4a2')
  const [editingMech, setEditingMech] = useState<Mech | null>(null)
  const [editMechPilotId, setEditMechPilotId] = useState<number | ''>('')
  const [confirmDeletePilot, setConfirmDeletePilot] = useState<Pilot | null>(null)
  const [confirmDeleteMech, setConfirmDeleteMech] = useState<Mech | null>(null)

  const openEditPilot = (p: Pilot) => {
    setEditingPilot(p)
    setEditPilotName(p.name)
    setEditPilotCallsign(p.callsign ?? '')
    setEditGunnery(p.gunnery)
    setEditPiloting(p.piloting)
    setEditPilotFaction(p.faction)
    setEditPilotColor(p.color)
  }

  const submitEditPilot = async () => {
    if (!editingPilot) return
    try {
      await updatePilot(editingPilot.id, {
        name: editPilotName,
        callsign: editPilotCallsign || undefined,
        gunnery: editGunnery,
        piloting: editPiloting,
        faction: editPilotFaction,
        color: editPilotColor,
      })
      pushLog(`Piloto actualizado: ${editPilotName}`)
      setEditingPilot(null)
      refetch()
    } catch {
      setError('No se pudo actualizar el piloto.')
    }
  }

  const openEditMech = (m: Mech) => {
    setEditingMech(m)
    setEditMechPilotId(m.pilot_id ?? '')
  }

  const submitEditMech = async () => {
    if (!editingMech || editMechPilotId === '') return
    try {
      await updateMech(editingMech.id, { pilot_id: editMechPilotId })
      pushLog(`Mech actualizado: ${editingMech.chassis}`)
      setEditingMech(null)
      refetch()
    } catch {
      setError('No se pudo actualizar el mech.')
    }
  }

  const submitDeletePilot = async () => {
    if (!confirmDeletePilot) return
    try {
      await deletePilot(confirmDeletePilot.id)
      pushLog(`Piloto eliminado: ${confirmDeletePilot.name}`)
      setConfirmDeletePilot(null)
      refetch()
    } catch {
      setError('No se pudo eliminar el piloto.')
    }
  }

  const submitDeleteMech = async () => {
    if (!confirmDeleteMech) return
    try {
      await deleteMech(confirmDeleteMech.id)
      pushLog(`Mech eliminado: ${confirmDeleteMech.chassis}`)
      // delete_mech also removes any of its units server-side (see
      // app/mechs.py) — no WS broadcast for it, so drop them locally too.
      setUnits((prev) => prev.filter((u) => u.mech_id !== confirmDeleteMech.id))
      setConfirmDeleteMech(null)
      refetch()
    } catch {
      setError('No se pudo eliminar el mech.')
    }
  }

  const placeMechOnMap = async (mech: Mech, q: number, r: number, facingDeg?: number) => {
    if (mapId == null) return
    const existingUnit = units.find((u) => u.mech_id === mech.id)
    if (existingUnit) {
      submitMoveUnit(existingUnit, q, r, false, facingDeg)
      return
    }
    try {
      const created = await createUnit(mapId, {
        q, r, mech_id: mech.id, pilot_id: mech.pilot_id ?? undefined, ...(facingDeg != null ? { facing_deg: facingDeg } : {}),
      })
      setUnits((prev) => [...prev, created])
      pushLog(`#${mech.id} colocado en el mapa`)
    } catch {
      setError('No se pudo colocar el mech en el mapa.')
    }
  }

  const startSidebarMechDrag = (mech: Mech, pointerId: number, startX: number, startY: number) => {
    // Pointer Events, not mouse events — a touch drag on mobile doesn't
    // reliably fire mousedown/mousemove/mouseup at all (real user report:
    // a fast drag did nothing), and without a pointer sequence of our own
    // to consume the gesture, a slow press falls through to the browser's
    // native long-press-for-context-menu instead ("entiende que estoy
    // haciendo botón derecho"). Pointer Events fire the same way for
    // mouse/touch/pen, so one handler covers both — see the
    // touch-action: none on .entity-card-draggable (GMView.css) and the
    // pointerdown preventDefault below, both needed to actually stop the
    // browser's own touch gesture from competing with this one.
    let dragging = false
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 6) {
        dragging = true
        setDraggingSidebarMech(mech)
      }
      if (dragging) setSidebarDragPos({ x: e.clientX, y: e.clientY })
    }
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (dragging && e.type === 'pointerup') {
        const container = mapContainerRef.current
        if (container && raycastToGroundRef.current && map) {
          const rect = container.getBoundingClientRect()
          const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
          const hit = inside ? raycastToGroundRef.current(e.clientX, e.clientY) : null
          if (hit) {
            const [cx, cz] = mapCenter(map.tiles)
            const { q, r } = worldToHex(hit[0] + cx, hit[1] + cz)
            setPendingFacing({ kind: 'place', mech, q, r, x: e.clientX, y: e.clientY })
          }
        }
      } else if (!dragging && e.type === 'pointerup') {
        setMechMenu({ mech, x: e.clientX, y: e.clientY })
      }
      setDraggingSidebarMech(null)
      setSidebarDragPos(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const onUnitClick = (unit: Unit, x: number, y: number) => {
    if (pickingTargetFor != null && pickingTargetFor !== unit.id) {
      const attacker = units.find((u) => u.id === pickingTargetFor)
      setPickingTargetFor(null)
      if (attacker) setAttackPanel({ attacker, target: unit })
      return
    }
    setMenu({ unit, x, y })
  }

  // Only picking a movement-phase destination left here now — the old
  // unrestricted "click anywhere to reposition" pick (pickingMoveFor)
  // went away with the Mover button that started it (see
  // UnitContextMenu's own doc comment for why).
  const onTileClick = (q: number, r: number, clientX: number, clientY: number) => {
    if (movementHighlight == null) return
    const key = `${q},${r}`
    const hex = movementHighlight.hexes.get(key)
    if (hex) {
      const { unitId, movementType } = movementHighlight
      const unit = units.find((u) => u.id === unitId)
      setMovementHighlight(null)
      // Same "pick a final facing" step as the free-form drag/place
      // flows below — resolvePendingFacing branches on movementType to
      // call moveUnitWithMp (MP-restricted) instead of submitMoveUnit.
      // path/allowedFacings ride along so the walk animation follows the
      // real route and FacingPicker only offers affordable facings.
      if (unit) {
        setPendingFacing({
          kind: 'move', unit, movementType, q, r, x: clientX, y: clientY,
          path: hex.path, allowedFacings: hex.facings,
        })
      }
    }
    // A click outside the highlighted set just cancels the pick.
    setMovementHighlight(null)
  }

  // ---- fase de movimiento (requested directly — se activa sola en
  // cuanto todos han tirado iniciativa, empezando por quien menos sacó;
  // ver rounds.ts's activeMoverPilotId / turns.py's movement_order). El
  // GM usa su propio mapa embebido, ya interactivo, en vez del mecanismo
  // de difusión que usa PlayerView (que no tiene mapa propio). ----
  const [movementHighlight, setMovementHighlight] = useState<
    { unitId: number; movementType: MovementType; hexes: Map<string, ReachableHex> } | null
  >(null)
  const activeMover = roundState ? activeMoverPilotId(roundState) : null
  const startPhaseMovement = async (unit: Unit, movementType: MovementType) => {
    try {
      // requestMovement (not the plain getReachableHexes fetch) so this
      // ALSO broadcasts movement_started — the shared table shows the
      // highlight regardless of whether the GM or the player picked the
      // movement type, not just player-initiated moves.
      const { hexes } = await requestMovement(unit.id, movementType)
      setMovementHighlight({ unitId: unit.id, movementType, hexes: new Map(hexes.map((h) => [`${h.q},${h.r}`, h])) })
    } catch {
      setError('No se pudieron calcular las casillas alcanzables.')
    }
  }

  const onUnitDragEnd = (unit: Unit, q: number, r: number, clientX: number, clientY: number) => {
    setPendingFacing({ kind: 'move', unit, q, r, x: clientX, y: clientY })
  }

  // Volley = every weapon toggled on in WeaponVolleyPanel, fired one at a
  // time against the same fixed attacker/target — sequential (not
  // Promise.all) on purpose: each shot's heat has to land before the
  // next one's to-hit penalty is computed (see combat.py's own
  // resolve_attack docstring), and a rejected shot (out of range/no LOS
  // for THAT weapon specifically) shouldn't abort the rest of the
  // volley, just get logged and skipped.
  //
  // The hit/miss line itself is NOT pushed here — see the lastAttack
  // effect below, which logs every attack_result broadcast regardless of
  // who fired it. Logging it here too used to double it up for the GM's
  // own shots, and (the actual bug report) meant a PLAYER's attack never
  // appeared in the GM's registry at all, since nothing here ever ran
  // for a shot GMView didn't itself initiate.
  const [firingVolley, setFiringVolley] = useState(false)
  const submitWeaponVolley = async (weaponIds: number[]) => {
    if (!campaignId || !attackPanel) return
    setFiringVolley(true)
    for (const weaponId of weaponIds) {
      try {
        await attack(campaignId, {
          attacker_unit_id: attackPanel.attacker.id,
          target_unit_id: attackPanel.target.id,
          weapon_id: weaponId,
        })
      } catch {
        pushLog(`Un arma no pudo disparar (fuera de alcance, sin munición o sin línea de visión).`)
      }
    }
    if (attackPanel.attacker.pilot_id != null) await submitMarkActed(attackPanel.attacker.pilot_id)
    setFiringVolley(false)
    setAttackPanel(null)
    refetch()
  }

  if (campaignId == null) return <div className="gm-view">preparando campaña…</div>

  return (
    <div className="gm-view">
      <NavBar campaignId={campaignId} current="/gm" links={GM_NAV_LINKS} />
      <h1>GM — {campaign?.name ?? `campaña #${campaignId}`}</h1>
      {loading && <p className="loading">Cargando…</p>}
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="gm-layout">
      <aside className="gm-sidebar">
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <h2>Pilotos</h2>
            <button className="add-btn" onClick={() => { setPilotColor(suggestPilotColor(pilots.length)); setShowPilotModal(true) }}>+</button>
          </div>
          <div className="card-list">
            {pilots.map((p) => (
              <Tooltip key={p.id} content={<>G{p.gunnery}/P{p.piloting}</>}>
                <div
                  className="entity-card"
                  onClick={(e) => setPilotMenu({ pilot: p, x: e.clientX, y: e.clientY })}
                >
                  <span className="entity-card-name">{p.name}{p.callsign && ` "${p.callsign}"`}</span>
                  <span className={`faction-tag faction-${p.faction}`}>{FACTION_LABELS[p.faction]}</span>
                  {p.status !== 'approved' && <span className={`status-tag status-${p.status}`}>{p.status}</span>}
                </div>
              </Tooltip>
            ))}
          </div>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <h2>Mechs</h2>
            <button className="add-btn" onClick={() => setShowMechModal(true)}>+</button>
          </div>
          <div className="card-list">
            {mechs.map((m) => {
              const ct = m.locations.find((l) => l.location === 'CT')
              return (
                <Tooltip
                  key={m.id}
                  content={
                    <>
                      CT {ct?.structure_current}/{ct?.structure_max} — calor {m.heat_current}/{m.heat_sinks}
                      {m.weapons.length > 0 && <><br />{m.weapons.map((w) => w.weapon_name).join(', ')}</>}
                    </>
                  }
                >
                  <div
                    className="entity-card entity-card-draggable"
                    style={{ '--entity-faction-color': mechFactionColor(m) } as CSSProperties}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      // Best-effort only — startSidebarMechDrag already
                      // listens on `window`, not this element, so capture
                      // isn't load-bearing for it to work. Some mobile
                      // browsers (iOS Safari has a history of flaky
                      // support) can throw here; since this call isn't
                      // wrapped, an uncaught throw would abort the handler
                      // before startSidebarMechDrag ever runs — the same
                      // "fast drag does nothing" symptom this is meant to
                      // fix, just from a different cause.
                      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* non-fatal, see above */ }
                      startSidebarMechDrag(m, e.pointerId, e.clientX, e.clientY)
                    }}
                    // touch-action: none (GMView.css) stops the browser from
                    // treating the gesture as a scroll, but a slow press
                    // still fires a native `contextmenu` event on Android —
                    // that's the actual "se interpreta como botón derecho"
                    // real users hit, a separate thing from the pointer
                    // events above, and the one thing a synthetic
                    // PointerEvent test (dispatchEvent in a script) can
                    // never reproduce, since it skips the browser's own
                    // touch-and-hold gesture recognizer entirely.
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    <span className="entity-card-name">{mechCardName(m)}</span>
                    {m.status !== 'approved' && <span className={`status-tag status-${m.status}`}>{m.status}</span>}
                  </div>
                </Tooltip>
              )
            })}
          </div>
        </div>
      </aside>

      <div className="gm-main">
      <section>
        <h2>Ronda</h2>
        <div className="row">
          <span className="round-info">
            {roundState && roundState.round_number > 0
              ? `Ronda ${roundState.round_number} — Fase: ${PHASE_LABELS[currentPhase(roundState)]}`
              : 'Sin ronda empezada'}
          </span>
          <select
            value={campaign?.initiative_mode ?? 'team'}
            onChange={(e) => submitInitiativeMode(e.target.value as InitiativeMode)}
          >
            <option value="team">Por equipos (regla real)</option>
            <option value="individual">Individual (1 tirada por piloto)</option>
          </select>
          <button onClick={submitStartRound}>
            {roundState && roundState.round_number > 0 ? 'Siguiente ronda' : 'Empezar ronda'}
          </button>
        </div>

        {pickingTargetFor != null && (
          <div className="row">
            <span className="round-info">Elige un objetivo en el mapa…</span>
            <button onClick={() => setPickingTargetFor(null)}>Cancelar</button>
          </div>
        )}

        {mapId == null ? (
          <p className="round-info">Sin mapa activo — actívalo desde "Mapas".</p>
        ) : !map ? (
          <p className="round-info">Cargando mapa…</p>
        ) : (
          <div className="map-embed" ref={mapContainerRef}>
            <Canvas shadows camera={{ position: [0, 16, 0.01], fov: 40 }}>
              <color attach="background" args={['#0f1a18']} />
              <ambientLight intensity={0.6} />
              <directionalLight
                position={[4, 8, 3]} intensity={1.4} castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-camera-left={-30} shadow-camera-right={30}
                shadow-camera-top={30} shadow-camera-bottom={-30}
                shadow-camera-far={60}
              />
              <TableBackground />
              <CameraBridge onReady={(fn) => { raycastToGroundRef.current = fn }} />
              <Suspense fallback={null}>
                <HexMap
                  map={map}
                  units={units}
                  needsInitiativePilotIds={needsInitiativePilotIds}
                  activeMoverPilotId={activeMover}
                  activeAttackerPilotIds={roundState ? activeAttackPilotIds(roundState) : undefined}
                  moveHighlightHexes={movementHighlight ? new Set(movementHighlight.hexes.keys()) : undefined}
                  targetableHexes={targetableHexes}
                  walkPaths={walkPaths}
                  activeAttack={activeAttackVfx}
                  onAttackEffectDone={onAttackEffectDone}
                  onUnitClick={onUnitClick}
                  onTileClick={onTileClick}
                  onUnitDragEnd={onUnitDragEnd}
                  onDraggingChange={setIsDraggingUnit}
                />
              </Suspense>
              <OrbitControls enablePan enableRotate={!isDraggingUnit} minPolarAngle={0} maxPolarAngle={0} />
            </Canvas>
          </div>
        )}

        {roundState && roundState.round_number > 0 && roundState.rolls.length > 0 && (
          <ul className="chips round-rolls">
            {roundState.rolls.map((r, i) => (
              <li key={i}>{formatRoll(r)}</li>
            ))}
          </ul>
        )}
        {roundState && roundState.round_number > 0 && (
          <ul className="chips round-pilots">
            {pilots.map((p) => {
              const acted = roundState.acted_pilot_ids.includes(p.id)
              return (
                <li key={p.id}>
                  <button
                    className={acted ? 'acted' : ''}
                    onClick={() => submitMarkActed(p.id)}
                    disabled={acted}
                  >
                    {acted ? '✓ ' : ''}{p.name}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {(pendingPilots.length > 0 || pendingMechs.length > 0) && (
        <section>
          <h2>Fichas pendientes</h2>
          {pendingPilots.length > 0 && (
            <>
              <h3 className="step-label">Pilotos</h3>
              <ul className="chips review-list">
                {pendingPilots.map((p) => (
                  <li key={p.id}>
                    #{p.id} {p.name} {p.callsign && `"${p.callsign}"`} — G{p.gunnery}/P{p.piloting}
                    <button type="button" onClick={() => approvePilot(p.id)}>Aprobar</button>
                    <button type="button" onClick={() => setRejectingPilotId(p.id)}>Rechazar</button>
                    {rejectingPilotId === p.id && (
                      <div className="reject-form">
                        <textarea
                          placeholder="qué hay que corregir…"
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                        />
                        <button type="button" onClick={() => submitRejectPilot(p.id)}>Confirmar rechazo</button>
                        <button type="button" onClick={() => { setRejectingPilotId(null); setRejectNote('') }}>Cancelar</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {pendingMechs.length > 0 && (
            <>
              <h3 className="step-label">Mechs</h3>
              <ul className="chips review-list">
                {pendingMechs.map((m) => (
                  <li key={m.id}>
                    #{m.id} {m.chassis} {m.model} — {m.tonnage}t
                    <button type="button" onClick={() => approveMech(m.id)}>Aprobar</button>
                    <button type="button" onClick={() => setRejectingMechId(m.id)}>Rechazar</button>
                    {rejectingMechId === m.id && (
                      <div className="reject-form">
                        <textarea
                          placeholder="qué hay que corregir…"
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                        />
                        <button type="button" onClick={() => submitRejectMech(m.id)}>Confirmar rechazo</button>
                        <button type="button" onClick={() => { setRejectingMechId(null); setRejectNote('') }}>Cancelar</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      </div>
      </div>

      <section>
        <h2>Registro</h2>
        <button onClick={submitUndo} className="undo">Deshacer última acción</button>
        <ul className="log">
          {log.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </section>

      {showPilotModal && (
        <Modal title="Nuevo piloto" onClose={() => setShowPilotModal(false)}>
          <PilotForm
            name={pilotName} onName={setPilotName}
            callsign={pilotCallsign} onCallsign={setPilotCallsign}
            gunnery={gunnery} onGunnery={setGunnery}
            piloting={piloting} onPiloting={setPiloting}
            faction={pilotFaction} onFaction={setPilotFaction} showFaction
            color={pilotColor} onColor={setPilotColor}
            onSubmit={submitPilot} submitLabel="Crear piloto" submitDisabled={!pilotName}
          />
        </Modal>
      )}

      {showMechModal && (
        <Modal title="Nuevo mech" onClose={() => setShowMechModal(false)}>
          <div className="row">
            <select value={selectedChassis} onChange={(e) => setSelectedChassis(e.target.value)}>
              <option value="">chasis…</option>
              {chassisOptions.map((c) => (
                <option key={c} value={c}>{MECH_CHASSIS_ASSETS[c] ? `🛠️ ${c}` : c}</option>
              ))}
            </select>
            <select
              value={selectedModelFile}
              onChange={(e) => setSelectedModelFile(e.target.value)}
              disabled={modelOptions.length === 0}
            >
              <option value="">modelo…</option>
              {modelOptions.map((m) => <option key={m.file} value={m.file}>{m.model}</option>)}
            </select>
            <select value={mechPilotId} onChange={(e) => setMechPilotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">piloto… (obligatorio)</option>
              {pilots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <button onClick={submitMech} disabled={!chassis || mechPilotId === ''}>Guardar</button>
        </Modal>
      )}

      {viewingMech && (
        <Modal title={`${viewingMech.chassis} ${viewingMech.model ?? ''}`.trim()} onClose={() => setViewingMechId(null)}>
          <MechRecordSheet mech={viewingMech} weaponCatalog={weaponCatalog} readOnly />
        </Modal>
      )}

      {mechMenu && (() => {
        const menuPilot = pilots.find((p) => p.id === mechMenu.mech.pilot_id)
        const showRollInitiative = campaign?.initiative_mode === 'individual' && menuPilot?.faction === 'enemy'
        return (
          <DropdownMenu
            x={mechMenu.x} y={mechMenu.y}
            title={`${mechMenu.mech.chassis} ${mechMenu.mech.model ?? ''}`.trim()}
            onClose={() => setMechMenu(null)}
          >
            <button onClick={() => { setViewingMechId(mechMenu.mech.id); setMechMenu(null) }}>Ver ficha</button>
            {showRollInitiative && (
              <button
                disabled={!needsInitiative(menuPilot!.id)}
                onClick={() => { rollInitiativeForPilot(menuPilot!.id); setMechMenu(null) }}
              >
                Tirar iniciativa
              </button>
            )}
            <button onClick={() => { openEditMech(mechMenu.mech); setMechMenu(null) }}>Editar</button>
            <button className="danger" onClick={() => { setConfirmDeleteMech(mechMenu.mech); setMechMenu(null) }}>Eliminar</button>
          </DropdownMenu>
        )
      })()}

      {pilotMenu && (
        <DropdownMenu
          x={pilotMenu.x} y={pilotMenu.y}
          title={pilotMenu.pilot.name}
          onClose={() => setPilotMenu(null)}
        >
          <button onClick={() => { openEditPilot(pilotMenu.pilot); setPilotMenu(null) }}>Editar</button>
          <button className="danger" onClick={() => { setConfirmDeletePilot(pilotMenu.pilot); setPilotMenu(null) }}>Eliminar</button>
        </DropdownMenu>
      )}

      {editingPilot && (
        <Modal title={`Editar ${editingPilot.name}`} onClose={() => setEditingPilot(null)}>
          <PilotForm
            name={editPilotName} onName={setEditPilotName}
            callsign={editPilotCallsign} onCallsign={setEditPilotCallsign}
            gunnery={editGunnery} onGunnery={setEditGunnery}
            piloting={editPiloting} onPiloting={setEditPiloting}
            faction={editPilotFaction} onFaction={setEditPilotFaction} showFaction
            color={editPilotColor} onColor={setEditPilotColor}
            onSubmit={submitEditPilot} submitLabel="Guardar" submitDisabled={!editPilotName}
          />
        </Modal>
      )}

      {editingMech && (
        <Modal title={`Editar ${editingMech.chassis} ${editingMech.model ?? ''}`.trim()} onClose={() => setEditingMech(null)}>
          <div className="row">
            <select value={editMechPilotId} onChange={(e) => setEditMechPilotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">piloto…</option>
              {pilots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button onClick={submitEditMech} disabled={editMechPilotId === ''}>Guardar</button>
          </div>
        </Modal>
      )}

      {confirmDeletePilot && (
        <ConfirmDialog
          title="Eliminar piloto"
          message={`¿Seguro que quieres eliminar a ${confirmDeletePilot.name}? Sus mechs se quedarán sin piloto.`}
          onConfirm={submitDeletePilot}
          onCancel={() => setConfirmDeletePilot(null)}
        />
      )}

      {confirmDeleteMech && (
        <ConfirmDialog
          title="Eliminar mech"
          message={`¿Seguro que quieres eliminar ${confirmDeleteMech.chassis} ${confirmDeleteMech.model ?? ''}? Se quitará también del mapa si está colocado.`}
          onConfirm={submitDeleteMech}
          onCancel={() => setConfirmDeleteMech(null)}
        />
      )}

      {draggingSidebarMech && sidebarDragPos && (
        <div className="sidebar-drag-ghost" style={{ left: sidebarDragPos.x, top: sidebarDragPos.y }}>
          {draggingSidebarMech.chassis} {draggingSidebarMech.model}
        </div>
      )}

      {menu && (() => {
        const menuUnitPilot = pilots.find((p) => p.id === menu.unit.pilot_id)
        return (
          <UnitContextMenu
            unit={menu.unit}
            mech={mechForUnit(menu.unit)}
            canAct={canAct(menu.unit)}
            x={menu.x}
            y={menu.y}
            onAttack={() => { setPickingTargetFor(menu.unit.id); setMenu(null) }}
            onClose={() => setMenu(null)}
            showRollInitiative={campaign?.initiative_mode === 'individual' && menuUnitPilot?.faction === 'enemy'}
            canRollInitiative={menuUnitPilot != null && needsInitiative(menuUnitPilot.id)}
            onRollInitiative={() => { if (menuUnitPilot) rollInitiativeForPilot(menuUnitPilot.id); setMenu(null) }}
            showPhaseMovement={roundState?.movement_order.includes(menu.unit.pilot_id ?? -1) ?? false}
            canPhaseMove={menu.unit.pilot_id != null && activeMover === menu.unit.pilot_id}
            onPhaseMove={(type) => { startPhaseMovement(menu.unit, type); setMenu(null) }}
          />
        )
      })()}

      {attackPanel && mechForUnit(attackPanel.attacker) && (
        <WeaponVolleyPanel
          attackerMech={mechForUnit(attackPanel.attacker)!}
          target={attackPanel.target}
          targetMech={mechForUnit(attackPanel.target)}
          weaponCatalog={weaponCatalog}
          firing={firingVolley}
          onFire={submitWeaponVolley}
          onClose={() => setAttackPanel(null)}
        />
      )}

      {pendingFacing && (
        <FacingPicker
          x={pendingFacing.x}
          y={pendingFacing.y}
          onPick={resolvePendingFacing}
          onDismiss={() => resolvePendingFacing()}
          allowedFacings={pendingFacing.kind === 'move' ? pendingFacing.allowedFacings : undefined}
        />
      )}
    </div>
  )
}

/** D&D 5e's own GM screen (ROADMAP.md Fase R4 — slice mínimo). Much
 * smaller than GMViewBattletech on purpose: a square map (SquareMap.tsx,
 * not HexMap.tsx — see its own doc comment for why), a character
 * sheet/attack/initiative panel (DndCharacterSheet.tsx), and one
 * interaction this slice actually needs — clicking an empty tile places
 * whichever character is selected in the sheet. No move-after-placement,
 * no ghost tokens, no fog of war (see this Fase's own design notes in
 * ROADMAP.md) — placing IS the only board action a D&D character has
 * here beyond attacking. */
function GMViewDnd({ campaignId }: { campaignId: number }) {
  const { activeMapId } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)
  const { map, units, setUnits } = useMapState(mapId, null)
  const [characters, setCharacters] = useState<DndCharacter[]>([])
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listDndCharacters(campaignId)
      .then(setCharacters)
      .catch(() => setError('No se pudo conectar con el servidor.'))
  }, [campaignId])

  const placedCharacterIds = new Set(units.map((u) => u.dnd_character_id).filter((id): id is number => id != null))
  const selectedUnit = units.find((u) => u.dnd_character_id === selectedCharacterId)

  const onTileClick = async (q: number, r: number) => {
    if (mapId == null || selectedCharacterId == null || placedCharacterIds.has(selectedCharacterId)) return
    try {
      const unit = await createUnit(mapId, { q, r, dnd_character_id: selectedCharacterId })
      setUnits((prev) => [...prev, unit])
    } catch {
      setError('No se pudo colocar el personaje en el mapa.')
    }
  }

  return (
    <div className="gm-view">
      <NavBar campaignId={campaignId} current="/gm" links={GM_NAV_LINKS} />
      <div style={{ display: 'flex', height: 'calc(100vh - var(--nav-height, 52px))' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          {map ? (
            <Canvas shadows camera={{ position: [0, 16, 0.01], fov: 40 }}>
              <color attach="background" args={['#0f1a18']} />
              <ambientLight intensity={0.6} />
              <directionalLight position={[10, 20, 10]} intensity={1} castShadow />
              <SquareMap map={map} units={units} onTileClick={onTileClick} selectedUnitId={selectedUnit?.id ?? null} />
              <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} />
            </Canvas>
          ) : (
            <p style={{ padding: 20, color: 'var(--text-secondary)' }}>
              Sin mapa activo — crea uno cuadrado desde el editor de mapas.
            </p>
          )}
        </div>
        <div style={{ width: 360, padding: 12, overflowY: 'auto' }}>
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          {selectedCharacterId != null && !placedCharacterIds.has(selectedCharacterId) && (
            <p style={{ fontSize: 12, color: 'var(--accent-2)' }}>Click en una casilla del mapa para colocarlo.</p>
          )}
          <DndCharacterSheet
            campaignId={campaignId}
            characters={characters}
            selectedCharacterId={selectedCharacterId}
            onSelectCharacter={setSelectedCharacterId}
            onCharacterCreated={(c) => setCharacters((prev) => [...prev, c])}
          />
        </div>
      </div>
    </div>
  )
}

/** Real entry point (replaces the old direct `GMView` export) — decides
 * BattleTech vs D&D 5e from the campaign's own `system` and mounts the
 * matching screen. Defaults to the BattleTech path while the campaign
 * is still loading (system === null), so an existing BattleTech table
 * sees zero behavior change — the only new branch is the one that fires
 * once a `dnd5e` campaign is confirmed. */
export function GMView() {
  const campaignId = useCampaignId()
  const [system, setSystem] = useState<string | null>(null)

  useEffect(() => {
    if (campaignId == null) return
    let cancelled = false
    listCampaigns().then((all) => {
      const found = all.find((c) => c.id === campaignId)
      if (!cancelled) setSystem(found?.system ?? 'battletech')
    })
    return () => {
      cancelled = true
    }
  }, [campaignId])

  if (campaignId == null) return null
  if (system === 'dnd5e') return <GMViewDnd campaignId={campaignId} />
  return <GMViewBattletech />
}
