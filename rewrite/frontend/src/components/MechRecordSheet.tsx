import type { Mech, WeaponStats } from '../api'
import {
  ARMOR_GEOMETRY, ARMOR_REAR_GEOMETRY, ARMOR_REAR_VIEWBOX, ARMOR_VIEWBOX,
  STRUCTURE_GEOMETRY, STRUCTURE_VIEWBOX, type MechLocationCode, type SheetLocationGeometry,
} from '../mechSheetGeometry'
import './MechRecordSheet.css'

// Official Heat Scale thresholds (ROADMAP.md Fase R2, verified against
// the CAT3500D rulebook + Total Warfare quick reference this session) —
// level -> short effect label. `null` levels exist only to keep the
// scale continuous between labeled rungs, same as the paper sheet.
const HEAT_SCALE: [number, string | null][] = [
  [30, 'Apagado'], [29, null], [28, 'Exp. munición 8+'], [27, null], [26, 'Apagado 10+'],
  [25, '-5 MP'], [24, '+4 a impactar'], [23, 'Exp. munición 6+'], [22, 'Apagado 8+'],
  [21, null], [20, '-4 MP'], [19, 'Exp. munición 4+'], [18, 'Apagado 6+'], [17, '+3 a impactar'],
  [16, null], [15, '-3 MP'], [14, 'Apagado 4+'], [13, '+2 a impactar'], [12, null], [11, null],
  [10, '-2 MP'], [9, null], [8, '+1 a impactar'], [7, null], [6, null], [5, '-1 MP'],
  [4, null], [3, null], [2, null], [1, null], [0, null],
]

// Hit Location Table (2d6), same constants as app/combat.py's
// HIT_LOCATION_FRONT_REAR/LEFT/RIGHT — verified against the official
// rulebook this session. [location, isCritical].
const HIT_LOCATION: Record<'front' | 'left' | 'right', Record<number, [string, boolean]>> = {
  front: {
    2: ['CT', true], 3: ['RA', false], 4: ['RA', false], 5: ['RL', false], 6: ['RT', false],
    7: ['CT', false], 8: ['LT', false], 9: ['LL', false], 10: ['LA', false], 11: ['LA', false], 12: ['HD', false],
  },
  left: {
    2: ['LT', true], 3: ['LL', false], 4: ['LA', false], 5: ['LA', false], 6: ['LL', false],
    7: ['LT', false], 8: ['CT', false], 9: ['RT', false], 10: ['RA', false], 11: ['RL', false], 12: ['HD', false],
  },
  right: {
    2: ['RT', true], 3: ['RL', false], 4: ['RA', false], 5: ['RA', false], 6: ['RL', false],
    7: ['RT', false], 8: ['CT', false], 9: ['LT', false], 10: ['LA', false], 11: ['LL', false], 12: ['HD', false],
  },
}

// Determining Critical Hits Table — official rule, read directly off
// the reference sheet this session (matches the CAT3500D rulebook).
const CRIT_CHANCE: [string, string][] = [
  ['2–7', '0'], ['8–9', '1'], ['10–11', '2'], ['12', '3 / Miembro arrancado'],
]

// Consciousness Number Table (official rule): target number for the
// consciousness roll after the Nth pilot hit — 1st hit needs a 3+, 2nd a
// 5+, and so on. A 6th hit has no roll — the pilot is dead, not just out
// — rendered as its own fixed box below, same as the reference sheet's
// 6th wound box (an X, not a number to beat).
const CONSCIOUSNESS_TARGETS = [3, 5, 7, 10, 11]
const WOUND_BOX_COUNT = CONSCIOUSNESS_TARGETS.length + 1

const CRITICAL_LOCATION_LABELS: Record<string, string> = {
  HD: 'Cabeza', CT: 'Torso Central', LT: 'Torso Izq.', RT: 'Torso Dcho.',
  LA: 'Brazo Izq.', RA: 'Brazo Dcho.', LL: 'Pierna Izq.', RL: 'Pierna Dcha.',
}

