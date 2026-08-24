import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { HexMap, useAttackVfxQueue } from './HexMap'
import { MODEL_CHEST_FRACTION, MODEL_HEAD_FRACTION, MODEL_SCALE } from './Mech3D'
import { ARMOR_GEOMETRY, ARMOR_VIEWBOX, type MechLocationCode } from '../mechSheetGeometry'
import {
  attack, getMap, getUnitVisibleEnemies, getWeaponCatalog, markRoundActed, requestInitiative,
  type AttackResult, type Mech, type MapData, type RoundState, type Unit, type VisibleEnemy, type WeaponStats,
} from '../api'
import { activeMoverPilotId, currentPhase } from '../rounds'
import { hexToWorld, mapCenter } from '../hexMath'
import './FirstPersonView.css'

// Derived from Mech3D's own scale/proportions rather than a hardcoded
// number, so bumping the model's size there doesn't quietly leave the
// cockpit camera sitting somewhere around its knees.
const EYE_HEIGHT = MODEL_SCALE * MODEL_HEAD_FRACTION
const LOOK_DISTANCE = 4
// Reticle is 56px wide (TargetLockIcon) — a bit more than that so two
// decluttered markers never touch.
const MARKER_MIN_SEPARATION = 64

/** Fixed, non-orbiting camera — a snapshot of what this mech sees right
 * now, facing where it's actually oriented (facing_deg), not a
 * free-look. Position/lookAt are recomputed by the caller whenever the
 * unit's own position/facing changes; this just applies them every
 * frame, same imperative pattern as KillReplay.tsx's OrbitCam. */
function FixedFirstPersonCam({
  position, lookAt,
}: { position: [number, number, number]; lookAt: [number, number, number] }) {
  useFrame((state) => {
    state.camera.position.set(...position)
    state.camera.lookAt(...lookAt)
  })
  return null
}

/** Projects each detected enemy's 3D position onto screen space every
 * frame and writes the result straight onto the matching HUD label's
 * style (via labelRefs, shared with the plain DOM <div>s rendered
 * outside the Canvas — see FirstPersonView below). No <Html> from drei
 * anywhere in this codebase; this keeps to the same DOM-overlay-over-
 * canvas convention as TableView's .hud. Mutates refs directly instead
 * of setState, so a HUD full of enemies doesn't trigger a React render
 * every frame — same reasoning as Die.tsx's vanish animation. */
// Real CC0 photo (ambientCG's Day Sky HDRI 067B — see
// public/textures/CREDITS.md), not a procedural gradient — the user
// specifically asked to see a real sky from the cockpit. Plain
// THREE.TextureLoader rather than r3f's useLoader (which suspends and
// this codebase sets up no Suspense boundary anywhere) — starts blank,
// repaints once the image loads, same as a normal <img>.
function SkyBackground() {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/sky.jpg')
    t.mapping = THREE.EquirectangularReflectionMapping
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  return <primitive object={texture} attach="background" />
}

function EnemyMarkersController({
  enemies, centerX, centerZ, elevationAt, labelRefs,
}: {
  enemies: VisibleEnemy[]
  centerX: number
  centerZ: number
  elevationAt: (q: number, r: number) => number
  labelRefs: React.RefObject<Record<number, HTMLDivElement | null>>
}) {
  useFrame((state) => {
    const { camera, size } = state
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const candidates: { enemy: VisibleEnemy; px: number; py: number }[] = []
    for (const enemy of enemies) {
      const label = labelRefs.current[enemy.unit_id]
      if (!label) continue
      const [rawX, rawZ] = hexToWorld(enemy.q, enemy.r)
      const y = 0.3 + elevationAt(enemy.q, enemy.r) * 0.22 + MODEL_SCALE * MODEL_CHEST_FRACTION
      const worldPos = new THREE.Vector3(rawX - centerX, y, rawZ - centerZ)
      // Three.js's project() doesn't clip points behind the camera — they
      // can still land inside the [-1,1] NDC box with bogus coordinates —
      // so this dot-product check has to run first, not be folded into
      // the NDC bounds check below.
      if (worldPos.clone().sub(camera.position).dot(forward) <= 0) {
        label.style.display = 'none'
        continue
      }
      const ndc = worldPos.clone().project(camera)
      if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) {
        label.style.display = 'none'
        continue
      }
      candidates.push({ enemy, px: (ndc.x * 0.5 + 0.5) * size.width, py: (-ndc.y * 0.5 + 0.5) * size.height })
    }

    // Declutter: two enemies roughly colinear with the observer project
    // to nearly the same screen point (a real and fairly common case,
    // not just an edge case) — their reticles would stack exactly on
    // top of each other and read as a single detected enemy. The
    // nearer one keeps its true position; anything that would land on
    // an already-placed marker gets nudged down until it clears.
    candidates.sort((a, b) => a.enemy.distance - b.enemy.distance)
    const placed: { px: number; py: number }[] = []
    for (const c of candidates) {
      while (placed.some((p) => Math.abs(p.px - c.px) < MARKER_MIN_SEPARATION && Math.abs(p.py - c.py) < MARKER_MIN_SEPARATION)) {
        c.py += MARKER_MIN_SEPARATION
      }
      placed.push({ px: c.px, py: c.py })
      const label = labelRefs.current[c.enemy.unit_id]!
      label.style.display = 'flex'
      label.style.transform = `translate(${c.px}px, ${c.py}px) translate(-50%, -50%)`
    }
  })
  return null
}

