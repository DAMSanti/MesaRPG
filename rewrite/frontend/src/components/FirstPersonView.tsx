import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import { EffectComposer, Outline, Selection } from '@react-three/postprocessing'
import { KernelSize } from 'postprocessing'
import * as THREE from 'three'
import {
  ARRIVE_EPSILON, BIG_TURN_THRESHOLD, ELEVATION_STEP, GROUND_BASE_HEIGHT, HexMap, TURN_SPEED, WALK_SPEED, angleDelta,
  findAnnotatedLocalPoint, lerpAngle, rotateLocalOffsetByYaw, useAttackVfxQueue, useMechAnnotationsCache,
} from './HexMap'
import { jumpFlight, type JumpPhase } from '../jumpFlight'
import { MODEL_HEAD_FRACTION, MODEL_SCALE } from './Mech3D'
import { ARMOR_GEOMETRY, ARMOR_VIEWBOX, type MechLocationCode } from '../mechSheetGeometry'
import { FacingPicker } from './FacingPicker'
import {
  attack, getMap, getUnitVisibleEnemies, getUnitVisibleHexes, getWeaponCatalog, isPendingRollResult, markRoundActed,
  moveUnit, moveUnitWithMp, requestInitiative, requestMovement, submitMeleeAttack,
  type AttackResult, type Mech, type MapData, type MeleeAttackType, type MovementType, type ReachableHex,
  type RoundState, type Unit, type VisibleEnemy, type VisibleHex, type WeaponStats,
} from '../api'
import { activeMoverPilotId, currentPhase, useDisplayedPhase, useHeldActiveMover } from '../rounds'
import { HEX_SIZE, hexToWorld, mapCenter } from '../hexMath'
import type { FogWalkStep, MeleeResult, UnitWalked } from '../ws'
import './FirstPersonView.css'

// Derived from Mech3D's own scale/proportions rather than a hardcoded
// number, so bumping the model's size there doesn't quietly leave the
// cockpit camera sitting somewhere around its knees.
const EYE_HEIGHT = MODEL_SCALE * MODEL_HEAD_FRACTION
// MECH-factor scaled (tuned by eye against the cockpit/model, same family
// as HexMap.tsx's FOG_HEIGHT) — old 4 × MODEL_SCALE's own old value (1.65).
const LOOK_DISTANCE = 4 * (MODEL_SCALE / 1.65)
// Target silhouettes are ~56px wide at the fallback/near size — a bit
// more than that so two decluttered markers never touch.
const MARKER_MIN_SEPARATION = 64

// How far (world units) the camera bobs vertically while actively
// stepping, and how fast — small on purpose ("un pequeño bob", real user
// request), just enough to read as footsteps rather than a smooth
// glide. BOB_SMOOTH_RATE fades it in/out instead of snapping the instant
// isMoving flips, so a step that's mid-leg when the path queue empties
// doesn't cut the bob off abruptly.
// MECH-factor scaled, same family as LOOK_DISTANCE above — BOB_FREQUENCY/
// BOB_SMOOTH_RATE are rates (Hz / per-second), not spatial, so they stay.
const BOB_AMPLITUDE = 0.035 * (MODEL_SCALE / 1.65)
const BOB_FREQUENCY = 4
const BOB_SMOOTH_RATE = 8

/** The cockpit's own view of the world, non-orbiting but no longer a
 * fixed snapshot either — animated hex-by-hex along the SAME real path
 * (`path`, from walkPaths.get(unit.id), populated off the identical
 * unit_walked broadcast every other view already uses) instead of
 * jumping straight to wherever the server confirmed the move ended.
 * Reuses HexMap's own per-frame stepping math (WALK_SPEED/TURN_SPEED/
 * ARRIVE_EPSILON/lerpAngle) so this cockpit turns and steps at the exact
 * same pace everyone else watches this mech's body do it — real user
 * request: "el movimiento paso a paso [ya está en TableView y
 * GMView]... tambien en FPV... debemos ver como gira, y da pasos, añade
 * un pequeño bob a la cámara cuando anda, siguiendo el path calculado."
 *
 * Owns the cockpit floodlight too (rendered below) — it has to track
 * this exact same animated position every frame, not the final one, or
 * it visibly detaches from the camera mid-walk.
 *
 * Also closes a latent bug this same feature exposed: FirstPersonView
 * never renders a UnitMarker for the player's OWN unit (it's excluded
 * from sceneUnits — you don't see your own mech's body from inside it),
 * so nothing was ever calling useHeldActiveMover's onUnitWalkDone for a
 * self-initiated move — its "walking" hold stayed pinned to this pilot
 * forever after their very first move of the session, since nothing
 * ever cleared it. onWalkDone here is that missing call. */