// Fixed critical-slot count per location — a rule constant (same for every
// biped mech), not derived from data, so the table can render its full
// numbered slot list even for a mech with no known equipment layout yet
// (a manually-created mech only knows its weapons, not a full crit
// assignment — see app/mech_import.py for the one case that does).
// Verified against the reference sheet's own slot count per location.
const CRITICAL_SLOT_COUNT: Record<string, number> = {
  HD: 6, CT: 12, LT: 12, RT: 12, LA: 12, RA: 12, LL: 6, RL: 6,
}

const REAR_LOCATIONS = ['LT', 'CT', 'RT'] as const

interface PipRowProps {
  max: number
  current: number
  onClick?: (newCurrent: number) => void
}

// A field of small circles, hollow until damage lands — same mechanic as
// a fresh paper sheet: every box starts empty, and you pencil one in for
// each point lost. `current` is how many are still intact, so only the
// pips from `current` onward are filled. Click a hollow (intact) pip to
// mark damage down through it; click a filled (damaged) pip to restore up
// through it (undo/GM correction). previewFullHealth (creation preview)
// renders every pip hollow (nothing damaged yet, no real mech to read a
// current value from); readOnly independently makes them non-clickable.
// Used for the heat-sink count, which (unlike armor/structure) has no
// anatomical position on the sheet.
function PipRow({ max, current, onClick }: PipRowProps) {
  return (
    <div className="pip-row">
      {Array.from({ length: max }, (_, i) => {
        const filled = i >= current
        return (
          <span
            key={i}
            className={`pip ${filled ? 'filled' : 'empty'}${onClick ? ' clickable' : ''}`}
            onClick={onClick ? () => onClick(filled ? i + 1 : i) : undefined}
          />
        )
      })}
    </div>
  )
}

// One location's pip field, sliced to that mech's actual max (the
// geometry arrays hold the Atlas's full template capacity — see
// mechSheetGeometry.ts — so a lighter mech simply doesn't render the
// trailing slots it doesn't have, the same "extra template slots exist
// but are hidden" mechanic the source sheet encodes with its `noShow`
// class, just computed per-mech instead of baked in for one chassis).
function SheetPipField({
  geometry, max, current, onClick,
}: {
  geometry: SheetLocationGeometry
  max: number
  current: number
  onClick?: (newCurrent: number) => void
}) {
  const dots = geometry.dots.slice(0, Math.min(max, geometry.dots.length))
  return (
    <>
      {dots.map((d, i) => {
        // Hollow until damage lands, same as PipRow above: `current` is
        // how many points are still intact, so only the pips from
        // `current` onward are filled/marked as lost.
        const filled = i >= current
        return (
          <circle
            key={i}
            cx={d.x}
            cy={d.y}
            r={geometry.pipRadius}
            className={`sheet-pip ${filled ? 'filled' : 'empty'}${onClick ? ' clickable' : ''}`}
            onClick={onClick ? () => onClick(filled ? i + 1 : i) : undefined}
          />
        )
      })}
    </>
  )
}

type LabelDirection = 'up' | 'down' | 'left' | 'right'

interface LabelSpec {
  dir: LabelDirection
  /** Nudge along the cross-axis (vertical for left/right, horizontal for up/down) — separates
   * labels that would otherwise land on the same line, e.g. an arm and its neighboring torso
   * side share almost the same vertical band, so one is pushed up and the other down. */
  offset: number
}

// Which way each location's "CODE current/max" tag points away from its pip
// cluster, and how far to nudge it along the cross-axis — mirrors how the
// reference sheet leads a line out from each body part to its number plaque
// (head above, arms/torso-sides out to their side at staggered heights so
// neighboring labels don't collide, legs below) rather than stamping the
// text over the pips.
const LABEL_SPEC: Record<MechLocationCode, LabelSpec> = {
  HD: { dir: 'up', offset: 0 },
  CT: { dir: 'right', offset: -24 },
  LT: { dir: 'left', offset: 12 },
  RT: { dir: 'right', offset: 12 },
  LA: { dir: 'left', offset: -8 },
  RA: { dir: 'right', offset: -8 },
  LL: { dir: 'down', offset: 0 },
  RL: { dir: 'down', offset: 0 },
}

const REAR_LABEL_SPEC: Record<'LT' | 'CT' | 'RT', LabelSpec> = {
  LT: { dir: 'left', offset: 0 },
  CT: { dir: 'up', offset: 0 },
  RT: { dir: 'right', offset: 0 },
}