// Cockpit HUD chrome — a jet-fighter-style frame (dotted top/bottom
// arcs meeting in a center chevron, side tick-mark ladders, corner
// brackets) around the 3D view, per user-provided reference images.
// Pure SVG, no image assets — same "zero asset cost" reasoning as
// Mech3D's old procedural prototype. Colors match tokens.css's own
// --accent/--danger (hardcoded here rather than var(), since these are
// SVG presentation attributes, not CSS properties, and var() inside a
// plain SVG attribute doesn't resolve reliably).
const HUD_ACCENT = '#1fc8ff'
const HUD_DANGER = '#e35d5d'
const HEAT_MAX = 30

function dotXs(from: number, to: number, step: number): number[] {
  const xs: number[] = []
  for (let x = from; x <= to; x += step) xs.push(x)
  return xs
}

/** One side's vertical gauge — a tick-marked ladder with a triangular
 * marker at the current value, same visual language on both sides
 * (HEAT on the left from the pilot's own mech, DIST to the nearest
 * detected enemy on the right — the two numeric readouts this cockpit
 * actually has real data for). */
function Ladder({
  x, label, value, max, mirror,
}: { x: number; label: string; value: number; max: number; mirror?: boolean }) {
  const yTop = 220
  const yBottom = 480
  const ticks = [0, 1, 2, 3].map((i) => {
    const frac = i / 3
    return { y: yTop + frac * (yBottom - yTop), val: Math.round(max * (1 - frac)) }
  })
  const clamped = Math.max(0, Math.min(max, value))
  const markerY = yTop + (1 - clamped / max) * (yBottom - yTop)
  const sign = mirror ? -1 : 1
  const tickX2 = x + 14 * sign
  const textX = x + 22 * sign
  const markerPoints = `${x - 4 * sign},${markerY} ${x - 16 * sign},${markerY - 7} ${x - 16 * sign},${markerY + 7}`
  return (
    <g>
      <line x1={x} y1={yTop} x2={x} y2={yBottom} stroke={HUD_ACCENT} strokeWidth={1.5} opacity={0.6} />
      <text
        x={x} y={yTop - 14} fill={HUD_ACCENT} fontSize={13} textAnchor="middle"
        fontFamily="'Cascadia Mono', monospace" opacity={0.9}
      >
        {label}
      </text>
      {ticks.map((t) => (
        <g key={t.y}>
          <line x1={x} y1={t.y} x2={tickX2} y2={t.y} stroke={HUD_ACCENT} strokeWidth={1.5} opacity={0.6} />
          <text
            x={textX} y={t.y + 4} fill={HUD_ACCENT} fontSize={11}
            textAnchor={mirror ? 'end' : 'start'} fontFamily="'Cascadia Mono', monospace" opacity={0.8}
          >
            {t.val}
          </text>
        </g>
      ))}
      <polygon points={markerPoints} fill={HUD_ACCENT} opacity={0.95} />
    </g>
  )
}

// Same body-location order the record sheet's own diagrams iterate in
// (MechRecordSheet.tsx) — front armor silhouette only (ARMOR_GEOMETRY),
// since this HUD readout has no room for the rear/structure panels too.
const HUD_MECH_LOCATIONS: MechLocationCode[] = ['HD', 'CT', 'LT', 'RT', 'LA', 'RA', 'LL', 'RL']

