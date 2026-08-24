import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { OrbitControls } from '@react-three/drei'
import { Die } from '../components/Die'
import { HexMap, useAttackVfxQueue } from '../components/HexMap'
import { KillReplay } from '../components/KillReplay'
import { TableBackground } from '../components/TableBackground'
import { BoardWalls } from '../components/BoardWalls'
import { NavBar } from '../components/NavBar'
import { useTableSocket } from '../ws'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import { getUnitVisibleHexes, moveUnitWithMp, reportInitiative, type MovementType, type ReachableHex, type Unit } from '../api'
import { useMapState } from '../useMapState'
import { activeAttackPilotIds, activeMoverPilotId, currentPhase, formatRolls, PHASE_LABELS, pilotsNeedingInitiative } from '../rounds'
import './TableView.css'

// Debug-only LoS view (see HexMap's LosDebugOverlay + app/units.py's
// visible_hexes_from_unit) — real per-player vision-cone fog is still
// unbuilt (VISION.md §4.2), so this is the "prove it's computing
// something" stand-in: pick any unit on the map, see the tiles it has
// LoS to highlighted, regardless of whether it even has a pilot linked
// (unlike the real fog, which is pilot-gated).
function useUnitLosDebug(units: Unit[]) {
  const [unitId, setUnitId] = useState<number | null>(null)
  const [hexes, setHexes] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (unitId == null) {
      setHexes(new Set())
      return
    }
    let cancelled = false
    getUnitVisibleHexes(unitId).then((visible) => {
      if (!cancelled) setHexes(new Set(visible.map((h) => `${h.q},${h.r}`)))
    })
    return () => {
      cancelled = true
    }
  }, [unitId, units])

  return { unitId, setUnitId, hexes }
}


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
  rollId, color, lane, onSettled, onDone,
}: {
  rollId: number | string
  color: string
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
        rollId={seed} color={color}
        spawn={[THROW_ORIGIN_X, 1.1, laneZ + jitterZ - 0.4]}
        throwVelocity={[speed, 1.4, (seed % 3) * 0.4 - 0.4]}
        onSettled={settle('a')}
        vanishing={vanishing}
        onVanished={onDone}
      />
      <Die
        rollId={seed} color={color}
        spawn={[THROW_ORIGIN_X, 1.3, laneZ + jitterZ + 0.4]}
        throwVelocity={[speed - 0.4, 1.7, (seed % 3) * 0.4 - 0.6]}
        onSettled={settle('b')}
        vanishing={vanishing}
      />
    </>
  )
}

export function TableView() {
  const campaignId = useCampaignId()
  const {
    connected, lastRoll, visibility, lastRevealedUnitId, lastAttack, activeMapId, roundState, initiativeRollRequest,
    movementStarted,
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
  const losDebug = useUnitLosDebug(units)

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
  const [activeThrows, setActiveThrows] = useState<{ key: number; pilotId: number; color: string }[]>([])
  useEffect(() => {
    if (!initiativeRollRequest) return
    setActiveThrows((prev) => {
      // Same pilot's throw is already in flight — a StrictMode/dev-HMR
      // duplicate WS delivery re-firing this effect must not restart the
      // dice mid-roll (that resets the settle timers and can strand it
      // never reporting). Only a genuinely different pilot's request
      // adds a new entry.
      if (prev.some((t) => t.pilotId === initiativeRollRequest.pilot_id)) return prev
      return [...prev, { key: Date.now(), pilotId: initiativeRollRequest.pilot_id, color: initiativeRollRequest.color }]
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
        {roundState && roundState.round_number > 0 && (
          <>
            <span className="roll-badge phase-badge">Fase: {PHASE_LABELS[currentPhase(roundState)]}</span>
            <span className="roll-badge round-badge">
              Ronda {roundState.round_number} · {formatRolls(roundState.rolls)}
            </span>
          </>
        )}
      </div>

      <div className="hud-nav">
        <NavBar campaignId={campaignId} current="/" variant="overlay" />
      </div>

      {units.length > 0 && (
        <div className="los-debug">
          <span>LoS debug</span>
          <select
            value={losDebug.unitId ?? ''}
            onChange={(e) => losDebug.setUnitId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">apagado</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                #{u.id} {u.is_ghost ? '(fantasma)' : ''} {u.pilot_faction ?? 'sin piloto'} @ {u.q},{u.r}
              </option>
            ))}
          </select>
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
                losDebugHexes={losDebug.hexes}
                needsInitiativePilotIds={pilotsNeedingInitiative(roundState, units)}
                activeMoverPilotId={roundState ? activeMoverPilotId(roundState) : null}
                activeAttackerPilotIds={roundState ? activeAttackPilotIds(roundState) : undefined}
                moveHighlightHexes={activeMovement ? new Set(activeMovement.hexes.keys()) : undefined}
                walkPaths={walkPaths}
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
              lane={i}
              onSettled={reportSettledInitiative(t.pilotId)}
              onDone={() => setActiveThrows((prev) => prev.filter((x) => x.key !== t.key))}
            />
          ))}
        </Physics>
        <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} />
      </Canvas>

      {replay && <KillReplay label={replay} onDone={() => setReplay(null)} />}
    </div>
  )
}
