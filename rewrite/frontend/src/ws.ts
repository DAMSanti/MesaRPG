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
  weapon_id: number | null
  weapon_name: string | null
  target_number: number
  roll: number
  hit: boolean
  location: string | null
  critical: boolean
  mech_destroyed: boolean
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
    initiativeRollRequest, movementStarted, roll,
  }
}
