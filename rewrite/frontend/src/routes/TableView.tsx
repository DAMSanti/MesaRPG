import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { OrbitControls } from '@react-three/drei'
import { Die } from '../components/Die'
import { HexMap, useAttackVfxQueue } from '../components/HexMap'
import { KillReplay } from '../components/KillReplay'
import { TableBackground } from '../components/TableBackground'
import { BoardWalls } from '../components/BoardWalls'
import { EnemyRevealCinematic } from '../components/EnemyRevealCinematic'
import { useTableSocket } from '../ws'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import {
  getVisibility, listCampaigns, listMechs, moveUnitWithMp, reportInitiative, resolveHeatPhase,
  type Campaign, type Mech, type MovementType, type ReachableHex,
} from '../api'
import { useMapState } from '../useMapState'
import {
  activeAttackPilotIds, activeMoverPilotId, currentPhase, PHASE_LABELS, pilotsNeedingInitiative, useDisplayedPhase,
} from '../rounds'
import { FACTION_COLORS } from '../factions'
import { SquareMap } from '../components/SquareMap'
import './TableView.css'

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
// Just off the board's edge (the board itself is centered on world
// origin — see mapCenter/hexToWorld) — close enough that a modest toss
// speed still comfortably reaches and settles within a typical map
// instead of sailing across and off the far side.
const THROW_ORIGIN_X = -5

// How long the dice sit still showing their result before vanishing.
const DICE_VISIBLE_MS = 5000

// Concurrent throws (everyone rolling at once — requested directly, one
// pilot's throw must not get cut off by another's) land in their own
// lateral lane instead of overlapping — a fixed, deterministic offset
// per lane index, not the old hash-based jitter (which only spread out
// *consecutive* single throws, never designed to keep several truly
// simultaneous ones apart).
const LANE_SPACING = 2.2

function InitiativeDice({
  rollId, color, dieStyle, lane, onSettled, onDone,
}: {
  rollId: number | string
  color: string
  /** The rolling pilot's own die-style pick (../dieStyles.ts), if any —
   * real user request. */
  dieStyle: string | null
  /** Which concurrent throw this is (0, 1, 2…) — see TableView's
   * activeThrows — purely for spatial separation, not gameplay. */
  lane: number
  onSettled: (total: number, dice: [number, number]) => void
  /** Fires once the dice have fully vanished — the caller's cue to stop
   * rendering this <InitiativeDice> at all. */
  onDone: () => void
}) {
  const seed = typeof rollId === 'number' ? rollId : 0
  // One ref per mounted roll (a fresh InitiativeDice instance per
  // request — see its `key` at the call site) so two dice from the same
  // throw can each report in independently and the total only fires
  // once both are in.
  const valuesRef = useRef<{ a: number | null; b: number | null }>({ a: null, b: null })
  const reportedRef = useRef(false)
  const [vanishing, setVanishing] = useState(false)
  const settle = (which: 'a' | 'b') => (value: number) => {
    valuesRef.current[which] = value
    const { a, b } = valuesRef.current
    if (a != null && b != null && !reportedRef.current) {
      reportedRef.current = true
      onSettled(a + b, [a, b])
      setTimeout(() => {
        setVanishing(true)
      }, DICE_VISIBLE_MS)
    }
  }

  // Thrown in from just off the board's edge, low and at a real-toss
  // (not runaway) speed — small per-roll jitter (on top of the lane
  // offset) so two dice from the SAME throw don't land in the exact
  // same spot either.
  const laneZ = (lane - 1) * LANE_SPACING
  const jitterZ = ((seed % 5) - 2) * 0.5
  const speed = 3 + (seed % 3) * 0.4
  return (
    <>
      <Die
        rollId={seed} color={color} style={dieStyle}
        spawn={[THROW_ORIGIN_X, 1.1, laneZ + jitterZ - 0.4]}
        throwVelocity={[speed, 1.4, (seed % 3) * 0.4 - 0.4]}
        onSettled={settle('a')}
        vanishing={vanishing}
        onVanished={onDone}
      />
      <Die
        rollId={seed} color={color} style={dieStyle}
        spawn={[THROW_ORIGIN_X, 1.3, laneZ + jitterZ + 0.4]}
        throwVelocity={[speed - 0.4, 1.7, (seed % 3) * 0.4 - 0.6]}
        onSettled={settle('b')}
        vanishing={vanishing}
      />
    </>
  )
}

/** The BattleTech shared-table screen — everything this file did before
 * Fase R4 (D&D 5e as a second system). Renamed, otherwise untouched:
 * see the real `TableView` export at the bottom of this file. */
