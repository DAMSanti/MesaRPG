import { useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { DroppedLimb } from '../droppedLimbs'
import { limbLocationOfMesh } from './Mech3D'
import { useProfiledFrame } from './PerfProbe'

/** A severed limb on its way to the ground, and then lying on it.
 *
 * Real user report: "el Jenner ha perdido la extremidad, pero esta no ha
 * colisionado con el suelo y se ha quedado ahi... tiene que quedarse ahi
 * permanentemente durante la partida."
 *
 * Animated by hand rather than dropped into the physics world, because
 * only TableView has a <Physics> provider — GM view and the cockpit have
 * none, and wreckage that exists in one view and not the others is worse
 * than wreckage that falls on a scripted arc. The arc is a real one: it
 * keeps whatever sideways momentum the limb had, accelerates downward, and
 * tumbles about an axis of its own until it lands.
 *
 * It lands once. Everything after the fall is a fixed pose computed from
 * the same seed, so a component remount — which happens on every session
 * poll — finds the limb exactly where it already was instead of dropping
 * it again. */

/** Downward acceleration, in world units per second squared. Not real
 * gravity: the board is at BattleTech scale (a hex is 30 units, a mech 10
 * tall) and a true 9.8 reads as slow motion against objects that size. */
const LIMB_GRAVITY = 62
/** How far a limb drifts away from the mech as it comes off — it is thrown
 * clear, not dropped straight down a shaft. */
const LIMB_THROW = 3.2

export function FallenLimb({ limb, groundY }: { limb: DroppedLimb; groundY: number }) {
  const ref = useRef<THREE.Group>(null)
  // Resolved from the model rather than carried in the record, which is
  // what lets a limb be something the server can store: the same few
  // numbers describe one that just fell and one restored from a previous
  // session. useGLTF is cached, and the mech this came off is already
  // loaded, so this costs nothing.
  const { scene } = useGLTF(limb.modelUrl)
  const piece = useMemo(() => {
    let found: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null
    scene.traverse((object) => {
      if (found) return
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || limbLocationOfMesh(mesh.name) !== limb.location) return
      found = {
        geometry: mesh.geometry,
        material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
      }
    })
    return found as { geometry: THREE.BufferGeometry; material: THREE.Material } | null
  }, [scene, limb.location])

  // Everything random about this limb, drawn once from its own stable seed.
  const rnd = (n: number) => {
    const s = Math.sin(limb.seed * 12.9898 + n * 78.233) * 43758.5453
    return s - Math.floor(s)
  }
  const throwAngle = rnd(1) * Math.PI * 2
  const throwSpeed = LIMB_THROW * (0.6 + rnd(2) * 0.8)
  const spinX = (rnd(3) - 0.5) * 7
  const spinZ = (rnd(4) - 0.5) * 7
  // Lying down: face-up or face-down, never standing on end.
  const restTiltX = (rnd(5) < 0.5 ? -1 : 1) * (Math.PI / 2) * (0.82 + rnd(6) * 0.3)
  const restYaw = limb.facing + (rnd(7) - 0.5) * 2.4

  // How long the fall takes, from the height it came off at.
  const fallHeight = Math.max(0.2, limb.dropY - groundY)
  const fallSeconds = Math.sqrt((2 * fallHeight) / LIMB_GRAVITY)

  useProfiledFrame('extremidades caidas', () => {
    const group = ref.current
    if (!group) return
    const elapsed = (performance.now() - limb.droppedAt) / 1000

    if (elapsed >= fallSeconds) {
      // At rest, and staying there. Written every frame rather than once
      // because this component may mount long after the limb landed and
      // there is no "landed" event to have missed.
      group.position.set(
        limb.x + Math.cos(throwAngle) * throwSpeed * fallSeconds,
        groundY,
        limb.z + Math.sin(throwAngle) * throwSpeed * fallSeconds,
      )
      group.rotation.set(restTiltX, restYaw, 0)
      return
    }

    const t = Math.max(0, elapsed)
    group.position.set(
      limb.x + Math.cos(throwAngle) * throwSpeed * t,
      Math.max(groundY, limb.dropY - 0.5 * LIMB_GRAVITY * t * t),
      limb.z + Math.sin(throwAngle) * throwSpeed * t,
    )
    // Tumbling, easing into the resting pose over the last of the fall so
    // it settles rather than snapping flat the instant it touches down.
    const settle = Math.min(1, (t / fallSeconds) ** 3)
    group.rotation.set(
      spinX * t * (1 - settle) + restTiltX * settle,
      limb.facing + (restYaw - limb.facing) * settle,
      spinZ * t * (1 - settle),
    )
  })

  // A model with no separate mesh for this limb has nothing to drop — the
  // mech simply loses it from its silhouette, which is what already
  // happens for every single-mesh chassis.
  if (!piece) return null
  return (
    <group ref={ref} position={[limb.x, limb.dropY, limb.z]} rotation={[0, limb.facing, 0]}>
      <mesh
        geometry={piece.geometry}
        material={piece.material}
        userData={{ perfGroup: 'mechs' }}
        castShadow
        receiveShadow
      />
    </group>
  )
}
