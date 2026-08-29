import { Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import { useMapState } from '../useMapState'
import { useTableSocket } from '../ws'
import { NavBar, GM_LINKS } from '../components/NavBar'
import { PilotForm } from '../components/PilotForm'
import { ChassisSelect } from '../components/ChassisSelect'
import { MechRecordSheet } from '../components/MechRecordSheet'
import { HexMap, useAttackVfxQueue } from '../components/HexMap'
import { SquareMap } from '../components/SquareMap'
import { DndCharacterSheet } from '../components/DndCharacterSheet'
import { TableBackground } from '../components/TableBackground'
import { UnitContextMenu } from '../components/UnitContextMenu'
import { FacingPicker } from '../components/FacingPicker'
import { DropdownMenu } from '../components/DropdownMenu'
import { WeaponVolleyPanel } from '../components/WeaponVolleyPanel'
import { MeleeAttackPanel } from '../components/MeleeAttackPanel'
import { Modal } from '../components/Modal'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Tooltip } from '../components/Tooltip'
import { CameraBridge } from '../components/CameraBridge'
import { DieStylePicker } from '../components/DieStylePicker'
import { SEVERABLE_LOCATIONS } from '../components/Mech3D'
import { MECH_CHASSIS_ASSETS } from '../mechAssets'
import { FACTION_COLORS, FACTION_LABELS, NEUTRAL_UNIT_COLOR, type Faction } from '../factions'
import { suggestPilotColor } from '../pilotColors'
import { DIE_STYLES, buildHeldByMap } from '../dieStyles'
import {
  activeAttackPilotIds, activeMoverPilotId, currentPhase, PHASE_LABELS, pilotsNeedingInitiative, useDisplayedPhase, useHeldActiveMover,
} from '../rounds'
import { HEX_SIZE, mapCenter, worldToHex } from '../hexMath'
import {
  buildMechLocationsPayload, emptyLocationsForm, locationsFormFromMechLocationIn,
} from '../characterSheet'
import {
  addMechEquipment,
  addMechWeapon,
  ApiError,
  attack,
  isPendingRollResult,
  createMech,
  createPilot,
  createUnit,
  deleteMech,
  deletePilot,
  deleteUnit,
  getMechImport,
  getUnitVisibleEnemies,
  getWeaponCatalog,
  listCampaigns,
  listCampaignEvents,
  listDndCharacters,
  listMechChassis,
  listMechModels,
  listMechs,
  listPilots,
  markRoundActed,
  moveUnit,
  moveUnitWithMp,
  passRoundPhase,
  resolveHeatPhase,
  reviewMech,
  requestInitiative,
  requestMovement,
  reviewPilot,
  fallOver,
  setEnemyRevealCinematic,
  setGmDiceMode,
  setGmDieStyle,
  setInitiativeMode,
  standUp,
  startRound,
  submitMeleeAttack,
  undoLastAction,
  updateMech,
  updateMechLocation,
  updatePilot,
  type Campaign,
  type CampaignEvent,
  type DndCharacter,
  type InitiativeMode,
  type Mech,
  type MechImportData,
  type MechChassisResult,
  type MechModelResult,
  type MeleeAttackType,
  type MovementType,
  type Pilot,
  type ReachableHex,
  type Unit,
  type VisibleEnemy,
  type WeaponStats,
} from '../api'
import './GMView.css'
import { PerfProbe } from '../components/PerfProbe'
import { PerfHud } from '../components/PerfHud'
import { FrameGate, useRenderPolicy } from '../components/RenderPolicy'

/** The BattleTech GM screen — everything this file did before Fase R4
 * (D&D 5e as a second system). Renamed, otherwise untouched: see the
 * real `GMView` export at the bottom of this file, which just decides
 * whether to mount this or GMViewDnd based on the campaign's system. */
