import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useAnimations, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'
import { resolveMechModelUrl } from '../mechAssets'

/**
 * Textured placeholder (superseding the earlier box-primitive
 * prototype) — a real glTF model (public/models/mech-placeholder.glb,
 * Tripo-generated) used as a stand-in for every mech on the board until
 * real per-chassis assets exist. Deliberately generic/unbranded (not a
 * real BattleTech chassis) — same "no licensing exposure" reasoning
 * this component's earlier prototype already flagged (VISION.md §5).
 *
 * chassis/model (a unit's mech_chassis/mech_model, see api.ts's Unit)
 * resolve to a specific curated asset when we have one — see
 * mechAssets.ts's 3-tier fallback (exact model > chassis placeholder >
 * this generic placeholder). Omitting them always renders the generic
 * placeholder, same as before this existed.
 */
interface Mech3DProps {
  color: string
  emissive?: string
  emissiveIntensity?: number
  chassis?: string | null
  model?: string | null
  /** Plays the "Walk" clip instead of "Idle" while true (HexMap's
   * UnitMarker sets this while it's easing the mech's position toward a
   * new hex) — false/omitted always means "Idle". Rigged assets missing
   * one or both clips just don't switch (see the animation effect
   * below), never a crash. */
  isMoving?: boolean
}

const GENERIC_MODEL_URL = '/models/mech-placeholder.glb'

// Source model's own bounding box is X ±0.374, Y 0..1, Z ±0.310 (already
// resting on y=0) — roughly matched the old procedural mech's own
// footprint (X ±0.32, Y 0..~0.89) at 1:1 scale. Bumped well past that on
// request — a mech visibly overhanging its own hex is the normal look
// for tabletop miniatures (readability over strict scale accuracy), not
// a bug to correct back down.
export const MODEL_SCALE = 1.65

// Local bounding box top is y=1 (see above) — this is roughly where a
// head/cockpit sits rather than the very topmost point, so
// FirstPersonView can derive its camera eye height as MODEL_SCALE *
// MODEL_HEAD_FRACTION instead of a hardcoded number that would silently
// drift out of sync whenever MODEL_SCALE changes.
export const MODEL_HEAD_FRACTION = 0.9

// Roughly torso-center height — FirstPersonView anchors the enemy
// target-lock reticle here (MODEL_SCALE * MODEL_CHEST_FRACTION) so it
// lands on the chest regardless of how MODEL_SCALE is tuned, instead of
// a fixed offset that silently drifts toward the legs as the model
// grows.
export const MODEL_CHEST_FRACTION = 0.6

// How strongly the faction color (player/enemy/pilot color) tints the
// model — blended over white, so 1 would fully replace the model's own
// paint job and 0 would show no tint at all. Kept low so it reads as a
// faint wash rather than recoloring the mech outright.
const FACTION_TINT_STRENGTH = 0.22

// Must match HexMap.tsx's own WALK_SPEED (world units/sec) — duplicated
// rather than imported since HexMap.tsx imports THIS file (Mech3D),
// so the reverse import would be circular. Used only to keep the walk
// animation's timeScale in sync with how fast stepToward is actually
// sliding the mech, below.
const WALK_SPEED = 3.5
// Tuned guess at how much ground (world units) one full authored Walk
// cycle should cover to read as a real stride rather than the legs
// sliding through the motion (real user report: "el loop es muy
// sutil") — adjust this one number after watching it live, not the
// ratio math around it.
const HEX_STRIDE_REFERENCE = 1.6

