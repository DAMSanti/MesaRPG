// Real BattleTech weight class brackets (Total Warfare) — used purely to
// group the chassis dropdown (real user request: "ordenar el selector
// de chasis... por ligeros medios y pesados, o las categorías que use
// battletech"), shared between GMView's and PlayerView's own mech-
// creation forms.
export type WeightClass = 'Ligero' | 'Medio' | 'Pesado' | 'Asalto'

export const WEIGHT_CLASS_ORDER: WeightClass[] = ['Ligero', 'Medio', 'Pesado', 'Asalto']

export function weightClassFor(tonnage: number): WeightClass {
  if (tonnage <= 35) return 'Ligero'
  if (tonnage <= 55) return 'Medio'
  if (tonnage <= 75) return 'Pesado'
  return 'Asalto'
}

/** Groups a flat chassis list into WEIGHT_CLASS_ORDER buckets, each
 * chassis alphabetical within its own bucket (list_chassis already
 * comes back chassis-sorted from the backend, so this preserves that
 * order per bucket without re-sorting). */
export function groupChassisByWeightClass<T extends { chassis: string; tonnage: number }>(
  entries: T[],
): { weightClass: WeightClass; entries: T[] }[] {
  return WEIGHT_CLASS_ORDER
    .map((weightClass) => ({ weightClass, entries: entries.filter((e) => weightClassFor(e.tonnage) === weightClass) }))
    .filter((group) => group.entries.length > 0)
}