function TableViewBattletech() {
  const campaignId = useCampaignId()
  const {
    connected, lastRoll, visibility, lastRevealedUnitId, lastAttack, activeMapId, roundState, initiativeRollRequest,
    movementStarted, heatPhaseResult, rosterVersion,
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
  const [replay, setReplay] = useState<string | null>(null)

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
  useEffect(() => {
    if (lastRevealedUnitId == null) return
    if (campaign && !campaign.enemy_reveal_cinematic) return
    const revealed = units.find((u) => u.id === lastRevealedUnitId)
    // Only a genuine hostile contact gets the cinematic — a revealed
    // ally/npc ghost (rare, but the mechanic doesn't discriminate) isn't
    // the "surprise enemy contact" moment this was built for.
    if (revealed?.pilot_faction !== 'enemy') return
    setRevealCinematicUnitId(lastRevealedUnitId)
  }, [lastRevealedUnitId, campaign, units])
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
  }, [campaignId, visibility, lastAttack, rosterVersion])
  // heat_phase_resolved carries the new heat_current directly — patched
  // in immediately rather than waiting on a full mechs refetch, so the
  // steam reacts the instant the Heat Phase resolves.
  useEffect(() => {
    if (!heatPhaseResult) return
    setMechs((prev) => prev.map((m) => {
      const r = heatPhaseResult.results.find((res) => res.mech_id === m.id)
      return r ? { ...m, heat_current: r.heat_current } : m
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
    setTeamVisibleHexes(new Set(visibility.visible_hexes.map((h) => `${h.q},${h.r}`)))
  }, [visibility])

  useEffect(() => {
    if (lastAttack?.mech_destroyed) {
      setReplay(`MECH #${lastAttack.target_mech_id} DESTRUIDO`)
    }
  }, [lastAttack])

  // Attack VFX — shared-table view gets the same laser/tracer/missile
  // animation as GMView, derived the same way, queued (see
  // useAttackVfxQueue's own doc comment) so a fast attack resolving
  // while a slower one still animates doesn't cut the first one off.
  const { activeAttack: activeAttackVfx, onAttackEffectDone } = useAttackVfxQueue(lastAttack, units)

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
  const [activeThrows, setActiveThrows] = useState<{ key: number; pilotId: number; color: string; dieStyle: string | null }[]>([])
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
        key: Date.now(), pilotId: initiativeRollRequest.pilot_id,
        color: initiativeRollRequest.color, dieStyle: initiativeRollRequest.die_style,
      }]
    })
  }, [initiativeRollRequest])

  const reportSettledInitiative = (pilotId: number) => (total: number, dice: [number, number]) => {
    if (campaignId == null) return
    reportInitiative(campaignId, pilotId, total, dice).catch(() => {})
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
  //
  // DELIBERATELY does NOT also listen for the `unit_walked` broadcast the
  // way GMView/FirstPersonView now do (see their own matching comments) —
  // this is the one view rendered with `physics` (below), and a real
  // live crash traced to here (an uncaught @react-three/rapier panic,
  // "recursive use of an object detected... unsafe aliasing", repeating
  // every frame and freezing the whole tab) landed right after that
  // extra WS-driven re-render was added on top of this screen's own
  // physics/dice activity. Reverted rather than risk it again blind — a
  // move THIS screen didn't itself capture the destination click for
  // (GM's own map, PlayerView's Acciones, a cockpit HUD) still falls
  // back to a straight line here specifically, unlike the other views.
  const [walkPaths, setWalkPaths] = useState<Map<number, { q: number; r: number }[]>>(new Map())

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
          {connected ? 'conectado' : 'sin conexión'} — campaña #{campaignId}
        </span>
        {lastRoll && (
          <span className="roll-badge">
            {lastRoll.die} → <strong>{lastRoll.result}</strong>
          </span>
        )}
        {lastRevealedUnitId != null && (
          <span className="roll-badge reveal-badge">¡figura revelada! #{lastRevealedUnitId}</span>
        )}
      </div>

      {/* Real user request: centered at the top instead of tucked into
          the left-corner HUD strip, and just phase + round number — no
          initiative-roll listing (that moved out of this shared screen
          entirely, real user request: "eliminar iniciativas de la table
          view"). */}
      {roundState && roundState.round_number > 0 && (
        <div className="phase-indicator">
          <span className="phase-indicator-phase">{PHASE_LABELS[displayedPhase]}</span>
          <span className="phase-indicator-round">Ronda {roundState.round_number}</span>
        </div>
      )}

      {/* Cenital por defecto: es lo que replica la cámara real de la mesa
          física. Solo se rompe para el inset de repetición (abajo), nunca
          para el canvas principal. */}
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
        <Physics gravity={[0, -9.81, 0]}>
          {map && <BoardWalls map={map} clearLeftOf={THROW_ORIGIN_X} />}
          <Suspense fallback={null}>
            {map && (
              <HexMap
                map={map}
                units={units}
                needsInitiativePilotIds={pilotsNeedingInitiative(roundState, units)}
                activeMoverPilotId={roundState ? activeMoverPilotId(roundState) : null}
                activeAttackerPilotIds={roundState ? activeAttackPilotIds(roundState, units) : undefined}
                moveHighlightHexes={activeMovement ? new Set(activeMovement.hexes.keys()) : undefined}
                walkPaths={walkPaths}
                heatByUnitId={heatByUnitId}
                proneUnitIds={proneUnitIds}
                shutdownUnitIds={shutdownUnitIds}
                teamVisibleHexes={teamVisibleHexes ?? undefined}
                activeAttack={activeAttackVfx}
                onAttackEffectDone={onAttackEffectDone}
                onTileClick={onTableTileClick}
                physics
              />
            )}
          </Suspense>
          {activeThrows.map((t, i) => (
            <InitiativeDice
              key={t.key}
              rollId={t.key}
              color={t.color}
              dieStyle={t.dieStyle}
              lane={i}
              onSettled={reportSettledInitiative(t.pilotId)}
              onDone={() => setActiveThrows((prev) => prev.filter((x) => x.key !== t.key))}
            />
          ))}
        </Physics>
        {/* dampingFactor explicit — drei's OrbitControls defaults
            enableDamping to true but leaves three.js's own default
            dampingFactor (0.05, very little friction), which is why a
            drag/rotate used to keep spinning for a long time after
            release (real user report). 0.2 keeps a little inertia
            without the endless slow spin. */}
        <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
      </Canvas>

      {replay && <KillReplay label={replay} onDone={() => setReplay(null)} />}

      {revealCinematicUnit && (
        <EnemyRevealCinematic
          chassis={revealCinematicUnit.mech_chassis}
          model={revealCinematicUnit.mech_model}
          color={FACTION_COLORS.enemy}
          onClose={() => setRevealCinematicUnitId(null)}
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
