import type { InitiativeRoll, Pilot, RoundState, Unit } from './api'
import { FACTION_LABELS, type Faction } from './factions'

/** "Jugador 7" for a team-mode roll, "Widow 3" for an individual-mode
 * roll — shared so the compact badges (mesa/jugador) and the fuller GM
 * section never describe the same roll differently. Shows the modifier
 * breakdown inline once one actually applies (none do yet — see
 * turns.py's _initiative_modifiers) — "Widow 7 (+1 Tactical Genius = 8)". */
export function formatRoll(r: InitiativeRoll): string {
  const label = r.kind === 'pilot' ? (r.pilot_name ?? '?') : FACTION_LABELS[r.faction as Faction]
  if (r.modifier_total === 0) return `${label} ${r.roll}`
  const breakdown = r.modifiers.map((m) => `${m.value >= 0 ? '+' : ''}${m.value} ${m.label}`).join(', ')
  return `${label} ${r.roll} (${breakdown} = ${r.total})`
}

export function formatRolls(rolls: InitiativeRoll[]): string {
  return rolls.map(formatRoll).join(' · ')
}

/** Which pilot(s) may act right now, in strict roll order — used to gate
 * the GM map's per-unit context menu (app/systems/battletech/turns.py
 * itself stays advisory/non-blocking; this is a stricter *frontend* UX
 * layered on the same data, not a change to that backend philosophy).
 *
 * - individual mode: exactly the single lowest-rolled pilot who hasn't
 *   acted yet — a real one-at-a-time order.
 * - team mode: rolls are per-faction only (no pilot-level order exists),
 *   so "whose turn" is every not-yet-acted pilot on the lowest-rolled
 *   faction that still has one; once that faction is fully acted, turn
 *   passes to the next faction in roll order. */
export function activeTurnPilotIds(round: RoundState, pilots: Pilot[]): Set<number> {
  if (round.round_number === 0) return new Set()
  const acted = new Set(round.acted_pilot_ids)

  if (round.mode === 'individual') {
    const next = round.rolls.find((r) => r.pilot_id != null && !acted.has(r.pilot_id))
    return next?.pilot_id != null ? new Set([next.pilot_id]) : new Set()
  }

  const pilotsByFaction = new Map<string, number[]>()
  for (const p of pilots) {
    if (!pilotsByFaction.has(p.faction)) pilotsByFaction.set(p.faction, [])
    pilotsByFaction.get(p.faction)!.push(p.id)
  }
  for (const roll of round.rolls) {
    const unacted = (pilotsByFaction.get(roll.faction) ?? []).filter((id) => !acted.has(id))
    if (unacted.length > 0) return new Set(unacted)
  }
  return new Set()
}

/** Pilots (with a unit on this map) who still haven't rolled this round
 * — individual mode only; team mode rolls both sides in one shot inside
 * start_round itself, so there's never a "waiting on you" window to
 * highlight. Used to wash the tile of every such unit on the shared
 * board (TableView) and the GM's own map, not just the ones the GM
 * happens to roll for (enemies) — a player forgetting to roll is just
 * as worth flagging as an enemy the GM hasn't gotten to yet. */
export function pilotsNeedingInitiative(round: RoundState | null, units: Unit[]): Set<number> {
  if (!round || round.round_number === 0) return new Set()
  if (round.rolls.some((r) => r.kind === 'faction')) return new Set()
  const rolled = new Set(round.rolls.filter((r) => r.pilot_id != null).map((r) => r.pilot_id))
  const ids = new Set<number>()
  for (const u of units) {
    if (u.pilot_id != null && !rolled.has(u.pilot_id)) ids.add(u.pilot_id)
  }
  return ids
}

/** Whose turn it is to move right now, in movement_order (lowest
 * initiative total first — see turns.py's _movement_order) — null
 * before the movement phase starts (not everyone's rolled yet) or once
 * everyone in it has already moved. One pilot at a time, unlike
 * activeTurnPilotIds' team-mode group — movement always alternates
 * per-pilot regardless of mode (turns.py's own documented
 * simplification of the real "unequal numbers" rule). */
export function activeMoverPilotId(round: RoundState): number | null {
  const moved = new Set(round.moved_pilot_ids)
  return round.movement_order.find((id) => !moved.has(id)) ?? null
}

/** Who may actually attack right now, during the ranged/melee phases —
 * deliberately NOT initiative order (activeTurnPilotIds above). A pilot
 * with no real target (no range/LOS/ammo for ranged, nobody adjacent for
 * melee) was jamming the whole phase before this existed: they were
 * still "next" in strict initiative order, so activeTurnPilotIds kept
 * pointing at them, nobody else's canAct passed, and the round could
 * never move on since a pilot with nothing to shoot has no natural way
 * to end up in acted_pilot_ids. Turn order for these two phases is
 * instead just "anyone still holding a real target" — matches this
 * engine's own documented stance that turn order is advisory, not
 * blocking (see turns.py's module docstring), and needs no separate
 * "skip" bookkeeping: a targetless pilot was simply never eligible. */
export function activeAttackPilotIds(round: RoundState): Set<number> {
  const phase = currentPhase(round)
  const ids =
    phase === 'ranged' ? round.ranged_target_pilot_ids
      : phase === 'melee' ? round.melee_target_pilot_ids
        : []
  const acted = new Set(round.acted_pilot_ids)
  return new Set(ids.filter((id) => !acted.has(id)))
}

/** The round's current global phase — requested directly so TableView,
 * GMView and the 1st-person HUD can all show the same clear "we're in
 * X phase" indicator instead of the change happening silently.
 * 'movement' becoming active is what auto-advances the movement phase:
 * movement_order only populates once everyone who's rolling this round
 * has (turns.py's _movement_order), so this flips the instant that
 * happens — no separate "start movement phase" step needed.
 *
 * 'ranged'/'melee' work the same way, driven by the round's own
 * ranged_target_pilot_ids/melee_target_pilot_ids (turns.py's
 * _pilots_with_ranged_targets/_pilots_with_melee_targets — real LOS/
 * weapon-range/adjacency, recomputed live): a phase with nobody left in
 * its own not-yet-acted target list is skipped entirely, exactly as
 * requested ("solo se activará si algún mech tiene alcance y en LoS
 * algún mech al que pueda atacar") — movement can fall straight through
 * to 'melee', or all the way to 'other', without 'ranged' ever showing. */
export type RoundPhase = 'none' | 'initiative' | 'movement' | 'ranged' | 'melee' | 'other'

function _pending(ids: number[], acted: number[]): boolean {
  const actedSet = new Set(acted)
  return ids.some((id) => !actedSet.has(id))
}

export function currentPhase(round: RoundState): RoundPhase {
  if (round.round_number === 0) return 'none'
  if (round.movement_order.length === 0) return 'initiative'
  const allMoved = round.movement_order.every((id) => round.moved_pilot_ids.includes(id))
  if (!allMoved) return 'movement'
  if (_pending(round.ranged_target_pilot_ids, round.acted_pilot_ids)) return 'ranged'
  if (_pending(round.melee_target_pilot_ids, round.acted_pilot_ids)) return 'melee'
  return 'other'
}

export const PHASE_LABELS: Record<RoundPhase, string> = {
  none: 'sin ronda',
  initiative: 'Iniciativa',
  movement: 'Movimiento',
  ranged: 'Ataque a distancia',
  melee: 'Combate a melee',
  other: 'Fin de ronda',
}
