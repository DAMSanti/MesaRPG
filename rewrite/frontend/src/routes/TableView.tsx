import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { Environment, OrbitControls } from '@react-three/drei'
import { PhysicalDiceThrow, THROW_ORIGIN_X } from '../components/PhysicalDiceThrow'
import { HexMap, useAttackVfxQueue } from '../components/HexMap'
import { HEX_SIZE } from '../hexMath'
import { TableBackground } from '../components/TableBackground'
import { BoardWalls } from '../components/BoardWalls'
import { EnemyRevealCinematic } from '../components/EnemyRevealCinematic'
import { useTableSocket, type FogWalkStep } from '../ws'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import {
  getVisibility, listCampaigns, listMechs, moveUnitWithMp, reportInitiative, reportPendingRoll, resolveHeatPhase,
  type Campaign, type Mech, type MovementType, type ReachableHex,
} from '../api'
import { useMapState } from '../useMapState'
import {
  activeAttackPilotIds, activeMoverPilotId, currentPhase, PHASE_LABELS, pilotsNeedingInitiative, useDisplayedPhase, useHeldActiveMover,
} from '../rounds'
import { FACTION_COLORS } from '../factions'
import { SquareMap } from '../components/SquareMap'
import './TableView.css'
import { SceneLighting } from '../components/SceneLighting'
import { DEFAULT_TIME_OF_DAY } from '../dayNight'
import { PerfProbe, PerfPhysicsProbe } from '../components/PerfProbe'
import { PerfHud } from '../components/PerfHud'
import { FrameGate, useRenderPolicy } from '../components/RenderPolicy'

const REVEAL_CINEMATIC_AUTO_CLOSE_MS = 7000

// Manual per-pilot initiative rolls (individual mode) roll physically on
// the shared table's own board instead of a popup on the GM's/player's
// personal screen — "no deben verse en un modal, deben aparecer con
// físicas rodando sobre el tablero," thrown in with real velocity "como
// se tirarían dados reales en una mesa" (not dropped from directly
// above), against the board's own geometry, not a separate tray: "la
// colisión debe ser contra el mapa... con los modelos de mechs." HexMap
// takes a `physics` prop for exactly this (TableView only — GMView's/
// MapEditorView's embedded maps have no <Physics> provider, so they
// never set it) — every tile and mech standing on it becomes a real
// collider. The two dice ARE the result now, not a display for one the
// server already picked ("vamos a hacer que los dados sean el valor
// real") — each reports whatever face it actually lands on
// (Die's onSettled), and once both have, the sum is the real roll,
// reported back to the server (TableView's reportSettledInitiative).
//
/** Thin dieCount=2 wrapper around the shared PhysicalDiceThrow (Fase B
 * extracted it out of this component — see its own doc comment) —
 * deliberately kept as its own named component/signature rather than
 * inlining PhysicalDiceThrow at every call site below, since initiative
 * still goes through its own dedicated request/report pair (untouched,
 * lower risk than folding it into the new generic physical-roll flow). */
function InitiativeDice({
  rollId, color, dieStyle, lane, onSettled, onDone,
}: {
  rollId: number | string
  color: string
  dieStyle: string | null
  lane: number
  onSettled: (total: number, dice: [number, number]) => void
  onDone: () => void
}) {
  return (
    <PhysicalDiceThrow
      rollId={rollId} dieCount={2} color={color} dieStyle={dieStyle} lane={lane}
      onSettled={(total, dice) => onSettled(total, [dice[0], dice[1]])}
      onDone={onDone}
    />
  )
}

/** The BattleTech shared-table screen — everything this file did before
 * Fase R4 (D&D 5e as a second system). Renamed, otherwise untouched:
 * see the real `TableView` export at the bottom of this file. */
