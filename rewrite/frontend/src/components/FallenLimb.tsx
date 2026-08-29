import { useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { DroppedLimb } from '../droppedLimbs'
import { limbLocationOfMesh, MODEL_SCALE } from './Mech3D'
import { limbLocationLookup, useMechAnnotationsCache } from '../mechAnnotations'
import { buildBakedPiece, recenterBakedPiece } from '../bakedPiece'
import { getGlowTexture } from './AttackEffects'
import { useProfiledFrame } from './PerfProbe'

/** A severed limb on its way to the ground, and then lying on it.
 *
 * Real user report: "el Jenner ha perdido la extremidad, pero esta no ha
 * colisionado con el suelo y se ha quedado ahi... tiene que quedarse ahi
 * permanentemente durante la partida", then, once it was falling but
 * nothing was visible: "las extremidades directamente desaparecen... debe
 * ser como en el mechlab, los brazos cayendo por gravedad hasta que
 * colisionan con el suelo y las piernas con una pequena explosion que las
 * haga caer."
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

/** Legs get thrown harder and spun faster than arms.
 *
 * Real user request: "las piernas con una pequena explosion que las haga
 * caer." MechLab reached the same conclusion first and solved it the same
 * way (applyLegTipSpin — an angular kick plus a small hop), for a reason
 * that survives the move to a scripted arc: a leg is long, roughly
 * symmetrical and lands on its end, so without a real kick it reads as
 * standing there rather than as having been blown off. The blast that took
 * it off is what puts it on the ground. */
const LEG_THROW_BOOST = 1.9
const LEG_SPIN_BOOST = 2.4
/** How long the puff at the joint lasts. Deliberately short and purely
 * cosmetic: it marks where the leg tore off, it is not a weapon effect and
 * it damages nothing. */
const LEG_BLAST_MS = 320

export function FallenLimb({
  limb, groundY, mechScale = 1,
}: {
  limb: DroppedLimb
  groundY: number
  /** The view's own boardgame-token multiplier (HexMap's BOARDGAME_MECH_
   * SCALE, 1 at real scale). Only ever needed for a limb restored from the
   * server: a limb that was watched falling already carries the exact
   * on-screen scale it was drawn at, boardgame multiplier and all. */
  mechScale?: number
}) {
  const ref = useRef<THREE.Group>(null)
  const blastRef = useRef<THREE.Mesh>(null)
  // Resolved from the model rather than carried in the record, which is
  // what lets a limb be something the server can store: the same few
  // numbers describe one that just fell and one restored from a previous
  // session. useGLTF is cached, and the mech this came off is already
  // loaded, so this costs nothing.
  const { scene } = useGLTF(limb.modelUrl)
  // Resolved the same way Mech3D resolves what to HIDE, so the piece that
  // falls is the piece that disappeared — see limbLocationLookup.
  const annotations = useMechAnnotationsCache()
  const limbLookup = useMemo(
    () => limbLocationLookup(annotations, limb.modelUrl),
    [annotations, limb.modelUrl],
  )

  // Two ways in, one shape out. A limb somebody watched come off arrives
  // already baked, in the pose and at the scale it was really being drawn
  // at — Mech3D bakes it in the one frame that information exists. A limb
  // restored from the server has none of that, so it is baked here from
  // the model's own rest pose instead: a piece lying still on the ground
  // does not need the exact pose it was severed in, and this is the only
  // way to rebuild one from the handful of numbers the server keeps.
  const piece = useMemo(() => {
    if (limb.piece) return limb.piece
    let found: {
      geometry: THREE.BufferGeometry; material: THREE.Material; scale: number
      quaternion: THREE.Quaternion
    } | null = null
    scene.traverse((object) => {
      if (found) return
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const location = limbLookup.get(mesh.name.trim().toLowerCase())
        ?? limbLocationOfMesh(mesh.name)
      if (location !== limb.location) return
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      mesh.updateWorldMatrix(true, false)
      const skinned = mesh as THREE.SkinnedMesh
      const baked = skinned.isSkinnedMesh
        ? buildBakedPiece(skinned, skinned.geometry)
        : recenterBakedPiece(mesh.geometry.clone(), mesh.matrixWorld)
      found = {
        geometry: baked.geometry,
        material: source.clone(),
        // `baked.scale` is this node's own scale INSIDE the raw model (the
        // Jenner's armature carries a 0.5 of its own, so this is not 1),
        // and the board then draws the whole model at MODEL_SCALE times the
        // view's boardgame multiplier. Measured off the real matrix rather
        // than re-derived from the model's height: normalizeMechInstance
        // computes a normalization that <primitive scale={MODEL_SCALE}>
        // then overwrites, so the height-based formula describes what the
        // pipeline INTENDS and not what it does.
        scale: baked.scale * MODEL_SCALE * mechScale,
        quaternion: baked.worldQuaternion,
      }
    })
    return found as {
      geometry: THREE.BufferGeometry; material: THREE.Material; scale: number
      quaternion: THREE.Quaternion
    } | null
  }, [limb.piece, scene, limb.location, limbLookup, mechScale])

  // Everything random about this limb, drawn once from its own stable seed.
  const rnd = (n: number) => {
    const s = Math.sin(limb.seed * 12.9898 + n * 78.233) * 43758.5453
    return s - Math.floor(s)
  }
  const isLeg = limb.location === 'LL' || limb.location === 'RL'
  const throwAngle = rnd(1) * Math.PI * 2
  const throwSpeed = LIMB_THROW * (0.6 + rnd(2) * 0.8) * (isLeg ? LEG_THROW_BOOST : 1)
  const spinBoost = isLeg ? LEG_SPIN_BOOST : 1
  const spinX = (rnd(3) - 0.5) * 7 * spinBoost
  const spinZ = (rnd(4) - 0.5) * 7 * spinBoost
  // Lying down: face-up or face-down, never standing on end.
  const restTiltX = (rnd(5) < 0.5 ? -1 : 1) * (Math.PI / 2) * (0.82 + rnd(6) * 0.3)
  // Relative to the orientation the piece already carries (see
  // baseQuaternion), not an absolute heading — for a limb that was watched
  // falling, the yaw the mech was facing is baked into the piece itself. A
  // restored one was baked from the model's rest pose, which knows nothing
  // about which way its mech was pointing, so it gets the stored facing
  // added back here.
  const restYaw = (rnd(7) - 0.5) * 2.4 + (limb.piece ? 0 : limb.facing)

  // The orientation the piece was being drawn at the instant it came off.
  // The tumble below happens on the group AROUND it, and the geometry is
  // recentered on its own bounding box, so it spins about its own middle
  // rather than swinging around some distant origin.
  const baseQuaternion = piece?.quaternion
  const pieceScale = piece?.scale ?? 1

  // How long the fall takes, from the height it came off at.
  const fallHeight = Math.max(0.2, limb.dropY - groundY)
  const fallSeconds = Math.sqrt((2 * fallHeight) / LIMB_GRAVITY)

  useProfiledFrame('extremidades caidas', () => {
    const group = ref.current
    if (!group) return
    const elapsed = (performance.now() - limb.droppedAt) / 1000

    const blast = blastRef.current
    if (blast) {
      const blastT = elapsed / (LEG_BLAST_MS / 1000)
      const alive = blastT >= 0 && blastT < 1
      blast.visible = alive
      if (alive) {
        const mat = blast.material as THREE.MeshBasicMaterial
        mat.opacity = (1 - blastT) ** 2
        blast.scale.setScalar(1 + blastT * 2.4)
      }
    }

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
      restYaw * settle,
      spinZ * t * (1 - settle),
    )
  })

  // A model with no separate mesh for this limb has nothing to drop — the
  // mech simply loses it from its silhouette, which is what already
  // happens for every single-mesh chassis.
  if (!piece) return null
  return (
    <group ref={ref} position={[limb.x, limb.dropY, limb.z]}>
      <mesh
        geometry={piece.geometry}
        material={piece.material}
        quaternion={baseQuaternion}
        scale={pieceScale}
        userData={{ perfGroup: 'mechs' }}
        castShadow
        receiveShadow
      />
      {isLeg && (
        <mesh ref={blastRef} visible={false}>
          <planeGeometry args={[pieceScale * 2.4, pieceScale * 2.4]} />
          <meshBasicMaterial
            map={getGlowTexture()}
            color="#ffb04a"
            transparent
            opacity={1}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  )
}