function bounds(dots: { x: number; y: number }[]) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let sumX = 0
  let sumY = 0
  for (const d of dots) {
    if (d.x < minX) minX = d.x
    if (d.x > maxX) maxX = d.x
    if (d.y < minY) minY = d.y
    if (d.y > maxY) maxY = d.y
    sumX += d.x
    sumY += d.y
  }
  return { minX, maxX, minY, maxY, avgX: sumX / dots.length, avgY: sumY / dots.length }
}

// `sideNeighbor` is the arm sharing a torso-side's height band (LT↔LA,
// RT↔RA) — those two clusters sit close enough that a torso-side tag
// pushed out just past its own edge still lands on top of the arm's
// pips, so 'left'/'right' placement clears past *both* clusters' combined
// edge instead of just its own.
function labelAnchor(geometry: SheetLocationGeometry, spec: LabelSpec, sideNeighbor?: SheetLocationGeometry) {
  const own = bounds(geometry.dots)
  const wide = sideNeighbor ? bounds([...geometry.dots, ...sideNeighbor.dots]) : own
  switch (spec.dir) {
    case 'up': return { x: own.avgX + spec.offset, y: own.minY - 4, anchor: 'middle' as const }
    case 'down': return { x: own.avgX + spec.offset, y: own.maxY + 9, anchor: 'middle' as const }
    case 'left': return { x: wide.minX - 4, y: own.avgY + spec.offset, anchor: 'end' as const }
    case 'right': return { x: wide.maxX + 4, y: own.avgY + spec.offset, anchor: 'start' as const }
  }
}

// One body location's outline + pip field — no label. Split out from the
// tag (below) so a diagram can render every location's body first and
// every location's tag second: bodies are opaque shapes that would
// otherwise paint over a neighboring location's tag if the two overlap
// (limbs sit close together on a real BattleTech silhouette), so tags
// need to be guaranteed to land on top of every body, not just their own.
function LocationBody({
  geometry, max, current, onClick,
}: {
  geometry: SheetLocationGeometry
  max: number
  current: number
  onClick?: (newCurrent: number) => void
}) {
  const { outline } = geometry
  return (
    <g className="sheet-location">
      {outline.kind === 'polygon' ? (
        <polygon className="sheet-outline" points={outline.d} transform={outline.transform} />
      ) : (
        <path className="sheet-outline" d={outline.d} transform={outline.transform} />
      )}
      <SheetPipField geometry={geometry} max={max} current={current} onClick={onClick} />
    </g>
  )
}

// A small "CODE current/max" tag pointing away from a location's pip
// cluster, on a white plaque — same idea as the reference sheet's own
// number-plaque backgrounds, needed because tags sometimes sit right next
// to (or over the edge of) a neighboring limb's silhouette.
function LocationTag({
  label, geometry, max, current, labelSpec, sideNeighbor,
}: {
  label: string
  geometry: SheetLocationGeometry
  max: number
  current: number
  labelSpec: LabelSpec
  sideNeighbor?: SheetLocationGeometry
}) {
  const anchor = labelAnchor(geometry, labelSpec, sideNeighbor)
  const text = `${label} ${current}/${max}`
  const boxW = text.length * 4.3
  const boxH = 8.5
  const boxX = anchor.anchor === 'start' ? anchor.x : anchor.anchor === 'end' ? anchor.x - boxW : anchor.x - boxW / 2
  const boxY = anchor.y - boxH * 0.72
  return (
    <g className="sheet-loc-tag">
      <rect className="sheet-loc-label-bg" x={boxX} y={boxY} width={boxW} height={boxH} rx={1.2} />
      <text className="sheet-loc-label" x={anchor.x} y={anchor.y} textAnchor={anchor.anchor}>
        {text}
      </text>
    </g>
  )
}