// blue (full health) -> yellow -> orange -> red (destroyed), same 4-stop
// gradient the user asked for ("desde el azul del HUD, pasando por
// amarillo/naranja/rojo a medida que baja la vida"). Piecewise-linear
// RGB interpolation between whichever two stops straddle `pct`.
const HEALTH_GRADIENT: [number, [number, number, number]][] = [
  [1, [31, 200, 255]], // HUD_ACCENT
  [0.66, [255, 214, 10]],
  [0.33, [255, 149, 0]],
  [0, [227, 93, 93]], // HUD_DANGER
]
function healthColor(pct: number): string {
  const clamped = Math.max(0, Math.min(1, pct))
  for (let i = 0; i < HEALTH_GRADIENT.length - 1; i++) {
    const [hiP, hiC] = HEALTH_GRADIENT[i]
    const [loP, loC] = HEALTH_GRADIENT[i + 1]
    if (clamped <= hiP && clamped >= loP) {
      const t = hiP === loP ? 0 : (hiP - clamped) / (hiP - loP)
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t)
      return `rgb(${mix(hiC[0], loC[0])}, ${mix(hiC[1], loC[1])}, ${mix(hiC[2], loC[2])})`
    }
  }
  return `rgb(${HEALTH_GRADIENT[HEALTH_GRADIENT.length - 1][1].join(', ')})`
}

/** Replaces the old plain "DIST" ladder — same front-armor silhouette
 * geometry MechRecordSheet's own armor diagram uses (real user request:
 * "quiero que utilices los mismos [diagramas] que en la ficha"), each
 * location filled by a blue→yellow→orange→red gradient of its combined
 * armor+structure health instead of individual pip dots (too fine-
 * grained to read at this HUD's small corner size). Nested <svg> so the
 * silhouette's own sheet-space coordinates (ARMOR_VIEWBOX) don't need
 * any manual translation into the outer HUD's 1200x700 space. */
function MechHealthDiagram({ mech, x, y, width, height }: {
  mech: Mech | null
  x: number
  y: number
  width: number
  height: number
}) {
  const byLoc = new Map((mech?.locations ?? []).map((l) => [l.location, l]))
  return (
    <g>
      <text
        x={x + width / 2} y={y - 10} fill={HUD_ACCENT} fontSize={13} textAnchor="middle"
        fontFamily="'Cascadia Mono', monospace" opacity={0.9}
      >
        MECH
      </text>
      <svg x={x} y={y} width={width} height={height} viewBox={ARMOR_VIEWBOX}>
        {HUD_MECH_LOCATIONS.map((code) => {
          const geo = ARMOR_GEOMETRY[code]
          const loc = byLoc.get(code)
          const pct = loc ? (loc.armor_current + loc.structure_current) / Math.max(1, loc.armor_max + loc.structure_max) : 1
          const fill = healthColor(pct)
          return geo.outline.kind === 'polygon' ? (
            <polygon key={code} points={geo.outline.d} transform={geo.outline.transform} fill={fill} fillOpacity={0.5} stroke={HUD_ACCENT} strokeWidth={1} strokeOpacity={0.85} />
          ) : (
            <path key={code} d={geo.outline.d} transform={geo.outline.transform} fill={fill} fillOpacity={0.5} stroke={HUD_ACCENT} strokeWidth={1} strokeOpacity={0.85} />
          )
        })}
      </svg>
    </g>
  )
}

function CornerBracket({
  x, y, flipX, flipY,
}: { x: number; y: number; flipX?: boolean; flipY?: boolean }) {
  const sx = flipX ? -1 : 1
  const sy = flipY ? -1 : 1
  const len = 34
  return (
    <polyline
      points={`${x},${y + len * sy} ${x},${y} ${x + len * sx},${y}`}
      fill="none" stroke={HUD_ACCENT} strokeWidth={2} opacity={0.6}
    />
  )
}

/** No center reticle/compass — the user explicitly asked for the frame
 * without it ("sin el marcador del centro"), just the arcs, ladders and
 * corner brackets. */
