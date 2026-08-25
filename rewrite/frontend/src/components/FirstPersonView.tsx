import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import { EffectComposer, Outline, Selection } from '@react-three/postprocessing'
import { KernelSize } from 'postprocessing'
import * as THREE from 'three'
import { HexMap, useAttackVfxQueue } from './HexMap'
import { MODEL_HEAD_FRACTION, MODEL_SCALE } from './Mech3D'
import { ARMOR_GEOMETRY, ARMOR_VIEWBOX, type MechLocationCode } from '../mechSheetGeometry'
import { FacingPicker } from './FacingPicker'
import {
  attack, getMap, getUnitVisibleEnemies, getWeaponCatalog, markRoundActed, moveUnit,
  moveUnitWithMp, requestInitiative, requestMovement, submitMeleeAttack,
  type AttackResult, type Mech, type MapData, type MeleeAttackType, type MovementType, type ReachableHex,
  type RoundState, type Unit, type VisibleEnemy, type WeaponStats,
} from '../api'
import { activeMoverPilotId, currentPhase } from '../rounds'
import { hexToWorld, mapCenter } from '../hexMath'
import type { UnitWalked } from '../ws'
import './FirstPersonView.css'

// Derived from Mech3D's own scale/proportions rather than a hardcoded
// number, so bumping the model's size there doesn't quietly leave the
// cockpit camera sitting somewhere around its knees.
const EYE_HEIGHT = MODEL_SCALE * MODEL_HEAD_FRACTION
const LOOK_DISTANCE = 4
// Target silhouettes are ~56px wide at the fallback/near size — a bit
// more than that so two decluttered markers never touch.
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

// Kept off the true viewport edge so an edge indicator never overlaps
// HudFrame's own corner brackets/arcs.
const OFFSCREEN_EDGE_MARGIN_PX = 46