interface Props {
  mech: Pick<
    Mech,
    'chassis' | 'model' | 'tonnage' | 'walk_mp' | 'run_mp' | 'jump_mp' | 'locations' | 'weapons' | 'heat_sinks' | 'heat_current' | 'criticals'
  >
  pilot?: { id?: number; gunnery: number; piloting: number; hits?: number } | null
  /** No click-to-edit — pips/weapon rows/criticals render inert. Doesn't
   * by itself change WHAT is shown, only whether it's interactive; see
   * previewFullHealth for the (previously conflated) other half. */
  readOnly?: boolean
  /** This mech isn't real yet (mech-creation "Vista previa de la hoja",
   * before it's even saved) — armor/structure/heat show at full/zero
   * instead of mech.locations' own current values, since there IS no
   * real current state yet to show. Was previously implied by readOnly
   * itself, which silently forced this same full-health mockup onto
   * every OTHER readOnly view too (GMView's "Ver ficha" among them) —
   * that's what made an already-damaged mech's sheet always render as
   * pristine there, no matter how stale or fresh the data actually was.
   * Defaults to false — a normal read-only VIEW of a real mech (GMView's
   * own case) wants real numbers, just without click handlers. */
  previewFullHealth?: boolean
  weaponCatalog?: Record<string, WeaponStats>
  selectedWeaponId?: number | null
  onArmorChange?: (location: string, value: number) => void
  onArmorRearChange?: (location: string, value: number) => void
  onStructureChange?: (location: string, value: number) => void
  onSelectWeapon?: (weaponId: number) => void
  onPilotHitsChange?: (value: number) => void
  onToggleCritical?: (location: string, slotIndex: number, hit: boolean) => void
}

