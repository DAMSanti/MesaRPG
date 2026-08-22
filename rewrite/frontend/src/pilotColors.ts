// Suggested default for a new pilot's dice color (PilotForm's color
// picker) — same palette as scripts/backfill_pilot_colors.py on the
// backend, kept in sync by eye since there's no shared config between
// the two languages. Purely a starting point; the GM/player can always
// pick something else via the color input.
export const PILOT_COLOR_PALETTE = [
  '#4dc9ff', '#ff6b6b', '#8ed081', '#c792ea', '#ffb454',
  '#5ad1c9', '#f27ab0', '#d4c96b', '#7a9cff', '#e8875c',
]

export function suggestPilotColor(existingPilotCount: number): string {
  return PILOT_COLOR_PALETTE[existingPilotCount % PILOT_COLOR_PALETTE.length]
}