function HudFrame({ heat, mech }: { heat: number; mech: Mech | null }) {
  const topDotsLeft = dotXs(70, 520, 26)
  const topDotsRight = dotXs(680, 1130, 26)
  return (
    <svg className="fp-hud-frame" viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid meet">
      {topDotsLeft.map((x) => <circle key={`t-l-${x}`} cx={x} cy={22} r={2.2} fill={HUD_ACCENT} opacity={0.7} />)}
      {topDotsRight.map((x) => <circle key={`t-r-${x}`} cx={x} cy={22} r={2.2} fill={HUD_ACCENT} opacity={0.7} />)}

      {topDotsLeft.map((x) => <circle key={`b-l-${x}`} cx={x} cy={678} r={2.2} fill={HUD_ACCENT} opacity={0.7} />)}
      {topDotsRight.map((x) => <circle key={`b-r-${x}`} cx={x} cy={678} r={2.2} fill={HUD_ACCENT} opacity={0.7} />)}
      <polyline points="520,678 600,634 680,678" fill="none" stroke={HUD_ACCENT} strokeWidth={1.5} opacity={0.85} />

      <CornerBracket x={40} y={40} />
      <CornerBracket x={1160} y={40} flipX />
      <CornerBracket x={40} y={660} flipY />
      <CornerBracket x={1160} y={660} flipX flipY />

      <Ladder x={90} label="HEAT" value={heat} max={HEAT_MAX} />
      <MechHealthDiagram mech={mech} x={1000} y={230} width={190} height={218} />
    </svg>
  )
}

/** Circular lock-on reticle marking a detected enemy, per the user's
 * reference image — replaces the earlier plain rectangular tag. */
function TargetLockIcon() {
  const ticks = [0, 45, 90, 135, 180, 225, 270, 315]
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="fp-target-lock">
      <circle cx={28} cy={28} r={20} fill="none" stroke={HUD_DANGER} strokeWidth={1.4} />
      <circle cx={28} cy={28} r={2.5} fill={HUD_DANGER} />
      {ticks.map((deg) => {
        const rad = (deg * Math.PI) / 180
        const x1 = 28 + 20 * Math.cos(rad), y1 = 28 + 20 * Math.sin(rad)
        const x2 = 28 + 25 * Math.cos(rad), y2 = 28 + 25 * Math.sin(rad)
        return <line key={deg} x1={x1} y1={y1} x2={x2} y2={y2} stroke={HUD_DANGER} strokeWidth={1.4} />
      })}
      <polygon points="28,2 24,9 32,9" fill={HUD_DANGER} />
    </svg>
  )
}

/** Bottom-center HUD panel that appears once a detected enemy has been
 * tapped (see FirstPersonView's selectedTargetId) — the cockpit
 * equivalent of GMView/PlayerView's desktop WeaponVolleyPanel: one
 * toggle per mounted weapon, FIRE to send the volley. Same underlying
 * per-weapon /attack loop (FirstPersonView's own fireVolley), just
 * drawn in the HUD's cyan/monospace language instead of a floating
 * panel, since this is a cockpit readout, not a dialog box. */