// Vertical pip-box heat scale, current level highlighted — the same
// levels/effects verified against the official rulebook in app/combat.py.
function HeatScale({ current }: { current: number }) {
  return (
    <div className="heat-scale">
      <div className="info-panel-title">Calor</div>
      <div className="heat-scale-levels">
        {HEAT_SCALE.map(([level, effect]) => (
          <div key={level} className={`heat-level${level === current ? ' current' : ''}${level <= current ? ' lit' : ''}`}>
            <span className="heat-level-num">{level}</span>
            {effect && <span className="heat-level-effect">{effect}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function HitLocationTable() {
  const rows = Array.from({ length: 11 }, (_, i) => 12 - i)
  return (
    <table className="hitloc-table">
      <thead><tr><th>2d6</th><th>Izq.</th><th>Frnt/Tras.</th><th>Dcha.</th></tr></thead>
      <tbody>
        {rows.map((roll) => (
          <tr key={roll}>
            <td>{roll}</td>
            <td>{HIT_LOCATION.left[roll][0]}{HIT_LOCATION.left[roll][1] && '*'}</td>
            <td>{HIT_LOCATION.front[roll][0]}{HIT_LOCATION.front[roll][1] && '*'}</td>
            <td>{HIT_LOCATION.right[roll][0]}{HIT_LOCATION.right[roll][1] && '*'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface CriticalSlot {
  slot_index: number
  item_name: string
  hit: boolean
}

// Each installed item is a real, clickable critical slot — touching one
// marks it destroyed for real (PATCH /api/mechs/{id}/criticals/...), same
// mechanic as crossing it off in pencil on the paper sheet. `-Empty-`
// slots aren't clickable — there's nothing there to destroy.
//
// Always renders the full numbered slot list for the location (see
// CRITICAL_SLOT_COUNT — a rule constant, not data), same as a blank paper
// sheet always shows "1." through "12." before you've written anything in
// — a mech with no known equipment layout just gets every slot rendered
// as `-Empty-` instead of the table disappearing outright.
function CriticalHitBlock({
  location, items, readOnly, onToggle,
}: {
  location: string
  items: CriticalSlot[] | undefined
  readOnly: boolean
  onToggle?: (location: string, slotIndex: number, hit: boolean) => void
}) {
  const slotCount = CRITICAL_SLOT_COUNT[location]
  const bySlot = new Map((items ?? []).map((s) => [s.slot_index, s]))
  const slots: CriticalSlot[] = Array.from({ length: slotCount }, (_, i) => bySlot.get(i) ?? {
    slot_index: i, item_name: '-Empty-', hit: false,
  })
  return (
    <div className="crit-block">
      <div className="crit-block-header">{CRITICAL_LOCATION_LABELS[location]}</div>
      <ol>
        {slots.map((slot) => {
          const empty = slot.item_name === '-Empty-'
          const clickable = !readOnly && !empty && !!onToggle
          return (
            <li
              key={slot.slot_index}
              className={`${empty ? 'empty' : ''} ${slot.hit ? 'hit' : ''} ${clickable ? 'clickable' : ''}`}
              onClick={clickable ? () => onToggle!(location, slot.slot_index, !slot.hit) : undefined}
            >
              {slot.item_name}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** A real BattleTech record sheet, digitized: two-column page layout
 * (data panels on the left, armor/structure diagrams on the right — same
 * composition as the paper sheet), the actual illustrated biped outline
 * traced off a reference record sheet (mechSheetGeometry.ts) with pip
 * fields positioned exactly where that location's armor/structure plate
 * sits, a Pilot hit/KO track, an Inventory & Attacks table (ranged
 * weapons + melee), a Hit Location reference table, a Critical Hit Table
 * per location (every slot always rendered — `-Empty-` where the actual
 * equipment layout isn't known yet, real item names for mechs imported
 * from the public MTF database, see app/mech_import.py), and a Heat
 * Scale. `readOnly` drops every click handler (a plain view, no editing);
 * `previewFullHealth` separately renders full armor/structure/zero heat
 * regardless of the real mech.locations values (mech-creation's "Vista
 * previa de la hoja", before it's even saved — there IS no real current
 * state yet). These two used to be the same prop, which meant a normal
 * read-only VIEW of a real, already-damaged mech (GMView's "Ver ficha")
 * silently rendered as pristine no matter how damaged it actually was —
 * split apart once that bug was found. Otherwise (neither flag) pips/
 * weapon rows are click-to-act, for playing the same way you'd use a
 * paper sheet (ROADMAP.md Fase R3). */
export function MechRecordSheet({
  mech, pilot, readOnly = false, previewFullHealth = false, weaponCatalog, selectedWeaponId, onArmorChange,
  onArmorRearChange, onStructureChange, onSelectWeapon, onPilotHitsChange, onToggleCritical,
}: Props) {
  const byLoc = Object.fromEntries(mech.locations.map((l) => [l.location, l]))
  const get = (loc: string) => byLoc[loc]

  const rearLocations = REAR_LOCATIONS.filter((loc) => get(loc)?.armor_rear_max != null)

  const punchDamage = Math.ceil(mech.tonnage / 10)
  const kickDamage = Math.ceil(mech.tonnage / 5)

  // Each location's body (opaque silhouette + pips) renders before any
  // tag, and every tag renders after every body — otherwise a location
  // whose body happens to sit near a neighbor's tag (limbs pack tightly
  // on a real BattleTech silhouette) can paint over that tag, since SVG
  // has no z-index and later-drawn shapes simply cover earlier ones.
  const armorLocs = (Object.keys(ARMOR_GEOMETRY) as MechLocationCode[])
    .map((loc) => {
      const l = get(loc)
      if (!l) return null
      const max = l.armor_max
      const current = previewFullHealth ? max : l.armor_current
      return { loc, max, current }
    })
    .filter((x): x is { loc: MechLocationCode; max: number; current: number } => x !== null)

  const armorDiagram = (
    <svg viewBox={ARMOR_VIEWBOX} className="mech-armor-svg">
      {armorLocs.map(({ loc, max, current }) => (
        <LocationBody
          key={loc} geometry={ARMOR_GEOMETRY[loc]} max={max} current={current}
          onClick={readOnly || !onArmorChange ? undefined : (v) => onArmorChange(loc, v)}
        />
      ))}
      {armorLocs.map(({ loc, max, current }) => (
        <LocationTag
          key={loc} label={loc} geometry={ARMOR_GEOMETRY[loc]} max={max} current={current}
          labelSpec={LABEL_SPEC[loc]}
          sideNeighbor={loc === 'LT' ? ARMOR_GEOMETRY.LA : loc === 'RT' ? ARMOR_GEOMETRY.RA : undefined}
        />
      ))}
    </svg>
  )

  const structureLocs = (Object.keys(STRUCTURE_GEOMETRY) as MechLocationCode[])
    .map((loc) => {
      const l = get(loc)
      if (!l) return null
      const max = l.structure_max
      const current = previewFullHealth ? max : l.structure_current
      return { loc, max, current }
    })
    .filter((x): x is { loc: MechLocationCode; max: number; current: number } => x !== null)

  const structureDiagram = (
    <svg viewBox={STRUCTURE_VIEWBOX} className="mech-structure-svg">
      {structureLocs.map(({ loc, max, current }) => (
        <LocationBody
          key={loc} geometry={STRUCTURE_GEOMETRY[loc]} max={max} current={current}
          onClick={readOnly || !onStructureChange ? undefined : (v) => onStructureChange(loc, v)}
        />
      ))}
      {structureLocs.map(({ loc, max, current }) => (
        <LocationTag
          key={loc} label={loc} geometry={STRUCTURE_GEOMETRY[loc]} max={max} current={current}
          labelSpec={LABEL_SPEC[loc]}
          sideNeighbor={loc === 'LT' ? STRUCTURE_GEOMETRY.LA : loc === 'RT' ? STRUCTURE_GEOMETRY.RA : undefined}
        />
      ))}
    </svg>
  )

  const rearLocs = rearLocations.map((loc) => {
    const l = get(loc)!
    const max = l.armor_rear_max!
    const current = previewFullHealth ? max : (l.armor_rear_current ?? 0)
    return { loc, max, current }
  })

  const rearDiagram = rearLocs.length > 0 && (
    <svg viewBox={ARMOR_REAR_VIEWBOX} className="mech-rear-svg">
      {rearLocs.map(({ loc, max, current }) => (
        <LocationBody
          key={loc} geometry={ARMOR_REAR_GEOMETRY[loc]} max={max} current={current}
          onClick={readOnly || !onArmorRearChange ? undefined : (v) => onArmorRearChange(loc, v)}
        />
      ))}
      {rearLocs.map(({ loc, max, current }) => (
        <LocationTag
          key={loc} label={`${loc}R`} geometry={ARMOR_REAR_GEOMETRY[loc]} max={max} current={current}
          labelSpec={REAR_LABEL_SPEC[loc]}
        />
      ))}
    </svg>
  )

  return (
    <div className="mech-record-sheet">
      <div className="sheet-col-left">
        <div className="data-panel">
          <div className="sheet-title-row">
            <div>
              <span className="sheet-model">{mech.model}</span>
              <h3 className="sheet-chassis">{mech.chassis}</h3>
            </div>
          </div>

          <div className="panel-row">
            <div className="info-panel">
              <div className="info-panel-title">Overview</div>
              <div className="stat-bars">
                <div className="stat-bar"><span className="stat-bar-label">Andar</span><span className="stat-bar-value">{mech.walk_mp}</span></div>
                <div className="stat-bar"><span className="stat-bar-label">Correr</span><span className="stat-bar-value">{mech.run_mp}</span></div>
                {mech.jump_mp > 0 && (
                  <div className="stat-bar"><span className="stat-bar-label">Saltar</span><span className="stat-bar-value">{mech.jump_mp}</span></div>
                )}
                <div className="stat-bar"><span className="stat-bar-label">Tonelaje</span><span className="stat-bar-value">{mech.tonnage}t</span></div>
              </div>
            </div>
            {pilot && (
              <div className="info-panel">
                <div className="info-panel-title">Piloto</div>
                <div className="info-row"><span>Gunnery</span><strong>{pilot.gunnery}</strong></div>
                <div className="info-row"><span>Piloting</span><strong>{pilot.piloting}</strong></div>
                <div className="ko-track">Heridas</div>
                <div className="wound-track">
                  {Array.from({ length: WOUND_BOX_COUNT }, (_, i) => {
                    const hits = pilot.hits ?? 0
                    const marked = i < hits
                    const clickable = !readOnly && !!onPilotHitsChange
                    const fatal = i === WOUND_BOX_COUNT - 1
                    return (
                      <span
                        key={i}
                        className={`wound-box${fatal ? ' fatal' : ''}${marked ? ' marked' : ''}${clickable ? ' clickable' : ''}`}
                        onClick={clickable ? () => onPilotHitsChange!(marked ? i : i + 1) : undefined}
                      >
                        {fatal ? '✕' : `${CONSCIOUSNESS_TARGETS[i]}+`}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          <h4 className="sheet-block-title">Inventario y ataques</h4>
          <div className="sheet-scroll">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Arma</th><th>Loc</th><th>Calor</th><th>Dañ</th><th>Min</th><th>Cort</th><th>Med</th><th>Lrg</th><th>Mun</th>
                </tr>
              </thead>
              <tbody>
                {mech.weapons.length === 0 && (
                  <tr className="melee-row"><td colSpan={9}>Sin armas a distancia instaladas.</td></tr>
                )}
                {mech.weapons.map((w) => {
                  const stats = weaponCatalog?.[w.weapon_name]
                  const clickable = !readOnly && !!onSelectWeapon && w.ammo_remaining !== 0
                  return (
                    <tr
                      key={w.id}
                      className={`${clickable ? 'clickable' : ''} ${selectedWeaponId === w.id ? 'selected' : ''}`}
                      onClick={clickable ? () => onSelectWeapon!(w.id) : undefined}
                    >
                      <td>{w.weapon_name}</td>
                      <td>{w.location}</td>
                      <td>{stats?.heat ?? '—'}</td>
                      <td>{stats?.damage ?? '—'}</td>
                      <td>{stats?.min_range || '—'}</td>
                      <td>{stats?.short ?? '—'}</td>
                      <td>{stats?.medium ?? '—'}</td>
                      <td>{stats?.long ?? '—'}</td>
                      <td>{w.ammo_remaining ?? '—'}</td>
                    </tr>
                  )
                })}
                {/* Fists and feet aren't equipment — every mech always has them, so unlike
                    ranged weapons these melee rows never depend on mech.weapons. */}
                <tr className="melee-row"><td colSpan={2}>Puñetazo (LA)</td><td>—</td><td>{punchDamage}</td><td colSpan={4}>cuerpo a cuerpo</td><td>—</td></tr>
                <tr className="melee-row"><td colSpan={2}>Puñetazo (RA)</td><td>—</td><td>{punchDamage}</td><td colSpan={4}>cuerpo a cuerpo</td><td>—</td></tr>
                <tr className="melee-row"><td colSpan={2}>Patada</td><td>—</td><td>{kickDamage}</td><td colSpan={4}>cuerpo a cuerpo</td><td>—</td></tr>
              </tbody>
            </table>
          </div>
          {!readOnly && onSelectWeapon && mech.weapons.length > 0 && (
            <p className="sheet-hint">Toca un arma para elegirla en el panel de ataque.</p>
          )}

          <h4 className="sheet-block-title">Localización de impacto (2d6)</h4>
          <div className="sheet-scroll"><HitLocationTable /></div>
        </div>

        <div className="data-panel">
          <div className="banner">Tabla de críticos</div>
          <div className="crit-grid">
            {(['LA', 'HD', 'RA', 'LT', 'CT', 'RT', 'LL', 'RL'] as const).map((loc) => (
              <CriticalHitBlock
                key={loc} location={loc} items={mech.criticals[loc]} readOnly={readOnly} onToggle={onToggleCritical}
              />
            ))}
          </div>
          {(!mech.criticals || Object.keys(mech.criticals).length === 0) && (
            <p className="sheet-hint">Sin datos de equipamiento — solo se conocen los slots vacíos hasta importar el mech de la base de datos pública.</p>
          )}
          <table className="crit-chance-table">
            <thead><tr><th>2d6</th><th>Críticos</th></tr></thead>
            <tbody>{CRIT_CHANCE.map(([roll, n]) => <tr key={roll}><td>{roll}</td><td>{n}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="sheet-col-right">
        <div className="diagram-panel">
          <div className="banner">Blindaje estándar</div>
          <div className="sheet-scroll">{armorDiagram}</div>
          {rearLocations.length > 0 && (
            <>
              <h4 className="sheet-block-title">Blindaje trasero</h4>
              <div className="sheet-scroll">{rearDiagram}</div>
            </>
          )}
        </div>

        <div className="diagram-panel">
          <div className="banner">Estructura interna</div>
          <div className="sheet-scroll">{structureDiagram}</div>
          <div className="sinks-and-heat">
            <div className="info-panel sinks-panel">
              <div className="info-panel-title">Disipadores</div>
              <div className="info-row"><strong>{mech.heat_sinks}</strong></div>
              <PipRow max={mech.heat_sinks} current={mech.heat_sinks} />
            </div>
            <HeatScale current={previewFullHealth ? 0 : mech.heat_current} />
          </div>
        </div>
      </div>
    </div>
  )
}
