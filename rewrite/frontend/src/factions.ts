/** Battletech only needs three sides (ROADMAP.md S2 follow-up) — no
 * finer-grained faction system. Shared between GM's pilot form and the
 * map views so a faction always means the same color everywhere. */
export const FACTIONS = ['player', 'enemy', 'npc'] as const
export type Faction = (typeof FACTIONS)[number]

export const FACTION_LABELS: Record<Faction, string> = {
  player: 'Jugador',
  enemy: 'Enemigo',
  npc: 'NPC',
}

export const FACTION_COLORS: Record<Faction, string> = {
  player: '#7fd4c8',
  enemy: '#e35d5d',
  npc: '#e3a765',
}

export const NEUTRAL_UNIT_COLOR = '#9aa4a2'
