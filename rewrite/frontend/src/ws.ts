import { useCallback, useEffect, useRef, useState } from 'react'
import { getRound, type ReachableHex, type RoundState } from './api'

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8124/ws'

export type DieType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20'

export interface RollResult {
  type: 'roll_result'
  id: number
  campaign_id: number
  pilot_id: number | null
  die: DieType
  result: number
  label: string | null
  created_at: string
}

/**
 * Each campaign is its own WebSocket room server-side (see
 * rewrite/backend/app/ws.py) — a broadcast in one campaign never reaches
 * a client connected to another.
 */
export interface VisibilityUpdate {
  type: 'visibility_update'
  visible: Record<string, number[]>
  newly_revealed: number[]
}

export interface AttackResult {
  type: 'attack_result'
  target_mech_id: number
  // Only populated for real board attacks — see api.ts's AttackResult.
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

// A physical/melee attack just resolved (main.py's /api/units/{id}/melee
// — api.ts's MeleeAttackResult is the same shape minus the `type` tag).
// Kept as its own message type rather than reusing 'attack_result' since
// the two carry genuinely different fields (hit_results/self_damage_
// results/fall vs a single weapon shot's location/critical).
export interface MeleeResult {
  type: 'melee_result'
  attack_type: 'punch' | 'kick' | 'charge' | 'dfa'
  attacker_unit_id: number
  target_unit_id: number
  attacker_mech_id: number
  target_mech_id: number
  target_number: number
  roll: number
  hit: boolean
  damage: number | null
  mech_destroyed: boolean
  fall: Record<string, unknown> | null
  self_fall: Record<string, unknown> | null
}

// turns.py's resolve_heat_phase result — broadcast once per round the
// instant GMView calls resolveHeatPhase (see rounds.ts's currentPhase
// reaching 'other' with round.heat_resolved still false). Drives the
// thermometer's "watch it drop" animation and the shutdown/ammo-
// explosion notifications across every connected view.
export interface HeatPhaseResolved {
  type: 'heat_phase_resolved'
  campaign_id: number
  results: {
    mech_id: number
    heat_current: number
    shutdown: boolean | null
    restarted: boolean | null
    ammo_explosion: { damage: number } | null
    pilot_wound: number | null
  }[]
}

export interface ActiveMapChanged {
  type: 'active_map_changed'
  map_id: number
}

// "Please physically throw dice for this pilot" — sent by GMView's/
// PlayerView's "Tirar iniciativa" button (api.ts's requestInitiative),
// consumed only by TableView (the shared board), which is the one that
// actually rolls: reads whatever its two physics dice land on, then
// reports that back (api.ts's reportInitiative). See app/systems/
// battletech/turns.py's request_pilot_initiative for why there's no
// server-side random 2d6 for this flow anymore.
export interface InitiativeRollRequested {
  type: 'initiative_roll_requested'
  pilot_id: number
  pilot_name: string
  color: string
  die_style: string | null
}

// "This unit wants to move, here's where it can go" — broadcast by
// api.ts's requestMovement (PlayerView's Acciones has no map of its own,
// so it asks the shared table to paint the highlight + capture the
// confirming click). GMView instead uses its own embedded map directly,
// via getReachableHexes, without this broadcast.
export interface MovementStarted {
  type: 'movement_started'
  pilot_id: number | null
  unit_id: number
  movement_type: 'walk' | 'run' | 'jump'
  hexes: ReachableHex[]
}

// The real hex-by-hex route a move-with-mp just took (see
// movement.py's execute_move) — real user report: without this,
// any client that didn't itself pick this destination (the shared
// table watching a move requested from PlayerView/FirstPersonView, or
// any other viewer) had no route data at all and animated a straight
// line through whatever was in between, ignoring the actual
// pathfinding. Broadcast to everyone regardless of who moved it.
export interface UnitWalked {
  type: 'unit_walked'
  unit_id: number
  path: { q: number; r: number }[]
}

export function useTableSocket(campaignId: number | null) {
  const [connected, setConnected] = useState(false)
  const [lastRoll, setLastRoll] = useState<RollResult | null>(null)
  const [visibility, setVisibility] = useState<VisibilityUpdate | null>(null)
  const [lastRevealedUnitId, setLastRevealedUnitId] = useState<number | null>(null)
  const [lastAttack, setLastAttack] = useState<AttackResult | null>(null)
  const [activeMapId, setActiveMapId] = useState<number | null>(null)
  const [roundState, setRoundState] = useState<RoundState | null>(null)
  const [initiativeRollRequest, setInitiativeRollRequest] = useState<InitiativeRollRequested | null>(null)
  const [movementStarted, setMovementStarted] = useState<MovementStarted | null>(null)
  const [unitWalked, setUnitWalked] = useState<UnitWalked | null>(null)
  const [lastMelee, setLastMelee] = useState<MeleeResult | null>(null)
  const [heatPhaseResult, setHeatPhaseResult] = useState<HeatPhaseResolved | null>(null)
  // Bumped on every "roster_updated" broadcast (pilot/mech created,
  // reviewed, resubmitted, edited or deleted) — no payload, just a
  // signal. Consumers put this in a useEffect's deps to refetch their
  // own pilots/mechs list instead of requiring a manual reload (real
  // user report: "no se actualiza en tiempo real").
  const [rosterVersion, setRosterVersion] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (campaignId == null) return

    // StrictMode mounts this effect twice in dev (mount → cleanup →
    // mount). The `current` guard stops the discarded socket's onclose
    // from stomping on the real connection's state once it lands.
    let current = true
    const ws = new WebSocket(`${WS_BASE}/${campaignId}`)
    wsRef.current = ws

    // WS only carries round state going FORWARD from when it connects —
    // an already-underway round needs an explicit fetch on mount too.
    getRound(campaignId).then((r) => {
      if (current) setRoundState(r)
    })

    ws.onopen = () => {
      if (current) setConnected(true)
    }
    ws.onclose = () => {
      if (current) setConnected(false)
    }
    ws.onmessage = (event) => {
      if (!current) return
      const message = JSON.parse(event.data)
      if (message.type === 'roll_result') {
        setLastRoll(message as RollResult)
      } else if (message.type === 'visibility_update') {
        setVisibility(message as VisibilityUpdate)
      } else if (message.type === 'unit_revealed') {
        setLastRevealedUnitId(message.unit_id)
      } else if (message.type === 'attack_result') {
        setLastAttack(message as AttackResult)
      } else if (message.type === 'active_map_changed') {
        setActiveMapId((message as ActiveMapChanged).map_id)
      } else if (message.type === 'round_started' || message.type === 'round_updated') {
        setRoundState(message as RoundState)
      } else if (message.type === 'initiative_roll_requested') {
        setInitiativeRollRequest(message as InitiativeRollRequested)
      } else if (message.type === 'movement_started') {
        setMovementStarted(message as MovementStarted)
      } else if (message.type === 'unit_walked') {
        setUnitWalked(message as UnitWalked)
      } else if (message.type === 'melee_result') {
        setLastMelee(message as MeleeResult)
      } else if (message.type === 'heat_phase_resolved') {
        setHeatPhaseResult(message as HeatPhaseResolved)
      } else if (message.type === 'roster_updated') {
        setRosterVersion((v) => v + 1)
      }
    }

    return () => {
      current = false
      ws.close()
    }
  }, [campaignId])

  const roll = useCallback(
    (die: DieType, opts?: { pilotId?: number; label?: string }) => {
      wsRef.current?.send(
        JSON.stringify({
          type: 'roll',
          die,
          pilot_id: opts?.pilotId,
          label: opts?.label,
        }),
      )
    },
    [],
  )

  return {
    connected, lastRoll, visibility, lastRevealedUnitId, lastAttack, activeMapId, roundState,
    initiativeRollRequest, movementStarted, unitWalked, lastMelee, heatPhaseResult, rosterVersion, roll,
  }
}
