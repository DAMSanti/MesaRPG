// Die-style catalog (real user request: "muchos diseños, perlados,
// metalicos, con puntos, con numeros, tanta variedad como en la vida
// real") — every player and the GM can each pick ONE of these, exclusive
// across the whole campaign (see app/dice_styles.py's DIE_STYLE_IDS,
// which must match this file's ids 1:1 — kept in sync by eye, same as
// pilotColors.ts vs scripts/backfill_pilot_colors.py, no shared config
// between the two languages in this codebase). Same 10-entry size as
// PILOT_COLOR_PALETTE.
import type { Campaign, Pilot } from './api'

export type DieMaterialKind = 'standard' | 'metallic' | 'pearl'
export type DieMarkingKind = 'pips' | 'numbers'

export interface DieStyle {
  id: string
  name: string
  color: string
  material: DieMaterialKind
  marking: DieMarkingKind
}

export const DIE_STYLES: DieStyle[] = [
  { id: 'standard-ivory', name: 'Marfil clásico', color: '#eef1ef', material: 'standard', marking: 'pips' },
  { id: 'standard-onyx', name: 'Ónix clásico', color: '#232323', material: 'standard', marking: 'pips' },
  { id: 'crimson-pip', name: 'Carmesí', color: '#b33033', material: 'standard', marking: 'pips' },
  { id: 'cobalt-pip', name: 'Cobalto', color: '#2a5ea8', material: 'standard', marking: 'pips' },
  { id: 'verdant-pip', name: 'Esmeralda', color: '#2f7d4f', material: 'standard', marking: 'pips' },
  { id: 'amber-numeral', name: 'Ámbar numerado', color: '#c98a2c', material: 'standard', marking: 'numbers' },
  { id: 'slate-numeral', name: 'Pizarra numerada', color: '#4d5760', material: 'standard', marking: 'numbers' },
  { id: 'chrome-metallic', name: 'Cromo', color: '#c7ccd1', material: 'metallic', marking: 'numbers' },
  { id: 'gunmetal-metallic', name: 'Metal oscuro', color: '#3a3f45', material: 'metallic', marking: 'pips' },
  { id: 'opal-pearl', name: 'Ópalo perlado', color: '#e9e4f0', material: 'pearl', marking: 'pips' },
]

export interface ResolvedDieLook {
  color: string
  roughness: number
  metalness: number
  marking: DieMarkingKind
  iridescence?: number
  sheen?: number
  sheenColorHex?: string
}

// Falls back to the legacy plain-box look (a pilot's own `color`, matte
// plastic, pips) when no style is picked — zero visual regression for
// anyone who never engages with this feature. 'metallic'/'pearl' lean on
// metalness/iridescence+sheen alone (no environment map) to stay inside
// this app's offline requirement (VISION.md §3) — won't read as true
// chrome without real reflections, an accepted tradeoff for staying
// asset-free.
export function resolveDieStyle(styleId: string | null | undefined, fallbackColor: string): ResolvedDieLook {
  const found = DIE_STYLES.find((s) => s.id === styleId)
  if (!found) return { color: fallbackColor, roughness: 0.45, metalness: 0.05, marking: 'pips' }
  if (found.material === 'metallic') {
    return { color: found.color, roughness: 0.25, metalness: 0.85, marking: found.marking }
  }
  if (found.material === 'pearl') {
    return {
      color: found.color, roughness: 0.3, metalness: 0.1, marking: found.marking,
      iridescence: 1, sheen: 1, sheenColorHex: found.color,
    }
  }
  return { color: found.color, roughness: 0.45, metalness: 0.05, marking: found.marking }
}

// styleId -> display name of whoever holds it ('GM' or a pilot's own
// name) — shared by both GMView's and PlayerView's settings modals so
// this lookup logic isn't duplicated twice.
export function buildHeldByMap(
  pilots: Pick<Pilot, 'id' | 'die_style' | 'name'>[],
  campaign: Pick<Campaign, 'gm_die_style'> | null,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of pilots) if (p.die_style) map.set(p.die_style, p.name)
  if (campaign?.gm_die_style) map.set(campaign.gm_die_style, 'GM')
  return map
}