function Mech3DModel({ color, emissive, emissiveIntensity, chassis, model, isMoving }: Mech3DProps) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene, animations } = useGLTF(url)
  const groupRef = useRef<THREE.Group>(null)

  // useGLTF caches and shares a single scene graph across every mech on
  // the board — mutating a shared material's color would recolor every
  // other instance using it too. Clone the hierarchy AND each mesh's
  // own material (geometry/textures stay shared, only the lightweight
  // material needs its own copy) so each instance's faction tint is
  // independent. SkeletonUtils.clone (not the plain Object3D.clone a
  // non-rigged model could get away with) — a rigged model's
  // SkinnedMesh.skeleton still points at the ORIGINAL bones after a
  // plain clone, so every instance on the board would silently share
  // (and fight over) one skeleton instead of animating independently.
  const instance = useMemo(() => {
    const clone = SkeletonUtils.clone(scene) as THREE.Group
    clone.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material = (obj.material as THREE.Material).clone()
        obj.castShadow = true
      }
    })
    // Curated per-chassis assets (mechAssets.ts) come from all kinds of
    // sources with their own scale/units/pivot — normalize every model
    // to the same local convention the original placeholder happened to
    // already be in (1 unit tall, centered on X/Z, resting on y=0) so
    // MODEL_SCALE and the MODEL_HEAD_FRACTION/MODEL_CHEST_FRACTION
    // derived heights below stay meaningful for any model, not just the
    // placeholder — a newly dropped-in .glb never needs its own
    // hand-tuned scale/offset entry.
    const box = new THREE.Box3().setFromObject(clone)
    const size = new THREE.Vector3()
    box.getSize(size)
    if (size.y > 0) {
      const s = 1 / size.y
      clone.scale.setScalar(s)
      const center = new THREE.Vector3()
      box.getCenter(center)
      clone.position.set(-center.x * s, -box.min.y * s, -center.z * s)
    }
    return clone
  }, [scene])

  // Rigged curated assets (see the Blender envelope-weighting pipeline
  // documented in mechAssets.ts) ship "Idle" and "Walk" clips; HexMap's
  // UnitMarker sets isMoving while it's easing this mech's position
  // toward a new hex, so the two crossfade in step with the actual
  // walk instead of the legs cycling while the mech stands still (or
  // vice versa). Everything else — the generic placeholder before its
  // own rig existed, any not-yet-rigged model — simply has no
  // animations, and both lookups below are undefined, making this a
  // no-op rather than a special case to guard.
  const { actions } = useAnimations(animations, groupRef)
  useEffect(() => {
    const idle = actions['Idle']
    const walk = actions['Walk']
    if (!idle && !walk) return
    const active = isMoving ? (walk ?? idle) : (idle ?? walk)
    const inactive = active === idle ? walk : idle
    // Sync the walk cycle's playback speed to how fast HexMap's
    // stepToward is actually sliding this mech across the ground,
    // instead of always the clip's own authored pace — real user
    // report: at HexMap's WALK_SPEED (world units/sec, unrelated to
    // whatever ground speed this clip was originally animated for), the
    // legs visibly slid rather than strode ("el loop es muy sutil").
    // HEX_STRIDE_REFERENCE is a tuned guess at how much ground one full
    // authored cycle should cover to read as a real stride rather than
    // skating — adjust this single constant (not the ratio math) if a
    // live look says it's still off.
    if (walk && active === walk) {
      const clipDuration = walk.getClip().duration
      if (clipDuration > 0) walk.timeScale = WALK_SPEED / (HEX_STRIDE_REFERENCE / clipDuration)
    }
    active?.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.2).play()
    inactive?.fadeOut(0.2)
  }, [actions, isMoving])

  useEffect(() => {
    // A full-strength color replacement washed out the model's own
    // paint/detail entirely — this blends only a faint amount of the
    // faction color over white (i.e. the texture's own colors
    // untouched) instead, just enough to read as a tint at a glance.
    const tint = new THREE.Color(color)
    instance.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material as THREE.MeshStandardMaterial
        mat.color.set(0xffffff).lerp(tint, FACTION_TINT_STRENGTH)
        mat.emissive.set(emissive ?? '#000000')
        mat.emissiveIntensity = emissiveIntensity ?? 0
      }
    })
  }, [instance, color, emissive, emissiveIntensity])

  return <primitive ref={groupRef} object={instance} scale={MODEL_SCALE} />
}

// Only the generic placeholder — the guaranteed-available fallback — is
// worth eagerly preloading; curated per-chassis assets (mechAssets.ts)
// load on demand via useGLTF's own cache when a mech first needs one,
// instead of every client fetching all of them (tens of MB) up front.
useGLTF.preload(GENERIC_MODEL_URL)

// Same shapes the textured model replaced — kept as the fallback a
// failed/broken model load degrades to (see Mech3DBoundary below),
// rather than a mech silently vanishing with no on-screen sign anything
// is wrong. A GLTF load failure is a rejected promise, which Suspense
// does NOT catch (only pending loads) — without this boundary, that
// error would propagate past this component's own Suspense wrapper and
// take out everything else inside it too (every other unit/tile in the
// same <HexMap>), not just this one mech.
function Mech3DFallback({ color, emissive, emissiveIntensity }: Mech3DProps) {
  const mat = { color, emissive, emissiveIntensity }
  return (
    <group>
      <mesh position={[-0.14, 0.22, 0]} castShadow>
        <boxGeometry args={[0.15, 0.44, 0.16]} />
        <meshStandardMaterial {...mat} />
      </mesh>
      <mesh position={[0.14, 0.22, 0]} castShadow>
        <boxGeometry args={[0.15, 0.44, 0.16]} />
        <meshStandardMaterial {...mat} />
      </mesh>
      <mesh position={[0, 0.58, 0]} castShadow>
        <boxGeometry args={[0.48, 0.3, 0.28]} />
        <meshStandardMaterial {...mat} />
      </mesh>
      <mesh position={[-0.32, 0.55, 0]} castShadow>
        <boxGeometry args={[0.14, 0.36, 0.14]} />
        <meshStandardMaterial {...mat} />
      </mesh>
      <mesh position={[0.32, 0.55, 0]} castShadow>
        <boxGeometry args={[0.14, 0.36, 0.14]} />
        <meshStandardMaterial {...mat} />
      </mesh>
      <mesh position={[0, 0.82, 0.02]} castShadow>
        <boxGeometry args={[0.16, 0.14, 0.16]} />
        <meshStandardMaterial {...mat} />
      </mesh>
    </group>
  )
}

class Mech3DBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.error('Mech3D model failed to load, falling back to placeholder geometry:', error)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function Mech3D(props: Mech3DProps) {
  return (
    <Mech3DBoundary fallback={<Mech3DFallback {...props} />}>
      <Mech3DModel {...props} />
    </Mech3DBoundary>
  )
}