function GMViewBattletech() {
  const campaignId = useCampaignId()
  const { activeMapId, roundState, visibility, lastAttack, lastMelee, rosterVersion, unitWalked, heatPhaseResult } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)
  const { map, units, setUnits } = useMapState(mapId, visibility ?? lastAttack)
  const [pilots, setPilots] = useState<Pilot[]>([])
  const [mechs, setMechs] = useState<Mech[]>([])
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const [campaignEvents, setCampaignEvents] = useState<CampaignEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = async () => {
    if (campaignId == null) return
    try {
      setPilots(await listPilots(campaignId))
      setMechs(await listMechs(campaignId))
      const all = await listCampaigns()
      setCampaign(all.find((c) => c.id === campaignId) ?? null)
      setCampaignEvents(await listCampaignEvents(campaignId))
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

  // Real user request: the Heat Phase resolves itself, no GM button —
  // the instant ranged/melee are both done and heat hasn't been resolved
  // yet this round (rounds.ts's currentPhase landing on 'heat'), this GM
  // screen (the one authoritative source for round progression already —
  // it's the only one with a "Siguiente ronda" button) calls the endpoint
  // itself. resolveHeatPhase is idempotent server-side (bt_rounds.
  // heat_resolved), so a second GM tab open on the same campaign calling
  // this too is a harmless no-op, not a double-resolution.
  useEffect(() => {
    if (!campaignId || !roundState) return
    if (currentPhase(roundState) !== 'heat') return
    resolveHeatPhase(campaignId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, roundState])

  // Real user request: "cuando llegue a final de ronda, automaticamente
  // tiene que pasar a la siguiente ronda de iniciativas" — same self-
  // driving pattern as the heat-phase effect just above: this GM screen
  // is the one authoritative source for round progression already (the
  // "Siguiente ronda" button's own submitStartRound calls this exact
  // same endpoint), so once currentPhase lands on 'other' (every phase
  // this round has to offer is done), it starts the next one itself
  // instead of waiting on a manual click. Safe against a second GM tab/a
  // re-fired effect the same way the heat one is: a successful call
  // advances round_number, which changes `roundState` and moves
  // currentPhase off 'other' on the very next render, so this can't
  // double-advance — it only ever fires again for a NEW round genuinely
  // reaching its own end.
  useEffect(() => {
    if (!campaignId || !roundState) return
    if (currentPhase(roundState) !== 'other') return
    startRound(campaignId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, roundState])

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
    if (visibility || lastAttack || lastMelee) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility, lastAttack, lastMelee])

  // "roster_updated" (app/main.py) — a pilot/mech was created, reviewed,
  // resubmitted, edited or deleted, by anyone (GM or any player). Without
  // this, a ficha a player just submitted (or a rejection the GM just
  // sent) never shows up until someone manually reloads the page (real
  // user report: "no se actualiza en tiempo real"). rosterVersion starts
  // at 0 and this only fires on a real change, so it never double-fetches
  // the mount-time refetch above.
  useEffect(() => {
    if (rosterVersion > 0) refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterVersion])

  // heat_phase_resolved carries the new heat_current directly — patched
  // into local mechs state immediately (rather than waiting on the next
  // refetch) so SteamPuffs and the mech sheet's HeatScale react the
  // instant the Heat Phase resolves, same reasoning as TableView's own
  // equivalent effect.
  useEffect(() => {
    if (!heatPhaseResult) return
    setMechs((prev) => prev.map((m) => {
      const r = heatPhaseResult.results.find((res) => res.mech_id === m.id)
      // is_shutdown patched too (real user report: the overheat tint
      // used to stay stale until some later, unrelated refetch) — see
      // HeatPhaseResolved's own doc comment on why heat_current alone
      // wasn't enough.
      return r ? { ...m, heat_current: r.heat_current, is_shutdown: r.is_shutdown, destroyed_reason: r.destroyed_reason } : m
    }))
  }, [heatPhaseResult])
  // Held phase (rounds.ts's useDisplayedPhase) — real user report: an
  // empty melee/heat phase used to resolve within the same WS
  // round-trip as whatever ended the phase before it, reading as
  // "skipped" even though it was genuinely considered. Drives the round
  // bar's phase label below AND steam gating (only DURING the Heat
  // phase, on every mech carrying real heat — real user report this
  // used to show in every phase instead).
  const displayedPhase = useDisplayedPhase(roundState)
  const heatByUnitId = displayedPhase === 'heat'
    ? new Map(
        units.filter((u) => u.mech_id != null).map((u) => [u.id, mechs.find((m) => m.id === u.mech_id)?.heat_current ?? 0]),
      )
    : new Map<number, number>()
  const proneUnitIds = new Set(units.filter((u) => mechs.find((m) => m.id === u.mech_id)?.is_prone).map((u) => u.id))
  const shutdownUnitIds = new Set(units.filter((u) => mechs.find((m) => m.id === u.mech_id)?.is_shutdown).map((u) => u.id))
  const destroyedReasonByUnitId = new Map(
    units
      .map((u) => [u.id, mechs.find((m) => m.id === u.mech_id)?.destroyed_reason ?? null] as const)
      .filter((entry): entry is [number, 'structural' | 'pilot_killed'] => entry[1] != null),
  )
  // Real user request: a mech should lose the limb when its structure hits
  // zero, "para todos los mechs que tengan las extremidades configuradas".
  // Whether a model can show it is the model's business — Mech3D matches
  // mesh names and does nothing for the single-mesh chassis — so this just
  // reports the fact and lets the model answer for itself.
  const severedLocationsByUnitId = new Map(
    units.map((u) => {
      const mech = mechs.find((m) => m.id === u.mech_id)
      const severed = new Set(
        (mech?.locations ?? [])
          // structure_max 0 means the location does not exist on this
          // chassis at all, which is not the same as having been blown off.
          .filter((l) => l.structure_max > 0 && l.structure_current <= 0)
          .map((l) => l.location),
      )
      return [u.id, severed] as const
    }),
  )

  // Fase D real user request: "los muertos no deberían tirar iniciativas"
  // — a pilot whose mech is already destroyed has nothing left to roll
  // for, same reasoning turns.py's own movement_order/target-list
  // exclusion already uses server-side.
  const destroyedPilotIds = new Set(
    mechs.filter((m) => m.destroyed_reason != null && m.pilot_id != null).map((m) => m.pilot_id!),
  )

  // Attack VFX (laser/PPC/tracer/missile/flamer) — only real board shots
  // carry attacker_unit_id/target_unit_id (see combat.py's
  // resolve_attack), so a narrative/manual attack with no real units
  // just plays no animation. Queued (see useAttackVfxQueue's own doc
  // comment) so a fast attack resolving while a slower one is still
  // animating doesn't cut the first one's VFX off mid-flight.
  const { activeAttack: activeAttackVfx, onAttackEffectDone, waitForDrain: waitForAttackVfxDrain } = useAttackVfxQueue(lastAttack, units, mechs)

  // ---- pilot form (now lives inside a modal opened from the sidebar's
  // "+" button, not an always-visible inline section) ----
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showPilotModal, setShowPilotModal] = useState(false)
  const [pilotName, setPilotName] = useState('')
  const [pilotCallsign, setPilotCallsign] = useState('')
  const [gunnery, setGunnery] = useState(4)
  const [piloting, setPiloting] = useState(5)
  const [pilotFaction, setPilotFaction] = useState<Faction>('player')
  const [pilotColor, setPilotColor] = useState(suggestPilotColor(0))
  // Belt-and-suspenders against an impatient double-click creating the
  // same pilot twice (real user report — the same risk exists here as
  // for submitMech below, even though only mechs were reported). The
  // ref check is synchronous, so it also catches a second click that
  // lands before React has re-rendered the disabled button — state
  // alone (submittingPilot) can't guarantee that on its own.
  const [submittingPilot, setSubmittingPilot] = useState(false)
  const submittingPilotRef = useRef(false)

  const submitPilot = async () => {
    if (!campaignId || !pilotName || submittingPilotRef.current) return
    submittingPilotRef.current = true
    setSubmittingPilot(true)
    try {
      await createPilot(campaignId, {
        name: pilotName,
        callsign: pilotCallsign || undefined,
        gunnery,
        piloting,
        faction: pilotFaction,
        color: pilotColor,
      })
      setPilotName('')
      setPilotCallsign('')
      setShowPilotModal(false)
      refetch()
    } catch {
      setError('No se pudo crear el piloto.')
    } finally {
      submittingPilotRef.current = false
      setSubmittingPilot(false)
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

  const [chassisOptions, setChassisOptions] = useState<MechChassisResult[]>([])
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

  // Same double-submit guard as submitPilot above — the actual reported
  // bug: "guardara varias veces el mismo mech" from an impatient
  // double-click, since createMech + its follow-up weapon/equipment
  // POSTs take a moment. The ref check is synchronous so it also blocks
  // a second click that lands before the disabled button has re-rendered.
  const [submittingMech, setSubmittingMech] = useState(false)
  const submittingMechRef = useRef(false)

  const submitMech = async () => {
    if (!campaignId || !chassis || submittingMechRef.current) return
    submittingMechRef.current = true
    setSubmittingMech(true)
    try {
      const locs = buildMechLocationsPayload(locations)
      const m = await createMech(campaignId, {
        chassis,
        model: model || undefined,
        tonnage,
        walk_mp: walkMp,
        run_mp: runMp,
        heat_sinks: heatSinks,
        // Optional (real user request: "Necesito un boton de... añadir
        // mech... aunque haya mechs que seleccionar" — the GM needs to
        // be able to pre-build an unassigned roster for players to
        // later claim from PlayerView's own "elegir un mech existente",
        // not only ever pair a mech with a pilot at creation time).
        pilot_id: mechPilotId === '' ? undefined : mechPilotId,
        locations: locs,
        criticals: Object.keys(pendingCriticals).length > 0 ? pendingCriticals : undefined,
      })
      for (const w of pendingWeapons) {
        await addMechWeapon(m.id, w.weapon_name, w.location).catch(() => {})
      }
      for (const eq of pendingEquipment) {
        await addMechEquipment(m.id, eq.equipment_name, eq.location).catch(() => {})
      }
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
    } finally {
      submittingMechRef.current = false
      setSubmittingMech(false)
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

  const submitUndo = async () => {
    if (!campaignId) return
    try {
      await undoLastAction(campaignId)
      refetch()
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'Esa acción no se puede deshacer automáticamente.'
          : 'No hay nada que deshacer.',
      )
    }
  }

  const submitStartRound = async () => {
    if (!campaignId) return
    try {
      await startRound(campaignId)
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

  // Real user request: "se puede desactivar desde las opciones de
  // campaña en el GM view" — TableView's own 360°-orbit cinematic modal
  // on enemy reveal.
  const submitEnemyRevealCinematic = async (enabled: boolean) => {
    if (!campaignId) return
    try {
      const c = await setEnemyRevealCinematic(campaignId, enabled)
      setCampaign(c)
    } catch {
      setError('No se pudo cambiar la cinemática de revelación.')
    }
  }

  // Real user request/correction: "el GM también tiene que poder
  // escoger entre dados físicos o tiradas automáticas... O TODOS SUS
  // PILOTOS TIRAN AUTOMATICO O TODOS TIRAN FISICO" — one campaign-wide
  // switch governing every enemy/npc pilot's rolls, not a per-pilot one.
  const submitGmDiceMode = async (mode: 'physical' | 'auto') => {
    if (!campaignId) return
    try {
      const c = await setGmDiceMode(campaignId, mode)
      setCampaign(c)
    } catch {
      setError('No se pudo cambiar el modo de dados del GM.')
    }
  }

  // Toggle-off if re-picking your own current style, otherwise switch
  // directly (the old one is simply overwritten server-side, freeing it).
  const submitGmDieStyle = async (styleId: string) => {
    if (!campaignId) return
    const next = campaign?.gm_die_style === styleId ? null : styleId
    try {
      const c = await setGmDieStyle(campaignId, next)
      setCampaign(c)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Ese estilo de dados ya está en uso.' : 'No se pudo cambiar el estilo de dados.')
      refetch()
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

  // "Pasar turno" (real user request/report) — phase-scoped, NOT the
  // same as submitMarkActed above: a real attack blocks both ranged and
  // melee for this pilot, but an explicit pass with nothing to shoot
  // only satisfies the phase it was pressed in, leaving the other still
  // open (e.g. a target-less ranged turn no longer burns a real melee
  // opportunity against an adjacent enemy).
  const submitPassAttack = async (pilotId: number, phase: 'ranged' | 'melee') => {
    if (!campaignId) return
    try {
      await passRoundPhase(campaignId, pilotId, phase)
    } catch {
      setError('No se pudo pasar el turno.')
    }
  }

  // ---- mapa interactivo: clic en un mech → menú (Atacar, gated por
  // orden de iniciativa — rounds.ts's activeAttackPilotIds — saltando
  // automáticamente a quien no tenga un objetivo real esta fase, ver su
  // propio comentario), o arrastrarlo libremente (sin gating — el GM
  // siempre puede reposicionar la miniatura). ----
  const canAct = (unit: Unit) =>
    unit.pilot_id != null && roundState != null && activeAttackPilotIds(roundState, units).has(unit.pilot_id)
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
    // Fase D real user request: "los muertos no deberían tirar
    // iniciativas" — see destroyedPilotIds' own doc comment above.
    && !destroyedPilotIds.has(pilotId)
    // Real user report: a pilot/mech added mid-round shouldn't be
    // promptable to roll either — they're not in this round's own
    // participant snapshot (turns.py's bt_round_participants) and
    // couldn't get a turn from it even if they did roll.
    && (roundState?.participant_pilot_ids?.includes(pilotId) ?? false)
  // Tile highlight — every pilot still waiting to roll, not just the
  // enemies the GM personally rolls for (needsInitiative above stays
  // enemy-scoped, that's still only about which "Tirar iniciativa"
  // button is enabled).
  const needsInitiativePilotIds = pilotsNeedingInitiative(roundState, units, destroyedPilotIds)
  // Doesn't roll anything here — asks the shared table (TableView) to
  // physically throw dice for this pilot; the real value comes back
  // later over WS (round_updated), landing in roundState.rolls the same
  // way any other roll does, and the chips list below already renders
  // that reactively — no separate log line needed for the request itself.
  const rollInitiativeForPilot = async (pilotId: number) => {
    if (!campaignId) return
    try {
      await requestInitiative(campaignId, pilotId)
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
    // "Cambiar dirección" (real user request) — rotate in place, no
    // hex picked at all; resolvePendingFacing below sends the SAME
    // q/r back through submitMoveUnit, only facing_deg changes.
    | ({ kind: 'rotate'; unit: Unit } & { q: number; r: number; x: number; y: number })
    | null
  const [pendingFacing, setPendingFacing] = useState<PendingFacing>(null)
  // The real route for whichever unit(s) currently have a movement-phase
  // move in flight, keyed by unit id — threaded to HexMap's walkPaths so
  // the mech walks the actual calculated path instead of a straight line.
  const [walkPaths, setWalkPaths] = useState<Map<number, { q: number; r: number }[]>>(new Map())
  // Real user request: proper Walk/Run/Jump animation chains, not the
  // same Idle/Walk crossfade for every move — same population pattern as
  // walkPaths above (set locally in submitPhaseMove for this screen's own
  // moves, from unit_walked's own movement_type for everyone else's).
  const [walkMovementTypes, setWalkMovementTypes] = useState<Map<number, MovementType>>(new Map())
  // Debug-only (real user request: "activar temporalmente... el salto
  // siempre") — see UnitContextMenu's own forceJump prop doc comment.
  // Purely client-side, per-unit, never sent to the backend.
  const [forceJumpUnitIds, setForceJumpUnitIds] = useState<Set<number>>(new Set())

  // Debug tooling for two effects that are otherwise only reachable by
  // playing until the dice happen to produce them (real user request:
  // "quiero una forma de debuggear la pérdida de extremidades y el
  // splatter de sangre en la cabina"). Both go through the ordinary
  // endpoints and write real state rather than poking the renderer: the
  // views derive the cockpit blood from the pilot's own `hits` and a
  // severed limb from `structure_current <= 0`, so driving those two
  // numbers is what exercises the actual code path end to end — including
  // the broadcast, so an open FPV on another screen reacts the same way it
  // would to a real hit.
  const debugPilotHit = async (unit: Unit) => {
    const pilot = pilots.find((p) => p.id === unit.pilot_id)
    if (!pilot) return
    // Capped one short of the six that kill a MechWarrior: the point of
    // this button is to WATCH the cockpit, and a dead pilot's mech is
    // destroyed and its FPV closes itself (see PlayerView's own forced
    // exit), which would end the thing being debugged.
    const hits = Math.min(5, (pilot.hits ?? 0) + 1)
    if (hits === pilot.hits) return
    try {
      await updatePilot(pilot.id, { hits })
      await refetch()
    } catch {
      setError('No se pudo aplicar el daño de piloto (debug).')
    }
  }

  const debugSeverLimbs = async (unit: Unit) => {
    const mech = mechForUnit(unit)
    if (!mech) return
    // All four at once, per the request ("las perderá todas"). A location
    // with structure_max 0 does not exist on this chassis at all, which is
    // not the same as one that has been blown off — zeroing it would tell
    // the model to drop a limb the mech never had.
    const limbs = (mech.locations ?? []).filter(
      (l) => SEVERABLE_LOCATIONS.includes(l.location) && l.structure_max > 0 && l.structure_current > 0,
    )
    if (limbs.length === 0) return
    try {
      // Sequential rather than Promise.all: each PATCH returns the whole
      // mech and broadcasts, and firing four concurrent writes at the same
      // row is how you get one of them silently reverted.
      for (const limb of limbs) {
        await updateMechLocation(mech.id, limb.location, { structure_current: 0 })
      }
      await refetch()
    } catch {
      setError('No se pudieron arrancar las extremidades (debug).')
    }
  }
  // unit_walked (real user report) covers every move this screen didn't
  // itself resolve — PlayerView's Acciones tab, FirstPersonView's cockpit
  // HUD, or another connected GM screen — which this client would
  // otherwise never learn a real route for, leaving HexMap to fall back
  // to a straight line through whatever's in between. Guarded against
  // re-applying to a move THIS screen just resolved locally (submitPhaseMove
  // below already set fresher path data with no network round trip;
  // re-setting it from the broadcast's later, reference-different array
  // would reset the walk mid-stride back to its first waypoint).
  const selfResolvedMoveRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!unitWalked) return
    if (selfResolvedMoveRef.current.delete(unitWalked.unit_id)) return
    if (unitWalked.path.length > 0) {
      setWalkPaths((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.path))
      setWalkMovementTypes((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.movement_type))
      const walkedUnit = units.find((u) => u.id === unitWalked.unit_id)
      heldMover.onUnitWalkStart(unitWalked.unit_id, walkedUnit?.pilot_id ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitWalked])

  const submitMoveUnit = async (unit: Unit, q: number, r: number, markActed: boolean, facingDeg?: number) => {
    // Optimistic: the marker already visually followed the drag to (q, r)
    // while dragging — patch local state to match immediately instead of
    // letting it snap back to the stale fetched position and wait for the
    // move request + WS-triggered refetch to catch up a moment later.
    setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}) } : u)))
    try {
      // Debug-only (real user request, see UnitContextMenu's own
      // forceJump doc comment) — tags this already-unrestricted move as
      // a jump for animation purposes, no MP/jump_mp involved at all.
      await moveUnit(unit.id, q, r, facingDeg, forceJumpUnitIds.has(unit.id) ? 'jump' : undefined)
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
      setWalkMovementTypes((prev) => new Map(prev).set(unit.id, movementType))
      selfResolvedMoveRef.current.add(unit.id)
      heldMover.onUnitWalkStart(unit.id, unit.pilot_id ?? null)
    }
    setUnits((prev) => prev.map((u) => (u.id === unit.id ? { ...u, q, r, ...(facingDeg != null ? { facing_deg: facingDeg } : {}) } : u)))
    try {
      await moveUnitWithMp(unit.id, q, r, movementType, facingDeg)
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
    } else if (pendingFacing.kind === 'rotate') {
      // Dismissing (Escape/click outside) cancels — unlike 'move'/'place',
      // there's no move to fall back to completing without a facing.
      if (facingDeg != null) submitMoveUnit(pendingFacing.unit, pendingFacing.q, pendingFacing.r, false, facingDeg)
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
  const renderPolicy = useRenderPolicy()
  const raycastToGroundRef = useRef<((clientX: number, clientY: number) => [number, number] | null) | null>(null)

  // ---- editar/eliminar (from the pilot/mech menus above) ----
  const [editingPilot, setEditingPilot] = useState<Pilot | null>(null)
  const [editPilotName, setEditPilotName] = useState('')
  const [editPilotCallsign, setEditPilotCallsign] = useState('')
  const [editGunnery, setEditGunnery] = useState(4)
  const [editPiloting, setEditPiloting] = useState(5)
  const [editPilotFaction, setEditPilotFaction] = useState<Faction>('player')
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
      })
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
      // delete_mech also removes any of its units server-side (see
      // app/mechs.py) — no WS broadcast for it, so drop them locally too.
      setUnits((prev) => prev.filter((u) => u.mech_id !== confirmDeleteMech.id))
      setConfirmDeleteMech(null)
      refetch()
    } catch {
      setError('No se pudo eliminar el mech.')
    }
  }

  // "Quitar del mapa" (real user request) — removes the token so the
  // mech is free to be placed again, but leaves the mech itself (and
  // its pilot) untouched in the campaign, unlike submitDeleteMech above.
  const removeMechFromMap = async (unit: Unit) => {
    try {
      await deleteUnit(unit.id)
      setUnits((prev) => prev.filter((u) => u.id !== unit.id))
    } catch {
      setError('No se pudo quitar el mech del mapa.')
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
    // A pending/rejected mech can't be dropped on the board yet — the
    // GM has to review it first (real user request: "El GM solo puede
    // colocar aquellos mechs aprobados"; the backend enforces the same
    // rule, see units.py's MechNotApproved). canDrag=false means the
    // pointer sequence below never enters "dragging", so a press-and-
    // release on one of these cards always falls through to the plain
    // click-menu branch in finish() — same as any other click.
    const canDrag = mech.status === 'approved'
    let dragging = false
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      if (canDrag && !dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 6) {
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
      // Real user report: picking an already-destroyed mech as a target
      // opened the attack panel/weapon list same as any live target, but
      // the backend now silently rejects the shot (combat.py's own
      // TargetAlreadyDestroyed) — the volley loop swallows a rejected
      // shot per-weapon on purpose (so one out-of-range weapon doesn't
      // block the rest of a multi-weapon volley), so nothing visibly
      // happened when clicked. Reject the pick itself instead, with a
      // real explanation, so the panel never opens on a wreck at all.
      if (attacker && mechForUnit(unit)?.destroyed_reason != null) {
        setError('Ese mech ya está destruido — no se le puede atacar.')
        return
      }
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
    if (movementHighlight == null) {
      // Real user request: "quiero que el menu que se abre al hacer click
      // a un mech en el GMview, se abra tambien si le das al tile en el
      // que esta situado" — HexMap's own onUnitClick only fires on a
      // direct raycast hit against the model's own mesh, which can miss
      // on a mech's own thin/gappy silhouette; the tile it's actually
      // standing on is a much more forgiving target for the exact same
      // menu (onUnitClick itself still handles the pickingTargetFor
      // attack-target-pick branch same as a direct click would).
      const unit = units.find((u) => u.q === q && u.r === r)
      if (unit) onUnitClick(unit, clientX, clientY)
      return
    }
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
  const rawActiveMover = roundState ? activeMoverPilotId(roundState) : null
  const heldMover = useHeldActiveMover(rawActiveMover)
  const activeMover = heldMover.displayedMoverPilotId
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
  // volley, just get skipped — every hit/miss (and a rejected shot) is
  // already reflected in the persisted campaign event log server-side.
  const [firingVolley, setFiringVolley] = useState(false)
  // Fase B: a pilot with dice_mode='physical' makes attack() return
  // {pending: true, ...} instead of a finished result — TableView is the
  // one that actually throws the physical dice and reports them back
  // (over its own connection), so THIS screen's only way to know "that
  // shot is actually done now" is to wait for the eventual attack_result
  // broadcast to arrive on its own socket. Without this, the volley loop
  // below would fire every weapon's HTTP call almost instantly (each one
  // individually still pending its own dice) and call submitMarkActed
  // before a single physical die had even been thrown.
  const pendingAttackResolversRef = useRef<(() => void)[]>([])
  useEffect(() => {
    if (!lastAttack) return
    pendingAttackResolversRef.current.forEach((resolve) => resolve())
    pendingAttackResolversRef.current = []
  }, [lastAttack])
  const waitForNextAttackResult = () =>
    new Promise<void>((resolve) => {
      pendingAttackResolversRef.current.push(resolve)
    })

  const submitWeaponVolley = async (weaponIds: number[]) => {
    if (!campaignId || !attackPanel) return
    setFiringVolley(true)
    for (const weaponId of weaponIds) {
      try {
        const outcome = await attack(campaignId, {
          attacker_unit_id: attackPanel.attacker.id,
          target_unit_id: attackPanel.target.id,
          weapon_id: weaponId,
        })
        if (isPendingRollResult(outcome)) await waitForNextAttackResult()
      } catch {
        // rejected (out of range/no ammo/no LOS) — skip, volley continues
      }
    }
    // Real user request: "el turno de ataque debe durar hasta que TODAS
    // las animaciones de ataque terminen" — the volley loop above only
    // waits for each shot's real RESULT (server resolution, plus a
    // physical dice pause), which can land well before this queue has
    // finished actually PLAYING the last one or two shots' beam/tracer/
    // missile VFX in order (see useAttackVfxQueue's own doc comment on
    // why the queue itself outlives the last broadcast).
    await waitForAttackVfxDrain()
    if (attackPanel.attacker.pilot_id != null) await submitMarkActed(attackPanel.attacker.pilot_id)
    setFiringVolley(false)
    setAttackPanel(null)
    refetch()
  }

  // Melee phase's equivalent — a single physical attack instead of a
  // volley, same fixed attackPanel pair, same submitMarkActed-then-
  // refetch tail as the ranged path above.
  // Fase B: same "wait for the real result" gap punch/kick can now hit —
  // a physical-mode pilot's melee attack can pause (see melee.py's own
  // scope note — charge/DFA never pauses, punch/kick can), same
  // reasoning as submitWeaponVolley's own waitForNextAttackResult above,
  // just watching lastMelee instead of lastAttack.
  const pendingMeleeResolversRef = useRef<(() => void)[]>([])
  useEffect(() => {
    if (!lastMelee) return
    pendingMeleeResolversRef.current.forEach((resolve) => resolve())
    pendingMeleeResolversRef.current = []
  }, [lastMelee])
  const waitForNextMeleeResult = () =>
    new Promise<void>((resolve) => {
      pendingMeleeResolversRef.current.push(resolve)
    })

  const submitMeleeAttackFromPanel = async (attackType: MeleeAttackType, arm?: 'left' | 'right') => {
    if (!attackPanel) return
    setFiringVolley(true)
    try {
      const outcome = await submitMeleeAttack(attackPanel.attacker.id, attackPanel.target.id, attackType, arm)
      if (isPendingRollResult(outcome)) await waitForNextMeleeResult()
    } catch {
      // rejected (not adjacent/no LOS/incapacitated/movement doesn't
      // qualify for Carga-DFA) — surfaced to the GM via the failed
      // request itself, nothing further to do here.
    }
    if (attackPanel.attacker.pilot_id != null) await submitMarkActed(attackPanel.attacker.pilot_id)
    setFiringVolley(false)
    setAttackPanel(null)
    refetch()
  }

  if (campaignId == null) return <div className="gm-view">preparando campaña…</div>

  return (
    <div className="gm-view">
      <NavBar campaignId={campaignId} campaignName={campaign?.name} current="/gm" links={GM_LINKS}>
        <button className="nav-gear-btn" onClick={() => setShowSettingsModal(true)} title="Ajustes">⚙️</button>
      </NavBar>
      {loading && <p className="loading">Cargando…</p>}
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="round-bar">
        <span className="round-bar-label">
          RONDA: {roundState && roundState.round_number > 0 ? roundState.round_number : '—'}
          {roundState && roundState.round_number > 0 && ` — ${PHASE_LABELS[displayedPhase]}`}
        </span>
        <button onClick={submitStartRound}>
          {roundState && roundState.round_number > 0 ? 'Siguiente ronda' : 'Empezar ronda'}
        </button>
      </div>

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
                  className={`entity-card${p.status === 'pending' ? ' status-pending' : ''}`}
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
                    className={`entity-card entity-card-draggable${m.status === 'pending' ? ' status-pending' : ''}`}
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
            {/* near/far explicit and HEX_SIZE-scaled alongside position —
                the perspective depth buffer's usable precision is relative
                to how far the camera actually sits from what it's looking
                at, not an absolute world-unit amount; leaving these at
                three.js's own defaults (0.1/2000) while the camera moved
                30x further away starved the buffer of precision at the
                actual scene depth, reading as z-fighting/flicker on zoom
                (real user report: "se glichea el agua cuando hago zoom").
                Scaling both by HEX_SIZE preserves the exact same near/far
                RATIO (hence the same precision curve) that worked fine
                before, just covering the new, 30x-bigger scene. */}
            {/* Real user report: zoom-out z-fighting that visibly JUMPS
                between different hexes as the zoom level changes — the
                textbook signature of depth-buffer precision loss, not a
                per-tile bug. near:far was 0.1:2000 * HEX_SIZE = 1:20000 —
                a 24-bit depth buffer distributes almost all of its real
                precision within the first few percent of that range
                (nearest the camera), leaving very little for everything
                else. First attempt cut far all the way to 100*HEX_SIZE —
                too aggressive: real zoomed-OUT use (OrbitControls has no
                maxDistance set, and a normal "see the whole board"
                zoom-out already puts the camera several thousand units
                out) started exceeding that far plane and clipping the
                ENTIRE map to nothing, a real regression, not a fix.
                Settled on near raised to 1*HEX_SIZE (still far below
                anything this top-down camera ever actually gets close
                to) and far cut to 500*HEX_SIZE — ratio improves from
                1:20000 to 1:500 (40x), while empirically staying well
                clear of where a normal "whole board" zoom-out actually
                sits. */}
            <Canvas
              shadows
              camera={{ position: [0, 16 * HEX_SIZE, 0.01], fov: 40, near: 1 * HEX_SIZE, far: 500 * HEX_SIZE }}
            >
              {/* First child on purpose — see TableView's own note. */}
              <PerfProbe />
              <FrameGate policy={renderPolicy} />
              <color attach="background" args={['#0f1a18']} />
              <ambientLight intensity={0.6} />
              <directionalLight
                position={[4, 8, 3]} intensity={1.4} castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-camera-left={-30 * HEX_SIZE} shadow-camera-right={30 * HEX_SIZE}
                shadow-camera-top={30 * HEX_SIZE} shadow-camera-bottom={-30 * HEX_SIZE}
                shadow-camera-far={60 * HEX_SIZE}
                // Real user report: dark speckled blotches across whole
                // tile faces, worse when zoomed out — classic shadow-map
                // self-shadowing acne (three.js's own shadow.bias/
                // normalBias both default to 0), and this terrain mesh's
                // own per-vertex noise/ramp displacement (terrainReliefAt,
                // added earlier this session) gives it exactly the kind of
                // constantly-varying normal that triggers it — a flat
                // plane rarely shows this at all. Worse at a distance
                // because more of the shadow map's fixed 2048² resolution
                // covers the visible area at once, making its own
                // discretization error more visible per screen pixel.
                // normalBias (offsets the shadow-map LOOKUP along the
                // surface normal, not the light direction) is the
                // standard fix for acne specifically on non-flat
                // receivers, scaled to this scene's real HEX_SIZE=30m
                // units the same way every other small-offset constant
                // this session already is (see e.g. hexTileGeometry.ts's
                // own TEXTURE_BLEND_LIFT).
                shadow-normalBias={HEX_SIZE * 0.02}
              />
              <TableBackground hexScale />
              <CameraBridge onReady={(fn) => { raycastToGroundRef.current = fn }} />
              <Suspense fallback={null}>
                <HexMap
                  map={map}
                  units={units}
                  needsInitiativePilotIds={needsInitiativePilotIds}
                  activeMoverPilotId={activeMover}
                  activeAttackerPilotIds={roundState ? activeAttackPilotIds(roundState, units) : undefined}
                  moveHighlightHexes={movementHighlight ? new Set(movementHighlight.hexes.keys()) : undefined}
                  pathPreviewHexes={
                    pendingFacing?.kind === 'move' && pendingFacing.path
                      ? new Set(pendingFacing.path.map((p) => `${p.q},${p.r}`))
                      : undefined
                  }
                  targetableHexes={targetableHexes}
                  walkPaths={walkPaths}
                  walkMovementTypes={walkMovementTypes}
                  heatByUnitId={heatByUnitId}
                  proneUnitIds={proneUnitIds}
                  shutdownUnitIds={shutdownUnitIds}
                  destroyedReasonByUnitId={destroyedReasonByUnitId}
                  severedLocationsByUnitId={severedLocationsByUnitId}
                  activeAttack={activeAttackVfx}
                  onAttackEffectDone={onAttackEffectDone}
                  onUnitWalkDone={heldMover.onUnitWalkDone}
                  onUnitClick={onUnitClick}
                  onTileClick={onTileClick}
                  onUnitDragEnd={onUnitDragEnd}
                  onDraggingChange={setIsDraggingUnit}
                  boardgameScale
                />
              </Suspense>
              {/* dampingFactor explicit — see TableView.tsx's own
                  comment on this same fix (endless slow spin after a
                  drag/rotate release, real user report). */}
              <OrbitControls enablePan enableRotate={!isDraggingUnit} minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
            </Canvas>
            <PerfHud />
          </div>
        )}

        {/* Un botón por piloto — muestra su tirada de iniciativa (si la
            tiene, solo modo individual) en vez de la lista de tiradas
            aparte de antes, y al pulsarlo abre el mismo menú que un clic
            sobre su mech en el mapa (real user request: "no sé qué
            hacen [estos botones]... deberían desplegar el mismo menú"). */}
        {roundState && roundState.round_number > 0 && (
          <ul className="chips round-pilots">
            {pilots.map((p) => {
              const acted = roundState.acted_pilot_ids.includes(p.id)
              const roll = roundState.rolls.find((r) => r.pilot_id === p.id)
              const unit = units.find((u) => u.pilot_id === p.id)
              return (
                <li key={p.id}>
                  <button
                    className={acted ? 'acted' : ''}
                    onClick={(e) => unit && setMenu({ unit, x: e.clientX, y: e.clientY })}
                    disabled={!unit}
                    title={unit ? 'Ver acciones' : 'Sin mech en el mapa'}
                  >
                    {acted ? '✓ ' : ''}{p.name}{roll ? ` (${roll.total})` : ''}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>


      </div>
      </div>

      <section>
        <h2>Registro</h2>
        <button onClick={submitUndo} className="undo">Deshacer última acción</button>
        {/* Persisted campaign history (survives a reload — real user
            request) — every in-session action logs its own line here
            via app/events.py. Real user request: only this one scrolling
            list, not a second non-scrolling one alongside it. */}
        <ul className="log event-log">
          {campaignEvents.map((e) => (
            <li key={e.id} className={e.undone ? 'event-undone' : ''}>{e.summary}</li>
          ))}
        </ul>
      </section>

      {showSettingsModal && (
        <Modal title="Ajustes" onClose={() => setShowSettingsModal(false)}>
          <h3 className="step-label">Dados</h3>
          <DieStylePicker
            styles={DIE_STYLES}
            heldBy={buildHeldByMap(pilots, campaign)}
            currentStyleId={campaign?.gm_die_style ?? null}
            onPick={submitGmDieStyle}
          />

          <h3 className="step-label">House Rules</h3>
          <div className="row settings-row">
            <span>Tipo de iniciativa</span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={campaign?.initiative_mode === 'individual'}
                onChange={(e) => submitInitiativeMode(e.target.checked ? 'individual' : 'team')}
              />
              <span className="toggle-slider" />
            </label>
            <span className="toggle-label">
              {campaign?.initiative_mode === 'individual' ? 'Individual (1 tirada por piloto)' : 'Por equipos (regla real)'}
            </span>
          </div>

          <div className="row settings-row">
            <span>Cinemática de revelación</span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={campaign?.enemy_reveal_cinematic ?? true}
                onChange={(e) => submitEnemyRevealCinematic(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
            <span className="toggle-label">
              {(campaign?.enemy_reveal_cinematic ?? true) ? 'Activada' : 'Desactivada'}
            </span>
          </div>

          <div className="row settings-row">
            <span>Dados del GM</span>
            <label className="toggle-switch" title="Gobierna TODOS los pilotos enemy/npc a la vez, no uno a uno">
              <input
                type="checkbox"
                checked={campaign?.gm_dice_mode === 'auto'}
                onChange={(e) => submitGmDiceMode(e.target.checked ? 'auto' : 'physical')}
              />
              <span className="toggle-slider" />
            </label>
            <span className="toggle-label">
              {campaign?.gm_dice_mode === 'auto' ? 'Automáticos (todos los enemigos)' : 'Físicos en la mesa (todos los enemigos)'}
            </span>
          </div>

          {/* Real user request: herramienta de anotación de mechs (dev-
              only, no la ve ningún jugador) — un enlace discreto aquí
              para que sea localizable sin memorizar la URL. */}
          <div className="row settings-row">
            <a href="/mechlab" target="_blank" rel="noreferrer">🔧 Editor de mechs (dev)</a>
          </div>
        </Modal>
      )}

      {showPilotModal && (
        <Modal title="Nuevo piloto" onClose={() => setShowPilotModal(false)}>
          <PilotForm
            name={pilotName} onName={setPilotName}
            callsign={pilotCallsign} onCallsign={setPilotCallsign}
            gunnery={gunnery} onGunnery={setGunnery}
            piloting={piloting} onPiloting={setPiloting}
            faction={pilotFaction} onFaction={setPilotFaction} showFaction
            onSubmit={submitPilot} submitLabel={submittingPilot ? 'Creando…' : 'Crear piloto'} submitDisabled={!pilotName || submittingPilot}
          />
        </Modal>
      )}

      {showMechModal && (
        <Modal title="Nuevo mech" onClose={() => setShowMechModal(false)}>
          <div className="row">
            <ChassisSelect value={selectedChassis} onChange={setSelectedChassis} options={chassisOptions} />
            <select
              value={selectedModelFile}
              onChange={(e) => setSelectedModelFile(e.target.value)}
              disabled={modelOptions.length === 0}
            >
              <option value="">modelo…</option>
              {modelOptions.map((m) => (
                <option key={m.file} value={m.file}>
                  {MECH_CHASSIS_ASSETS[selectedChassis]?.models[m.model] ? `🛠️ ${m.model}` : m.model}
                </option>
              ))}
            </select>
            <select value={mechPilotId} onChange={(e) => setMechPilotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">piloto (opcional)</option>
              {pilots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <button onClick={submitMech} disabled={!chassis || submittingMech}>
            {submittingMech ? 'Guardando…' : 'Guardar'}
          </button>
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
        const menuUnit = units.find((u) => u.mech_id === mechMenu.mech.id)
        return (
          <DropdownMenu
            x={mechMenu.x} y={mechMenu.y}
            title={`${mechMenu.mech.chassis} ${mechMenu.mech.model ?? ''}`.trim()}
            onClose={() => setMechMenu(null)}
          >
            <button onClick={() => { setViewingMechId(mechMenu.mech.id); setMechMenu(null) }}>Ver ficha</button>
            {mechMenu.mech.status === 'pending' && (
              <>
                <button onClick={() => { approveMech(mechMenu.mech.id); setMechMenu(null) }}>✓ Aprobar</button>
                <button onClick={() => { setRejectingMechId(mechMenu.mech.id); setRejectNote(''); setMechMenu(null) }}>✗ Rechazar</button>
              </>
            )}
            {showRollInitiative && (
              <button
                disabled={!needsInitiative(menuPilot!.id)}
                onClick={() => { rollInitiativeForPilot(menuPilot!.id); setMechMenu(null) }}
              >
                Tirar iniciativa
              </button>
            )}
            {menuUnit && (
              <button onClick={() => { removeMechFromMap(menuUnit); setMechMenu(null) }}>Quitar del mapa</button>
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
          {pilotMenu.pilot.status === 'pending' && (
            <>
              <button onClick={() => { approvePilot(pilotMenu.pilot.id); setPilotMenu(null) }}>✓ Aprobar</button>
              <button onClick={() => { setRejectingPilotId(pilotMenu.pilot.id); setRejectNote(''); setPilotMenu(null) }}>✗ Rechazar</button>
            </>
          )}
          <button onClick={() => { openEditPilot(pilotMenu.pilot); setPilotMenu(null) }}>Editar</button>
          <button className="danger" onClick={() => { setConfirmDeletePilot(pilotMenu.pilot); setPilotMenu(null) }}>Eliminar</button>
        </DropdownMenu>
      )}

      {rejectingPilotId != null && (() => {
        const p = pilots.find((x) => x.id === rejectingPilotId)
        return (
          <Modal title={`Rechazar a ${p?.name ?? 'piloto'}`} onClose={() => { setRejectingPilotId(null); setRejectNote('') }}>
            <textarea
              className="reject-note"
              placeholder="qué hay que corregir…"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
            <button type="button" onClick={() => submitRejectPilot(rejectingPilotId)}>Confirmar rechazo</button>
          </Modal>
        )
      })()}

      {rejectingMechId != null && (() => {
        const m = mechs.find((x) => x.id === rejectingMechId)
        return (
          <Modal
            title={`Rechazar ${m ? `${m.chassis} ${m.model ?? ''}`.trim() : 'mech'}`}
            onClose={() => { setRejectingMechId(null); setRejectNote('') }}
          >
            <textarea
              className="reject-note"
              placeholder="qué hay que corregir…"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
            <button type="button" onClick={() => submitRejectMech(rejectingMechId)}>Confirmar rechazo</button>
          </Modal>
        )
      })()}

      {editingPilot && (
        <Modal title={`Editar ${editingPilot.name}`} onClose={() => setEditingPilot(null)}>
          <PilotForm
            name={editPilotName} onName={setEditPilotName}
            callsign={editPilotCallsign} onCallsign={setEditPilotCallsign}
            gunnery={editGunnery} onGunnery={setEditGunnery}
            piloting={editPiloting} onPiloting={setEditPiloting}
            faction={editPilotFaction} onFaction={setEditPilotFaction} showFaction
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
        // Real user request: an action that doesn't correspond to the
        // round's CURRENT phase disappears from the menu entirely,
        // instead of sitting there greyed out — canAct/canPhaseMove
        // below still separately gate whether it's specifically THIS
        // pilot's turn within a phase that does match (shown as
        // disabled+hint, same as before).
        const menuPhase = roundState ? currentPhase(roundState) : 'none'
        return (
          <UnitContextMenu
            unit={menu.unit}
            mech={mechForUnit(menu.unit)}
            canAct={canAct(menu.unit)}
            x={menu.x}
            y={menu.y}
            onAttack={() => { setPickingTargetFor(menu.unit.id); setMenu(null) }}
            onClose={() => setMenu(null)}
            showAttack={menuPhase === 'ranged' || menuPhase === 'melee'}
            onSkipAttack={() => {
              if (menuUnitPilot && (menuPhase === 'ranged' || menuPhase === 'melee')) {
                submitPassAttack(menuUnitPilot.id, menuPhase)
              }
              setMenu(null)
            }}
            showRollInitiative={menuPhase === 'initiative' && campaign?.initiative_mode === 'individual' && menuUnitPilot?.faction === 'enemy'}
            canRollInitiative={menuUnitPilot != null && needsInitiative(menuUnitPilot.id)}
            onRollInitiative={() => { if (menuUnitPilot) rollInitiativeForPilot(menuUnitPilot.id); setMenu(null) }}
            showPhaseMovement={menuPhase === 'movement' && (roundState?.movement_order.includes(menu.unit.pilot_id ?? -1) ?? false)}
            canPhaseMove={menu.unit.pilot_id != null && activeMover === menu.unit.pilot_id}
            onPhaseMove={(type) => { startPhaseMovement(menu.unit, type); setMenu(null) }}
            onRotate={() => {
              setPendingFacing({ kind: 'rotate', unit: menu.unit, q: menu.unit.q, r: menu.unit.r, x: menu.x, y: menu.y })
              setMenu(null)
            }}
            onSkipMovement={() => { submitMoveUnit(menu.unit, menu.unit.q, menu.unit.r, false); setMenu(null) }}
            onStandUp={() => { standUp(menu.unit.id).then(refetch).catch(() => {}); setMenu(null) }}
            onFallOver={() => { fallOver(menu.unit.id).then(refetch).catch(() => {}); setMenu(null) }}
            onDebugPilotHit={menuUnitPilot ? () => { debugPilotHit(menu.unit); setMenu(null) } : undefined}
            onDebugSeverLimbs={mechForUnit(menu.unit) ? () => { debugSeverLimbs(menu.unit); setMenu(null) } : undefined}
            forceJump={forceJumpUnitIds.has(menu.unit.id)}
            onForceJumpChange={(value) => {
              setForceJumpUnitIds((prev) => {
                const next = new Set(prev)
                if (value) next.add(menu.unit.id)
                else next.delete(menu.unit.id)
                return next
              })
            }}
          />
        )
      })()}

      {attackPanel && mechForUnit(attackPanel.attacker) && (
        roundState && currentPhase(roundState) === 'melee' ? (
          <MeleeAttackPanel
            attackerMech={mechForUnit(attackPanel.attacker)!}
            attacker={attackPanel.attacker}
            target={attackPanel.target}
            targetMech={mechForUnit(attackPanel.target)}
            roundState={roundState}
            firing={firingVolley}
            onAttack={submitMeleeAttackFromPanel}
            onClose={() => setAttackPanel(null)}
          />
        ) : (
          <WeaponVolleyPanel
            attackerMech={mechForUnit(attackPanel.attacker)!}
            target={attackPanel.target}
            targetMech={mechForUnit(attackPanel.target)}
            weaponCatalog={weaponCatalog}
            firing={firingVolley}
            onFire={submitWeaponVolley}
            onClose={() => setAttackPanel(null)}
          />
        )
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
      <NavBar campaignId={campaignId} current="/gm" links={GM_LINKS} />
      <div style={{ display: 'flex', height: 'calc(100vh - var(--nav-height, 52px))' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          {map ? (
            <Canvas shadows camera={{ position: [0, 16, 0.01], fov: 40 }}>
              <color attach="background" args={['#0f1a18']} />
              <ambientLight intensity={0.6} />
              <directionalLight position={[10, 20, 10]} intensity={1} castShadow />
              <SquareMap map={map} units={units} onTileClick={onTileClick} selectedUnitId={selectedUnit?.id ?? null} />
              {/* dampingFactor explicit — see the battletech map's own
                  Canvas above (same fix, same reason). */}
              <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
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