function WalkingFirstPersonCam({
  q, r, facingDeg, path, movementType, eyeYAt, cockpitLocal, centerX, centerZ, lookYawDeg, onWalkDone, onWalkStep,
}: {
  q: number
  r: number
  facingDeg: number
  path?: { q: number; r: number }[]
  /** Real user request: real Despegar→Saltar→Aterrizar with the cockpit
   * camera genuinely rising and falling during the player's OWN jump —
   * this cockpit never renders its own body (see this component's own
   * top doc comment), so it can't get the arc "for free" from Mech3D the
   * way every OTHER visible unit's HexMap-rendered body does; it has to
   * run the exact same jumpFlight math itself. 'walk'/'run'/undefined
   * behave identically here (only jump changes the stepping shape). */
  movementType?: 'walk' | 'run' | 'jump'
  eyeYAt: (q: number, r: number) => number
  /** Real user request: "la posicion que selecciono de 'cabina' es donde
   * tiene que estar la camara en FPV" — MechLab's own saved cockpit
   * annotation (Mech3D's normalized local space, pre-MODEL_SCALE), or
   * null for a mech nobody's annotated yet (falls back to eyeYAt's own
   * generic head-height guess, exactly the old behavior). Rotated by
   * this cockpit's OWN live body yaw every frame (rotateLocalOffsetByYaw
   * below) rather than the static facingDeg, so it stays glued to the
   * mech's body through a turn instead of snapping at the end of one. */
  cockpitLocal: [number, number, number] | null
  centerX: number
  centerZ: number
  lookYawDeg: number
  onWalkDone?: () => void
  /** Fires when the camera ARRIVES at one waypoint of `path` (before
   * advancing to the next) — same real user request as HexMap's own
   * UnitMarker.onWalkStep, for this cockpit's own fog (cockpit_fog_
   * steps): "la niebla se tiene que ir disipando con cada movimiento...
   * tanto en TableView como en FPV". `index` is 0-based within `path`. */
  onWalkStep?: (index: number) => void
}) {
  const [rawX, rawZ] = hexToWorld(q, r)
  const target: [number, number] = [rawX - centerX, rawZ - centerZ]
  const baseY = eyeYAt(q, r)
  const facingRotationY = Math.PI / 2 - (facingDeg * Math.PI) / 180

  const animatedPos = useRef<[number, number]>(target)
  const animatedY = useRef<number>(baseY)
  const animatedRot = useRef<number>(facingRotationY)
  const [isMoving, setIsMoving] = useState(false)
  const pathQueueRef = useRef<{ x: number; z: number; y: number }[]>([])
  const lastPathRef = useRef<{ q: number; r: number }[] | undefined>(undefined)
  // Real user request: same real jump arc HexMap.tsx's UnitMarker gets —
  // see jumpFlightRef's own doc comment there for why this is a
  // completely separate stepping path from pathQueueRef above (a jump's
  // own path is always just the single landing hex, no real route).
  const jumpFlightRef = useRef<{ origin: [number, number, number]; destination: [number, number, number]; elapsed: number } | null>(null)
  const [jumpPhase, setJumpPhase] = useState<Exclude<JumpPhase, 'done'> | null>(null)
  const bobPhaseRef = useRef(0)
  const bobIntensityRef = useRef(0)
  const lightRef = useRef<THREE.PointLight>(null)

  // Same "replace the queue wholesale on a genuinely new path" pattern
  // HexMap's own UnitMarker uses — see its own doc comment. UNLIKE
  // UnitMarker's own version of this, centerX/centerZ have to be baked
  // in here: UnitMarker lives inside HexMap's outer <group position=
  // [-centerX, 0, -centerZ]>, so its own raw hexToWorld waypoints get
  // re-centered for free by that parent transform — this component
  // drives the THREE camera directly, with no such parent group, so a
  // waypoint left in raw world space (like `target` below correctly
  // avoids) sent the camera wandering off toward the map's uncentered
  // origin on every intermediate step before finally snapping onto the
  // correctly-centered final target (real user report: "se ha ido fuera
  // del mapa y despues ha vuelto a la localizacion a la que tenia que ir").
  // Same big-turn early fog-reveal fix as HexMap's own UnitMarker — see
  // its doc comment for the real user report this addresses (a mech
  // turning to reach a hex well behind it left cockpit_fog_steps stale
  // through the whole turn, popping only once the short slide finished).
  const firstStepFiredEarlyRef = useRef(false)
  useEffect(() => {
    if (path && path !== lastPathRef.current) {
      lastPathRef.current = path
      if (movementType === 'jump') {
        pathQueueRef.current = []
        const [ox, oz] = animatedPos.current
        const dest = path[path.length - 1]
        const [dx, dz] = hexToWorld(dest.q, dest.r)
        jumpFlightRef.current = {
          origin: [ox, animatedY.current, oz],
          destination: [dx - centerX, eyeYAt(dest.q, dest.r), dz - centerZ],
          elapsed: 0,
        }
        firstStepFiredEarlyRef.current = false
        return
      }
      jumpFlightRef.current = null
      pathQueueRef.current = path.map((p) => {
        const [x, z] = hexToWorld(p.q, p.r)
        return { x: x - centerX, z: z - centerZ, y: eyeYAt(p.q, p.r) }
      })
      firstStepFiredEarlyRef.current = false
      const first = pathQueueRef.current[0]
      if (first) {
        const [cx, cz] = animatedPos.current
        const dx = first.x - cx
        const dz = first.z - cz
        if (Math.hypot(dx, dz) > ARRIVE_EPSILON) {
          const heading = Math.atan2(dx, dz)
          if (Math.abs(angleDelta(animatedRot.current, heading)) > BIG_TURN_THRESHOLD) {
            onWalkStep?.(0)
            firstStepFiredEarlyRef.current = true
          }
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, movementType, eyeYAt, centerX, centerZ])

  useFrame((state, delta) => {
    const jump = jumpFlightRef.current
    if (jump) {
      jump.elapsed += delta
      const result = jumpFlight(jump.origin, jump.destination, jump.elapsed)
      const [px, py, pz] = result.position
      animatedPos.current = [px, pz]
      animatedY.current = py
      const [ox, , oz] = jump.origin
      const [dx2, , dz2] = jump.destination
      const heading = Math.hypot(dx2 - ox, dz2 - oz) > ARRIVE_EPSILON ? Math.atan2(dx2 - ox, dz2 - oz) : facingRotationY
      animatedRot.current = lerpAngle(animatedRot.current, heading, Math.min(1, TURN_SPEED * delta))
      if (result.phase === 'done') {
        jumpFlightRef.current = null
        setJumpPhase(null)
        onWalkStep?.(0)
        if (isMoving) { setIsMoving(false); onWalkDone?.() }
      } else if (jumpPhase !== result.phase) {
        setJumpPhase(result.phase)
        if (!isMoving) setIsMoving(true)
      }
    } else {
      const queue = pathQueueRef.current
      const immediateTarget = queue.length > 0 ? queue[0] : { x: target[0], z: target[1], y: baseY }
      const [cx, cz] = animatedPos.current
      const cy = animatedY.current
      const dx = immediateTarget.x - cx
      const dz = immediateTarget.z - cz
      const dist = Math.hypot(dx, dz)
      const headingTarget = dist > ARRIVE_EPSILON ? Math.atan2(dx, dz) : facingRotationY
      animatedRot.current = lerpAngle(animatedRot.current, headingTarget, Math.min(1, TURN_SPEED * delta))

      if (dist <= ARRIVE_EPSILON) {
        animatedPos.current = [immediateTarget.x, immediateTarget.z]
        animatedY.current = immediateTarget.y
        if (queue.length > 0) {
          // queue.length here is BEFORE the slice below — still counts
          // the waypoint just arrived at, same index math as HexMap's own
          // UnitMarker.onWalkStep. Index 0 may have already fired early
          // (see firstStepFiredEarlyRef above) — skip it here so its fog
          // step doesn't apply twice.
          if (path) {
            const idx = path.length - queue.length
            if (!(idx === 0 && firstStepFiredEarlyRef.current)) onWalkStep?.(idx)
          }
          pathQueueRef.current = queue.slice(1)
        } else if (isMoving) {
          setIsMoving(false)
          onWalkDone?.()
        }
      } else {
        const step = Math.min(1, (WALK_SPEED * delta) / dist)
        animatedPos.current = [cx + dx * step, cz + dz * step]
        animatedY.current = cy + (immediateTarget.y - cy) * step
        if (!isMoving) setIsMoving(true)
      }
    }

    // No footstep bob during a jump — the arc itself is the motion.
    bobIntensityRef.current = THREE.MathUtils.lerp(
      bobIntensityRef.current, isMoving && !jump ? 1 : 0, Math.min(1, BOB_SMOOTH_RATE * delta),
    )
    bobPhaseRef.current += delta * BOB_FREQUENCY
    const bobY = Math.sin(bobPhaseRef.current * Math.PI * 2) * BOB_AMPLITUDE * bobIntensityRef.current

    // lookYawDeg is SUBTRACTED, not added — same sign convention the old
    // static formula used (Math.PI/2 - (facing_deg + lookYawDeg)*π/180),
    // just with the walking-turn's own animatedRot standing in for the
    // static facing_deg term.
    const viewYaw = animatedRot.current - (lookYawDeg * Math.PI) / 180
    const forward: [number, number] = [Math.sin(viewYaw), Math.cos(viewYaw)]
    const [hexX, hexZ] = animatedPos.current
    // Real user request: "la posicion que selecciono de 'cabina' es donde
    // tiene que estar la camara en FPV" — rotated by this mech's own
    // CURRENT body yaw (animatedRot, not the static facingDeg) so the
    // cockpit point stays glued to the body through a mid-walk turn.
    // eyeYAt already returned bare ground level (no generic head-height
    // baked in) whenever cockpitLocal is set — see its own doc comment.
    const cockpitOffset = cockpitLocal ? rotateLocalOffsetByYaw(cockpitLocal, animatedRot.current) : null
    const ax = hexX + (cockpitOffset?.x ?? 0)
    const az = hexZ + (cockpitOffset?.z ?? 0)
    const ay = animatedY.current + (cockpitOffset?.y ?? 0) + bobY
    state.camera.position.set(ax, ay, az)
    state.camera.lookAt(ax + forward[0] * LOOK_DISTANCE, ay, az + forward[1] * LOOK_DISTANCE)
    lightRef.current?.position.set(ax, ay, az)
  })

  // A cockpit-mounted floodlight at the camera's own position — the sun
  // alone left mechs looking near-black at eye level, where the fixed
  // overhead light from TableView/GMView barely reaches. Distance-
  // limited so it lights what's actually in view without washing out
  // the whole scene.
  return <pointLight ref={lightRef} intensity={12} distance={14} decay={1.5} />
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
      // instead of MODEL_CHEST_FRACTION. The trailing clearance term is
      // MECH-factor scaled (same family as LOOK_DISTANCE above) so it
      // stays visually proportionate to the now-much-taller head height.
      const y = GROUND_BASE_HEIGHT + elevationAt(enemy.q, enemy.r) * ELEVATION_STEP
        + MODEL_SCALE * MODEL_HEAD_FRACTION + 0.3 * (MODEL_SCALE / 1.65)
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

// All five are real, tracked phases now (see turns.py's movement_order/
// moved_pilot_ids/ranged_target_pilot_ids/melee_target_pilot_ids/
// heat_resolved) — Heat highlights via activePhases below same as the
// rest, driven by the held displayedPhase so it's actually visible for a
// beat instead of resolving invisibly within the same round-trip.
type Phase = 'iniciativa' | 'movimiento' | 'distancia' | 'melee' | 'heat'
const PHASES: { key: Phase; label: string }[] = [
  { key: 'iniciativa', label: 'Iniciativa' },
  { key: 'movimiento', label: 'Movimiento' },
  { key: 'distancia', label: 'Distancia' },
  { key: 'melee', label: 'Melee' },
  { key: 'heat', label: 'Heat' },
]

export function FirstPersonView({
  unit, mech, units, mechs, roundState, visibility, lastAttack, lastMelee, unitWalked, onClose,
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
  /** Fase B: same wait-for-the-real-result need as lastAttack above, for
   * this cockpit's own melee (punch/kick) flow — see fireMelee's own
   * waitForNextMeleeResult. */
  lastMelee?: MeleeResult | null
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
  const [visibleHexes, setVisibleHexes] = useState<VisibleHex[]>([])
  // Real user request: "la niebla se tiene que ir disipando con cada
  // movimiento... tanto en TableView como en FPV" — the getUnitVisible
  // Hexes fetch below still fires on every visibility_update broadcast
  // and resolves almost immediately, well before a multi-hex walk's own
  // animation actually finishes; without this it would apply the TRUE
  // final cockpit fog first, then visibly regress back to earlier/
  // incomplete cockpit_fog_steps for the rest of the walk. Set true the
  // moment a walk with real cockpit_fog_steps starts (below), cleared
  // once onCockpitWalkStep applies that walk's own LAST step — same
  // reasoning/pattern as TableView's own walkingFogUnitIdsRef.
  const walkingCockpitFogRef = useRef(false)
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
  // to ±LOOK_YAW_LIMIT_DEG so the total sweep (yaw range + the camera's
  // own FOV at each extreme) is exactly 180°, matching the server's own
  // vision arc (units.py's _VISION_ARC_DEG — this cockpit was showing
  // strictly less than what the mech can actually detect per the rules,
  // since it only ever rendered dead ahead). Reset whenever the base
  // facing actually changes (the unit turned/moved) — an old look offset
  // relative to a new facing read as disorienting rather than useful.
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
    Promise.all([
      getMap(unit.map_id), getUnitVisibleEnemies(unit.id), getWeaponCatalog(),
    ]).then(([m, e, w]) => {
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

  // This cockpit's own fog of war data — kept as its own fetch (not
  // folded into the Promise.all above) so a failure here can't leave
  // map/enemies/weaponCatalog stuck stale too, and so it's independently
  // retriable/debuggable (real user report: FPV was fogging every tile
  // rather than just the handful outside this unit's own facing-cone
  // LoS — see cockpitVisibleHexes below).
  useEffect(() => {
    if (walkingCockpitFogRef.current) return
    let cancelled = false
    getUnitVisibleHexes(unit.id).then((h) => {
      if (!cancelled) setVisibleHexes(h)
    }).catch(() => {})
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
  const { activeAttack: activeAttackVfx, onAttackEffectDone, waitForDrain: waitForAttackVfxDrain } = useAttackVfxQueue(lastAttack, units, mechs ?? [])

  // Red screen-edge flash on a successful incoming hit (real user
  // request) — a monotonic counter, not a boolean, so two hits landing
  // within the same animation window each still get their own flash: a
  // boolean toggled back to the same "on" value the CSS animation is
  // already mid-run for wouldn't restart it, but remounting the overlay
  // under a fresh `key` (below) always does.
  const [hitFlashId, setHitFlashId] = useState(0)
  // Real user report: reopening FPV replayed the LAST hit's red flash —
  // lastAttack is a parent-held prop that keeps whatever the most recent
  // attack was, and this effect's dependency array still fires once on a
  // fresh mount regardless of whether that value actually just changed.
  // seenAttackRef pins down whatever lastAttack already was the moment
  // THIS mount happened, so that first run is "already known," not new —
  // same fix as useAttackVfxQueue's own seenRef.
  const seenAttackRef = useRef(lastAttack)
  useEffect(() => {
    if (lastAttack === seenAttackRef.current) return
    seenAttackRef.current = lastAttack
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
  // Held phase (rounds.ts's useDisplayedPhase) — display-only, for the
  // phase pill row and steam below, NEVER for gating real interactivity
  // (canAttack/isMyMoveTurn/the melee HUD switch above all correctly
  // keep using the raw `phase` — an artificially delayed gate would make
  // real actions lag behind what the round state already allows). Real
  // user report: an empty melee/heat phase used to resolve within the
  // same WS round-trip as whatever ended the phase before it, so this
  // pill row jumped straight past them, reading as "skipped" even though
  // they were genuinely considered.
  const displayedPhase = useDisplayedPhase(roundState)
  // Unlike activePhases below (the phase pill row, deliberately global —
  // see its own comment), this one IS specifically "is it my own turn" —
  // an "¡INICIATIVA YA!"/"¡TU TURNO!" banner that fires for everyone in
  // the phase would be noise; the point is telling THIS pilot they're
  // the one being waited on.
  const heldMover = useHeldActiveMover(roundState ? activeMoverPilotId(roundState) : null)
  const isMyMoveTurn = unit.pilot_id != null && heldMover.displayedMoverPilotId === unit.pilot_id
  const activePhases: Set<Phase> =
    displayedPhase === 'movement'
      ? new Set(['movimiento'])
      : displayedPhase === 'initiative'
        ? new Set(['iniciativa'])
        : displayedPhase === 'ranged'
          ? new Set(['distancia'])
          : displayedPhase === 'melee'
            ? new Set(['melee'])
            : displayedPhase === 'heat'
              ? new Set(['heat'])
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
  // Real user request: proper Walk/Run/Jump animation chains for every
  // OTHER visible unit on this cockpit's own <HexMap> — same population
  // pattern as walkPaths above. This cockpit's OWN unit never renders
  // through HexMap (see this component's own doc comment), so this Map
  // is purely for allies/enemies; the player's own jump arc is handled
  // separately below (WalkingFirstPersonCam's own jumpPhase/jumpFlight).
  const [walkMovementTypes, setWalkMovementTypes] = useState<Map<number, 'walk' | 'run' | 'jump'>>(new Map())
  // This cockpit's own per-waypoint fog for its OWN walk — real user
  // request: "la niebla se tiene que ir disipando con cada movimiento...
  // tanto en TableView como en FPV". Only ever relevant for `unit.id`
  // itself (cockpit_fog_steps is only ever sent for a player-faction
  // walker, and this cockpit's own controlled unit is always one), so a
  // flat array is enough — no need for TableView's per-unit Map.
  const [cockpitFogSteps, setCockpitFogSteps] = useState<FogWalkStep[] | null>(null)
  // Real user report: reopening FPV sometimes replayed the LAST unit's
  // walk (this cockpit's own, or a visible ally/enemy's) — unitWalked is
  // a parent-held prop that keeps whatever the most recent walk event
  // WAS, and this effect's dependency array still fires once on a fresh
  // mount regardless of whether that value actually just changed. Same
  // seenRef fix as useAttackVfxQueue's/hitFlashId's own.
  const seenWalkRef = useRef(unitWalked)
  useEffect(() => {
    if (unitWalked === seenWalkRef.current) return
    seenWalkRef.current = unitWalked
    if (!unitWalked || unitWalked.path.length === 0) return
    setWalkPaths((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.path))
    setWalkMovementTypes((prev) => new Map(prev).set(unitWalked.unit_id, unitWalked.movement_type))
    if (unitWalked.unit_id === unit.id) {
      const steps = unitWalked.cockpit_fog_steps ?? null
      setCockpitFogSteps(steps)
      if (steps && steps.length > 0) walkingCockpitFogRef.current = true
    }
    const walkedUnit = units.find((u) => u.id === unitWalked.unit_id)
    heldMover.onUnitWalkStart(unitWalked.unit_id, walkedUnit?.pilot_id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitWalked])

  const onCockpitWalkStep = (index: number) => {
    const step = cockpitFogSteps?.[index]
    if (step) setVisibleHexes(step.visible_hexes)
    // The last waypoint's own step IS the true final answer — safe to
    // let the ordinary getUnitVisibleHexes fetch resume on the next
    // visibility_update.
    if (cockpitFogSteps && index === cockpitFogSteps.length - 1) walkingCockpitFogRef.current = false
  }

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

  // Fase B: same "wait for the real attack_result before firing the next
  // shot / marking acted" gap as GMView's own submitWeaponVolley — see
  // its doc comment. A pilot with dice_mode='physical' makes attack()
  // return {pending: true, ...} instead of a finished result; TableView
  // is what actually throws the dice, so this cockpit only learns "done"
  // via its own lastAttack prop eventually updating.
  const pendingAttackResolversRef = useRef<(() => void)[]>([])
  useEffect(() => {
    if (!lastAttack) return
    pendingAttackResolversRef.current.forEach((resolve) => resolve())
    pendingAttackResolversRef.current = []
  }, [lastAttack])
  const waitForNextAttackResult = () =>
    new Promise<void>((resolve) => {
      pendingAttackResolversRef.current.push(resolve)
    })

  // Sequential /attack calls, one per toggled weapon, same volley
  // pattern as GMView/PlayerView's own submitWeaponVolley — mirrored
  // here instead of shared because this one drives HUD-styled JSX below
  // rather than the desktop WeaponVolleyPanel component.
  const fireVolley = async (weaponIds: number[]) => {
    if (selectedTargetId == null) return
    setFiringVolley(true)
    for (const weaponId of weaponIds) {
      try {
        const outcome = await attack(unit.campaign_id, {
          attacker_unit_id: unit.id,
          target_unit_id: selectedTargetId,
          weapon_id: weaponId,
        })
        if (isPendingRollResult(outcome)) await waitForNextAttackResult()
      } catch {
        // A rejected weapon (out of range/no ammo/no LOS) just doesn't
        // fire — the rest of the volley still goes out. No in-cockpit
        // log to write it to (unlike GMView/PlayerView's pushLog), so
        // this is silently skipped from here; the shot's absence in the
        // attack_result broadcast is the only record.
      }
    }
    // Same "wait for the VFX queue to actually finish playing, not just
    // for the last result to land" reasoning as GMView's own
    // submitWeaponVolley — see useAttackVfxQueue's waitForDrain doc
    // comment.
    await waitForAttackVfxDrain()
    if (unit.pilot_id != null) await markRoundActed(unit.campaign_id, unit.pilot_id).catch(() => {})
    setFiringVolley(false)
    setSelectedTargetId(null)
  }

  // Fase B: same wait-for-the-real-result need as fireVolley's own
  // waitForNextAttackResult, watching lastMelee instead.
  const pendingMeleeResolversRef = useRef<(() => void)[]>([])
  useEffect(() => {
    if (!lastMelee) return
    pendingMeleeResolversRef.current.forEach((resolve) => resolve())
    pendingMeleeResolversRef.current = []
  }, [lastMelee])
  const waitForNextMeleeResult = () =>
    new Promise<void>((resolve) => {
      pendingMeleeResolversRef.current.push(resolve)
    })

  // Melee phase's single-attack equivalent of fireVolley above.
  const fireMelee = async (attackType: MeleeAttackType, arm?: 'left' | 'right') => {
    if (selectedTargetId == null) return
    setFiringVolley(true)
    try {
      const outcome = await submitMeleeAttack(unit.id, selectedTargetId, attackType, arm)
      if (isPendingRollResult(outcome)) await waitForNextMeleeResult()
    } catch {
      // rejected (not adjacent/incapacitated/movement doesn't qualify) —
      // same silent-skip stance as fireVolley above.
    }
    if (unit.pilot_id != null) await markRoundActed(unit.campaign_id, unit.pilot_id).catch(() => {})
    setFiringVolley(false)
    setSelectedTargetId(null)
  }

  // centerX/centerZ (the map's own world-space origin offset) stay
  // static for as long as this map does — no per-frame cost in
  // recomputing them, but no need either. eyeYAt mirrors HexMap's own
  // elevation→eye-height math, now as a function of q/r instead of a
  // single computed value, so WalkingFirstPersonCam below can look up
  // each waypoint's own eye height while walking a real (possibly multi-
  // elevation) path.
  const [centerX, centerZ] = useMemo(() => (map ? mapCenter(map.tiles) : [0, 0]), [map])
  // Real user request: "la posicion que selecciono de 'cabina' es donde
  // tiene que estar la camara en FPV" — MechLab's own saved cockpit point
  // for this unit's exact model, or null for a mech nobody's annotated
  // yet. WalkingFirstPersonCam rotates it by the mech's own live body yaw
  // every frame and adds it on top of eyeYAt's now-bare ground level.
  const mechAnnotations = useMechAnnotationsCache()
  const cockpitLocal = useMemo(
    () => findAnnotatedLocalPoint(mechAnnotations, unit, 'cockpit', null),
    // unit's own chassis/model, not the whole (frequently-changing, e.g.
    // every q/r move) object reference — recomputing on every unit
    // update would be harmless but pointless, this only ever changes
    // when the mech itself does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mechAnnotations, unit.mech_chassis, unit.mech_model],
  )
  const eyeYAt = (q: number, r: number) => {
    const elevation = map?.tiles.find((t) => t.q === q && t.r === r)?.elevation ?? 0
    const ground = GROUND_BASE_HEIGHT + elevation * ELEVATION_STEP
    // Only the annotated cockpit case gets bare ground here — its own
    // rotated Y offset supplies the real eye height instead (see
    // WalkingFirstPersonCam's useFrame). An unannotated mech keeps the
    // exact old fixed-head-height formula, unchanged.
    return cockpitLocal ? ground : ground + EYE_HEIGHT
  }

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
    if (sceneSettled || !map) return
    if (assetsLoading) return
    if (!assetsStartedRef.current) {
      const t = setTimeout(() => setSceneSettled(true), LOAD_GRACE_MS)
      return () => clearTimeout(t)
    }
    setSceneSettled(true)
  }, [map, assetsLoading, sceneSettled])

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

  // Real user report: dragging all the way to a ±90° yaw limit let the
  // player see well past the server's 180° total vision arc (units.py's
  // _VISION_ARC_DEG) — the limit only accounted for where the camera
  // POINTS, not how WIDE it sees. At max yaw the camera's own field of
  // view still extends CAMERA_FOV_DEG/2 further out on top of that, so
  // the yaw limit has to leave room for half the FOV on each side:
  // total visible = 2*limit + fov ⇒ limit = (180 - fov) / 2.
  const CAMERA_FOV_DEG = 70
  const LOOK_YAW_LIMIT_DEG = 90 - CAMERA_FOV_DEG / 2
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
  // Real user report: steam was showing on ANY hot mech in every phase —
  // the actual request was only DURING the Heat phase ("los mechs EN
  // ESTA FASE desprenderán vapor"), on every mech carrying real heat.
  const heatByUnitId = displayedPhase === 'heat'
    ? new Map(
        sceneUnits.filter((u) => u.mech_id != null).map((u) => [u.id, mechs?.find((m) => m.id === u.mech_id)?.heat_current ?? 0]),
      )
    : new Map<number, number>()
  const proneUnitIds = new Set(sceneUnits.filter((u) => mechs?.find((m) => m.id === u.mech_id)?.is_prone).map((u) => u.id))
  const shutdownUnitIds = new Set(sceneUnits.filter((u) => mechs?.find((m) => m.id === u.mech_id)?.is_shutdown).map((u) => u.id))
  const destroyedReasonByUnitId = new Map(
    sceneUnits
      .map((u) => [u.id, mechs?.find((m) => m.id === u.mech_id)?.destroyed_reason ?? null] as const)
      .filter((entry): entry is [number, 'structural' | 'pilot_killed'] => entry[1] != null),
  )
  // This cockpit's own fog of war (real user request: "esa niebla en el
  // FPV pero ahí solo mostrará lo que ve el personaje") — deliberately
  // NOT the team-wide union TableView uses, just this one unit's own
  // facing-cone LoS (visibleHexes, from getUnitVisibleHexes).
  const cockpitVisibleHexes = new Set(visibleHexes.map((h) => `${h.q},${h.r}`))

  return (
    <div className="first-person-view">
      {!booted && (
        <div className={`fp-boot${poweringOn ? ' poweron' : ''}`}>
          <div className="fp-static" />
        </div>
      )}
      {map && (
        // Mounted (invisible) the moment map is ready rather than only
        // once `booted` — the whole point is that its GLTF/
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
            <Canvas shadows camera={{ fov: CAMERA_FOV_DEG }}>
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
                  shadow-camera-left={-30 * HEX_SIZE} shadow-camera-right={30 * HEX_SIZE}
                  shadow-camera-top={30 * HEX_SIZE} shadow-camera-bottom={-30 * HEX_SIZE}
                  shadow-camera-far={60 * HEX_SIZE}
                />
                <WalkingFirstPersonCam
                  q={unit.q} r={unit.r} facingDeg={unit.facing_deg}
                  path={walkPaths.get(unit.id)} movementType={walkMovementTypes.get(unit.id)}
                  eyeYAt={eyeYAt} cockpitLocal={cockpitLocal}
                  centerX={centerX} centerZ={centerZ} lookYawDeg={lookYawDeg}
                  onWalkDone={() => {
                    // Safety net for onCockpitWalkStep's own last-index
                    // clear — a walk that never actually reaches its
                    // last waypoint (interrupted mid-flight for any
                    // reason) would otherwise leave the cockpit's fog
                    // stuck frozen forever.
                    walkingCockpitFogRef.current = false
                    heldMover.onUnitWalkDone(unit.id)
                  }}
                  onWalkStep={onCockpitWalkStep}
                />
                <Suspense fallback={null}>
                  <HexMap
                    map={map}
                    units={sceneUnits}
                    activeAttack={activeAttackVfx}
                    onAttackEffectDone={onAttackEffectDone}
                    onUnitWalkDone={heldMover.onUnitWalkDone}
                    moveHighlightHexes={movementHighlight ? new Set(movementHighlight.hexes.keys()) : undefined}
                    pathPreviewHexes={
                      pendingFacing?.kind === 'move' && pendingFacing.path
                        ? new Set(pendingFacing.path.map((p) => `${p.q},${p.r}`))
                        : undefined
                    }
                    onTileClick={onFpvTileClick}
                    onUnitClick={onFpvUnitClick}
                    walkPaths={walkPaths}
                    walkMovementTypes={walkMovementTypes}
                    outlineUnitIds={visibleEnemyUnitIds}
                    heatByUnitId={heatByUnitId}
                    proneUnitIds={proneUnitIds}
                    shutdownUnitIds={shutdownUnitIds}
                    destroyedReasonByUnitId={destroyedReasonByUnitId}
                    teamVisibleHexes={cockpitVisibleHexes}
                    fogSubtle
                  />
                </Suspense>
                <EnemyMarkersController
                  enemies={enemies}
                  centerX={centerX}
                  centerZ={centerZ}
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
