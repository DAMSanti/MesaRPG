import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import { resolveDieStyle, type DieMarkingKind } from '../dieStyles'

// Pip layout per face value, on a 3x3 grid (-1, 0, 1 in each axis).
const PIP_LAYOUTS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
}

function createFaceTexture(pips: number, faceColor: string, marking: DieMarkingKind = 'pips'): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = faceColor
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = '#c3ccc6'
  ctx.lineWidth = 6
  ctx.strokeRect(3, 3, size - 6, size - 6)

  ctx.fillStyle = '#1c2422'
  if (marking === 'numbers') {
    // A numbered die style (real user request: "con numeros") — same
    // face-background/border as the pip style, just the big numeral
    // drawn centered instead of the dot pattern below.
    ctx.font = `bold ${size * 0.56}px 'Cascadia Mono', Consolas, ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(pips), size / 2, size / 2 + size * 0.02)
  } else {
    const radius = size * 0.09
    const step = size * 0.27
    const center = size / 2
    for (const [gx, gy] of PIP_LAYOUTS[pips]) {
      ctx.beginPath()
      ctx.arc(center + gx * step, center + gy * step, radius, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// BoxGeometry material order is [+x, -x, +y, -y, +z, -z].
// Opposite faces of a real d6 sum to 7: this ordering keeps that true.
const FACE_PIPS = [1, 6, 2, 5, 3, 4]

// Local (pre-rotation) outward normal of the face carrying each pip
// value — matches FACE_PIPS/BoxGeometry's own [+x,-x,+y,-y,+z,-z] order.
// Used to read back which face physics actually landed face-up (see
// valueFromRotation below) — the die is the real source of the result
// now, not the other way around ("vamos a hacer que los dados sean el
// valor real").
const FACE_LOCAL_NORMALS: [number, THREE.Vector3][] = [
  [1, new THREE.Vector3(1, 0, 0)],
  [6, new THREE.Vector3(-1, 0, 0)],
  [2, new THREE.Vector3(0, 1, 0)],
  [5, new THREE.Vector3(0, -1, 0)],
  [3, new THREE.Vector3(0, 0, 1)],
  [4, new THREE.Vector3(0, 0, -1)],
]

const WORLD_UP = new THREE.Vector3(0, 1, 0)

/** Given the die's actual resting rotation, finds which face is
 * pointing up — whichever local face normal, once rotated, is closest
 * to world-up. */
function valueFromRotation(quat: THREE.Quaternion): number {
  let best = 1
  let bestDot = -Infinity
  for (const [value, normal] of FACE_LOCAL_NORMALS) {
    const dot = normal.clone().applyQuaternion(quat).dot(WORLD_UP)
    if (dot > bestDot) {
      bestDot = dot
      best = value
    }
  }
  return best
}

interface DieProps {
  /** Changing this key is what triggers a fresh roll (see TableView). */
  rollId: number
  spawn: [number, number, number]
  /** Face background color — defaults to the plain white/grey TableView
   * has always used. The manual initiative-roll flow (GMView/PlayerView)
   * passes each pilot's own color instead. Pips stay dark regardless;
   * every color in src/pilotColors.ts's palette is light enough to keep
   * them readable. Ignored once `style` is set — a picked style's own
   * fixed color wins. */
  color?: string
  /** A DIE_STYLES id (see ../dieStyles.ts) — real user request: every
   * player/GM can pick a distinct look (material + pip-vs-number
   * marking), exclusive across the table. Coexists with `color` rather
   * than replacing it: unset (null/undefined) keeps today's exact
   * legacy look (plain box, pips, `color`), so a pilot who never
   * touches this feature sees zero change. */
  style?: string | null
  /** Initial linear velocity, e.g. a real toss thrown in from off the
   * board instead of a straight drop from above — see TableView's
   * InitiativeDice. Defaults to a small random pop-and-tumble in place
   * (the original generic-dice-tray behavior). */
  throwVelocity?: [number, number, number]
  /** Fires once, the first time this die's physics body actually comes
   * to rest, with whichever face real physics landed face-up. This is
   * the real result now; nothing corrects it afterward. */
  onSettled?: (value: number) => void
  /** Set true to start shrinking/fading the die out — see TableView's
   * InitiativeDice, which flips this 5s after both dice have settled.
   * Purely visual, driven every frame from the outside rather than an
   * internal timer, so multiple dice vanish in lockstep. */
  vanishing?: boolean
  /** Fires once the vanish animation finishes (scale/opacity reach 0) —
   * the caller's cue to actually unmount this Die. */
  onVanished?: () => void
}

// How long the shrink-and-fade takes once `vanishing` flips true.
const VANISH_DURATION_MS = 550

// @react-three/rapier's RigidBody has no onSleep/onWake callback prop in
// this version — the underlying rapier body does expose isSleeping(),
// so this polls it every frame instead. Rapier only actually puts a
// body to sleep once its velocity stays under a threshold for several
// consecutive frames — resting on hex terrain (angled tile edges,
// height steps between neighboring tiles) can leave a die gently
// rocking indefinitely and never technically qualify, so there's also a
// flat timeout backstop: read whatever face is up and settle anyway if
// real sleep hasn't happened by then, so a roll can never hang forever
// waiting for perfect physical stillness.
const SETTLE_TIMEOUT_MS = 3500

export function Die({ spawn, color = '#eef1ef', style, throwVelocity, onSettled, vanishing, onVanished }: DieProps) {
  const bodyRef = useRef<RapierRigidBody>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const settledRef = useRef(false)
  const mountTimeRef = useRef(Date.now())
  const vanishStartRef = useRef<number | null>(null)
  const vanishedRef = useRef(false)
  // Real user report: a settled die would still sometimes visibly
  // "teleport" to a fixed spot mid-table, even after locking its
  // translation/rotation directly on the rapier body (settleNow below) —
  // a locked DYNAMIC body can still apparently get relocated by contact
  // resolution against a KINEMATIC one (HexMap's UnitMarker re-asserts
  // its own position via setNextKinematicTranslation every single frame,
  // moving or not — see its own doc comment). Switching the body's TYPE
  // to "fixed" once it settles is the actual bulletproof guarantee — a
  // fixed body is immovable by the solver, period, not just "locked".
  // Driven through this state (not an imperative rapier call) so
  // @react-three/rapier's own reactive `type` prop handling — confirmed
  // in its source to call the real setBodyType on change — does the work,
  // rather than fighting the wrapper's own prop-driven state tracking.
  const [settled, setSettled] = useState(false)

  // MeshPhysicalMaterial rather than MeshStandardMaterial — a strict
  // superset (same roughness/metalness/map), so the no-style path (both
  // iridescence/sheen left at 0) renders pixel-identical to before,
  // while a 'metallic'/'pearl' style can lean on the extra properties
  // with no second material-construction code path to maintain.
  const materials = useMemo(() => {
    const look = resolveDieStyle(style, color)
    return FACE_PIPS.map(
      (pips) =>
        new THREE.MeshPhysicalMaterial({
          map: createFaceTexture(pips, look.color, look.marking),
          roughness: look.roughness,
          metalness: look.metalness,
          iridescence: look.iridescence ?? 0,
          iridescenceIOR: look.iridescence ? 1.3 : 1,
          sheen: look.sheen ?? 0,
          sheenColor: look.sheenColorHex ? new THREE.Color(look.sheenColorHex) : undefined,
          transparent: true,
        }),
    )
  }, [style, color])

  const settleNow = () => {
    if (settledRef.current) return
    settledRef.current = true
    const body = bodyRef.current
    if (!body) return
    setSettled(true)
    if (!onSettled) return
    const r = body.rotation()
    onSettled(valueFromRotation(new THREE.Quaternion(r.x, r.y, r.z, r.w)))
  }

  // Polls isSleeping() every frame rather than relying on an event (this
  // version of @react-three/rapier's RigidBody has no onSleep/onWake
  // callback prop). The elapsed-time fallback lives in the same poll
  // (not a separate setTimeout) so it can't be silently cancelled by an
  // unrelated remount clearing a timer early.
  useFrame(() => {
    if (!settledRef.current && onSettled) {
      const asleep = bodyRef.current?.isSleeping()
      const elapsed = Date.now() - mountTimeRef.current
      if (asleep || elapsed > SETTLE_TIMEOUT_MS) settleNow()
    }

    if (!vanishing || vanishedRef.current) return
    if (vanishStartRef.current == null) {
      vanishStartRef.current = Date.now()
    }
    const t = Math.min(1, (Date.now() - vanishStartRef.current) / VANISH_DURATION_MS)
    const scale = 1 - t
    meshRef.current?.scale.setScalar(scale)
    for (const m of materials) m.opacity = scale
    if (t >= 1) {
      vanishedRef.current = true
      onVanished?.()
    }
  })

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    if (throwVelocity) {
      // A real toss: set velocity directly (not an impulse) so it flies
      // in at a consistent, controllable speed regardless of the die's
      // mass, plus spin so it visibly tumbles as it crosses the board.
      body.setLinvel({ x: throwVelocity[0], y: throwVelocity[1], z: throwVelocity[2] }, true)
      body.setAngvel(
        { x: (Math.random() - 0.5) * 18, y: (Math.random() - 0.5) * 18, z: (Math.random() - 0.5) * 18 },
        true,
      )
    } else {
      // Random-ish pop-and-tumble in place — the original generic dice
      // tray behavior, cosmetic only.
      body.applyImpulse(
        { x: (Math.random() - 0.5) * 3, y: 1.5, z: (Math.random() - 0.5) * 3 },
        true,
      )
      body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 4,
          y: (Math.random() - 0.5) * 4,
          z: (Math.random() - 0.5) * 4,
        },
        true,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <RigidBody
      ref={bodyRef}
      position={spawn}
      type={settled ? 'fixed' : undefined}
      colliders="cuboid"
      restitution={0.3}
      friction={0.6}
    >
      <mesh ref={meshRef} castShadow material={materials}>
        <boxGeometry args={[0.9, 0.9, 0.9]} />
      </mesh>
    </RigidBody>
  )
}