function WeaponHud({
  mech, weaponCatalog, targetLabel, firing, onFire, onClose,
}: {
  mech: Mech | null
  weaponCatalog: Record<string, WeaponStats>
  targetLabel: string
  firing: boolean
  onFire: (weaponIds: number[]) => void
  onClose: () => void
}) {
  const weapons = mech?.weapons ?? []
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(weapons.filter((w) => w.ammo_remaining !== 0).map((w) => w.id)),
  )
  const toggle = (weaponId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(weaponId)) next.delete(weaponId)
      else next.add(weaponId)
      return next
    })
  }

  return (
    <div className="fp-weapon-hud">
      <div className="fp-weapon-hud-header">
        <span>OBJETIVO: {targetLabel}</span>
        <button className="fp-weapon-hud-close" onClick={onClose} disabled={firing}>×</button>
      </div>
      {weapons.length === 0 ? (
        <div className="fp-weapon-hud-empty">sin armas montadas</div>
      ) : (
        <ul className="fp-weapon-hud-list">
          {weapons.map((w) => {
            const stats = weaponCatalog[w.weapon_name]
            const outOfAmmo = w.ammo_remaining === 0
            const on = selected.has(w.id) && !outOfAmmo
            return (
              <li key={w.id} className={`fp-weapon-hud-row${outOfAmmo ? ' out-of-ammo' : ''}`}>
                <button
                  type="button"
                  className={`fp-weapon-toggle${on ? ' on' : ''}`}
                  role="switch"
                  aria-checked={on}
                  disabled={outOfAmmo || firing}
                  onClick={() => toggle(w.id)}
                >
                  <span className="fp-weapon-toggle-thumb" />
                </button>
                <span className="fp-weapon-hud-name">{w.weapon_name}</span>
                <span className="fp-weapon-hud-stats">
                  {stats ? `${stats.short}/${stats.medium}/${stats.long}` : '—'}
                  {w.ammo_remaining != null && ` · ${w.ammo_remaining}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <button
        className="fp-weapon-hud-fire"
        disabled={selected.size === 0 || firing}
        onClick={() => onFire([...selected])}
      >
        {firing ? 'DISPARANDO…' : 'FIRE'}
      </button>
    </div>
  )
}

// Iniciativa, Movimiento, Distancia and Melee are all real, tracked
// phases now (see turns.py's movement_order/moved_pilot_ids/
// ranged_target_pilot_ids/melee_target_pilot_ids) — Heat still has no
// real phase of its own (dissipation happens once per round instead, see
// turns.py's own docstring), so that pill stays purely cosmetic.
type Phase = 'iniciativa' | 'movimiento' | 'distancia' | 'melee' | 'heat'
const PHASES: { key: Phase; label: string }[] = [
  { key: 'iniciativa', label: 'Iniciativa' },
  { key: 'movimiento', label: 'Movimiento' },
  { key: 'distancia', label: 'Distancia' },
  { key: 'melee', label: 'Melee' },
  { key: 'heat', label: 'Heat' },
]

export function FirstPersonView({
  unit, mech, units, roundState, visibility, lastAttack, onClose,
}: {
  unit: Unit
  mech: Mech | null
  units: Unit[]
  roundState: RoundState | null
  /** From useTableSocket — re-run the enemies fetch on every broadcast so
   * a foe that moves (or a new one that comes into view) while this
   * modal is open doesn't go stale. The camera itself already re-derives
   * from `unit` on every render, so it follows this mech's own live
   * position/facing without any extra wiring — only the enemies list
   * needed a live-refresh trigger. */
  visibility?: unknown
  /** Also from useTableSocket, same broadcast GMView/TableView use to
   * drive their own attack VFX — this cockpit has its own separate
   * <Canvas>/<HexMap> tree (a different camera on the same live table,
   * not a mirror of TableView's own canvas), so it needs this threaded
   * through explicitly to play the laser/tracer/missile animation too. */
  lastAttack?: AttackResult | null
  onClose: () => void
}) {
  const [map, setMap] = useState<MapData | null>(null)
  const [enemies, setEnemies] = useState<VisibleEnemy[]>([])
  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const labelRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Click-and-drag look — offset from the mech's own facing_deg, clamped
  // to ±90° (LOOK_YAW_LIMIT_DEG) so the total sweep is exactly 180°,
  // matching the server's own vision arc (units.py's _VISION_ARC_DEG —
  // this cockpit was showing strictly less than what the mech can
  // actually detect per the rules, since it only ever rendered dead
  // ahead). Reset whenever the base facing actually changes (the unit
  // turned/moved) — an old look offset relative to a new facing read as
  // disorienting rather than useful.
  const [lookYawDeg, setLookYawDeg] = useState(0)
  useEffect(() => {
    setLookYawDeg(0)
  }, [unit.id, unit.q, unit.r, unit.facing_deg])

  // Self-contained fetch — PlayerView itself never loads map tile
  // geometry today (it only needs unit positions for its own
  // WeaponVolleyPanel flow), so this loads its own copy rather than
  // adding that dependency to PlayerView's own refetch cycle for a modal
  // that's rarely open. weaponCatalog rides along here too (fetched
  // once, doesn't need the visibility-triggered refresh the other two
  // get) so this cockpit's own weapon-toggle HUD can show heat/range per
  // weapon without PlayerView needing to pass its own copy down.
  useEffect(() => {
    let cancelled = false
    Promise.all([getMap(unit.map_id), getUnitVisibleEnemies(unit.id), getWeaponCatalog()]).then(([m, e, w]) => {
      if (!cancelled) {
        setMap(m)
        setEnemies(e)
        setWeaponCatalog(w)
      }
    })
    return () => {
      cancelled = true
    }
  }, [unit.map_id, unit.id, visibility])

  // Which detected enemy this pilot has tapped as their target this
  // volley — cleared on close, on a new selection, or once Fire! resolves.
  const [selectedTargetId, setSelectedTargetId] = useState<number | null>(null)
  const [firingVolley, setFiringVolley] = useState(false)

  // Attack VFX — same derivation GMView/TableView do from their own
  // lastAttack + units, mounted into THIS cockpit's own HexMap instead of
  // theirs (see the lastAttack prop's own doc comment above), queued
  // (see useAttackVfxQueue's own doc comment) so a fast attack resolving
  // while a slower one still animates doesn't cut the first one off.
  const { activeAttack: activeAttackVfx, onAttackEffectDone } = useAttackVfxQueue(lastAttack, units)

  // Red screen-edge flash on a successful incoming hit (real user
  // request) — a monotonic counter, not a boolean, so two hits landing
  // within the same animation window each still get their own flash: a
  // boolean toggled back to the same "on" value the CSS animation is
  // already mid-run for wouldn't restart it, but remounting the overlay
  // under a fresh `key` (below) always does.
  const [hitFlashId, setHitFlashId] = useState(0)
  useEffect(() => {
    if (lastAttack?.hit && lastAttack.target_unit_id === unit.id) {
      setHitFlashId((n) => n + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttack])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rolled = roundState?.rolls.some((r) => r.kind === 'pilot' && r.pilot_id === unit.pilot_id) ?? false
  // The round's own global phase (same currentPhase TableView/GMView
  // show) — NOT "is it literally my own turn within the movement
  // queue." A pilot who's already rolled but is waiting behind others
  // in movement_order is still in the Movimiento phase; gating on their
  // own exact turn made this pill skip straight from Iniciativa to
  // Distancia/Melee for anyone who wasn't first to move.
  const phase = roundState ? currentPhase(roundState) : 'none'
  // Unlike activePhases below (the phase pill row, deliberately global —
  // see its own comment), this one IS specifically "is it my own turn" —
  // an "¡INICIATIVA YA!"/"¡TU TURNO!" banner that fires for everyone in
  // the phase would be noise; the point is telling THIS pilot they're
  // the one being waited on.
  const isMyMoveTurn = roundState != null && unit.pilot_id != null && activeMoverPilotId(roundState) === unit.pilot_id
  const activePhases: Set<Phase> =
    phase === 'movement'
      ? new Set(['movimiento'])
      : phase === 'initiative'
        ? new Set(['iniciativa'])
        : phase === 'ranged'
          ? new Set(['distancia'])
          : phase === 'melee'
            ? new Set(['melee'])
            : new Set()

  // The Iniciativa pill doubles as the roll button when it's this
  // pilot's turn to throw — "un botón de iniciativa, por así decirlo" —
  // same requestInitiative call PlayerView's own button makes; the
  // shared table (TableView) is still the one that actually rolls.
  const rollMyInitiative = () => {
    if (rolled || unit.pilot_id == null) return
    requestInitiative(unit.campaign_id, unit.pilot_id).catch(() => {})
  }

  // Same gate GMView's own canAct uses (ranged/melee phase, not yet
  // acted) — tapping a detected enemy to bring up the weapon HUD is only
  // meaningful when there's actually something to fire this turn.
  const acted = unit.pilot_id != null && (roundState?.acted_pilot_ids.includes(unit.pilot_id) ?? false)
  const canAttack = (phase === 'ranged' || phase === 'melee') && !acted
  const selectedTarget = enemies.find((e) => e.unit_id === selectedTargetId) ?? null

  // Real reach, not just "detected" — same range/adjacency rule GMView's
  // own targetableHexes uses. Every detected enemy stays tappable
  // (canAttack alone gates that, matching the server's own permissive
  // "advisory, not blocking" stance — a rejected weapon just silently
  // doesn't fire), but only a genuinely reachable one gets the glow, so
  // the reticle itself communicates whether there's any real point
  // tapping this particular contact right now.
  const maxWeaponRange = Math.max(
    0,
    ...(mech?.weapons ?? [])
      .filter((w) => w.ammo_remaining !== 0)
      .map((w) => weaponCatalog[w.weapon_name]?.long ?? 0),
  )
  const isReachable = (enemy: VisibleEnemy) => (phase === 'melee' ? enemy.distance <= 1 : enemy.distance <= maxWeaponRange)

  // Sequential /attack calls, one per toggled weapon, same volley
  // pattern as GMView/PlayerView's own submitWeaponVolley — mirrored
  // here instead of shared because this one drives HUD-styled JSX below
  // rather than the desktop WeaponVolleyPanel component.
  const fireVolley = async (weaponIds: number[]) => {
    if (selectedTargetId == null) return
    setFiringVolley(true)
    for (const weaponId of weaponIds) {
      try {
        await attack(unit.campaign_id, {
          attacker_unit_id: unit.id,
          target_unit_id: selectedTargetId,
          weapon_id: weaponId,
        })
      } catch {
        // A rejected weapon (out of range/no ammo/no LOS) just doesn't
        // fire — the rest of the volley still goes out. No in-cockpit
        // log to write it to (unlike GMView/PlayerView's pushLog), so
        // this is silently skipped from here; the shot's absence in the
        // attack_result broadcast is the only record.
      }
    }
    if (unit.pilot_id != null) await markRoundActed(unit.campaign_id, unit.pilot_id).catch(() => {})
    setFiringVolley(false)
    setSelectedTargetId(null)
  }

  const camera = useMemo(() => {
    if (!map) return null
    const [centerX, centerZ] = mapCenter(map.tiles)
    const [rawX, rawZ] = hexToWorld(unit.q, unit.r)
    const elevation = map.tiles.find((t) => t.q === unit.q && t.r === unit.r)?.elevation ?? 0
    const eyeY = 0.3 + elevation * 0.22 + EYE_HEIGHT
    // Same facing→rotation convention HexMap's UnitMarker uses to orient
    // the rendered Mech3D model — the camera looks the same way the
    // mech's own model visibly faces, offset by however far the player
    // has dragged their look within the ±90° limit.
    const facingRotationY = Math.PI / 2 - ((unit.facing_deg + lookYawDeg) * Math.PI) / 180
    const forward: [number, number] = [Math.sin(facingRotationY), Math.cos(facingRotationY)]
    const position: [number, number, number] = [rawX - centerX, eyeY, rawZ - centerZ]
    const lookAt: [number, number, number] = [
      position[0] + forward[0] * LOOK_DISTANCE,
      eyeY,
      position[2] + forward[1] * LOOK_DISTANCE,
    ]
    return { centerX, centerZ, position, lookAt }
  }, [map, unit.q, unit.r, unit.facing_deg, lookYawDeg])

  const LOOK_YAW_LIMIT_DEG = 90
  const LOOK_DEG_PER_PIXEL = 0.15
  const lookDragRef = useRef<{ pointerId: number; startX: number; startYaw: number } | null>(null)
  const onLookPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* best-effort, see GMView's own mech-drag handler */ }
    lookDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startYaw: lookYawDeg }
  }
  const onLookPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = lookDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const deltaDeg = (e.clientX - drag.startX) * LOOK_DEG_PER_PIXEL
    setLookYawDeg(Math.max(-LOOK_YAW_LIMIT_DEG, Math.min(LOOK_YAW_LIMIT_DEG, drag.startYaw + deltaDeg)))
  }
  const onLookPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (lookDragRef.current?.pointerId === e.pointerId) lookDragRef.current = null
  }

  const elevationAt = (q: number, r: number) => map?.tiles.find((t) => t.q === q && t.r === r)?.elevation ?? 0

  // Only render mechs this cockpit would actually see — this unit's own
  // side always (you'd see your allies regardless), enemies only if
  // they're in the detected `enemies` list (facing cone + LoS — see
  // visible_enemies_from_unit). Rendering an undetected enemy's model
  // anyway (e.g. one hidden behind forest) contradicted "lo que vería
  // ese mech" and read as a marker bug once its model showed up on
  // screen with no reticle over it.
  const visibleEnemyUnitIds = new Set(enemies.map((e) => e.unit_id))
  const sceneUnits = units.filter(
    (u) => u.id !== unit.id && (u.pilot_faction === unit.pilot_faction || visibleEnemyUnitIds.has(u.id)),
  )

  return (
    <div className="first-person-view">
      {/* Purely decorative "watching this on a screen" pass — faint
          scanlines + a slight vignette, static (no flicker/scan sweep),
          low enough opacity to read as texture rather than noise. Sits
          above everything else (z-index in the CSS) since the ask was
          for the whole feed to read as viewed through a monitor, HUD
          included, not just the 3D canvas underneath it. */}
      {/* Fake tilt-shift/diorama look (real user request) — a cheap
          CSS-only miniature-photography trick, no postprocessing
          dependency: blurred bands along the top/bottom edges (masked to
          a soft gradient instead of a hard-edged blur rectangle), plus a
          saturation/contrast boost on the canvas itself (see
          .fp-canvas-wrap) to sell the "scale model" look. */}
      <div className="fp-tiltshift-band top" />
      <div className="fp-tiltshift-band bottom" />
      <div className="fp-crt-overlay" />
      {hitFlashId > 0 && <div key={hitFlashId} className="fp-hit-flash" />}
      <HudFrame heat={mech?.heat_current ?? 0} mech={mech} />

      <div className="fp-topbar">
        <div className="fp-chassis">
          {mech ? `${mech.chassis}${mech.model ? ` ${mech.model}` : ''}` : `Unidad #${unit.id}`}
        </div>
        <button className="fp-close" onClick={onClose}>×</button>
      </div>

      {phase === 'initiative' && !rolled && (
        <div className="fp-turn-alert">¡INICIATIVA YA!</div>
      )}
      {isMyMoveTurn && (
        <div className="fp-turn-alert">¡TU TURNO DE MOVERTE!</div>
      )}

      <div className="fp-phase-row">
        {PHASES.map((p) =>
          p.key === 'iniciativa' && !rolled ? (
            <button key={p.key} className="fp-phase-pill active clickable" onClick={rollMyInitiative}>
              {p.label}
            </button>
          ) : (
            <span key={p.key} className={`fp-phase-pill ${activePhases.has(p.key) ? 'active' : ''}`}>
              {p.label}
            </span>
          ),
        )}
      </div>

      {!map || !camera ? (
        <div className="fp-loading">cargando vista…</div>
      ) : (
        <>
          <div
            className="fp-canvas-wrap"
            onPointerDown={onLookPointerDown}
            onPointerMove={onLookPointerMove}
            onPointerUp={onLookPointerUp}
            onPointerCancel={onLookPointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Canvas shadows camera={{ fov: 70 }}>
              <SkyBackground />
              <ambientLight intensity={1.2} />
              <directionalLight
                position={[4, 8, 3]} intensity={1.8} castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-camera-left={-30} shadow-camera-right={30}
                shadow-camera-top={30} shadow-camera-bottom={-30}
                shadow-camera-far={60}
              />
              {/* A cockpit-mounted floodlight at the camera's own position —
                  the sun alone left mechs looking near-black at eye level,
                  where the fixed overhead light from TableView/GMView barely
                  reaches. Distance-limited so it lights what's actually in
                  view without washing out the whole scene. */}
              <pointLight position={camera.position} intensity={12} distance={14} decay={1.5} />
              <FixedFirstPersonCam position={camera.position} lookAt={camera.lookAt} />
              <Suspense fallback={null}>
                <HexMap
                  map={map}
                  units={sceneUnits}
                  activeAttack={activeAttackVfx}
                  onAttackEffectDone={onAttackEffectDone}
                />
              </Suspense>
              <EnemyMarkersController
                enemies={enemies}
                centerX={camera.centerX}
                centerZ={camera.centerZ}
                elevationAt={elevationAt}
                labelRefs={labelRefs}
              />
            </Canvas>
          </div>
          {enemies.map((enemy) => (
            <div
              key={enemy.unit_id}
              ref={(el) => {
                labelRefs.current[enemy.unit_id] = el
              }}
              className={`fp-enemy-label${canAttack ? ' targetable' : ''}${canAttack && isReachable(enemy) ? ' in-range' : ''}${selectedTargetId === enemy.unit_id ? ' selected' : ''}`}
              onClick={canAttack ? () => setSelectedTargetId(enemy.unit_id) : undefined}
            >
              <TargetLockIcon />
              <div className="fp-enemy-caption">
                <span className="fp-enemy-name">{enemy.chassis ?? '?'} {enemy.model ?? ''}</span>
                <span className="fp-enemy-distance">{enemy.distance} hex</span>
              </div>
            </div>
          ))}
          {selectedTarget && (
            <WeaponHud
              mech={mech}
              weaponCatalog={weaponCatalog}
              targetLabel={`${selectedTarget.chassis ?? '?'} ${selectedTarget.model ?? ''}`}
              firing={firingVolley}
              onFire={fireVolley}
              onClose={() => setSelectedTargetId(null)}
            />
          )}
        </>
      )}
    </div>
  )
}