function TableViewBattletech() {
  const campaignId = useCampaignId()
  const renderPolicy = useRenderPolicy()
  const {
    connected, lastRoll, visibility, lastRevealedUnitId, lastAttack, lastMelee, activeMapId, roundState, initiativeRollRequest,
    physicalRollRequest, movementStarted, heatPhaseResult, rosterVersion, unitWalked, mapTime,
  } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)
  // NOT lastRevealedUnitId ?? visibility — a `??` chain here would make
  // the token "stick" at whatever unit last got newly revealed, and once
  // that happens once, later visibility_update broadcasts (which fire on
  // every move, revealed or not — see main.py's _broadcast_visibility)
  // stop mattering at all since lastRevealedUnitId no longer changes on
  // its own. visibility alone is already a strictly sufficient trigger
  // (every unit_revealed is preceded by a visibility_update in the same
  // broadcast), same as GMView's own useMapState call.
  const { map, units } = useMapState(mapId, visibility ?? lastAttack)
  // The GM's clock, live — see dayNight.ts. Falls back to whatever this
  // map was stored with, so a table opened before anyone touched the
  // slider is still lit correctly.
  const timeOfDay = (mapTime && mapTime.mapId === mapId ? mapTime.hour : undefined)
    ?? map?.time_of_day
    ?? DEFAULT_TIME_OF_DAY

  // Real user request: "cuando un enemigo entra en el LoS del equipo,
  // en el tableview se abre un modal... a modo de cinemática de
  // presentación. Se puede desactivar desde las opciones de campaña en
  // el GM view." Own tiny campaign fetch (this screen otherwise has no
  // reason to know campaign settings) — refetched on rosterVersion,
  // same broadcast the GM's own toggle already fires (see main.py's
  // set_enemy_reveal_cinematic).
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  useEffect(() => {
    if (campaignId == null) return
    listCampaigns().then((all) => setCampaign(all.find((c) => c.id === campaignId) ?? null)).catch(() => {})
  }, [campaignId, rosterVersion])

  const [revealCinematicUnitId, setRevealCinematicUnitId] = useState<number | null>(null)
  // Real user report: the cinematic re-appeared on every later move of
  // ANY unit, not just the very first reveal — because this effect's own
  // dependency array included `units`/`campaign`, it re-ran (and
  // re-showed the SAME cinematic) whenever either changed for any
  // unrelated reason, as long as `lastRevealedUnitId` still held the
  // value from an EARLIER broadcast (it's never reset to null between
  // broadcasts). handledRevealIdRef tracks which lastRevealedUnitId this
  // effect has already made a real decision for, so a later units/
  // campaign change alone can't re-trigger it — only a genuinely NEW
  // unit_revealed broadcast (a different id) can. units/campaign stay in
  // the dependency array on purpose (not just the closure) — the very
  // first time this fires, `units` may not have caught up with the
  // just-revealed unit yet (real race between the WS broadcast and the
  // REST refetch), so this needs to keep retrying, unmarked, until the
  // unit's own data is actually there to check its faction against.
  const handledRevealIdRef = useRef<number | null>(null)
  // Real user request: "si se descubren dos o mas mechs a la vez, sus
  // cinematicas serán secuenciales" — main.py's own _broadcast_visibility
  // fires one unit_revealed message per newly-revealed unit in a tight
  // loop, so two-or-more genuine reveals in the same round-trip used to
  // just overwrite each other in this single revealCinematicUnitId piece
  // of state (only the LAST one ever got shown, or — worse — cut the
  // first one's cinematic short mid-playback). A real queue: a reveal
  // that arrives while one is already showing waits its turn instead.
  const revealQueueRef = useRef<number[]>([])
  useEffect(() => {
    if (lastRevealedUnitId == null) return
    if (handledRevealIdRef.current === lastRevealedUnitId) return
    if (campaign && !campaign.enemy_reveal_cinematic) {
      handledRevealIdRef.current = lastRevealedUnitId
      return
    }
    const revealed = units.find((u) => u.id === lastRevealedUnitId)
    if (!revealed) return // units hasn't caught up yet — retry on the next units update, don't mark handled
    handledRevealIdRef.current = lastRevealedUnitId
    // Only a genuine hostile contact gets the cinematic — a revealed
    // ally/npc ghost (rare, but the mechanic doesn't discriminate) isn't
    // the "surprise enemy contact" moment this was built for.
    if (revealed.pilot_faction !== 'enemy') return
    setRevealCinematicUnitId((current) => {
      // Dedupe: a stray duplicate unit_revealed broadcast for the same id
      // must never queue a second showing of it — same id, same key, so
      // the child wouldn't remount and its own state would look "stuck"
      // even though it's really just showing the same thing twice.
      if (current === lastRevealedUnitId || revealQueueRef.current.includes(lastRevealedUnitId)) return current
      if (current == null) return lastRevealedUnitId
      revealQueueRef.current.push(lastRevealedUnitId)
      return current
    })
  }, [lastRevealedUnitId, campaign, units])
  const closeRevealCinematic = () => {
    setRevealCinematicUnitId(revealQueueRef.current.shift() ?? null)
  }
  // Owned here, not inside EnemyRevealCinematic itself — this effect is
  // keyed on the id directly, so it re-arms on every real transition
  // (including two reveals in a row sharing chassis/model, which used to
  // leave the child's own chassis/model-keyed timer never restarting).
  useEffect(() => {
    if (revealCinematicUnitId == null) return
    const t = setTimeout(closeRevealCinematic, REVEAL_CINEMATIC_AUTO_CLOSE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealCinematicUnitId])
  const revealCinematicUnit = units.find((u) => u.id === revealCinematicUnitId) ?? null

  // Mechs aren't part of useMapState (units alone drive the board's own
  // positions/facings) — fetched separately here purely to read
  // heat_current for SteamPuffs (real user request: "los mechs...
  // desprenderán vapor en todas las vistas de mapa"). Refetched on the
  // same triggers units already use, plus rosterVersion (a mech's
  // equipment/heat_sinks can change outside a move/attack).
  const [mechs, setMechs] = useState<Mech[]>([])
  useEffect(() => {
    if (campaignId == null) return
    listMechs(campaignId).then(setMechs).catch(() => {})
  }, [campaignId, visibility, lastAttack, lastMelee, rosterVersion])
  // heat_phase_resolved carries the new heat_current directly — patched
  // in immediately rather than waiting on a full mechs refetch, so the
  // steam reacts the instant the Heat Phase resolves. is_shutdown too
  // (real user report: the overheat tint used to stay stale until some
  // later, unrelated refetch caught up — see HeatPhaseResolved's own doc
  // comment in ws.ts).
  useEffect(() => {
    if (!heatPhaseResult) return
    setMechs((prev) => prev.map((m) => {
      const r = heatPhaseResult.results.find((res) => res.mech_id === m.id)
      return r ? { ...m, heat_current: r.heat_current, is_shutdown: r.is_shutdown, destroyed_reason: r.destroyed_reason } : m
    }))
  }, [heatPhaseResult])
  // Held phase (rounds.ts's useDisplayedPhase) — real user report: an
  // empty melee/heat phase used to resolve within the same WS
  // round-trip as whatever ended the phase before it, reading as
  // "skipped" even though it was genuinely considered. Drives the phase
  // indicator below AND steam gating (only DURING the Heat phase, on
  // every mech carrying real heat — "los mechs EN ESTA FASE
  // desprenderán vapor", real user report this used to show in every
  // phase instead).
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

  // Fase D real user request: "los muertos no deberían tirar iniciativas".
  const destroyedPilotIds = new Set(
    mechs.filter((m) => m.destroyed_reason != null && m.pilot_id != null).map((m) => m.pilot_id!),
  )

  // Real user report: the Heat Phase never resolved (a mech's steam kept
  // showing forever) whenever GMView — the only screen that used to
  // trigger this — wasn't the tab actually open. Mirrored here too so
  // whichever of GMView/TableView happens to be mounted drives it
  // forward; resolveHeatPhase is idempotent server-side (bt_rounds.
  // heat_resolved), so both screens calling it is a harmless no-op, not
  // a double-resolution.
  useEffect(() => {
    if (!campaignId || !roundState) return
    if (currentPhase(roundState) !== 'heat') return
    resolveHeatPhase(campaignId).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, roundState])

  // Real fog of war (real user request: "niebla de guerra real en el
  // table view... casillas que el equipo jugador no ve") — every hex at
  // least one player-faction unit currently sees, unioned server-side
  // (app/units.py's _team_visible_hexes). Seeded via a real GET on
  // mapId change (WS only carries updates going FORWARD from when it
  // connects, same reasoning as useMapState's own units/map fetch), then
  // kept live off the same visibility_update broadcast everything else
  // here already listens to.
  const [teamVisibleHexes, setTeamVisibleHexes] = useState<Set<string> | null>(null)
  // Real user request: "la niebla se tiene que ir disipando con cada
  // movimiento" — the OLD instant visibility_update (main.py's own
  // _broadcast_visibility, sent right after unit_walked) still arrives
  // over the wire almost immediately, well before a multi-hex walk's
  // animation actually finishes — applying it on arrival would fight
  // the new progressive fog_steps: the fog would jump straight to the
  // TRUE final state first, then visibly regress back to earlier/
  // incomplete steps for the rest of the walk, only to "catch up" again
  // once the animation reaches the end. Tracks which unit(s) currently
  // have a fog-stepped walk in flight (added in the unitWalked effect
  // below, removed once onTableUnitWalkStep applies that walk's own
  // LAST step) — the eager visibility_update write is skipped entirely
  // while any are, since the walk's own final fog_step already carries
  // the same authoritative answer at exactly the right moment.
  const walkingFogUnitIdsRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (mapId == null) return
    let cancelled = false
    getVisibility(mapId).then((v) => {
      if (!cancelled) setTeamVisibleHexes(new Set(v.visible_hexes.map((h) => `${h.q},${h.r}`)))
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mapId])
  useEffect(() => {
    if (!visibility) return
    if (walkingFogUnitIdsRef.current.size > 0) return
    setTeamVisibleHexes(new Set(visibility.visible_hexes.map((h) => `${h.q},${h.r}`)))
  }, [visibility])

  // Attack VFX — shared-table view gets the same laser/tracer/missile
  // animation as GMView, derived the same way, queued (see
  // useAttackVfxQueue's own doc comment) so a fast attack resolving
  // while a slower one still animates doesn't cut the first one off.
  const { activeAttack: activeAttackVfx, onAttackEffectDone } = useAttackVfxQueue(lastAttack, units, mechs)

  // GMView's/PlayerView's "Tirar iniciativa" button doesn't roll
  // anything itself anymore — it broadcasts "please throw dice for this
  // pilot" (initiative_roll_requested), and this is the one place that
  // actually does it: throw two real physics dice, wait for both to
  // settle, report whatever they actually landed on, then (5s later)
  // vanish and stop rendering. `activeThrows` is a LIST, not a single
  // slot — everyone should be able to roll at once ("quiero que TODOS
  // los jugadores/enemigos puedan tirar sus tiradas a la vez"); a single
  // slot meant a second request while the first was still resolving
  // replaced (and thus cut off mid-roll) the first one entirely. Each
  // entry's own `key` gives it a stable <InitiativeDice> identity, and
  // its index in the array becomes its lane (see LANE_SPACING) so
  // concurrent throws land apart instead of on top of each other.
  // Real user report: dice would keep "teleporting" the more of them were
  // in play, NEVER the first ones thrown, and only once something else
  // vanished — the actual mechanism: `lane` used to be each entry's
  // ARRAY INDEX, so removing an earlier (already-vanished) entry shifted
  // every LATER entry's index down by one. @react-three/rapier's own
  // RigidBody reacts to a `position` prop value change (even on an
  // already-settled body) by re-syncing its physics transform to match —
  // so a shifted lane → a recomputed `spawn` → the die's real rigid body
  // got yanked to the new coordinate, even mid-vanish or long after
  // resting. Each throw now gets a lane ONCE, at creation, that never
  // changes again regardless of what else is removed from this array
  // later.
  //
  // Real follow-up report: an ever-INCREASING counter (this used to be a
  // single nextLaneRef.current++, never decremented) fixed that bug but
  // introduced another — every throw for the rest of the whole session
  // got a strictly higher lane than the last, so laneZ (lane * spacing)
  // marched steadily further from the board the longer a session ran,
  // eventually spawning/landing dice way off the table. allocateLane
  // instead reuses the SMALLEST lane number not currently held by any
  // in-flight throw across BOTH lists below — bounded by how many throws
  // are actually concurrent right now, never by how many have EVER
  // happened this session.
  const allocateLane = () => {
    const used = new Set([...activeThrows, ...activePhysicalThrows].map((t) => t.lane))
    let lane = 0
    while (used.has(lane)) lane++
    return lane
  }

  const [activeThrows, setActiveThrows] = useState<{ pilotId: number; color: string; dieStyle: string | null; lane: number }[]>([])
  useEffect(() => {
    if (!initiativeRollRequest) return
    setActiveThrows((prev) => {
      // Same pilot's throw is already in flight — a StrictMode/dev-HMR
      // duplicate WS delivery re-firing this effect must not restart the
      // dice mid-roll (that resets the settle timers and can strand it
      // never reporting). Only a genuinely different pilot's request
      // adds a new entry.
      if (prev.some((t) => t.pilotId === initiativeRollRequest.pilot_id)) return prev
      return [...prev, {
        pilotId: initiativeRollRequest.pilot_id,
        color: initiativeRollRequest.color, dieStyle: initiativeRollRequest.die_style,
        lane: allocateLane(),
      }]
    })
    // allocateLane deliberately omitted — a fresh closure every render
    // (reads current activeThrows/activePhysicalThrows), and this effect
    // must only fire on a genuinely new initiativeRollRequest, not on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiativeRollRequest])

  const reportSettledInitiative = (pilotId: number) => (total: number, dice: [number, number]) => {
    if (campaignId == null) return
    reportInitiative(campaignId, pilotId, total, dice).catch(() => {})
  }

  // Fase B — the generic "any other roll" counterpart to activeThrows
  // above. Keyed by pending_roll_id (not pilot_id): a single attack can
  // chain several physical rolls back to back (impact -> location ->
  // criticals...), each one a NEW pending_roll_id/broadcast once the
  // previous is reported, so — unlike initiative, which is one throw per
  // pilot per round — the same pilot can legitimately have a fresh entry
  // appear here moments after the last one finished.
  const [activePhysicalThrows, setActivePhysicalThrows] = useState<
    { pendingRollId: number; dieCount: 1 | 2; color: string; dieStyle: string | null; lane: number }[]
  >([])
  useEffect(() => {
    if (!physicalRollRequest) return
    setActivePhysicalThrows((prev) => {
      if (prev.some((t) => t.pendingRollId === physicalRollRequest.pending_roll_id)) return prev
      return [...prev, {
        pendingRollId: physicalRollRequest.pending_roll_id,
        dieCount: physicalRollRequest.dice_spec === '2d6' ? 2 : 1,
        color: physicalRollRequest.color ?? '#c8c8c8', dieStyle: physicalRollRequest.die_style,
        lane: allocateLane(),
      }]
    })
    // Same allocateLane-omitted-from-deps reasoning as activeThrows' own
    // effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [physicalRollRequest])

  const reportSettledPhysicalRoll = (pendingRollId: number) => (_total: number, dice: number[]) => {
    if (campaignId == null) return
    reportPendingRoll(campaignId, pendingRollId, dice).catch(() => {})
  }

  // PlayerView has no map of its own (see api.ts's requestMovement) — a
  // player picking a movement type there broadcasts the reachable set
  // here instead, so the shared table can paint the highlight and
  // capture the confirming click. GMView's own embedded map handles its
  // own movement directly, without this broadcast.
  const [activeMovement, setActiveMovement] = useState<
    { unitId: number; pilotId: number | null; movementType: MovementType; hexes: Map<string, ReachableHex> } | null
  >(null)
  useEffect(() => {
    if (!movementStarted) return
    setActiveMovement({
      unitId: movementStarted.unit_id,
      pilotId: movementStarted.pilot_id,
      movementType: movementStarted.movement_type,
      hexes: new Map(movementStarted.hexes.map((h) => [`${h.q},${h.r}`, h])),
    })
  }, [movementStarted])

  // The real route for whichever unit(s) currently have a movement-phase
  // move in flight, keyed by unit id — populated the moment a tile click
  // resolves a valid destination, so once the server-driven `units` prop
  // eventually reflects the new q/r (via broadcast + refetch), HexMap
  // walks the actual calculated path instead of a straight line.
  const [walkPaths, setWalkPaths] = useState<Map<number, { q: number; r: number }[]>>(new Map())
  // Real user request: proper Walk/Run/Jump animation chains, not the
  // same Idle/Walk crossfade for every move — same population pattern as
  // walkPaths above, straight off this same unit_walked broadcast.
  const [walkMovementTypes, setWalkMovementTypes] = useState<Map<number, 'walk' | 'run' | 'jump'>>(new Map())
  // Real user request: "la niebla se tiene que ir disipando con cada
  // movimiento... cada paso del mech tiene que actualizar la niebla,
  // tanto en TableView como en FPV. Ahora mismo calcula la de la
  // posicion final nada mas empezar el movimiento" — one fog snapshot
  // per waypoint of whichever unit(s) are currently walking a real
  // path, applied to teamVisibleHexes exactly when HexMap's own walk
  // animation ARRIVES at each hex (onUnitWalkStep below), not the
  // instant the move starts.
  const [fogStepsByUnit, setFogStepsByUnit] = useState<Map<number, FogWalkStep[]>>(new Map())

  // Real user report (investigated 2026-08): a move whose destination
  // click THIS screen didn't itself capture (GM's own map, PlayerView's
  // Acciones, a cockpit HUD) always slid in a straight line here,
  // unlike GMView/FirstPersonView, which both already walk the real
  // path via this same unit_walked broadcast. This used to be
  // DELIBERATELY skipped specifically on this screen — a prior physics
  // crash (an uncaught @react-three/rapier panic, "recursive use of an
  // object detected... unsafe aliasing", freezing the tab) was traced to
  // adding it here, the one view rendered with `physics` (dice rolling
  // across the board). Re-added now: nothing here differs from what
  // GMView/FirstPersonView already do safely (same Map-replace pattern,
  // no component remounts — UnitMarker keeps its stable `key={unit.id}`
  // either way), and this app's rapier/@react-three/rapier versions have
  // moved on since that crash was first hit. Test carefully alongside
  // an active dice throw specifically (the original crash's other
  // ingredient) — revert this one effect if the tab freezes again.
  const heldMover = useHeldActiveMover(roundState ? activeMoverPilotId(roundState) : null)
  useEffect(() => {
    if (!unitWalked || unitWalked.path.length === 0) return
    setWalkPaths((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.path))
    setWalkMovementTypes((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.movement_type))
    if (unitWalked.fog_steps && unitWalked.fog_steps.length > 0) {
      setFogStepsByUnit((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.fog_steps!))
      walkingFogUnitIdsRef.current.add(unitWalked.unit_id)
    }
    const walkedUnit = units.find((u) => u.id === unitWalked.unit_id)
    heldMover.onUnitWalkStart(unitWalked.unit_id, walkedUnit?.pilot_id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitWalked])

  const onTableUnitWalkStep = (unitId: number, index: number) => {
    const unitSteps = fogStepsByUnit.get(unitId)
    const step = unitSteps?.[index]
    if (step) setTeamVisibleHexes(new Set(step.visible_hexes.map((h) => `${h.q},${h.r}`)))
    // The last waypoint's own fog_step IS the true final answer (both
    // computed from the same settled position) — safe to let the
    // ordinary visibility_update-driven effect resume writing again.
    if (unitSteps && index === unitSteps.length - 1) walkingFogUnitIdsRef.current.delete(unitId)
  }

  // Safety net for onTableUnitWalkStep's own last-index clear above — a
  // walk that never actually reaches its last waypoint (an undo mid-
  // flight redirects it elsewhere, the unit is destroyed mid-walk, …)
  // would otherwise leave that unit's id stuck in walkingFogUnitIdsRef
  // forever, silently freezing EVERY unit's fog on this screen. Whatever
  // eventually makes the walk animation settle — for any reason — also
  // clears it here.
  const onTableUnitWalkDone = (unitId: number) => {
    walkingFogUnitIdsRef.current.delete(unitId)
    heldMover.onUnitWalkDone(unitId)
  }

  // The move itself can also complete somewhere that never clicks a tile
  // HERE — GMView's own embedded map resolves its own moves directly
  // (see its startPhaseMovement/onTileClick), so this client's
  // activeMovement would otherwise sit showing a stale highlight
  // indefinitely. round_updated (broadcast after every move) is the
  // one signal every path shares — once this pilot shows up in
  // moved_pilot_ids, whatever move was pending for them is done.
  useEffect(() => {
    if (!activeMovement || activeMovement.pilotId == null || !roundState) return
    if (roundState.moved_pilot_ids.includes(activeMovement.pilotId)) setActiveMovement(null)
  }, [roundState, activeMovement])

  const onTableTileClick = (q: number, r: number) => {
    if (!activeMovement) return
    const key = `${q},${r}`
    const { unitId, movementType } = activeMovement
    const hex = activeMovement.hexes.get(key)
    setActiveMovement(null)
    if (hex) {
      if (hex.path.length > 0) setWalkPaths((prev) => new Map(prev).set(unitId, hex.path))
      moveUnitWithMp(unitId, q, r, movementType).catch(() => {})
    }
  }

  if (campaignId == null) {
    return (
      <div className="table-view">
        <div className="hud">preparando campaña…</div>
      </div>
    )
  }

  return (
    <div className="table-view">
      <div className="hud">
        <span className={`status-dot ${connected ? 'on' : 'off'}`} />
        <span>
          {connected ? 'conectado' : 'sin conexión'} — {campaign?.name ?? `campaña #${campaignId}`}
        </span>
        {lastRoll && (
          <span className="roll-badge">
            {lastRoll.die} → <strong>{lastRoll.result}</strong>
          </span>
        )}
      </div>

      {/* Real user request: just phase + round number, no initiative-roll
          listing (that moved out of this shared screen entirely, real
          user request: "eliminar iniciativas de la table view"). One
          copy per screen edge (see .phase-indicator-side's own doc
          comment) — this projects onto a table with players seated all
          the way around it, not just one "front". */}
      {roundState && roundState.round_number > 0 && ['top', 'bottom', 'left', 'right'].map((side) => (
        <div key={side} className={`phase-indicator-side ${side}`}>
          <span className="phase-indicator-phase">{PHASE_LABELS[displayedPhase]}</span>
          <span className="phase-indicator-round">Ronda {roundState.round_number}</span>
        </div>
      ))}

      {/* Cenital por defecto: es lo que replica la cámara real de la mesa
          física. Solo se rompe para el inset de repetición (abajo), nunca
          para el canvas principal. */}
      {/* near/far explicit and HEX_SIZE-scaled alongside position — see
          GMView.tsx's own identical comment (same fix, same real user
          report: "se glichea el agua cuando hago zoom"). */}
      {/* Real user report: zoom-out z-fighting that visibly jumps between
          different hexes as zoom changes — see GMView.tsx's own identical
          fix for the full reasoning (near:far precision ratio, not a
          per-tile bug; a first, more aggressive far cut clipped the whole
          map at a normal "zoomed all the way out" distance, a real
          regression, not a fix). */}
      <Canvas
        shadows
        camera={{ position: [0, 16 * HEX_SIZE, 0.01], fov: 40, near: 1 * HEX_SIZE, far: 500 * HEX_SIZE }}
      >
        {/* First child on purpose: it closes each frame's measurements,
            and R3F runs same-priority frame callbacks in mount order. */}
        <PerfProbe />
        <FrameGate policy={renderPolicy} />
        {/* Real user report: "los dados de jade se ven muy oscuros,
            quiza la escena tenga poca luz" — bumped alongside the
            per-material envMapIntensity values in dieStyles.ts; this
            benefits every mech/unit rendered in the same scene too,
            not just dice. */}
        {/* Matched to GMView's own 0.6 / 1.4, now as SceneLighting's own
            midday scales. These were raised to 0.85 / 1.8 for one reason —
            "los dados de jade se ven muy oscuros" — and lighting the whole
            board to fix the dice washed the board out, which is what the
            <Environment> below is actually for. Real user report: "en algun
            momento subimos el brillo o la iluminacion de TableView y se
            quedo asi, igualalo a GMView". */}
        <SceneLighting hour={timeOfDay} />
        {/* Real user request: metallic/glass dice need real reflections
            to read as true chrome/glass rather than a flat tinted
            material (see dieStyles.ts's own doc comment) — lighting/
            reflections ONLY (background=false keeps the plain table
            backdrop above untouched). Same bundled CC0 HDRI already
            partly used for FirstPersonView's sky (public/textures/
            CREDITS.md), offline per VISION.md §3 — no network fetch at
            runtime, just a local file under public/. */}
        <Suspense fallback={null}>
          <Environment files="/textures/dice-env.exr" background={false} />
        </Suspense>
        {/* -9.81 was real Earth gravity for the dice, the only dynamic
            (gravity-affected) bodies in this Physics world — every tile/
            mech/decor collider is fixed or kinematic, so this never
            touched the mech/hex rescale at all. Dice themselves DO need
            it scaled now (see Die.tsx's own doc comment on why they were
            invisible after that rescale): scaling every dice spatial/
            velocity constant by HEX_SIZE while leaving gravity's
            acceleration untouched would make the same fall take
            sqrt(HEX_SIZE) times longer (falling HEX_SIZE times farther
            under the same accel) — scaling gravity by HEX_SIZE too keeps
            the exact same fall/bounce TIMING, just at the new scale. */}
        <Physics gravity={[0, -9.81 * HEX_SIZE, 0]}>
          <PerfPhysicsProbe />
          {/* Real user report: a die that rolled off a tile into a gap
              fell straight through — this used to render OUTSIDE
              <Physics> entirely (a plain visual mesh, no collider at
              all). Moved inside and given `physics` so it can add its
              own backstop floor collider well below the tiles — see its
              own doc comment. */}
          <TableBackground physics hexScale />
          {map && <BoardWalls map={map} clearLeftOf={THROW_ORIGIN_X} />}
          <Suspense fallback={null}>
            {map && (
              <HexMap
                map={map}
                units={units}
                needsInitiativePilotIds={pilotsNeedingInitiative(roundState, units, destroyedPilotIds)}
                activeMoverPilotId={heldMover.displayedMoverPilotId}
                activeAttackerPilotIds={roundState ? activeAttackPilotIds(roundState, units) : undefined}
                moveHighlightHexes={activeMovement ? new Set(activeMovement.hexes.keys()) : undefined}
                walkPaths={walkPaths}
                walkMovementTypes={walkMovementTypes}
                heatByUnitId={heatByUnitId}
                proneUnitIds={proneUnitIds}
                shutdownUnitIds={shutdownUnitIds}
                destroyedReasonByUnitId={destroyedReasonByUnitId}
                severedLocationsByUnitId={severedLocationsByUnitId}
                teamVisibleHexes={teamVisibleHexes ?? undefined}
                activeAttack={activeAttackVfx}
                onAttackEffectDone={onAttackEffectDone}
                onUnitWalkDone={onTableUnitWalkDone}
                onUnitWalkStep={onTableUnitWalkStep}
                onTileClick={onTableTileClick}
                physics
                boardgameScale
              />
            )}
          </Suspense>
          {/* Real user report, two compounding bugs behind the same
              "teleporting die" symptom:
              1) key={t.key} used to be Date.now() — only millisecond
                 resolution, and Fase B can fire several roll requests
                 within the same millisecond, so two throws' keys could
                 collide; React would then reuse the FIRST's still-
                 mounted RigidBody for the SECOND throw instead of
                 mounting a new one. Fixed by keying on the naturally
                 unique pilotId/pendingRollId instead.
              2) `lane` used to be each entry's ARRAY INDEX — removing an
                 earlier (already-vanished) entry shifted every LATER
                 entry's index down by one, recomputing its `spawn`;
                 @react-three/rapier reacts to a changed `position` prop
                 by re-syncing the physics body's real transform to
                 match, even on an already-settled/fixed body — so a
                 shifted lane silently yanked an unrelated die to a new
                 spot. Fixed by handing out `lane` ONCE per throw, at
                 creation (nextLaneRef above), never recomputed from the
                 array afterward. */}
          {/* Die.tsx now loads real PBR textures for metallic styles via
              drei's useTexture (Suspense-based) — needs a boundary
              somewhere above it, this is the nearest one. fallback={null}
              just holds off mounting a throw's RigidBody for the (after
              the very first roll, cache-instant) moment its style's
              textures load, same as HexMap's own Suspense right above. */}
          <Suspense fallback={null}>
            {activeThrows.map((t) => (
              <InitiativeDice
                key={t.pilotId}
                rollId={t.pilotId}
                color={t.color}
                dieStyle={t.dieStyle}
                lane={t.lane}
                onSettled={reportSettledInitiative(t.pilotId)}
                onDone={() => setActiveThrows((prev) => prev.filter((x) => x.pilotId !== t.pilotId))}
              />
            ))}
            {activePhysicalThrows.map((t) => (
              <PhysicalDiceThrow
                key={t.pendingRollId}
                rollId={t.pendingRollId}
                dieCount={t.dieCount}
                color={t.color}
                dieStyle={t.dieStyle}
                lane={t.lane}
                onSettled={reportSettledPhysicalRoll(t.pendingRollId)}
                onDone={() => setActivePhysicalThrows((prev) => prev.filter((x) => x.pendingRollId !== t.pendingRollId))}
              />
            ))}
          </Suspense>
        </Physics>
        {/* dampingFactor explicit — drei's OrbitControls defaults
            enableDamping to true but leaves three.js's own default
            dampingFactor (0.05, very little friction), which is why a
            drag/rotate used to keep spinning for a long time after
            release (real user report). 0.2 keeps a little inertia
            without the endless slow spin. */}
        <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
      </Canvas>
      <PerfHud />

      {revealCinematicUnit && (
        // key={revealCinematicUnitId} forces a full remount for every new
        // reveal — without it, two reveals sharing the same chassis/model
        // (a common case: two of the same enemy mech) leave React reusing
        // the same instance, so EnemyRevealCinematic's own auto-close
        // timer (keyed off [chassis, model], see its own file) never
        // restarts for the second one — real user report: "la última se
        // queda eternamente".
        <EnemyRevealCinematic
          key={revealCinematicUnitId}
          chassis={revealCinematicUnit.mech_chassis}
          model={revealCinematicUnit.mech_model}
          color={FACTION_COLORS.enemy}
          onClose={closeRevealCinematic}
        />
      )}
    </div>
  )
}

/** D&D 5e's own shared-table screen (ROADMAP.md Fase R4 — slice mínimo)
 * — a passive display, same spirit as the BattleTech one (fixed cenital
 * camera, no interaction), but without physics/dice/kill-replay, none
 * of which this slice's D&D rules use yet. */
function TableViewDnd({ campaignId }: { campaignId: number }) {
  const { activeMapId, visibility, lastAttack } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)
  const { map, units } = useMapState(mapId, visibility ?? lastAttack)

  return (
    <div className="table-view">
      <Canvas shadows camera={{ position: [0, 16, 0.01], fov: 40 }}>
        <color attach="background" args={['#0f1a18']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[4, 8, 3]} intensity={1.4} castShadow />
        <TableBackground />
        {map && <SquareMap map={map} units={units} />}
        {/* dampingFactor explicit — drei's OrbitControls defaults
            enableDamping to true but leaves three.js's own default
            dampingFactor (0.05, very little friction), which is why a
            drag/rotate used to keep spinning for a long time after
            release (real user report). 0.2 keeps a little inertia
            without the endless slow spin. */}
        <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
      </Canvas>
    </div>
  )
}

/** Real entry point (replaces the old direct `TableView` export) —
 * same BattleTech-default-while-loading dispatch pattern as GMView's
 * own wrapper (see its doc comment): zero behavior change for an
 * existing BattleTech table. */
export function TableView() {
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
  if (system === 'dnd5e') return <TableViewDnd campaignId={campaignId} />
  return <TableViewBattletech />
}