// Positions each detected enemy's tap target + caption (name/distance)
// at its own projected chest point, same as before the outline rework —
// the visual "this is targeted" cue now lives in the 3D scene itself
// (Mech3D's outlineColor, a real edge-outline around the model's own
// silhouette) rather than a flat DOM shape traced over its screen
// projection, so this controller only needs one point per enemy again,
// not a projected bounding box.
function EnemyMarkersController({
  enemies, centerX, centerZ, elevationAt, labelRefs, offscreenRefs,
}: {
  enemies: VisibleEnemy[]
  centerX: number
  centerZ: number
  elevationAt: (q: number, r: number) => number
  labelRefs: React.RefObject<Record<number, HTMLDivElement | null>>
  offscreenRefs: React.RefObject<Record<number, HTMLDivElement | null>>
}) {
  useFrame((state) => {
    const { camera, size } = state
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const rightAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
    const flatForward = new THREE.Vector3(forward.x, 0, forward.z).normalize()
    const flatRight = new THREE.Vector3(rightAxis.x, 0, rightAxis.z).normalize()

    const candidates: { enemy: VisibleEnemy; px: number; py: number }[] = []
    for (const enemy of enemies) {
      const label = labelRefs.current[enemy.unit_id]
      const arrow = offscreenRefs.current[enemy.unit_id]
      if (!label || !arrow) continue

      const [rawX, rawZ] = hexToWorld(enemy.q, enemy.r)
      const lx = rawX - centerX, lz = rawZ - centerZ
      // Real user request: the caption (chassis/model + distance) should
      // float just above the mech, not sit centered on its torso — anchor
      // at head height (MODEL_HEAD_FRACTION) plus a bit of clearance
      // instead of MODEL_CHEST_FRACTION.
      const y = 0.3 + elevationAt(enemy.q, enemy.r) * 0.22 + MODEL_SCALE * MODEL_HEAD_FRACTION + 0.3
      const worldPos = new THREE.Vector3(lx, y, lz)

      // Three.js's project() doesn't clip points behind the camera — they
      // can still land inside the [-1,1] NDC box with bogus coordinates —
      // so this dot-product check has to run first, not be folded into
      // the NDC bounds check below.
      const inFront = worldPos.clone().sub(camera.position).dot(forward) > 0
      const ndc = worldPos.clone().project(camera)
      const onScreen = inFront && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1

      if (!onScreen) {
        label.style.display = 'none'
        // Bearing relative to where the camera is actually looking, in
        // the horizontal (ground) plane only — vertical off-screen
        // (a contact far above/below) isn't meaningful on these mostly-
        // flat maps, and collapsing to a horizontal-only bearing keeps
        // the arrow's direction legible at a glance either way.
        const toEnemy = new THREE.Vector3(lx - camera.position.x, 0, lz - camera.position.z)
        if (toEnemy.lengthSq() < 1e-6) {
          arrow.style.display = 'none'
          continue
        }
        toEnemy.normalize()
        const bearing = Math.atan2(toEnemy.dot(flatRight), toEnemy.dot(flatForward))
        const dirX = Math.sin(bearing)
        const dirY = -Math.cos(bearing)
        const halfW = size.width / 2 - OFFSCREEN_EDGE_MARGIN_PX
        const halfH = size.height / 2 - OFFSCREEN_EDGE_MARGIN_PX
        const s = Math.min(
          Math.abs(dirX) > 1e-4 ? halfW / Math.abs(dirX) : Infinity,
          Math.abs(dirY) > 1e-4 ? halfH / Math.abs(dirY) : Infinity,
        )
        const ex = size.width / 2 + dirX * s
        const ey = size.height / 2 + dirY * s
        arrow.style.display = 'flex'
        arrow.style.transform = `translate(${ex}px, ${ey}px) translate(-50%, -50%) rotate(${(bearing * 180) / Math.PI}deg)`
        continue
      }
      arrow.style.display = 'none'
      candidates.push({ enemy, px: (ndc.x * 0.5 + 0.5) * size.width, py: (-ndc.y * 0.5 + 0.5) * size.height })
    }

    // Declutter: two enemies roughly colinear with the observer project
    // to nearly the same screen point (a real and fairly common case,
    // not just an edge case) — their labels would stack exactly on top
    // of each other and read as a single detected enemy. The nearer one
    // keeps its true position; anything that would land on an already-
    // placed marker gets nudged down until it clears.
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

/** Tweens toward `target` over `durationMs` instead of snapping — real
 * user request: "se vera una pequeña animación de como baja el
 * termómetro" once the Heat Phase actually drops a mech's heat_current.
 * Plain requestAnimationFrame rather than react-three-fiber's useFrame
 * since Thermometer lives in the plain SVG HUD overlay, not inside the
 * <Canvas>. Restarts cleanly from wherever the previous tween had
 * gotten to if `target` changes again mid-flight. */
function useSmoothedValue(target: number, durationMs = 900): number {
  const [display, setDisplay] = useState(target)
  const fromRef = useRef(target)
  const targetRef = useRef(target)
  const startRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (target === targetRef.current) return
    fromRef.current = display
    targetRef.current = target
    startRef.current = null
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)

    const step = (t: number) => {
      if (startRef.current == null) startRef.current = t
      const frac = Math.min(1, (t - startRef.current) / durationMs)
      const eased = 1 - (1 - frac) * (1 - frac)
      setDisplay(fromRef.current + (targetRef.current - fromRef.current) * eased)
      if (frac < 1) rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs])

  return display
}

/** Vertical thermometer-style HEAT gauge (real user request: "una línea
 * roja como un termómetro" instead of the old tick-ladder + triangle
 * marker) — a red fill rises inside a cyan tube as heat climbs, same
 * 0..max scale/tick spacing the old Ladder used at this same HUD
 * position. A separate short cyan marker partway up the tube pins
 * exactly how many points this mech's own heat sinks are worth (real
 * user request: "un marcador con la cantidad que los disipadores van a
 * ser capaces de disipar") — mechs.py's dissipate_heat floors
 * heat_current by exactly mech.heat_sinks at the top of every round, so
 * this marker is that same number's position on the same scale the red
 * fill uses, not a separate/derived value. */
function Thermometer({
  x, heat, max, dissipation,
}: { x: number; heat: number; max: number; dissipation: number }) {
  const smoothedHeat = useSmoothedValue(heat)
  const yTop = 220
  const yBottom = 480
  const tubeWidth = 12
  const ticks = [0, 1, 2, 3].map((i) => {
    const frac = i / 3
    return { y: yTop + frac * (yBottom - yTop), val: Math.round(max * (1 - frac)) }
  })
  const clampedHeat = Math.max(0, Math.min(max, smoothedHeat))
  const fillY = yTop + (1 - clampedHeat / max) * (yBottom - yTop)
  const clampedDissipation = Math.max(0, Math.min(max, dissipation))
  const dissipationY = yTop + (1 - clampedDissipation / max) * (yBottom - yTop)
  return (
    <g>
      <text
        x={x} y={yTop - 14} fill={HUD_ACCENT} fontSize={13} textAnchor="middle"
        fontFamily="'Cascadia Mono', monospace" opacity={0.9}
      >
        HEAT
      </text>
      <rect
        x={x - tubeWidth / 2} y={yTop} width={tubeWidth} height={yBottom - yTop} rx={tubeWidth / 2}
        fill="none" stroke={HUD_ACCENT} strokeWidth={1.5} opacity={0.6}
      />
      <rect
        x={x - tubeWidth / 2 + 2} y={fillY} width={tubeWidth - 4} height={Math.max(0, yBottom - fillY - 2)}
        rx={(tubeWidth - 4) / 2} fill={HUD_DANGER} opacity={0.85}
      />
      {ticks.map((t) => (
        <g key={t.y}>
          <line x1={x + tubeWidth / 2} y1={t.y} x2={x + tubeWidth / 2 + 8} y2={t.y} stroke={HUD_ACCENT} strokeWidth={1.5} opacity={0.6} />
          <text
            x={x + tubeWidth / 2 + 14} y={t.y + 4} fill={HUD_ACCENT} fontSize={11}
            textAnchor="start" fontFamily="'Cascadia Mono', monospace" opacity={0.8}
          >
            {t.val}
          </text>
        </g>
      ))}
      <polygon
        points={`${x - tubeWidth / 2 - 3},${dissipationY} ${x - tubeWidth / 2 - 13},${dissipationY - 6} ${x - tubeWidth / 2 - 13},${dissipationY + 6}`}
        fill={HUD_ACCENT} opacity={0.95}
      />
      <text
        x={x - tubeWidth / 2 - 17} y={dissipationY + 4} fill={HUD_ACCENT} fontSize={10}
        textAnchor="end" fontFamily="'Cascadia Mono', monospace" opacity={0.85}
      >
        -{Math.round(dissipation)}
      </text>
      <text
        x={x} y={yBottom + 22} fill={HUD_DANGER} fontSize={16} fontWeight={700}
        textAnchor="middle" fontFamily="'Cascadia Mono', monospace"
      >
        {Math.round(smoothedHeat)}
      </text>
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

      <Thermometer x={90} heat={heat} max={HEAT_MAX} dissipation={mech?.heat_sinks ?? 0} />
      <MechHealthDiagram mech={mech} x={1000} y={230} width={190} height={218} />
    </svg>
  )
}

/** Edge-of-screen indicator for a detected enemy currently outside the
 * frustum (real user request: "un triángulo rojo en el borde de la
 * pantalla en la dirección donde esté") — EnemyMarkersController clamps
 * this to the viewport edge along the enemy's real horizontal bearing
 * and sets the rotation to match, this just draws the triangle pointing
 * "up" in its own local space so the parent's rotate() aims it. */
function OffscreenArrow() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" className="fp-offscreen-arrow">
      <polygon points="14,2 24,22 4,22" fill={HUD_DANGER} />
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
  mech, weaponCatalog, targetLabel, firing, onFire, onClose, melee,
}: {
  mech: Mech | null
  weaponCatalog: Record<string, WeaponStats>
  targetLabel: string
  firing: boolean
  onFire: (weaponIds: number[]) => void
  onClose: () => void
  /** Melee phase — real user request: "cuando phase === 'melee' mostrar
   * botones Puñetazo/Patada/Carga/DFA en vez de la lista de armas".
   * Present instead of the weapon-toggle list whenever the round is
   * actually in its melee phase; Carga/DFA are pre-disabled client-side
   * to match melee.py's own movement gate (same courtesy as GMView's
   * MeleeAttackPanel), so the cockpit never offers an attack the server
   * will reject. */
  melee?: {
    canCharge: boolean
    canDfa: boolean
    onAttack: (attackType: MeleeAttackType, arm?: 'left' | 'right') => void
  }
}) {
  const weapons = mech?.weapons ?? []
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(weapons.filter((w) => w.ammo_remaining !== 0).map((w) => w.id)),
  )
  const [meleeType, setMeleeType] = useState<MeleeAttackType>('punch')
  const [meleeArm, setMeleeArm] = useState<'left' | 'right'>('right')
  const toggle = (weaponId: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(weaponId)) next.delete(weaponId)
      else next.add(weaponId)
      return next
    })
  }

  const meleeOptions: { type: MeleeAttackType; label: string; enabled: boolean }[] = melee
    ? [
        { type: 'punch', label: 'PUÑETAZO', enabled: true },
        { type: 'kick', label: 'PATADA', enabled: true },
        { type: 'charge', label: 'CARGA', enabled: melee.canCharge },
        { type: 'dfa', label: 'DFA', enabled: melee.canDfa },
      ]
    : []

  return (
    <div className="fp-weapon-hud">
      <div className="fp-weapon-hud-header">
        <span>OBJETIVO: {targetLabel}</span>
        <button className="fp-weapon-hud-close" onClick={onClose} disabled={firing}>×</button>
      </div>
      {melee ? (
        <>
          <ul className="fp-weapon-hud-list">
            {meleeOptions.map((opt) => (
              <li key={opt.type} className="fp-weapon-hud-row">
                <button
                  type="button"
                  className={`fp-melee-option${meleeType === opt.type ? ' selected' : ''}`}
                  disabled={!opt.enabled || firing}
                  onClick={() => setMeleeType(opt.type)}
                >
                  {opt.label}
                </button>
              </li>
            ))}
          </ul>
          {meleeType === 'punch' && (
            <div className="fp-melee-arm-picker">
              <button
                type="button"
                className={`fp-melee-option${meleeArm === 'left' ? ' selected' : ''}`}
                disabled={firing}
                onClick={() => setMeleeArm('left')}
              >
                BRAZO IZQ.
              </button>
              <button
                type="button"
                className={`fp-melee-option${meleeArm === 'right' ? ' selected' : ''}`}
                disabled={firing}
                onClick={() => setMeleeArm('right')}
              >
                BRAZO DCHO.
              </button>
            </div>
          )}
          <button
            className="fp-weapon-hud-fire"
            disabled={firing || !meleeOptions.find((o) => o.type === meleeType)?.enabled}
            onClick={() => melee.onAttack(meleeType, meleeType === 'punch' ? meleeArm : undefined)}
          >
            {firing ? 'ATACANDO…' : 'ATACAR'}
          </button>
        </>
      ) : weapons.length === 0 ? (
        <div className="fp-weapon-hud-empty">sin armas montadas</div>
      ) : (
        <>
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
                  />
                  <span className="fp-weapon-hud-name">{w.weapon_name}</span>
                  <span className="fp-weapon-hud-stats">
                    {stats ? `DMG:${stats.damage}   HEAT:${stats.heat}` : '—'}
                    {w.ammo_remaining != null && ` · ${w.ammo_remaining}`}
                  </span>
                </li>
              )
            })}
          </ul>
          <button
            className="fp-weapon-hud-fire"
            disabled={selected.size === 0 || firing}
            onClick={() => onFire([...selected])}
          >
            {firing ? 'DISPARANDO…' : 'FIRE'}
          </button>
        </>
      )}
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
  unit, mech, units, mechs, roundState, visibility, lastAttack, unitWalked, onClose,
}: {
  unit: Unit
  mech: Mech | null
  units: Unit[]
  /** Every mech in the campaign, same list GMView/TableView/PlayerView
   * already fetch for their own sheets — only consulted here for
   * heat_current, to drive SteamPuffs on this cockpit's own <HexMap>
   * instance for every ally/enemy mech rendered in it (real user
   * request: "los mechs... desprenderán vapor en todas las vistas de
   * mapa"). Omitted entirely just renders no steam, same as any caller
   * that hasn't wired this through yet. */
  mechs?: Mech[]
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
  /** Also from useTableSocket — real user report: any visible ally/enemy
   * mech walking across this cockpit's own <HexMap> instance had no
   * route data at all (only the player's OWN move, via the Movimiento
   * submenu below, ever populated one), so it slid in a straight line
   * through anything in between instead of the real path. No self-
   * initiated guard needed here (unlike GMView/TableView) — this view
   * never renders the player's own unit at all, so there's no locally-
   * fresher path data to protect against being overwritten. */
  unitWalked?: UnitWalked | null
  onClose: () => void
}) {
  const [map, setMap] = useState<MapData | null>(null)
  const [enemies, setEnemies] = useState<VisibleEnemy[]>([])
  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const labelRefs = useRef<Record<number, HTMLDivElement | null>>({})
  // Edge-of-screen arrow for a detected enemy currently outside the
  // frustum/behind the camera (real user request: "un triángulo rojo en
  // el borde de la pantalla en la dirección donde esté") — a sibling of
  // the label rather than a mode of it, since the two need independent
  // transforms (label centers on the enemy's own screen position, this
  // clamps to the viewport edge and rotates to point at it).
  const offscreenRefs = useRef<Record<number, HTMLDivElement | null>>({})

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

  // This view is `position: fixed; inset: 0`, so it visually covers the
  // whole viewport regardless of the page underneath — but without this,
  // the underlying PlayerView page (real content, real scroll height)
  // still shows a scrollbar the whole time this is open (real user
  // request: "no quiero scroll bar en la vista de 1ª persona"). Restores
  // whatever the body's own overflow was on close, rather than assuming
  // it was the default.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [])

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

  // Movimiento pill becomes the same kind of button as Iniciativa (real
  // user request) — click it, a submenu of Caminar/Correr/Saltar/Cambiar
  // dirección/Saltar movimiento drops down. Unlike PlayerView's own
  // Acciones tab (which has no map of its own and asks the SHARED table
  // to show the reachable-hex highlight via requestMovement's broadcast),
  // this cockpit already renders its own <HexMap> — picking a movement
  // type here fetches the same reachable set with the plain, non-
  // broadcasting getReachableHexes and renders the glow directly in
  // THIS player's own view only, nobody else's.
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false)
  const [movementHighlight, setMovementHighlight] = useState<
    { movementType: MovementType; hexes: Map<string, ReachableHex> } | null
  >(null)
  // 'move' carries the clicked hex's own path/allowedFacings (same shape
  // GMView's own pendingFacing does) so FacingPicker only offers facings
  // the remaining MP budget can actually afford there; 'rotate' has no
  // hex at all — same q/r the unit is already standing on.
  type FpvPendingFacing =
    | {
        kind: 'move'; movementType: MovementType; q: number; r: number; x: number; y: number
        allowedFacings?: number[]; path?: { q: number; r: number }[]
      }
    | { kind: 'rotate' }
    | null
  const [pendingFacing, setPendingFacing] = useState<FpvPendingFacing>(null)

  // Real user report: any visible ally/enemy walking across this
  // cockpit's own <HexMap> had no route data, so it slid in a straight
  // line through anything in between instead of the real path — see
  // unitWalked's own prop doc comment above for why no self-initiated
  // guard is needed here, unlike GMView/TableView.
  const [walkPaths, setWalkPaths] = useState<Map<number, { q: number; r: number }[]>>(new Map())
  useEffect(() => {
    if (!unitWalked || unitWalked.path.length === 0) return
    setWalkPaths((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.path))
  }, [unitWalked])

  const startFpvMovement = async (movementType: MovementType) => {
    setShowMoveSubmenu(false)
    try {
      // requestMovement (not the plain getReachableHexes fetch) so the
      // shared TableView screen ALSO shows this highlight (real user
      // request) — it already listens for the same movement_started
      // broadcast this triggers (see its own activeMovement effect),
      // exactly like GMView's own phase-movement flow.
      const { hexes } = await requestMovement(unit.id, movementType)
      setMovementHighlight({ movementType, hexes: new Map(hexes.map((h) => [`${h.q},${h.r}`, h])) })
    } catch {
      // silently no-op, same precedent as fireVolley's rejected-shot
      // handling below — no in-cockpit log to write a failure to.
    }
  }

  const onFpvTileClick = (q: number, r: number, clientX: number, clientY: number) => {
    if (!movementHighlight) return
    const hex = movementHighlight.hexes.get(`${q},${r}`)
    setMovementHighlight(null)
    if (hex) {
      setPendingFacing({
        kind: 'move', movementType: movementHighlight.movementType, q, r,
        x: clientX, y: clientY, allowedFacings: hex.facings, path: hex.path,
      })
    }
    // A click outside the highlighted set just cancels the pick, same as GMView.
  }

  // Real user request: clicking directly on a detected enemy's own 3D
  // model (inside its outline, not just its floating caption above)
  // should also open the weapon HUD during the ranged/melee phase —
  // same gate/target set the caption's own onClick already uses.
  const onFpvUnitClick = (clickedUnit: Unit) => {
    if (!canAttack) return
    if (!visibleEnemyUnitIds.has(clickedUnit.id)) return
    setSelectedTargetId(clickedUnit.id)
  }

  const onFpvRotate = () => {
    setShowMoveSubmenu(false)
    setPendingFacing({ kind: 'rotate' })
  }

  const onFpvSkipMovement = () => {
    setShowMoveSubmenu(false)
    // Same "record a 0-hex move" backend path as Cambiar dirección/
    // Saltar movimiento elsewhere in the app (main.py's /move endpoint
    // already counts a same-position reposition as this round's move) —
    // no facing prompt needed, the mech just stays put.
    moveUnit(unit.id, unit.q, unit.r).catch(() => {})
  }

  const resolveFpvFacing = (facingDeg?: number) => {
    if (!pendingFacing) return
    if (pendingFacing.kind === 'move') {
      moveUnitWithMp(unit.id, pendingFacing.q, pendingFacing.r, pendingFacing.movementType, facingDeg).catch(() => {})
    } else if (facingDeg != null) {
      moveUnit(unit.id, unit.q, unit.r, facingDeg).catch(() => {})
    }
    setPendingFacing(null)
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

  // Melee phase's single-attack equivalent of fireVolley above.
  const fireMelee = async (attackType: MeleeAttackType, arm?: 'left' | 'right') => {
    if (selectedTargetId == null) return
    setFiringVolley(true)
    try {
      await submitMeleeAttack(unit.id, selectedTargetId, attackType, arm)
    } catch {
      // rejected (not adjacent/incapacitated/movement doesn't qualify) —
      // same silent-skip stance as fireVolley above.
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

  // FacingPicker's own flower layout assumes GMView's fixed top-down
  // camera (screen-right = facing_deg 0, clockwise from there — see its
  // own top comment) — under this cockpit's rotatable camera, "straight
  // ahead" can be any of the 6 directions depending on facing_deg AND
  // however far the player has dragged their look (real user report).
  // This offset puts whatever the player is CURRENTLY looking at
  // (unit.facing_deg + lookYawDeg) at screen-up (270° in that same
  // convention) instead of wherever it would otherwise fall.
  const facingPickerRotationOffset = 270 - (unit.facing_deg + lookYawDeg)

  // Boot sequence (real user request) — the old plain "cargando vista…"
  // text left an awkward moment where the HUD (frame/name/phases, none
  // of which depend on the map) was already fully drawn while the 3D
  // scene was still blank underneath it — and just gating on map+camera
  // being fetched wasn't enough either: the REST fetch resolves almost
  // instantly, but the sky photo, mech GLTFs and terrain decor it then
  // triggers loading (SkyBackground/Mech3D/TerrainDecor) can still take
  // a couple of real seconds, which the player would see loading in live
  // underneath the map. useProgress (drei) tracks every loader that goes
  // through THREE.DefaultLoadingManager — GLTFLoader and TextureLoader
  // both do, by default, so this covers the sky texture and every mech/
  // terrain model without each of those components needing its own
  // "I'm ready" signal. A TV-static overlay covers the whole wait, then
  // a brief "power on" flash before revealing the complete, ALREADY-
  // fully-loaded view (HUD and scene together) in one go — the player
  // should never watch the map load in live underneath the static.
  const BOOT_MIN_MS = 500
  const LOAD_GRACE_MS = 350
  const [booted, setBooted] = useState(false)
  const [poweringOn, setPoweringOn] = useState(false)
  const [sceneSettled, setSceneSettled] = useState(false)
  const { active: assetsLoading } = useProgress()
  const bootStartRef = useRef(Date.now())
  const assetsStartedRef = useRef(false)
  const readyRef = useRef(false)

  useEffect(() => {
    if (assetsLoading) assetsStartedRef.current = true
  }, [assetsLoading])

  // Nothing observed loading yet could mean either "hasn't kicked off
  // its fetch this render" or "everything's already cached from an
  // earlier view" (useGLTF.preload calls elsewhere, or a second look at
  // the same map) — LOAD_GRACE_MS tells those two apart without an
  // indefinite wait: if a loader hasn't started by then, there's
  // genuinely nothing to load.
  useEffect(() => {
    if (sceneSettled || !map || !camera) return
    if (assetsLoading) return
    if (!assetsStartedRef.current) {
      const t = setTimeout(() => setSceneSettled(true), LOAD_GRACE_MS)
      return () => clearTimeout(t)
    }
    setSceneSettled(true)
  }, [map, camera, assetsLoading, sceneSettled])

  useEffect(() => {
    if (!sceneSettled || readyRef.current) return
    readyRef.current = true
    const delay = Math.max(0, BOOT_MIN_MS - (Date.now() - bootStartRef.current))
    let poweroffTimer: ReturnType<typeof setTimeout> | undefined
    const onTimer = setTimeout(() => {
      setPoweringOn(true)
      poweroffTimer = setTimeout(() => {
        setPoweringOn(false)
        setBooted(true)
      }, 420)
    }, delay)
    return () => {
      clearTimeout(onTimer)
      if (poweroffTimer) clearTimeout(poweroffTimer)
    }
  }, [sceneSettled])

  const LOOK_YAW_LIMIT_DEG = 90
  const LOOK_DEG_PER_PIXEL = 0.15
  // Below this many pixels of movement, a press-release is a click, not
  // a look-drag — real user request (bug): capturing the pointer
  // unconditionally on pointerdown redirected EVERY subsequent event
  // (including the release) to this wrapper div, which meant it never
  // reached the canvas's own r3f event system at all — so a tile's
  // onPointerUp (HexMap's resolveAt, which is what actually resolves a
  // reachable-hex click into a move) could never fire; clicking a
  // highlighted hex silently did nothing. Only capturing once real drag
  // movement is confirmed lets a genuine click's pointerup hit-test
  // normally against whatever's under the cursor, same as it would with
  // no wrapper listening at all — while still capturing (for smooth
  // continued dragging even if the cursor leaves the canvas) once an
  // actual look-drag is underway.
  const LOOK_DRAG_THRESHOLD_PX = 6
  const lookDragRef = useRef<{ pointerId: number; startX: number; startYaw: number; dragging: boolean } | null>(null)
  const onLookPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    lookDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startYaw: lookYawDeg, dragging: false }
  }
  const onLookPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = lookDragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const deltaPx = e.clientX - drag.startX
    if (!drag.dragging) {
      if (Math.abs(deltaPx) < LOOK_DRAG_THRESHOLD_PX) return
      drag.dragging = true
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* best-effort, see GMView's own mech-drag handler */ }
    }
    const deltaDeg = deltaPx * LOOK_DEG_PER_PIXEL
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
  const heatByUnitId = new Map(
    sceneUnits.filter((u) => u.mech_id != null).map((u) => [u.id, mechs?.find((m) => m.id === u.mech_id)?.heat_current ?? 0]),
  )
  const proneUnitIds = new Set(sceneUnits.filter((u) => mechs?.find((m) => m.id === u.mech_id)?.is_prone).map((u) => u.id))
  const shutdownUnitIds = new Set(sceneUnits.filter((u) => mechs?.find((m) => m.id === u.mech_id)?.is_shutdown).map((u) => u.id))

  return (
    <div className="first-person-view">
      {!booted && (
        <div className={`fp-boot${poweringOn ? ' poweron' : ''}`}>
          <div className="fp-static" />
        </div>
      )}
      {map && camera && (
        // Mounted (invisible) the moment map/camera are ready rather
        // than only once `booted` — the whole point is that its GLTF/
        // texture loads (which useProgress above is watching) actually
        // START while the static plays, instead of only beginning once
        // the static already finished. Revealed in one cut, never a
        // fade — the static's own power-on flash IS the reveal.
        <div className={`fp-ready${booted ? ' visible' : ''}`}>
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
              ) : p.key === 'movimiento' && isMyMoveTurn ? (
                <button
                  key={p.key} className="fp-phase-pill active clickable"
                  onClick={() => setShowMoveSubmenu((v) => !v)}
                >
                  {p.label}
                </button>
              ) : (
                <span key={p.key} className={`fp-phase-pill ${activePhases.has(p.key) ? 'active' : ''}`}>
                  {p.label}
                </span>
              ),
            )}
          </div>

          {showMoveSubmenu && (
            <div className="fp-move-submenu">
              <button onClick={() => startFpvMovement('walk')}>Caminar</button>
              <button onClick={() => startFpvMovement('run')}>Correr</button>
              <button disabled={!mech?.jump_mp} onClick={() => startFpvMovement('jump')}>Saltar</button>
              <button onClick={onFpvRotate}>Cambiar dirección</button>
              <button onClick={onFpvSkipMovement}>Saltar movimiento</button>
            </div>
          )}

          <div
            className="fp-canvas-wrap"
            onPointerDown={onLookPointerDown}
            onPointerMove={onLookPointerMove}
            onPointerUp={onLookPointerUp}
            onPointerCancel={onLookPointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Canvas shadows camera={{ fov: 70 }}>
              {/* Selection + Outline (real user request, with a reference
                  image: "resalte el contorno del mech enemigo, del modelo
                  3D" — a real edge-detected silhouette outline around the
                  actual model, not a flat shape traced over its screen
                  projection) — a proper screen-space edge-detection pass
                  over a mask render of whatever's claimed via <Select>,
                  which is why it reads as ONE clean outer silhouette per
                  mech even though each model is many separate meshes
                  (arms/legs/torso/guns) — a per-mesh backface-extrusion
                  outline was tried first and rejected for exactly that
                  reason (every part got its own seam). HexMap's own
                  UnitMarker claims each detected enemy via outlineUnitIds
                  -> <Select enabled>. */}
              <Selection>
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
                    moveHighlightHexes={movementHighlight ? new Set(movementHighlight.hexes.keys()) : undefined}
                    pathPreviewHexes={
                      pendingFacing?.kind === 'move' && pendingFacing.path
                        ? new Set(pendingFacing.path.map((p) => `${p.q},${p.r}`))
                        : undefined
                    }
                    onTileClick={onFpvTileClick}
                    onUnitClick={onFpvUnitClick}
                    walkPaths={walkPaths}
                    outlineUnitIds={visibleEnemyUnitIds}
                    heatByUnitId={heatByUnitId}
                    proneUnitIds={proneUnitIds}
                    shutdownUnitIds={shutdownUnitIds}
                  />
                </Suspense>
                <EnemyMarkersController
                  enemies={enemies}
                  centerX={camera.centerX}
                  centerZ={camera.centerZ}
                  elevationAt={elevationAt}
                  labelRefs={labelRefs}
                  offscreenRefs={offscreenRefs}
                />
                <EffectComposer autoClear={false}>
                  {/* Real user report: against a light background (the
                      sky) the outline read as too thin to notice —
                      edgeStrength alone didn't do much since it's a
                      glow-intensity multiplier, not a width; kernelSize
                      is what actually widens the blurred edge. */}
                  <Outline
                    visibleEdgeColor={0xe35d5d} hiddenEdgeColor={0xe35d5d} edgeStrength={10}
                    blur kernelSize={KernelSize.LARGE} width={1000}
                  />
                </EffectComposer>
              </Selection>
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
              <div className="fp-enemy-caption">
                <span className="fp-enemy-name">{enemy.chassis ?? '?'} {enemy.model ?? ''}</span>
                <span className="fp-enemy-distance">{enemy.distance} hex</span>
              </div>
            </div>
          ))}
          {enemies.map((enemy) => (
            <div
              key={enemy.unit_id}
              ref={(el) => {
                offscreenRefs.current[enemy.unit_id] = el
              }}
              className="fp-offscreen-indicator"
            >
              <OffscreenArrow />
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
              melee={phase === 'melee' ? {
                canCharge: (() => {
                  const move = roundState?.moves.find((m) => m.unit_id === unit.id)
                  return move != null && (move.movement_type === 'walk' || move.movement_type === 'run') && move.hexes_moved > 0
                })(),
                canDfa: (() => {
                  const move = roundState?.moves.find((m) => m.unit_id === unit.id)
                  return move != null && move.movement_type === 'jump'
                })(),
                onAttack: fireMelee,
              } : undefined}
            />
          )}
          {pendingFacing?.kind === 'move' && (
            <FacingPicker
              x={pendingFacing.x} y={pendingFacing.y}
              allowedFacings={pendingFacing.allowedFacings}
              rotationOffsetDeg={facingPickerRotationOffset}
              onPick={resolveFpvFacing}
              onDismiss={() => setPendingFacing(null)}
            />
          )}
          {pendingFacing?.kind === 'rotate' && (
            <FacingPicker
              x={window.innerWidth / 2} y={window.innerHeight / 2}
              rotationOffsetDeg={facingPickerRotationOffset}
              onPick={resolveFpvFacing}
              onDismiss={() => setPendingFacing(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}
