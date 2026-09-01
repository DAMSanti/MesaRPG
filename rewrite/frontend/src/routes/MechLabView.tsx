import {
  forwardRef, Suspense, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, TransformControls, useAnimations, useGLTF } from '@react-three/drei'
import { Physics, RigidBody, useRapier } from '@react-three/rapier'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { Collider, RigidBody as RapierRigidBody, World } from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import {
  getMechImport, listMechAnnotations, listMechAnnotationReview, listMechChassis, listMechFootprintMasks,
  listMechModels, listMechPbrSettings, saveMechAnnotations, saveMechFootprintMask,
  saveMechPbrSettings, setMechAnnotationReview,
  LIMB_LOCATIONS, MECH_LOCATIONS,
  type MechAnnotation, type MechAnnotationPoint, type MechAnnotationReview, type MechAnnotationReviewStatus,
  type MechAnnotationTrack, type MechChassisResult, type MechFootprintMaskRecord, type MechModelResult,
  type MechPbrSettingsRecord,
} from '../api'
import { invalidateMechAnnotations } from '../mechAnnotations'
import {
  bakeSkinnedGeometry, buildBakedPiece, filterLongEdgeTriangles, recenterBakedPiece,
} from '../bakedPiece'
import { ChassisSelect } from '../components/ChassisSelect'
import {
  applyMechCombatVisibility, buildRetargetedBorrowedClip, computeLimbMeshNames,
  computeWeaponMuzzlePoints, DEAD_MECH_CHAR_COLOR, findSavedPbrSettings, getChassisRestQuats,
  KNOWN_BORROWED_CLIP_PREFIX, Mech3D, MECH_PBR_DEFAULTS, MODEL_SCALE, normalizeMechInstance,
  useMechPbr,
  type MechPbrSettings,
} from '../components/Mech3D'
import { MECH_CHASSIS_ASSETS, resolveMechModelUrl } from '../mechAssets'
import './MechLabView.css'

// Real user report: exact-pixel raycasting missed often enough on this
// dense, miniature-derived geometry to be unusable for CLICKING ("no me
// funciona bien el click... hazlo mucho más permisivo") — a small spiral
// of nearby NDC offsets, tried in order until one actually hits a named
// mesh. Shared by LimbPainter's click handler AND its hover-highlight
// diagnostic — the hover code originally only tried the exact pointer
// position with no retry at all, which is exactly why it was reported as
// "detecta muy mal, solo en zonas concretas": it was missing on the same
// geometry the click handler was already built to route around.
const RAYCAST_RETRY_OFFSETS: [number, number][] = [
  [0, 0],
  [0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01],
  [0.01, 0.01], [-0.01, 0.01], [0.01, -0.01], [-0.01, -0.01],
  [0.02, 0], [-0.02, 0], [0, 0.02], [0, -0.02],
  [0.02, 0.02], [-0.02, 0.02], [0.02, -0.02], [-0.02, -0.02],
  [0.035, 0], [-0.035, 0], [0, 0.035], [0, -0.035],
  [0.035, 0.035], [-0.035, 0.035], [0.035, -0.035], [-0.035, -0.035],
]

// Real root cause found for a follow-up report ("en el Jenner, y SOLO en
// el Jenner... en los brazos no me encuentra absolutamente nada, el resto
// lo encuentra malamente"): inspected that model's own .glb directly —
// its arm meshes (BrazoD/BrazoI) are real, correctly-named, correctly-
// bind-posed skinned meshes, nothing structurally wrong with the asset.
// They're just far THINNER on screen than this chassis's own torso, so
// exact-triangle raycasting can miss them at literally every offset in
// RAYCAST_RETRY_OFFSETS' spiral (fixed absolute NDC offsets, not scaled
// to how big/thin the target actually is).
//
// Two follow-up rounds chased what looked like the same bug but weren't
// (both real, both found by inspecting the .glb directly — never
// guessed): a bounding-box fallback got fooled by 3 stray vertices in
// BrazoI weighted to the wrong bone; a vertex-sample fallback built to
// replace it got fooled by the SAME 3 vertices since one of them was
// index 0, always sampled first. Real follow-up report after fixing
// that too: "sigue viendo los brazos en la cadera" — the vertex-level
// fixes above only ever touched the FALLBACK path. The PRIMARY path
// (RAYCAST_RETRY_OFFSETS' real ray-triangle intersection against the
// live rendered mesh) was never touched, and turned out to have its own,
// separate real bug: BOTH arm meshes have a handful of real, correctly-
// weighted triangles — cap faces sealing the shoulder socket where the
// limb was separated from the torso in Blender — whose edges run
// ~0.12-0.22 units, roughly 15-20x every OTHER triangle's edge length in
// the same mesh (confirmed against the file: median edge ~0.009 across
// both arms). These aren't degenerate junk a single-vertex check would
// catch — they're real, raycastable surface, an internal seam patch that
// happens to reach from the shoulder back toward the torso/hip, close
// enough to occasionally win a raycast over the torso's own outer
// surface depending on camera angle. THIS is the actual "brazo detectado
// en la cadera" bug: the real, primary raycast was hitting this real
// (if practically invisible) patch, so no amount of fallback-tuning
// could ever have caught it.
//
// The fix: build a separate, invisible PICKING copy of each named mesh's
// geometry with any triangle whose longest edge blows past that mesh's
// own typical (median) edge length excluded, and raycast THAT — never
// the live rendered mesh — for both the primary spiral above and the
// sample-point fallback below. Nothing about how the model actually
// renders changes; only what counts as "this part" for picking purposes.
function buildPickingGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  return filterLongEdgeTriangles(mesh.geometry)
}

/** Never added to the actual rendered scene graph — it can never be seen
 * and never costs a render — used purely as a raycast target so neither
 * the primary spiral nor the sample-point fallback ever tests the live
 * mesh's own bad seam triangles. Has no live parent chain to keep its
 * matrixWorld updated on its own; see syncPickingProxies, called right
 * before every raycast check below. */
function buildPickingProxy(mesh: THREE.Mesh): THREE.Mesh {
  const proxy = new THREE.Mesh(buildPickingGeometry(mesh))
  proxy.name = mesh.name
  return proxy
}
function syncPickingProxies(proxiesByMesh: Map<THREE.Mesh, THREE.Mesh>) {
  proxiesByMesh.forEach((proxy, mesh) => proxy.matrixWorld.copy(mesh.matrixWorld))
}

const NAMED_MESH_SAMPLE_COUNT = 160
function sampleGeometryPoints(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const position = geometry.getAttribute('position')
  const stride = Math.max(1, Math.floor(position.count / NAMED_MESH_SAMPLE_COUNT))
  const points: THREE.Vector3[] = []
  for (let i = 0; i < position.count; i += stride) points.push(new THREE.Vector3().fromBufferAttribute(position, i))
  return points
}

const _sampleScratch = new THREE.Vector3()
// How close (NDC) a mesh's own nearest sample point must land to the
// cursor to count as a fallback pick at all — real user request for
// "más permisivo" picking still needs SOME cutoff, or hovering empty
// space off the model entirely would resolve to whichever mesh happens
// to have its single closest point least-far-away.
const NAMED_MESH_PICK_RADIUS = 0.05
function nearestNamedMeshBySamplePoints(
  samplesByMesh: Map<THREE.Mesh, THREE.Vector3[]>, ndcX: number, ndcY: number, camera: THREE.Camera,
): THREE.Mesh | null {
  let best: THREE.Mesh | null = null
  let bestDistSq = NAMED_MESH_PICK_RADIUS * NAMED_MESH_PICK_RADIUS
  for (const [mesh, points] of samplesByMesh) {
    for (const local of points) {
      _sampleScratch.copy(local).applyMatrix4(mesh.matrixWorld).project(camera)
      const dx = _sampleScratch.x - ndcX
      const dy = _sampleScratch.y - ndcY
      const distSq = dx * dx + dy * dy
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        best = mesh
      }
    }
  }
  return best
}

/**
 * MechLab — dev-only mech-annotation editor (real user request: "una
 * pequeña vista dentro de nuestra app donde seleccione el modelo del mech
 * que quiero, me lo muestres en 3d... y que yo tenga una forma de decirte
 * a ti donde esta cada cosa"). Only lists chassis that actually have a
 * curated 3D asset (mechAssets.ts's own MECH_CHASSIS_ASSETS) — real user
 * correction: "yo solo te pedia los de los que tenemos modelo 3d... los
 * otros no tiene sentido que los editemos ahora".
 *
 * Three modes, one shared point set per model_url (api.ts's
 * MechAnnotationPoint), all in Mech3D.tsx's own normalized local space
 * (see its exported normalizeMechInstance — 1 unit tall, centered on X/Z,
 * resting on y=0), BEFORE the outer `scale={MODEL_SCALE}`:
 * - Anotar armas: one point per weapon location + one cockpit point.
 * - Extremidades: which glTF mesh nodes make up each arm/leg, for a
 *   future "lose a limb" VFX to hide/detach.
 * - Ver rig: skeleton overlay + Idle/Walk clip playback, to debug which
 *   mesh parts do/don't actually move.
 *
 * Deliberately does NOT touch the real game's weapon-beam origin
 * (HexMap.tsx/AttackEffects.tsx), FirstPersonView's real camera, or any
 * real dismemberment VFX yet — this only builds and persists the data;
 * wiring it into gameplay is a separate follow-up once some mechs are
 * actually annotated.
 */

const LOOK_DISTANCE = 4

type Mode = 'annotate' | 'limbs' | 'rig' | 'texture' | 'footprint'
type MechLocationCode = (typeof MECH_LOCATIONS)[number]
type LimbLocation = (typeof LIMB_LOCATIONS)[number]

// Real user request: "hay mechs que por ejemplo tienen 3 armas en el
// torso... necesito poder marcar las 3, cuantas tiene lo lee de los datos
// del mech" — a weapon "slot" is now (location, index) instead of just
// location, since a location can hold more than one weapon point. Cockpit
// stays a single, indexless point.
// Real user follow-up: "no solo vamos a seleccionar armas, ademas vamos a
// seleccionar las diferentes partes del cuerpo del mech, para que cuando
// reciba ataques en sitios especificos, podamos mostrar esos ataques
// golpeando donde deben" — a 'hit' slot is one indexless point per
// location (like cockpit), separate from where its weapon(s) mount.
// Real user request: "anotar armas... que tenga la opción de
// autoconfigurar armas (ya no hay modo manual)" — weapons dropped manual
// click-to-place entirely (see onAutoDetectWeaponPoints below). The
// cockpit point does NOT — real user correction: "no me deja colocar la
// cabina a mano, para la cabina no tiene que haber automático" (it's a
// camera viewpoint, not something a bone position can stand in for) —
// stays exactly as manual-click as hit points always were.
// Real user request: hit points dropped entirely from this tab — "si se
// calcula en tiempo real, vamos a quitar la sección donde impacta un
// ataque a esa zona" (HexMap.tsx already tries the live bone-based
// detection FIRST for every attack, see getMeshDetectedHitPoint's own
// doc comment — nothing here was ever a hard requirement for a
// MW5-sourced chassis). The cockpit point is all that's left to click.
type ActiveSlot = { kind: 'cockpit' }

/** parentName is null for a root bone, or when the parent isn't itself part
 * of this same skeleton (e.g. an armature/scene root). See LimbPainter's
 * own onBonesChange for how it's built, and getDescendantBoneNames below
 * for how MechLabView uses it. */
type BoneInfo = { name: string; parentName: string | null }

/** BFS over `boneInfo`'s parent links to find every descendant of
 * `rootName` (children, grandchildren, …), itself included — real fix for
 * "en el selector de extremidades... a veces selecciono huesos y no me
 * selecciona toda la malla": ticking "UpperArm" alone misses vertices only
 * "Hand"/"Forearm" actually influence, so toggling a bone toggles its
 * whole sub-chain instead of just that one bone. */
function getDescendantBoneNames(boneInfo: BoneInfo[], rootName: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const b of boneInfo) {
    if (!b.parentName) continue
    const siblings = childrenOf.get(b.parentName) ?? []
    siblings.push(b.name)
    childrenOf.set(b.parentName, siblings)
  }
  const result = new Set<string>()
  const stack = [rootName]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (result.has(name)) continue
    result.add(name)
    stack.push(...(childrenOf.get(name) ?? []))
  }
  return result
}

const SLOT_LABELS: Record<MechLocationCode | 'cockpit', string> = {
  HD: 'Cabeza', CT: 'Torso central', LT: 'Torso izq.', RT: 'Torso der.',
  LA: 'Brazo izq.', RA: 'Brazo der.', LL: 'Pierna izq.', RL: 'Pierna der.',
  cockpit: 'Cabina / ojo',
}

const WEAPON_MARKER_COLOR = '#7fd4c8'
const COCKPIT_MARKER_COLOR = '#e3a765'
const HIT_MARKER_COLOR = '#d95fd9'
const LIMB_HIGHLIGHT_COLOR = '#e35d5d'
const BONE_MARKER_COLOR = '#e3a765'
const BONE_SEGMENT_UP = new THREE.Vector3(0, 1, 0)

/** Shared by RigViewer and LimbPainter below — both need to reach the
 * model's own skeleton, if it has one. Most of these curated assets are
 * ONE monolithic skinned mesh (real user report: "en el selector de
 * extremidades selecciona siempre todo el mech" — there's no separate
 * "arm" mesh node to click), so the skeleton's own bones are the only
 * real way to address a specific region of it. */
function findSkinnedMesh(root: THREE.Object3D): THREE.SkinnedMesh | null {
  const found: THREE.SkinnedMesh[] = []
  root.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) found.push(obj as THREE.SkinnedMesh)
  })
  return found[0] ?? null
}

function pointKey(kind: MechAnnotationPoint['kind'], location: MechAnnotationPoint['location']) {
  return `${kind}:${location ?? ''}`
}

// Real user request: "poder ver a simple vista en que estado se encuentra
// el anotar armas, extremidades y rig... 3 estados... colores, iconos...
// sin empezar / hecho / aceptado". Native <option> elements can't carry
// colored spans, so the dropdown indicator is plain emoji (renders fine
// cross-browser without any extra markup); the fuller colored badge lives
// in the sidebar for the currently-selected model/mode instead.
const REVIEW_STATUS_ICON: Record<MechAnnotationReviewStatus, string> = {
  not_started: '⚪', done: '🟡', accepted: '🟢',
}
const REVIEW_STATUS_LABEL: Record<MechAnnotationReviewStatus, string> = {
  not_started: 'Sin empezar', done: 'Hecho', accepted: 'Aceptado',
}
// Real user request: "los marcadores... deberian estar en el chasis ahora,
// no en los modelos" — keyed by chassis name (was modelUrl), plus a 5th
// track, 'footprint' (previously untracked — Huella had no review badge
// at all). See api.ts's own MechAnnotationTrack doc comment.
const REVIEW_TRACK_ORDER: MechAnnotationTrack[] = ['weapons', 'limbs', 'rig', 'texture', 'footprint']

function reviewKey(chassis: string, track: MechAnnotationTrack) {
  return `${chassis}::${track}`
}

function reviewStatusFor(
  reviewByKey: Map<string, MechAnnotationReviewStatus>,
  chassis: string | null,
  track: MechAnnotationTrack,
): MechAnnotationReviewStatus {
  if (!chassis) return 'not_started'
  return reviewByKey.get(reviewKey(chassis, track)) ?? 'not_started'
}

/** Small status badge + "Aceptar" button for whichever track the sidebar
 * is currently showing. Real user constraint: "Solo yo puedo aceptar cada
 * parte" — this is the ONLY place that ever sets 'accepted'; 'done' is set
 * automatically elsewhere (see MechLabView's bumpReviewToDone) but never
 * 'accepted'. */
function ReviewBadge({
  status, onAccept, onUnaccept,
}: {
  status: MechAnnotationReviewStatus
  onAccept: () => void
  onUnaccept: () => void
}) {
  return (
    <div className={`mechlab-review mechlab-review-${status}`}>
      <span className="mechlab-review-badge">
        {REVIEW_STATUS_ICON[status]} {REVIEW_STATUS_LABEL[status]}
      </span>
      {status === 'accepted' ? (
        <button type="button" onClick={onUnaccept}>↺ Desmarcar</button>
      ) : (
        <button type="button" onClick={onAccept} disabled={status === 'not_started'}>
          ✓ Aceptar
        </button>
      )}
    </div>
  )
}

/** Real user request: "una forma de ver 'que veria' el player desde el
 * editor" — then, after trying the modal version, "quiero volver a la
 * forma antigua de ver como FPV el modal no me gusta": back to swapping
 * the main viewport's own camera in place, not a popup. Static, looking
 * along local +Z (Mech3D's own unrotated-model convention, same as
 * FirstPersonView's real cockpit camera). */
function FpvPreviewCam({ cockpitLocal }: { cockpitLocal: [number, number, number] }) {
  useFrame((state) => {
    const [x, y, z] = cockpitLocal.map((v) => v * MODEL_SCALE)
    state.camera.position.set(x, y, z)
    state.camera.lookAt(x, y, z + LOOK_DISTANCE)
  })
  return null
}

function PointMarker({ point }: { point: MechAnnotationPoint }) {
  const [x, y, z] = [point.x * MODEL_SCALE, point.y * MODEL_SCALE, point.z * MODEL_SCALE]
  const color = point.kind === 'cockpit' ? COCKPIT_MARKER_COLOR : point.kind === 'hit' ? HIT_MARKER_COLOR : WEAPON_MARKER_COLOR
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[0.035, 12, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
    </mesh>
  )
}

const LIMB_WEIGHT_THRESHOLD = 0.25

/** Per-vertex boolean mask: true where `mesh` is primarily influenced (skin
 * weight >= LIMB_WEIGHT_THRESHOLD) by one of `boneNames`. Shared by the
 * limb paint-by-bone feature (paintInfluenceMask below) and RigViewer's own
 * "pinta la malla a la que afecta este hueso" — null if the mesh isn't
 * skinned at all. */
function boneInfluenceMask(mesh: THREE.SkinnedMesh, boneNames: Set<string>): boolean[] | null {
  const geometry = mesh.geometry
  const skinIndex = geometry.getAttribute('skinIndex')
  const skinWeight = geometry.getAttribute('skinWeight')
  if (!skinIndex || !skinWeight) return null

  const boneIndices = new Set<number>()
  mesh.skeleton.bones.forEach((b, i) => {
    if (boneNames.has(b.name)) boneIndices.add(i)
  })

  const count = geometry.attributes.position.count
  const mask = new Array<boolean>(count)
  for (let i = 0; i < count; i++) {
    let influenced = false
    for (let j = 0; j < 4; j++) {
      if (boneIndices.has(skinIndex.getComponent(i, j)) && skinWeight.getComponent(i, j) >= LIMB_WEIGHT_THRESHOLD) {
        influenced = true
        break
      }
    }
    mask[i] = influenced
  }
  return mask
}

/** Colors every vertex of `mesh` white, then re-colors whichever ones
 * `mask` marks influenced — real user report: "en el selector de
 * extremidades selecciona siempre todo el mech" (most of these curated
 * assets are ONE monolithic skinned mesh, no separate "arm" mesh node
 * exists to click), so bone skin-weight is the only real way to highlight
 * "just this region" of it. `mask` null clears back to plain white. */
function paintInfluenceMask(mesh: THREE.SkinnedMesh, mask: boolean[] | null) {
  const geometry = mesh.geometry
  const count = geometry.attributes.position.count
  let colorAttr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined
  if (!colorAttr) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3)
    geometry.setAttribute('color', colorAttr)
  }
  const highlight = new THREE.Color(LIMB_HIGHLIGHT_COLOR)
  for (let i = 0; i < count; i++) {
    if (mask?.[i]) colorAttr.setXYZ(i, highlight.r, highlight.g, highlight.b)
    else colorAttr.setXYZ(i, 1, 1, 1)
  }
  colorAttr.needsUpdate = true
}

/** A tiny material patch (applied once per material, harmless if unused):
 * adds a per-vertex `limbCut` float attribute and discards any fragment
 * where it's set, so a mesh region can be visually "cut away" without
 * actually editing its geometry. Real user request (Extremidades):
 * "necesitamos una forma de ver como seria la 'ruptura' de la malla
 * seleccionada" — this only ever runs client-side in the editor, it
 * doesn't touch the source .glb or persist anywhere. */
const LIMB_CUT_ATTR = 'limbCut'

function ensureLimbCutShaderPatch(material: THREE.Material) {
  const patched = material as THREE.Material & { __limbCutPatched?: boolean }
  if (patched.__limbCutPatched) return
  patched.__limbCutPatched = true
  const prior = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prior?.(shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${LIMB_CUT_ATTR};\nvarying float vLimbCut;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLimbCut = ${LIMB_CUT_ATTR};`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLimbCut;')
      .replace('#include <dithering_fragment>', 'if (vLimbCut > 0.5) discard;\n#include <dithering_fragment>')
  }
  material.needsUpdate = true
}

/** Writes `mask` (true = cut away) into the mesh's limbCut attribute — null
 * clears it back to "nothing cut." No-op until ensureLimbCutShaderPatch has
 * also been called on the mesh's own material at least once. */
function setLimbCutMask(mesh: THREE.SkinnedMesh, mask: boolean[] | null) {
  const geometry = mesh.geometry
  const count = geometry.attributes.position.count
  let cutAttr = geometry.getAttribute(LIMB_CUT_ATTR) as THREE.BufferAttribute | undefined
  if (!cutAttr) {
    cutAttr = new THREE.BufferAttribute(new Float32Array(count), 1)
    geometry.setAttribute(LIMB_CUT_ATTR, cutAttr)
  }
  for (let i = 0; i < count; i++) cutAttr.setX(i, mask?.[i] ? 1 : 0)
  cutAttr.needsUpdate = true
}

/** Builds a standalone fragment geometry containing only the faces `mask`
 * marks fully-selected (all 3 vertices) — a real, separate chunk of
 * geometry (sharing the source's attribute DATA via clone, not a shader
 * trick) so it can be animated falling on its own object transform. Used
 * only for the bone-painted-region cut case (see LimbPainter): a directly
 * clicked/toggled real mesh node is already its own object and falls the
 * same way without needing this. Returns null if the mask selects nothing
 * (nothing to build). */
function buildCutFragmentGeometry(geometry: THREE.BufferGeometry, mask: boolean[]): THREE.BufferGeometry | null {
  const srcIndex = geometry.index
  const newIndices: number[] = []
  if (srcIndex) {
    for (let i = 0; i < srcIndex.count; i += 3) {
      const a = srcIndex.getX(i)
      const b = srcIndex.getX(i + 1)
      const c = srcIndex.getX(i + 2)
      if (mask[a] && mask[b] && mask[c]) newIndices.push(a, b, c)
    }
  } else {
    const count = geometry.attributes.position.count
    for (let i = 0; i < count; i += 3) {
      if (mask[i] && mask[i + 1] && mask[i + 2]) newIndices.push(i, i + 1, i + 2)
    }
  }
  if (newIndices.length === 0) return null
  const fragment = geometry.clone()
  fragment.setIndex(newIndices)
  return fragment
}

/** Spawns a real DYNAMIC Rapier body + cuboid collider for a piece that
 * just started falling, at that mesh's OWN current position/rotation
 * (already set by the caller — see both call sites, both via
 * BakedPiece's own recentered worldPosition/worldQuaternion) — real user
 * request: "no deben tener fuerza, debe caer por gravedad y golpear con
 * todo lo que encuentre". No initial velocity is ever set here, so the
 * body starts genuinely at rest and only gravity (the world's own,
 * shared with the static colliders below and the ground) ever moves it
 * — CCD on since a piece can fall fast enough over a short preview-scale
 * distance to otherwise tunnel through something thin in a single
 * physics step. A cuboid, not a convex hull, per BakedPiece's own doc
 * comment — real bug found this session with a many-thousand-point
 * hull: it never registered a single contact against any of the other
 * named parts in testing, and there was no cheap way to verify why. A
 * box is easy to reason about, easy to verify, and good enough for "does
 * a falling piece bump into the rest of the mech" without needing to
 * hug every contour. */
function spawnFallingBody(
  world: World, rapier: typeof RAPIER, bodies: Map<THREE.Mesh, RapierRigidBody>,
  mesh: THREE.Mesh, halfExtents: THREE.Vector3,
): RapierRigidBody {
  const bodyDesc = rapier.RigidBodyDesc.dynamic()
    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
    .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w })
    .setCcdEnabled(true)
  const body = world.createRigidBody(bodyDesc)
  // A hard floor on each axis — Rapier rejects (or mishandles) a truly
  // zero-thickness cuboid, and a real mesh piece could in principle be
  // paper-thin along one axis.
  const MIN_HALF_EXTENT = 0.005
  const colliderDesc = rapier.ColliderDesc.cuboid(
    Math.max(halfExtents.x, MIN_HALF_EXTENT), Math.max(halfExtents.y, MIN_HALF_EXTENT), Math.max(halfExtents.z, MIN_HALF_EXTENT),
  )
  world.createCollider(colliderDesc, body)
  bodies.set(mesh, body)
  return body
}

function removeFallingBody(world: World, bodies: Map<THREE.Mesh, RapierRigidBody>, mesh: THREE.Mesh) {
  const body = bodies.get(mesh)
  if (body) {
    world.removeRigidBody(body)
    bodies.delete(mesh)
  }
}

/** Real user report: "las piernas cuando se rompen, por su geometria se
 * quedan de pie en equilibrio" — a leg's own flat "foot" end means the
 * recentered cuboid can land upright and just stay there, stable, instead
 * of toppling like a severed limb should. Real user follow-up, explicit
 * and scoped: "una pequeña fuerza (como una pequeña explosion)... para que
 * tiltee? Solo en las piernas" — a one-off spin around a random horizontal
 * axis, set directly (not accumulated via impulse) so it's independent of
 * the piece's own mass/inertia and stays exactly as small as this value
 * says regardless of piece size. Horizontal axis (never straight up) is
 * what makes an upright piece actually TIP rather than spin in place like
 * a top.
 *
 * Real follow-up after shipping the first version: "un poco mas fuerte,
 * aun se mantiene en pie" — 1.6 rad/s wasn't enough to overcome a leg's
 * own wide flat-footed stability, and a pure spin with zero linear
 * velocity meant a piece that broke already resting right at ground level
 * could have its spin absorbed by the very first ground contact before it
 * ever visibly rotated.
 *
 * First fix attempt added a sideways linear kick alongside a stronger
 * spin — live-tested and reverted: over ~2.5s a sideways push (even a
 * "small" one) is enough to skid the piece clean off the small preview
 * floor and out of frame, which is arguably worse than standing still,
 * AND is exactly the horizontal "launched" motion the user explicitly
 * ruled out earlier ("no deben tener fuerza, debe caer por gravedad").
 * Kept the fix to what that rule still allows: a bigger spin, plus a
 * PURELY VERTICAL hop (no sideways component at all) just enough to
 * break contact with the ground for a moment so the spin isn't cancelled
 * on the very next physics step — gravity brings it straight back down
 * to wherever it already was, no lateral drift. */
const LEG_TIP_ANGVEL = 7
const LEG_TIP_HOP_VEL = 0.6
function applyLegTipSpin(body: RapierRigidBody) {
  const angle = Math.random() * Math.PI * 2
  body.setAngvel({ x: Math.cos(angle) * LEG_TIP_ANGVEL, y: 0, z: Math.sin(angle) * LEG_TIP_ANGVEL }, true)
  body.setLinvel({ x: 0, y: LEG_TIP_HOP_VEL, z: 0 }, true)
}

function isLegMeshName(name: string): boolean {
  return /pierna/i.test(name)
}

/** Real user request: "nos falta una forma de seleccionar o pintar las
 * partes del mech correspondientes a los brazos y las piernas para que
 * puedan perderlas en combate" — then, once it turned out these models
 * are single monolithic meshes with no separate "arm"/"leg" node to
 * click: "en el selector de extremidades selecciona siempre todo el
 * mech, necesito poder 'partirle' en partes en esa misma pestaña".
 * Two complementary ways to build up a limb's membership, both feeding
 * the same `mesh_names` list on save (its real contents can be either
 * mesh node names or bone names, whichever a given model actually
 * supports): clicking directly on the model still toggles whatever mesh
 * node was hit (works for the rare model that DOES have separate parts);
 * ticking bones in the sidebar list paints the region their skin weight
 * actually influences (boneInfluenceMask/paintInfluenceMask above) — this
 * is the one that actually "splits" a single mesh into a selectable
 * region.
 *
 * `previewBreak` (real user request: "necesitamos una forma de ver como
 * seria la 'ruptura' de la malla seleccionada", then "no solo quiero que
 * haga desaparecer la extremidad magicamente, quiero que se caiga 'por
 * gravedad'") detaches the current selection instead of just highlighting
 * it: a bone-painted region gets shader-discarded from the main mesh via
 * setLimbCutMask AND a real standalone fragment (buildCutFragmentGeometry)
 * is spun up to actually fall away; a directly-clicked mesh node (a real,
 * separate glTF node) falls the same way on its own object transform — see
 * fallStateRef and the useFrame gravity step below. */
function LimbPainter({
  chassis, model, weapons, instanceRef, selectedMeshNames, selectedBoneNames, previewBreak, onToggleMesh,
  onBonesChange, onMeshNamesChange,
}: {
  chassis: string
  model: string | null
  /** Real user report: "en extremidades ahora mismo aparece el modelo con
   * TODAS las armas... quiero que solo aparezca con las armas del modelo
   * seleccionado" — this model's own real loadout (MechLabView's
   * templateWeaponsForMech3D), applied via applyMechCombatVisibility so
   * only the actually-equipped weapon mounts show, same as 'annotate'
   * mode already does through Mech3D itself. */
  weapons: { location: string; weaponName: string }[]
  /** Real user request: "también podremos... encontrar las extremidades
   * porque los nuevos modelos están nombrados y separados?" — same
   * purpose as Mech3D's own instanceRef prop (see its doc comment):
   * exposes this component's live, MODEL_SCALE-rendered instance so
   * MechLabView can call computeLimbMeshNames against it on demand. */
  instanceRef?: { current: THREE.Object3D | null }
  selectedMeshNames: Set<string>
  selectedBoneNames: Set<string>
  previewBreak: boolean
  onToggleMesh: (meshName: string) => void
  onBonesChange: (bones: BoneInfo[]) => void
  /** Real user request: clicking a genuinely separate mesh piece (post-
   * Blender-Separate models) kept missing on some pieces no matter how
   * forgiving the raycast retry got — "puedes detectar las partes de la
   * malla y ponerlas en una lista? sustituyes huesos por partes, y la
   * selecciono desde ahí". Same pattern as onBonesChange, just for real
   * mesh-node names instead of bone names — MechLabView renders both as
   * parallel checklists, both driving the same onToggleMesh/mesh_names. */
  onMeshNamesChange: (names: string[]) => void
}) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene } = useGLTF(url)
  const instance = useMemo(() => normalizeMechInstance(scene), [scene])
  if (instanceRef) instanceRef.current = instance
  // applyColorBoost: false — real user report: "en extremidades... ver rig,
  // textura y huella lo veo blanco" — MECH_COLOR_BOOST (1.7x) was measured
  // against the Jenner's own unusually dark (~19% brightness) camo texture;
  // applied to a lighter-painted chassis (the Warhammer) it pushes most
  // texels past 1.0 and clips toward flat white, worse the more directly a
  // panel faces the light (RigViewer's typical close top-down framing
  // showed it hardest, but the same overexposed material was already
  // there here too, just less obvious from this component's usual camera
  // angle). This tab is about picking real mesh/bone parts, not judging
  // paint brightness — showing the texture's own true, unboosted color is
  // both more useful here and incidentally fixes the whiteout.
  useMechPbr(instance, { applyColorBoost: false })
  // Real user report: "quiero que solo aparezca con las armas del modelo
  // seleccionado, y con el modelo bien, ni dañado ni destruido" — severed/
  // damaged both undefined forces the always-normal condition (this tab
  // has no real battle state to preview damage against anyway, unlike
  // 'annotate' mode's own dedicated damage-preview toggle).
  const limbWeaponsKey = weapons.map((w) => `${w.location}:${w.weaponName}`).join(',')
  useEffect(() => {
    applyMechCombatVisibility(instance, weapons, undefined, undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, limbWeaponsKey])
  const skinnedMesh = useMemo(() => findSkinnedMesh(instance), [instance])
  // Real bug found this session (via live browser inspection — matrixWorld
  // updates correctly on attach()+reparent, but this SkinnedMesh's own
  // modelViewMatrix — the actual per-frame uniform WebGL draws with —
  // NEVER refreshes afterward, confirmed by forcing an extreme position
  // and finding the render frozen exactly at the pre-attach spot no
  // matter what; a real three.js/r3f edge case specific to reparenting a
  // live, already-rendered SkinnedMesh via attach()). A directly-picked
  // mesh node now falls via a PLAIN (non-skinned) Mesh stand-in built
  // from the same geometry/material instead of the original SkinnedMesh
  // itself — exactly the same technique the bone-cut fragment below
  // already uses successfully, which sidesteps the whole SkinnedMesh
  // render pipeline (no bindMatrix/skeleton involved, so no equivalent
  // staleness). The original node is simply hidden (`visible = false`)
  // while its stand-in falls in fallenGroupRef; see originalParentRef's
  // own doc comment for how it maps one to the other.
  // Real bug found this session: the fragment used to be torn down and
  // rebuilt from scratch on EVERY run of the effect below, even when
  // nothing relevant had actually changed (MechLabView is a big component
  // that re-renders for lots of unrelated reasons) — each rebuild reset
  // fallState's `fallen`/`vy` back to 0, so a fragment that should have
  // been mid-fall instead looked permanently frozen at its starting spot
  // ("la vista previa sigue manteniendo las partes unidas entre si").
  // This tracks the bone-selection this fragment was actually built from,
  // so the effect can skip the rebuild — and thus skip resetting its fall
  // progress — whenever it re-runs without that actually changing.
  const lastFragmentKeyRef = useRef<string | null>(null)
  // Where a falling piece's stand-in mesh actually lives — a plain
  // (unscaled, unrotated) sibling of the model, so its own position
  // really is a predictable world-space unit once its Rapier body writes
  // into it each frame (see the sync useFrame below).
  const fallenGroupRef = useRef<THREE.Group>(null)
  const { world, rapier } = useRapier()
  // Real user request: "no deben tener fuerza, debe caer por gravedad y
  // golpear con todo lo que encuentre" — real Rapier rigid bodies now
  // drive every falling piece (this app already uses Rapier for the
  // dice — see TableView/Die.tsx), replacing an earlier hand-rolled
  // position.y-decrement "physics" that had no concept of collision at
  // all. One DYNAMIC body per currently-falling stand-in mesh, keyed by
  // the stand-in itself. A real Rapier RigidBody is never itself a React
  // node here (this component is already too imperative for that — see
  // pickingProxiesRef's own doc comment for why), so its transform has
  // to be synced onto the plain THREE mesh manually every frame — see
  // the sync useFrame below, which plays the same role fallStateRef used
  // to.
  const physicsBodiesRef = useRef<Map<THREE.Mesh, RapierRigidBody>>(new Map())
  // One FIXED (static) collider per named mesh part, built once per model
  // load (see the effect further below) — what actually lets a falling
  // piece "golpear con... otras partes de la malla del mech" instead of
  // passing straight through them. Disabled (not removed) for whichever
  // part is CURRENTLY the one falling, so its own dynamic collider
  // doesn't immediately collide with its own former static self sitting
  // at the exact same starting spot.
  const staticCollidersRef = useRef<Map<string, Collider>>(new Map())
  // Maps a directly-picked mesh node (still hidden, still living in
  // `instance`'s own tree — never reparented, only ever hidden) to the
  // plain-mesh stand-in currently falling in its place. Enough to UNDO
  // the whole thing for a node that gets deselected (or previewBreak
  // turned off) mid-fall: make the original visible again, re-enable its
  // static collider, remove the dynamic body, dispose the stand-in. The
  // bone-cut fragment never needs this: it's simply destroyed, never
  // restored (see lastFragmentKeyRef's own rebuild guard).
  const originalParentRef = useRef<Map<THREE.Object3D, THREE.Mesh>>(new Map())
  const fragmentPieceRef = useRef<THREE.Mesh | null>(null)

  // Real root cause found for "en los brazos no me encuentra absolutamente
  // nada, solo en el Jenner", then "sigue viendo los brazos en la
  // cadera": see buildPickingGeometry's own doc comment for the full
  // chain — the Jenner's own arm meshes have real, correctly-weighted
  // but abnormally long "seam cap" triangles reaching back toward the
  // torso. pickingProxiesRef holds one cleaned, invisible proxy mesh per
  // named part (used by BOTH the primary raycast spiral below AND the
  // sample-point fallback), namedMeshSamplesRef holds sample points
  // drawn from those SAME cleaned geometries. Both built ONCE here (not
  // rebuilt every check) since the mesh's own local geometry never
  // changes while previewing.
  const pickingProxiesRef = useRef<Map<THREE.Mesh, THREE.Mesh>>(new Map())
  // Reverse lookup back to the real, rendered mesh a proxy hit stands in
  // for — a raycast hit on a proxy is only ever useful as a NAME.
  const originalByProxyRef = useRef<Map<THREE.Mesh, THREE.Mesh>>(new Map())
  const namedMeshSamplesRef = useRef<Map<THREE.Mesh, THREE.Vector3[]>>(new Map())
  useEffect(() => {
    const names: string[] = []
    const proxies = new Map<THREE.Mesh, THREE.Mesh>()
    const originalByProxy = new Map<THREE.Mesh, THREE.Mesh>()
    const samples = new Map<THREE.Mesh, THREE.Vector3[]>()
    instance.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.name) {
        names.push(obj.name)
        const proxy = buildPickingProxy(obj)
        proxies.set(obj, proxy)
        originalByProxy.set(proxy, obj)
        samples.set(obj, sampleGeometryPoints(proxy.geometry))
      }
    })
    pickingProxiesRef.current = proxies
    originalByProxyRef.current = originalByProxy
    namedMeshSamplesRef.current = samples
    onMeshNamesChange(names)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance])

  // Real user request: a falling piece should "golpear con todo lo que
  // encuentre, por ejemplo otras partes de la malla del mech" — one
  // FIXED collider per named mesh part (see BakedPiece's own doc comment
  // for why a recentered cuboid, not a raw convex hull), so the rest of
  // the model is real, solid geometry a falling piece can land or bump
  // against. Built ONCE per model load.
  useEffect(() => {
    if (!world) return
    const built = new Map<string, Collider>()
    const bodies: RapierRigidBody[] = []
    instance.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh && obj.name)) return
      const piece = buildBakedPiece(obj as THREE.SkinnedMesh, obj.geometry)
      piece.geometry.dispose()
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.fixed().setTranslation(piece.worldPosition.x, piece.worldPosition.y, piece.worldPosition.z),
      )
      body.setRotation({ x: piece.worldQuaternion.x, y: piece.worldQuaternion.y, z: piece.worldQuaternion.z, w: piece.worldQuaternion.w }, true)
      const colliderDesc = rapier.ColliderDesc.cuboid(
        Math.max(piece.halfExtents.x, 0.005), Math.max(piece.halfExtents.y, 0.005), Math.max(piece.halfExtents.z, 0.005),
      )
      const collider = world.createCollider(colliderDesc, body)
      built.set(obj.name, collider)
      bodies.push(body)
    })
    staticCollidersRef.current = built
    return () => {
      for (const body of bodies) world.removeRigidBody(body)
      built.clear()
    }
  }, [instance, world, rapier])

  // Real user report: the "fills the hole" liner this used to add here (a
  // second, back-face-only copy of the whole skinnedMesh geometry, meant
  // to cap the cut region instead of leaving it looking straight through
  // to empty space) itself looked wrong in practice — "se queda algo de
  // textura en el mech... no quiero que quede" (a screenshot showed a
  // large, dark, still-attached solid chunk sitting exactly where the
  // limb had just fallen away from, right next to the same region
  // highlighted red as "selected" in a second screenshot: this WAS the
  // liner, not a leftover fragment — a fully separate BROKEN piece
  // genuinely does fall away correctly, unrelated to this). Explicit,
  // repeated instruction: don't touch the break/fall itself, only remove
  // this residue — so the liner is gone outright, back to a plain
  // shader-discarded hole on the main mesh (still handled by
  // ensureLimbCutShaderPatch/setLimbCutMask above).

  useEffect(() => {
    // parentName only set when the parent is ITSELF one of this skeleton's
    // own bones — MechLabView uses this to walk descendants when a bone is
    // ticked (see getDescendantBoneNames), real fix for "en el selector de
    // extremidades... a veces selecciono huesos y no me selecciona toda la
    // malla" (a vertex near the hand is influenced by "Hand", not the
    // "UpperArm" the user actually clicked — auto-including descendants is
    // what actually covers the whole limb).
    const bones = skinnedMesh?.skeleton.bones ?? []
    const boneSet = new Set(bones)
    onBonesChange(
      bones.map((b) => ({
        name: b.name,
        parentName: b.parent && boneSet.has(b.parent as THREE.Bone) ? b.parent.name : null,
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinnedMesh])

  // Switching models mid-preview would otherwise leave fallStateRef/
  // originalParentRef holding onto references from the PREVIOUS instance
  // forever — nothing below ever revisits them (instance.traverse only
  // walks the current instance's own tree). Unlike the old attach()-based
  // design, a stand-in mesh lives in fallenGroupRef, which is NOT
  // recreated on a model switch (it's a plain sibling `<group>`, not part
  // of `instance`'s own tree) — so it must be explicitly removed/disposed
  // here, or it would keep rendering as an orphaned leftover from the
  // previous model forever.
  useEffect(() => {
    for (const standIn of originalParentRef.current.values()) {
      removeFallingBody(world, physicsBodiesRef.current, standIn)
      standIn.parent?.remove(standIn)
      standIn.geometry.dispose()
      ;(standIn.material as THREE.Material).dispose()
    }
    originalParentRef.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance])

  useEffect(() => {
    let paintedByBones = false
    let cutMask: boolean[] | null = null
    if (skinnedMesh && selectedBoneNames.size > 0) {
      const mask = boneInfluenceMask(skinnedMesh, selectedBoneNames)
      if (mask) {
        paintedByBones = true
        paintInfluenceMask(skinnedMesh, mask)
        cutMask = previewBreak ? mask : null
      }
    } else if (skinnedMesh) {
      // No bones picked — clear any earlier paint back to plain white.
      paintInfluenceMask(skinnedMesh, null)
    }
    if (skinnedMesh) setLimbCutMask(skinnedMesh, cutMask)

    // Rebuild the falling fragment ONLY when the actual cut selection
    // changed (a stable, sorted key of the bone names it was built from,
    // or null when there's no cut at all) — NOT on every run of this
    // effect. This effect re-runs for lots of reasons unrelated to the
    // fragment (MechLabView is a big component, plenty of its state
    // changes ripple down through these same props) — rebuilding
    // unconditionally threw away an in-progress fall's fallState every
    // single time, which is why the piece never visibly finished
    // separating (see lastFragmentKeyRef's own doc comment above).
    // skinnedMesh.uuid included so switching models always forces a
    // rebuild even in the freak case both models' selected-bone-name
    // keys happen to collide as plain text.
    const cutKey = cutMask ? `${skinnedMesh?.uuid}:${[...selectedBoneNames].sort().join('|')}` : null
    if (cutKey !== lastFragmentKeyRef.current) {
      lastFragmentKeyRef.current = cutKey
      const oldFragment = fragmentPieceRef.current
      if (oldFragment) {
        removeFallingBody(world, physicsBodiesRef.current, oldFragment)
        oldFragment.parent?.remove(oldFragment)
        oldFragment.geometry.dispose()
        ;(oldFragment.material as THREE.Material).dispose()
        fragmentPieceRef.current = null
        // Real bug found live: "se cae bastante bien PERO se queda algo de
        // textura en el mech" — the source skinnedMesh is ITSELF one of
        // the named parts staticCollidersRef builds a collider for (see
        // that effect above), sized to the WHOLE fused body on a chassis
        // like this one. The directly-picked-mesh-node branch below
        // already disables that same source part's own static collider
        // for exactly this reason (staticCollidersRef...setEnabled(false),
        // a few lines down) — this bone-cut branch spawned its fragment
        // right on top of that still-ACTIVE, much bigger static collider
        // without ever disabling it, so the new dynamic body started deep
        // inside it and Rapier's contact resolution just held it pinned at
        // its spawn transform instead of letting it fall: not a rendering
        // bug, a physics one, but with a "leftover baked-in texture" look
        // since the stuck fragment sits exactly where the cut region was.
        // Re-enabled here (selection cleared / preview turned off) —
        // there's nothing left needing it disabled once no fragment of
        // this mesh is falling.
        if (skinnedMesh) staticCollidersRef.current.get(skinnedMesh.name)?.setEnabled(true)
      }
      // Guarded on its own — a failure building the bone-cut fragment
      // (odd geometry, a multi-material mesh, whatever) must never take
      // down the traversal below, which is what actually makes a
      // directly-picked mesh piece (the normal case now that
      // Extremidades selects from the "Piezas de la malla" list) fall.
      if (skinnedMesh && cutMask) {
        try {
          // Baked BEFORE cutting (see bakeSkinnedGeometry's own doc
          // comment) — same vertex count/order as skinnedMesh.geometry,
          // so buildCutFragmentGeometry's own index filtering still
          // applies correctly on top. Deliberately NOT run through
          // filterLongEdgeTriangles here — see BakedPiece's own doc
          // comment on why that has to stay reserved for an invisible
          // collider's own bounds, never the geometry that actually
          // renders (recenterBakedPiece, below, still uses it
          // internally for exactly that, just on a throwaway clone).
          const bakedGeometry = bakeSkinnedGeometry(skinnedMesh, skinnedMesh.geometry)
          const fragGeometry = buildCutFragmentGeometry(bakedGeometry, cutMask)
          bakedGeometry.dispose()
          if (fragGeometry) {
            const srcMaterial = Array.isArray(skinnedMesh.material) ? skinnedMesh.material[0] : skinnedMesh.material
            const material = (srcMaterial as THREE.MeshStandardMaterial).clone()
            material.vertexColors = false
            // Real user request: "quiero que las extremidades rotas se
            // pongan del color de los mechs muertos, así como carbonizado"
            // — same charred blend HexMap's own destroyed-mech tint uses
            // (DEAD_MECH_CHAR_COLOR, see its own use site in HexMap.tsx for
            // the current strength — kept identical here), applied
            // directly to the broken piece's own material rather than the
            // whole mech.
            material.color.set(0xffffff).lerp(new THREE.Color(DEAD_MECH_CHAR_COLOR), 0.55)
            material.emissive.set('#000000')
            material.emissiveIntensity = 0
            material.onBeforeCompile = () => {}
            material.needsUpdate = true
            // Recentered the same way a directly-picked node's own
            // stand-in is (see BakedPiece's own doc comment) — this cut
            // fragment is just as far from skinnedMesh's own local
            // origin as any other piece, same reasoning applies.
            const piece = recenterBakedPiece(fragGeometry, skinnedMesh.matrixWorld)
            const fragment = new THREE.Mesh(piece.geometry, material)
            fragment.position.copy(piece.worldPosition)
            fragment.quaternion.copy(piece.worldQuaternion)
            fragment.scale.setScalar(piece.scale)
            fragmentPieceRef.current = fragment
            fallenGroupRef.current?.add(fragment)
            const fragBody = spawnFallingBody(world, rapier, physicsBodiesRef.current, fragment, piece.halfExtents)
            // See the oldFragment cleanup's own doc comment (above) for
            // the full bug this guards against — the new fragment starts
            // out spatially overlapping skinnedMesh's OWN static collider
            // (it's cut from that same mesh's geometry), which pins it in
            // place instead of letting it fall unless that collider is
            // disabled for as long as this fragment exists.
            staticCollidersRef.current.get(skinnedMesh.name)?.setEnabled(false)
            // Bone-cut selection has no single "mesh node name" to check —
            // go by whichever bones were actually painted instead (same
            // "Pierna*" naming convention as the whole-piece case below).
            if ([...selectedBoneNames].some(isLegMeshName)) applyLegTipSpin(fragBody)
          }
        } catch (err) {
          console.error('LimbPainter: failed to build the break-preview fragment', err)
          fragmentPieceRef.current = null
        }
      }
    }

    // Restore pass FIRST — a directly-picked mesh node currently falling
    // is HIDDEN (its stand-in lives under fallenGroupRef instead — see
    // this whole section's own top comment), so the traversal below
    // (which only walks instance's own tree) would never think to make
    // it visible again on its own. Check every currently-broken node
    // against the CURRENT selection here instead, and restore anything
    // that should no longer be falling before the traversal re-registers
    // whatever's newly breaking.
    for (const [obj, standIn] of [...originalParentRef.current]) {
      const stillBreaking = previewBreak && selectedMeshNames.has(obj.name)
      if (!stillBreaking) {
        obj.visible = true
        staticCollidersRef.current.get(obj.name)?.setEnabled(true)
        removeFallingBody(world, physicsBodiesRef.current, standIn)
        standIn.parent?.remove(standIn)
        // Both disposed here — unlike obj.geometry itself, standIn's own
        // geometry is a real, independent BAKED clone (see
        // bakeSkinnedGeometry's own doc comment), not shared with obj.
        standIn.geometry.dispose()
        ;(standIn.material as THREE.Material).dispose()
        originalParentRef.current.delete(obj)
      }
    }

    const toBreak: THREE.Mesh[] = []
    instance.traverse((obj) => {
      // fragmentPieceRef lives under fallenGroupRef, a sibling of
      // `instance` — never actually hit by this traversal — but skipped
      // defensively anyway in case that ever changes.
      if (obj === fragmentPieceRef.current) return
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material as THREE.MeshStandardMaterial
        mat.vertexColors = paintedByBones
        ensureLimbCutShaderPatch(mat)
        const selected = selectedMeshNames.has(obj.name)
        mat.emissive.set(selected ? LIMB_HIGHLIGHT_COLOR : '#000000')
        mat.emissiveIntensity = selected ? 0.55 : 0
        mat.needsUpdate = true
        // Real, separate mesh nodes fall via a plain-mesh stand-in (see
        // this section's own top comment) instead of just vanishing.
        const breaking = previewBreak && selected
        if (breaking && !originalParentRef.current.has(obj)) toBreak.push(obj)
      }
    })
    if (fallenGroupRef.current) {
      for (const obj of toBreak) {
        const srcMaterial = Array.isArray(obj.material) ? obj.material[0] : obj.material
        const material = (srcMaterial as THREE.MeshStandardMaterial).clone()
        material.vertexColors = false
        // Real user request: "quiero que las extremidades rotas se pongan
        // del color de los mechs muertos, así como carbonizado" — see the
        // bone-cut fragment path's own copy of this comment above.
        material.color.set(0xffffff).lerp(new THREE.Color(DEAD_MECH_CHAR_COLOR), 0.55)
        material.emissive.set('#000000')
        material.emissiveIntensity = 0
        material.onBeforeCompile = () => {}
        material.needsUpdate = true
        // Baked, cleaned, and RECENTERED (see BakedPiece's own doc
        // comment for why) — a real, independent geometry now, not
        // shared with obj, so it gets disposed on restore.
        const piece = buildBakedPiece(obj as THREE.SkinnedMesh, obj.geometry)
        const standIn = new THREE.Mesh(piece.geometry, material)
        standIn.position.copy(piece.worldPosition)
        standIn.quaternion.copy(piece.worldQuaternion)
        standIn.scale.setScalar(piece.scale)
        standIn.castShadow = obj.castShadow
        fallenGroupRef.current.add(standIn)
        obj.visible = false
        // Its own static collider would otherwise sit in the exact same
        // spot the new dynamic one spawns in — see staticCollidersRef's
        // own doc comment for why this has to be disabled, not the
        // falling piece skipped past it.
        staticCollidersRef.current.get(obj.name)?.setEnabled(false)
        originalParentRef.current.set(obj, standIn)
        const standInBody = spawnFallingBody(world, rapier, physicsBodiesRef.current, standIn, piece.halfExtents)
        if (isLegMeshName(obj.name)) applyLegTipSpin(standInBody)
      }
    }

  }, [instance, skinnedMesh, selectedMeshNames, selectedBoneNames, previewBreak, world, rapier])

  // Dedicated unmount-only cleanup for the fragment — deliberately a
  // SEPARATE effect with an empty dep array, not the return value of the
  // effect above. That effect's own cleanup runs before EVERY rerun (any
  // dep change), not just on unmount, which would have disposed the
  // fragment out from under lastFragmentKeyRef's whole "skip the rebuild
  // when nothing relevant changed" guard — defeating the fix.
  useEffect(() => () => {
    const fragment = fragmentPieceRef.current
    if (fragment) {
      removeFallingBody(world, physicsBodiesRef.current, fragment)
      fragment.parent?.remove(fragment)
      fragment.geometry.dispose()
      ;(fragment.material as THREE.Material).dispose()
      fragmentPieceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Syncs every currently-falling piece's mesh onto its own real Rapier
  // body every frame — the body IS the physics now (real gravity, real
  // collision against the static colliders above and the ground), this
  // is purely "copy what Rapier already computed onto the thing that
  // gets drawn," the same role Die.tsx's own physical dice already play
  // opposite their own <RigidBody>.
  useFrame(() => {
    const bodies = physicsBodiesRef.current
    if (bodies.size === 0) return
    bodies.forEach((body, mesh) => {
      const t = body.translation()
      const r = body.rotation()
      mesh.position.set(t.x, t.y, t.z)
      mesh.quaternion.set(r.x, r.y, r.z, r.w)
    })
  })

  // Real user report: exact-pixel clicking to pick a mesh piece failed
  // often enough on this dense, miniature-derived geometry to be
  // unusable ("no me funciona bien el click... hazlo mucho más
  // permisivo") — same manual-raycast-with-retry fix as Mech3D's own
  // onSurfaceClick, but with a wider/denser spiral of offsets per that
  // explicit ask, since picking a whole separated limb piece can afford
  // a much bigger miss radius than annotating one small point.
  const groupRef = useRef<THREE.Object3D>(null)
  const { camera, raycaster, gl } = useThree()
  useEffect(() => {
    const canvas = gl.domElement
    const ndc = new THREE.Vector2()
    const onClickNative = (event: MouseEvent) => {
      const proxies = pickingProxiesRef.current
      if (proxies.size === 0) return
      // Raycast the CLEANED picking proxies, never the live rendered
      // group — see buildPickingGeometry's own doc comment for why the
      // live mesh's real triangles can't be trusted for this.
      syncPickingProxies(proxies)
      const proxyList = [...proxies.values()]
      const rect = canvas.getBoundingClientRect()
      const baseX = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const baseY = -((event.clientY - rect.top) / rect.height) * 2 + 1
      for (const [dx, dy] of RAYCAST_RETRY_OFFSETS) {
        ndc.set(baseX + dx, baseY + dy)
        raycaster.setFromCamera(ndc, camera)
        const hits = raycaster.intersectObjects(proxyList, false)
        const namedHit = hits.find((h) => h.object.name)
        if (namedHit) {
          onToggleMesh(namedHit.object.name)
          return
        }
      }
      // Every retry missed — see nearestNamedMeshBySamplePoints's own doc
      // comment for why (a thin part, e.g. the Jenner's own arms, can
      // miss every triangle-precision retry regardless of how wide the
      // spiral is).
      const fallback = nearestNamedMeshBySamplePoints(namedMeshSamplesRef.current, baseX, baseY, camera)
      if (fallback) onToggleMesh(fallback.name)
    }
    canvas.addEventListener('click', onClickNative)
    return () => canvas.removeEventListener('click', onClickNative)
  }, [camera, raycaster, gl, onToggleMesh])

  return (
    <>
      <primitive ref={groupRef} object={instance} scale={MODEL_SCALE} />
      {/* Where a breaking piece actually lives once it starts falling —
          see fallenGroupRef's own doc comment above. Deliberately a
          sibling of the model itself (identity transform, not nested
          under `instance`'s own MODEL_SCALE/normalization scaling) so a
          piece's local Y in here really is a real, predictable unit. */}
      <group ref={fallenGroupRef} />
    </>
  )
}

/** Real user request: "quiero una opcion para que me muestres el rig que
 * hiciste para la anim de idle y movimiento, y que yo pueda tocarlo" +
 * follow-up "los huesos solo me los muestras como un punto... y solo
 * cuando les selecciono... Quiero que se muestren siempre y cuando
 * seleccione uno le aisle" (a small marker per bone, always on, tracking
 * each bone's live world position every frame — a THREE.SkeletonHelper
 * line-wireframe was tried first and dropped, real user report: "los
 * huesos... no como un hueso lineal") + follow-up "no seria mejor
 * representar la esfera, con una piramide o algo asi hasta el hueso
 * linkeado? vamos como en blender": each parent→child bone pair now also
 * gets a 4-sided cone/pyramid ("segment") stretched and oriented between
 * their live world positions, same per-frame tracking as the point
 * markers. Leaf bones (no bone children) keep a plain point marker, since
 * there's no child position to aim a segment at. Isolating a bone shows
 * both its incoming segment (from its parent) and outgoing segment(s) (to
 * its own children), so the chain around it stays visible even when
 * everything else is hidden.
 * Full drag-to-rotate a bone (TransformControls) is a bigger, separate
 * next step — this is the see-and-identify half of "tocarlo", not yet the
 * manipulate half. Fully controlled from MechLabView (clip/bone choice,
 * play/scrub) — same "parent owns state, child applies+reports" pattern
 * FirstPersonView's own WalkingFirstPersonCam already uses, since this
 * codebase deliberately never uses drei's <Html> for in-canvas controls. */
const BONE_AXIS_HANDLE_LEN = 0.13
const BONE_AXIS_DRAG_SENSITIVITY = 0.0035

/** Real user request (Ver rig): "cuando selecciono un hueso... debo poder
 * moverlo, pero no con movimiento libre, debe mostrarme los ejes x y z y
 * dejarme mover 1 cada vez" — two independent handles (X red, Z blue, no
 * Y), each drag only ever touches its own axis of `bone.position`; there's
 * no combined-plane handle, so it's never possible to move both at once.
 * This is a pose-preview nudge, not a real rig edit — nothing here
 * persists, and the next scrub/play re-evaluates the clip and overwrites
 * it, same as grabbing a bone in Blender's pose mode without keying a
 * frame. Pointer capture (not raw onPointerMove tracking) is what keeps
 * the drag alive even if the cursor outruns the small handle mesh in a
 * single mouse-move tick. */
function BoneAxisHandles({
  bone, onDragStateChange, onDragStart,
}: {
  bone: THREE.Bone
  onDragStateChange: (dragging: boolean) => void
  /** Fired once, right as a drag begins (before any mutation) — real user
   * request: "necesito que funcione el Cntl+z para deshacer el ultimo
   * cambio". RigViewer uses this to snapshot the pre-drag value onto its
   * own undo stack. */
  onDragStart: (axis: 'x' | 'z', previousValue: number) => void
}) {
  const groupRef = useRef<THREE.Group>(null)
  const dragRef = useRef<{ axis: 'x' | 'z'; startClientX: number; startValue: number } | null>(null)

  useFrame(() => {
    const g = groupRef.current
    if (g) bone.getWorldPosition(g.position)
  })

  const startDrag = (axis: 'x' | 'z') => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    ;(e.target as unknown as Element).setPointerCapture?.(e.pointerId)
    const startValue = bone.position[axis]
    dragRef.current = { axis, startClientX: e.clientX, startValue }
    onDragStart(axis, startValue)
    onDragStateChange(true)
  }
  const onDrag = (e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current
    if (!drag) return
    e.stopPropagation()
    bone.position[drag.axis] = drag.startValue + (e.clientX - drag.startClientX) * BONE_AXIS_DRAG_SENSITIVITY
  }
  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!dragRef.current) return
    ;(e.target as unknown as Element).releasePointerCapture?.(e.pointerId)
    dragRef.current = null
    onDragStateChange(false)
  }

  return (
    <group ref={groupRef}>
      <mesh
        position={[BONE_AXIS_HANDLE_LEN, 0, 0]} rotation={[0, 0, -Math.PI / 2]}
        onPointerDown={startDrag('x')} onPointerMove={onDrag} onPointerUp={endDrag}
      >
        <coneGeometry args={[0.014, 0.055, 8]} />
        <meshBasicMaterial color="#e35d5d" depthTest={false} />
      </mesh>
      <mesh
        position={[0, 0, BONE_AXIS_HANDLE_LEN]} rotation={[Math.PI / 2, 0, 0]}
        onPointerDown={startDrag('z')} onPointerMove={onDrag} onPointerUp={endDrag}
      >
        <coneGeometry args={[0.014, 0.055, 8]} />
        <meshBasicMaterial color="#6ea8e3" depthTest={false} />
      </mesh>
    </group>
  )
}

// Real user request: "en mech lab me dejas hacer un cuadro alrededor de
// un pie, ese cuadro debe cortar una seccion de la malla y nos da la
// forma exacta de la huella, la guardamos en un png" — a real per-chassis
// footprint shape, since Mech3D.tsx's own skin-weight-based getFootShape
// can come back empty on a rig like the Jenner's (PieD/PieI are pure IK
// sockets with zero skinned vertices — confirmed by directly inspecting
// that GLB — so there's no vertex-membership shape to derive there at
// all).
//
// First version used a screen-space rubber-band drag (raycasting the 4
// corners against a FIXED camera). Real user correction after trying it:
// "da igual donde haga el cuadro, siempre aparece en blanco... si no me
// dejas mover la camara como voy a hacer un cuadro en un sitio correcto"
// — blocking camera orbit for the whole tab (so a screen-space drag
// wouldn't also spin the camera) meant the box could only ever be drawn
// against whatever the DEFAULT camera angle happened to show, which
// often wasn't even framing a foot; and "el cuadro me debes dejar
// ponerle, rotarle, desplazarle... debe ser fijo, y que mire lo que 'hay
// dentro' en un slice" — they want a real, persistent, freely
// positionable/rotatable 3D box, not a one-shot 2D rectangle.
//
// This version: a real BoxGeometry mesh, moved/rotated/scaled via drei's
// <TransformControls> (same gizmo pattern used everywhere else 3D
// manipulation is needed), completely independent of the camera — the
// user orbits the view with the mouse as always, and separately drags
// the box's own gizmo handles to position it. Capture derives an
// orthographic camera DIRECTLY from the box's own transform (position/
// quaternion/scale) rather than raycasting anything, so it's an exact
// "slice" of the box's own volume in the box's own local space — this
// is what actually gives a real slice for free: an orthographic
// frustum's near/far/left/right/top/bottom EXACTLY matching the box's
// own local half-extents on all 3 axes clips everything outside it on
// every side, with no separate clip-plane logic needed. Rotating the box
// rotates the captured slice's own orientation right along with it.
interface FootprintCaptureHandle {
  capture: () => void
}

/** `halfWidth`/`halfDepth` are the gizmo box's own half-extents at capture
 * time, in the SAME normalized (pre-MODEL_SCALE) units as Mech3D.tsx's own
 * FootShape — see saveMechFootprintMask's own doc comment for why: a real
 * caller (Mech3D.tsx's footstep stamping) multiplies by MODEL_SCALE
 * itself, exactly like it already does for the geometric-fallback foot
 * size, so this needs to travel with the image rather than being
 * re-derived later from a box that no longer exists by then. */
interface FootprintCaptureResult {
  dataUrl: string
  halfWidth: number
  halfDepth: number
}

const FOOTPRINT_CAPTURE_RESOLUTION = 256
const FOOTPRINT_BOX_DEFAULT_POSITION: [number, number, number] = [0.12, 0.08, 0.06]
const FOOTPRINT_BOX_DEFAULT_SCALE: [number, number, number] = [0.15, 0.12, 0.22]

const FootprintCapture = forwardRef<FootprintCaptureHandle, {
  chassis: string
  model: string | null
  /** See LimbPainter's own doc comment on the identical prop. */
  weapons: { location: string; weaponName: string }[]
  transformMode: 'translate' | 'rotate' | 'scale'
  onDraggingChange: (dragging: boolean) => void
  onCapture: (result: FootprintCaptureResult) => void
}>(function FootprintCapture({ chassis, model, weapons, transformMode, onDraggingChange, onCapture }, ref) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene } = useGLTF(url)
  const instance = useMemo(() => normalizeMechInstance(scene), [scene])
  // applyColorBoost: false — see LimbPainter's own doc comment on its
  // identical useMechPbr call for why (real user report: "en... huella lo
  // veo blanco").
  useMechPbr(instance, { applyColorBoost: false })
  // See LimbPainter's own identical effect for why weapons/undefined/
  // undefined (real loadout, always-normal condition).
  const footprintWeaponsKey = weapons.map((w) => `${w.location}:${w.weaponName}`).join(',')
  useEffect(() => {
    applyMechCombatVisibility(instance, weapons, undefined, undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, footprintWeaponsKey])
  const { gl } = useThree()
  const modelGroupRef = useRef<THREE.Group>(null)
  // Real bug found live (user report: "da igual donde haga el cuadro,
  // siempre aparece en blanco"): TransformControls with NO `object` prop
  // and the box as its JSX CHILD does not attach to the box mesh itself
  // — it silently renders its own internal wrapper <group> around the
  // children and attaches to THAT instead, so every drag was moving a
  // group my own code never had a reference to, while `boxRef` (this
  // mesh's own local transform) sat frozen at its original JSX props the
  // whole time — capture kept reading that same frozen default position/
  // size no matter how the visible gizmo box was actually dragged. Fixed
  // by attaching explicitly (`object={box}`) to the REAL mesh, rendered
  // as TransformControls' SIBLING, not its child — a plain object
  // instance (not a ref) is required, hence state + a callback ref
  // instead of the usual useRef, so it can't be attached before the mesh
  // actually exists.
  const [box, setBox] = useState<THREE.Mesh | null>(null)

  useImperativeHandle(ref, () => ({
    capture: () => {
      const model = modelGroupRef.current
      if (!model || !box) return

      const halfWidth = box.scale.x / 2
      const halfHeight = box.scale.y / 2
      const halfDepth = box.scale.z / 2

      const orthoCam = new THREE.OrthographicCamera(
        -halfWidth, halfWidth, halfDepth, -halfDepth, 0.001, box.scale.y + 0.001,
      )
      // Positioned at the box's own local TOP (not its center — sitting
      // at the center would only ever see the lower half, since near/far
      // only extend forward from the camera, never behind it), oriented
      // by the box's own quaternion so a rotated box tilts the slice
      // with it. Cameras look down their own local -Z by default; an
      // extra -90° tilt around the camera's own (now box-aligned) local
      // X re-aims that at the box's local -Y ("down" through the box),
      // same "avoid the degenerate straight-down default up vector"
      // reasoning GMView's own top-down game camera already uses,
      // applied via an explicit local rotation instead of a manual up-
      // vector/lookAt this time since the box can be arbitrarily rotated.
      const topOffset = new THREE.Vector3(0, halfHeight, 0).applyQuaternion(box.quaternion)
      orthoCam.position.copy(box.position).add(topOffset)
      orthoCam.quaternion.copy(box.quaternion)
      orthoCam.rotateX(-Math.PI / 2)
      orthoCam.updateMatrixWorld(true)
      orthoCam.updateProjectionMatrix()

      // Flat unlit white on every mesh in the capture, restored right
      // after — the output is meant to read as a clean silhouette/
      // coverage mask, not a lit render.
      const originals: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = []
      const maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
      model.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          originals.push({ mesh: obj, material: obj.material })
          obj.material = maskMaterial
        }
      })

      const renderTarget = new THREE.WebGLRenderTarget(FOOTPRINT_CAPTURE_RESOLUTION, FOOTPRINT_CAPTURE_RESOLUTION)
      const prevTarget = gl.getRenderTarget()
      const prevClearColor = new THREE.Color()
      gl.getClearColor(prevClearColor)
      const prevClearAlpha = gl.getClearAlpha()
      gl.setRenderTarget(renderTarget)
      gl.setClearColor(0x000000, 0)
      gl.clear(true, true, true)
      gl.render(model, orthoCam)

      const pixels = new Uint8Array(FOOTPRINT_CAPTURE_RESOLUTION * FOOTPRINT_CAPTURE_RESOLUTION * 4)
      gl.readRenderTargetPixels(renderTarget, 0, 0, FOOTPRINT_CAPTURE_RESOLUTION, FOOTPRINT_CAPTURE_RESOLUTION, pixels)

      gl.setRenderTarget(prevTarget)
      gl.setClearColor(prevClearColor, prevClearAlpha)
      renderTarget.dispose()
      maskMaterial.dispose()
      for (const { mesh, material } of originals) mesh.material = material

      const outCanvas = document.createElement('canvas')
      outCanvas.width = FOOTPRINT_CAPTURE_RESOLUTION
      outCanvas.height = FOOTPRINT_CAPTURE_RESOLUTION
      const ctx = outCanvas.getContext('2d')
      if (!ctx) return
      const imageData = ctx.createImageData(FOOTPRINT_CAPTURE_RESOLUTION, FOOTPRINT_CAPTURE_RESOLUTION)
      const n = FOOTPRINT_CAPTURE_RESOLUTION
      // WebGL read-back rows go bottom-to-top; canvas ImageData wants
      // top-to-bottom — flip.
      for (let row = 0; row < n; row++) {
        const srcRow = n - 1 - row
        imageData.data.set(pixels.subarray(srcRow * n * 4, (srcRow + 1) * n * 4), row * n * 4)
      }
      ctx.putImageData(imageData, 0, 0)
      onCapture({ dataUrl: outCanvas.toDataURL('image/png'), halfWidth, halfDepth })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [gl, box])

  return (
    <>
      <primitive ref={modelGroupRef} object={instance} />
      <mesh ref={setBox} position={FOOTPRINT_BOX_DEFAULT_POSITION} scale={FOOTPRINT_BOX_DEFAULT_SCALE}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#6ea8e3" wireframe transparent opacity={0.7} />
      </mesh>
      {/* Real user request: independent of camera orbit — dragging this
          gizmo's own handles must never also spin the view. drei's
          TransformControls' own onMouseDown/onMouseUp are exactly what
          MechLabView's own onDraggingChange uses to disable OrbitControls
          for the drag's duration, same "boneDragging" pattern the Ver rig
          tab's own custom gizmo already established. Only rendered once
          the box mesh actually exists (object needs a real instance, not
          a possibly-null ref). */}
      {box && (
        <TransformControls
          object={box} mode={transformMode} size={0.6}
          onMouseDown={() => onDraggingChange(true)}
          onMouseUp={() => onDraggingChange(false)}
        />
      )}
    </>
  )
})

function RigViewer({
  chassis, model, weapons, activeClip, playing, scrub, selectedBone,
  onClipsChange, onBonesChange, onScrubChange, onInfluencePercentChange, onBoneDragChange,
}: {
  chassis: string
  model: string | null
  /** See LimbPainter's own doc comment on the identical prop. */
  weapons: { location: string; weaponName: string }[]
  activeClip: string | null
  playing: boolean
  /** 0..1 — authoritative only while `playing` is false (the user is
   * scrubbing); while playing, this component drives time forward itself
   * and reports it up via onScrubChange instead. */
  scrub: number
  selectedBone: string | null
  onClipsChange: (names: string[]) => void
  onBonesChange: (names: string[]) => void
  onScrubChange: (value: number) => void
  /** % of the skinned mesh's vertices the selected bone actually moves —
   * real user request: "tambien me debe mostrar la cantidad de malla a la
   * que afecta pintandola." null when there's no selection/skin to measure. */
  onInfluencePercentChange: (percent: number | null) => void
  /** So MechLabView can disable OrbitControls while a bone-axis handle is
   * being dragged — otherwise orbiting and dragging fight over the same
   * pointer gesture. */
  onBoneDragChange: (dragging: boolean) => void
}) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene, animations: gltfAnimations } = useGLTF(url)
  // Real user report: Ver rig is the one place actually meant to show
  // whether a chassis's animation looks right — showing it the RAW,
  // still-wrong borrowed atlas_ clip here (while the game itself plays
  // the corrected version via Mech3D's own resolveClipKey) defeated the
  // entire point of asking to check it here. Same correction as Mech3D's
  // own animations memo (see buildRetargetedBorrowedClip's own doc
  // comment), but SUBSTITUTED under the clip's ORIGINAL name instead of
  // added alongside it — this component's own clip-button list is keyed
  // directly off these names, and there's no reason to make picking
  // between a "atlas_moveCoreIdle" and a "atlas_moveCoreIdle__retargeted"
  // button someone's problem here; showing the corrected pose IS showing
  // the animation, full stop.
  const animations = useMemo(() => {
    if (chassis?.toLowerCase() === KNOWN_BORROWED_CLIP_PREFIX) return gltfAnimations
    const chassisRestQuats = getChassisRestQuats(scene)
    return gltfAnimations.map((clip) => {
      if (!clip.name.toLowerCase().startsWith(`${KNOWN_BORROWED_CLIP_PREFIX}_`)) return clip
      const retargeted = buildRetargetedBorrowedClip(clip, chassisRestQuats)
      return new THREE.AnimationClip(clip.name, retargeted.duration, retargeted.tracks)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltfAnimations, scene, chassis])
  const groupRef = useRef<THREE.Group>(null)
  const instance = useMemo(() => normalizeMechInstance(scene), [scene])
  // applyColorBoost: false — see LimbPainter's own doc comment on its
  // identical useMechPbr call for why (real user report: "en ver rig...
  // lo veo blanco").
  useMechPbr(instance, { applyColorBoost: false })
  // See LimbPainter's own identical effect for why weapons/undefined/
  // undefined (real loadout, always-normal condition).
  const rigWeaponsKey = weapons.map((w) => `${w.location}:${w.weaponName}`).join(',')
  useEffect(() => {
    applyMechCombatVisibility(instance, weapons, undefined, undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, rigWeaponsKey])
  const { actions } = useAnimations(animations, groupRef)
  const boneMarkerRefs = useRef<Map<string, THREE.Object3D>>(new Map())
  const segmentRefs = useRef<Map<string, THREE.Object3D>>(new Map())
  const tmpParentPos = useRef(new THREE.Vector3()).current
  const tmpChildPos = useRef(new THREE.Vector3()).current
  const tmpDir = useRef(new THREE.Vector3()).current
  // Real user request: "necesito que funcione el Cntl+z para deshacer el
  // ultimo cambio" — one entry per bone-axis drag, pushed right as the
  // drag starts (see BoneAxisHandles' own onDragStart). Cleared whenever
  // the model changes so Ctrl+Z can never reach into a previous model's
  // now-detached bones.
  const undoStackRef = useRef<{ bone: THREE.Bone; axis: 'x' | 'z'; value: number }[]>([])

  useEffect(() => {
    onClipsChange(animations.map((a) => a.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animations])

  const skinnedMesh = useMemo(() => findSkinnedMesh(instance), [instance])
  const bones = skinnedMesh?.skeleton.bones ?? []

  useEffect(() => {
    undoStackRef.current = []
  }, [skinnedMesh])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      const last = undoStackRef.current.pop()
      if (!last) return
      e.preventDefault()
      last.bone.position[last.axis] = last.value
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    onBonesChange(bones.map((b) => b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinnedMesh])

  // Blender-style "bone" shape: a segment per parent→child pair among this
  // skeleton's own bones (not every Object3D child — a bone can have a
  // non-bone child, e.g. an attachment point, which isn't part of the
  // chain). Bones with no bone children (hands, feet, head tip, …) have no
  // segment of their own and fall back to a plain point marker below.
  const segments = useMemo(() => {
    const boneSet = new Set(bones)
    const segs: { key: string; parent: THREE.Bone; child: THREE.Bone }[] = []
    for (const bone of bones) {
      for (const child of bone.children) {
        if ((child as THREE.Bone).isBone && boneSet.has(child as THREE.Bone)) {
          segs.push({ key: `${bone.name}->${child.name}`, parent: bone, child: child as THREE.Bone })
        }
      }
    }
    return segs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinnedMesh])
  const leafBones = useMemo(
    () => bones.filter((b) => !segments.some((s) => s.parent === b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skinnedMesh, segments],
  )
  const selectedBoneObj = selectedBone ? bones.find((b) => b.name === selectedBone) ?? null : null

  const handleBoneDragStart = (axis: 'x' | 'z', previousValue: number) => {
    if (!selectedBoneObj) return
    undoStackRef.current.push({ bone: selectedBoneObj, axis, value: previousValue })
  }

  // Real user request: "tambien me debe mostrar la cantidad de malla a la
  // que afecta pintandola" — same paint-by-bone technique LimbPainter uses
  // for "partir" a limb, applied here just to SHOW which vertices a bone
  // actually drives, plus a rough % readout.
  useEffect(() => {
    if (!skinnedMesh) return
    let percent: number | null = null
    if (selectedBone) {
      const mask = boneInfluenceMask(skinnedMesh, new Set([selectedBone]))
      if (mask) {
        paintInfluenceMask(skinnedMesh, mask)
        percent = (100 * mask.filter(Boolean).length) / mask.length
      }
    } else {
      paintInfluenceMask(skinnedMesh, null)
    }
    const mat = skinnedMesh.material as THREE.MeshStandardMaterial
    mat.vertexColors = percent != null
    mat.needsUpdate = true
    onInfluencePercentChange(percent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinnedMesh, selectedBone])

  useEffect(() => {
    if (!activeClip) return
    const action = actions[activeClip]
    action?.reset().play()
    return () => {
      action?.stop()
    }
  }, [actions, activeClip])

  useEffect(() => {
    if (!activeClip) return
    const action = actions[activeClip]
    if (action) action.paused = !playing
  }, [playing, actions, activeClip])

  // Applies the parent's scrub value only while paused — while playing,
  // the useFrame below drives it forward and reports back up instead, so
  // the two never fight over who owns `time`.
  useEffect(() => {
    if (playing || !activeClip) return
    const action = actions[activeClip]
    if (!action) return
    const duration = action.getClip().duration
    action.time = scrub * duration
    action.paused = true
    // .time alone doesn't re-evaluate the skeleton pose until the mixer
    // is actually stepped — a manual zero-delta update forces that.
    action.getMixer().update(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrub, playing, activeClip])

  useFrame(() => {
    if (playing && activeClip) {
      const action = actions[activeClip]
      const duration = action?.getClip().duration ?? 0
      if (action && duration > 0) onScrubChange(action.time / duration)
    }
    for (const bone of leafBones) {
      const marker = boneMarkerRefs.current.get(bone.name)
      if (marker) bone.getWorldPosition(marker.position)
    }
    for (const seg of segments) {
      const mesh = segmentRefs.current.get(seg.key)
      if (!mesh) continue
      seg.parent.getWorldPosition(tmpParentPos)
      seg.child.getWorldPosition(tmpChildPos)
      mesh.position.copy(tmpParentPos).add(tmpChildPos).multiplyScalar(0.5)
      const length = tmpParentPos.distanceTo(tmpChildPos)
      if (length > 1e-6) {
        tmpDir.copy(tmpChildPos).sub(tmpParentPos).normalize()
        mesh.quaternion.setFromUnitVectors(BONE_SEGMENT_UP, tmpDir)
        mesh.scale.set(1, length, 1)
      }
    }
  })

  const visibleLeafBones = selectedBone ? leafBones.filter((b) => b.name === selectedBone) : leafBones
  const visibleSegments = selectedBone
    ? segments.filter((s) => s.parent.name === selectedBone || s.child.name === selectedBone)
    : segments

  return (
    <>
      <primitive ref={groupRef} object={instance} scale={MODEL_SCALE} />
      {visibleSegments.map((seg) => (
        <mesh
          key={seg.key}
          ref={(el) => {
            if (el) segmentRefs.current.set(seg.key, el)
            else segmentRefs.current.delete(seg.key)
          }}
        >
          <coneGeometry args={[selectedBone ? 0.035 : 0.018, 1, 4]} />
          <meshBasicMaterial color={BONE_MARKER_COLOR} depthTest={false} transparent opacity={selectedBone ? 1 : 0.85} />
        </mesh>
      ))}
      {visibleLeafBones.map((bone) => (
        <mesh
          key={bone.name}
          ref={(el) => {
            if (el) boneMarkerRefs.current.set(bone.name, el)
            else boneMarkerRefs.current.delete(bone.name)
          }}
        >
          <sphereGeometry args={[selectedBone ? 0.05 : 0.02, 10, 10]} />
          <meshBasicMaterial color={BONE_MARKER_COLOR} depthTest={false} transparent opacity={selectedBone ? 1 : 0.85} />
        </mesh>
      ))}
      {selectedBoneObj && !playing && (
        <BoneAxisHandles bone={selectedBoneObj} onDragStateChange={onBoneDragChange} onDragStart={handleBoneDragStart} />
      )}
    </>
  )
}

/** New user request: "otra 4ª categoria en mechlab por cada mech que sea
 * Textura, que muestre el PBR y unos sliders para configurar la
 * roughness, glossyness y todas las caracteristicas" — a plain preview +
 * live tuning panel for useMechPbr's own settings, since MECH_PBR_DEFAULTS
 * was only ever tuned against one chassis (the Jenner) and PBR now applies
 * to every mech ("esto tiene que ser generico") — lets each one be
 * re-tuned by eye instead of every chassis silently inheriting that one
 * mech's own calibration. Client-side preview only — no save button,
 * nothing persisted; MechLabView's own `pbrSettings` state resets to
 * MECH_PBR_DEFAULTS on every mode/model switch. */
function TextureTuner({
  chassis, model, weapons, settings,
}: {
  chassis: string
  model: string | null
  /** See LimbPainter's own doc comment on the identical prop. */
  weapons: { location: string; weaponName: string }[]
  settings: MechPbrSettings
}) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene } = useGLTF(url)
  const instance = useMemo(() => normalizeMechInstance(scene), [scene])
  useMechPbr(instance, { settings })
  // See LimbPainter's own identical effect for why weapons/undefined/
  // undefined (real loadout, always-normal condition) — applyColorBoost
  // stays at its default (true) here on purpose, unlike the other three
  // viewers: this tab's whole point IS previewing that boost.
  const textureWeaponsKey = weapons.map((w) => `${w.location}:${w.weaponName}`).join(',')
  useEffect(() => {
    applyMechCombatVisibility(instance, weapons, undefined, undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, textureWeaponsKey])
  return <primitive object={instance} scale={MODEL_SCALE} />
}


export function MechLabView() {
  const [chassisOptions, setChassisOptions] = useState<MechChassisResult[]>([])
  const [selectedChassis, setSelectedChassis] = useState('')
  const [modelOptions, setModelOptions] = useState<MechModelResult[]>([])
  const [selectedModelFile, setSelectedModelFile] = useState('')

  const [mode, setMode] = useState<Mode>('annotate')
  // Textura tab's own live tuning state — see TextureTuner's own doc
  // comment. Real user follow-up: "quiero poder guardarlo desde el
  // mechlab y como lo demas, 3 estados y un marcador en el desplegable" —
  // persisted per model_url now (see allPbrSettings below), same "seed
  // from server on modelUrl change" pattern as `points`/allAnnotations —
  // so it DOES reset per model after all, to whatever was last saved for
  // THAT model (or the generic defaults if nothing was ever saved there).
  const [pbrSettings, setPbrSettings] = useState<MechPbrSettings>(MECH_PBR_DEFAULTS)
  const [allPbrSettings, setAllPbrSettings] = useState<MechPbrSettingsRecord[]>([])

  const [allAnnotations, setAllAnnotations] = useState<MechAnnotation[]>([])
  const [points, setPoints] = useState<MechAnnotationPoint[]>([])
  const [activeSlot, setActiveSlot] = useState<ActiveSlot | null>(null)
  // Real user request: "con el cambio de modelos... tienes como sacar el
  // punto desde donde disparan? o te lo tengo que dar yo" — see
  // computeWeaponMuzzlePoints's own doc comment. Populated by Mech3D's own
  // instanceRef prop (the 'annotate' mode <Mech3D> call below) with the
  // SAME live, already-MODEL_SCALE-rendered instance it draws with.
  const annotateInstanceRef = useRef<THREE.Object3D | null>(null)
  // Same purpose as annotateInstanceRef, for LimbPainter's own separately-
  // built instance (the 'limbs' tab doesn't render through <Mech3D> at
  // all) — real user request: "también podremos... encontrar las
  // extremidades porque los nuevos modelos están nombrados y separados?"
  const limbInstanceRef = useRef<THREE.Object3D | null>(null)
  const [fpvPreview, setFpvPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const [activeLimb, setActiveLimb] = useState<LimbLocation | null>(null)
  const [previewBreak, setPreviewBreak] = useState(false)

  // Footprint-capture tab — see FootprintCapture's own doc comment. A
  // real, persistent 3D box (TransformControls: mover/rotar/escalar),
  // independent of camera orbit — footprintDragging only ever tracks the
  // GIZMO's own drag (via FootprintCapture's onDraggingChange), the same
  // "boneDragging" pattern the Ver rig tab's own gizmo already uses to
  // disable OrbitControls just for that.
  const footprintCaptureRef = useRef<FootprintCaptureHandle>(null)
  const [footprintCapture, setFootprintCapture] = useState<FootprintCaptureResult | null>(null)
  const [footprintDragging, setFootprintDragging] = useState(false)
  const [footprintTransformMode, setFootprintTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate')
  // Real user request: "quiero un boton de guardar, para cuando capture
  // una, que se use esa siempre" — same "seed from server on modelUrl
  // change" pattern as allPbrSettings/allAnnotations, so switching back to
  // a chassis that already has a saved mask shows it immediately instead
  // of looking empty until a fresh capture.
  const [allFootprintMasks, setAllFootprintMasks] = useState<MechFootprintMaskRecord[]>([])

  // Real bug hunt this session: a real crash earlier (reparenting a mesh
  // from inside instance.traverse(), now fixed) took the WHOLE WebGL
  // context down with it ("THREE.WebGLRenderer: Context Lost" in the
  // console) — and a lost context does NOT self-heal; nothing drawn to
  // this <canvas> after that point renders again, silently, no matter
  // how correct any later code is, until the page gets a REAL full
  // reload (not just re-navigating inside the SPA). That's the leading
  // suspect for "nada de lo que haces funciona" persisting even through
  // a plain, isolated diagnostic — so surface it loudly instead of
  // leaving a dead, silently-inert canvas that looks identical to one
  // that's simply not doing anything.
  const [webglContextLost, setWebglContextLost] = useState(false)

  // Real user request: "me gustaria que me pongas de cada mech, donde
  // tiene sus armas, para facilitarme el trabajo. Las fichas ya lo
  // reciben" — the exact same local MTF catalog GMView's/PlayerView's own
  // mech-creation forms already read via getMechImport, just displayed
  // instead of turned into a real mech record.
  const [templateWeapons, setTemplateWeapons] = useState<{ weapon_name: string; location: string }[]>([])
  // Mech3D's own `weapons` prop shape (camelCase weaponName) — same data,
  // just renamed to match what its weapon-mount-visual assignment expects.
  const templateWeaponsForMech3D = useMemo(
    () => templateWeapons.map((w) => ({ location: w.location, weaponName: w.weapon_name })),
    [templateWeapons],
  )

  const [rigClipNames, setRigClipNames] = useState<string[]>([])
  const [rigActiveClip, setRigActiveClip] = useState<string | null>(null)
  // Real user report: "en ver rig, los brazos estan mal colocados... y el
  // cristal de la cabina tambien" — RigViewer used to auto-select AND
  // auto-play the first clip in the list (alphabetically, an attack pose
  // for the Warhammer) the instant its clip names loaded. That was a
  // harmless no-op before this session's Blender NLA-bake fix (every clip
  // was frozen on a single static pose anyway), but now that clips
  // actually animate, this tab silently opened mid-attack-pose instead of
  // the same neutral bind pose every OTHER MechLab tab shows by default —
  // reading as "the rig is wrong" when it's really just showing a
  // perfectly real animated pose nobody asked to see yet. Starting
  // unselected/paused (see rigActiveClip's own effect below, now removed)
  // leaves the model on its plain bind pose until the user actually picks
  // a clip, matching annotate/limbs/textura/huella.
  const [rigPlaying, setRigPlaying] = useState(false)
  const [rigScrub, setRigScrub] = useState(0)
  const [rigBoneNames, setRigBoneNames] = useState<string[]>([])
  const [selectedBone, setSelectedBone] = useState<string | null>(null)
  const [rigInfluencePercent, setRigInfluencePercent] = useState<number | null>(null)
  const [boneDragging, setBoneDragging] = useState(false)

  const [limbBoneInfo, setLimbBoneInfo] = useState<BoneInfo[]>([])
  const limbBoneNames = useMemo(() => limbBoneInfo.map((b) => b.name), [limbBoneInfo])
  const [limbMeshNodeNames, setLimbMeshNodeNames] = useState<string[]>([])

  const [reviewByKey, setReviewByKey] = useState<Map<string, MechAnnotationReviewStatus>>(new Map())

  const applyReviewRow = (row: MechAnnotationReview) => {
    setReviewByKey((prev) => new Map(prev).set(reviewKey(row.chassis, row.track), row.status))
  }

  // Real user constraint: "Solo yo puedo aceptar cada parte" — 'accepted'
  // is never set here, only by the explicit ReviewBadge button below.
  // Never downgrades an already-'accepted' track back to 'done' — once the
  // user has accepted a track it stays accepted until they explicitly
  // unmark it, even if the underlying points get edited/resaved again.
  const bumpReviewToDone = (chassis: string, track: MechAnnotationTrack) => {
    if (reviewStatusFor(reviewByKey, chassis, track) !== 'not_started') return
    setMechAnnotationReview(chassis, track, 'done').then(applyReviewRow).catch(() => {})
  }

  const setReviewStatus = (chassis: string, track: MechAnnotationTrack, status: MechAnnotationReviewStatus) => {
    setMechAnnotationReview(chassis, track, status).then(applyReviewRow).catch(() => {})
  }

  useEffect(() => {
    // Real user correction: "yo solo te pedia los de los que tenemos
    // modelo 3d... los otros no tiene sentido que los editemos ahora" —
    // a chassis with no curated asset falls back to the generic unbranded
    // placeholder, not worth annotating specifically.
    // Real user request: "quita todos los chasis del desplegable de
    // mechlab menos bushwacker" — narrows THIS dropdown only, not the
    // shared MECH_CHASSIS_ASSETS registry itself (that one also drives
    // TableView/GMView mech spawning, which still needs every chassis).
    // Annihilator added once it finished the same full pipeline pass.
    const READY_CHASSIS = new Set([
      'Bushwacker', 'Annihilator', 'Archer', 'Assassin', 'Wolverine',
      'Atlas', 'Awesome', 'Banshee', 'BattleMaster', 'Blackjack', 'Black Knight', 'Cataphract', 'Catapult',
      'Champion', 'Cicada', 'Commando', 'Crab', 'Cyclops',
      'Centurion', 'Charger', 'Crusader',
      'Dervish', 'Dragon', 'Enforcer', 'Firestarter', 'Flea', 'Grasshopper', 'Griffin', 'Hatamoto-Chi',
    ])
    listMechChassis()
      .then((all) => setChassisOptions(all.filter((c) => READY_CHASSIS.has(c.chassis))))
      .catch(() => {})
    listMechAnnotations().then(setAllAnnotations).catch(() => {})
    listMechAnnotationReview()
      .then((rows) => setReviewByKey(new Map(rows.map((r) => [reviewKey(r.chassis, r.track), r.status]))))
      .catch(() => {})
    listMechPbrSettings().then(setAllPbrSettings).catch(() => {})
    listMechFootprintMasks().then(setAllFootprintMasks).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedChassis) {
      setModelOptions([])
      return
    }
    // Real user correction: "NO QUIERO que en el mechlab me muestres los
    // modelos especificos que no tengo... Solo me debes mostrar el
    // modelo que tengo" — a chassis like Commando lists many real MTF
    // variants (COM-1B, COM-2D, …), but mechAssets.ts only ever has a
    // curated .glb for the ONE variant actually modeled (or none, just a
    // chassis-wide placeholder); every other variant would silently
    // resolve to that SAME shared file, which isn't worth listing
    // separately here (unlike the create-mech dropdowns elsewhere, where
    // showing every real variant is the whole point).
    const dedicated = MECH_CHASSIS_ASSETS[selectedChassis]?.models ?? {}
    listMechModels(selectedChassis)
      .then((all) => setModelOptions(all.filter((m) => m.model in dedicated)))
      .catch(() => setModelOptions([]))
    setSelectedModelFile('')
  }, [selectedChassis])

  useEffect(() => {
    if (!selectedModelFile) {
      setTemplateWeapons([])
      return
    }
    getMechImport(selectedModelFile).then((data) => setTemplateWeapons(data.weapons)).catch(() => setTemplateWeapons([]))
  }, [selectedModelFile])

  const weaponsByLocation = useMemo(() => {
    const map: Partial<Record<(typeof MECH_LOCATIONS)[number], string[]>> = {}
    for (const w of templateWeapons) {
      const loc = w.location as (typeof MECH_LOCATIONS)[number]
      ;(map[loc] ??= []).push(w.weapon_name)
    }
    return map
  }, [templateWeapons])

  const selectedModel = modelOptions.find((m) => m.file === selectedModelFile)?.model ?? null
  const modelUrl = selectedChassis ? resolveMechModelUrl(selectedChassis, selectedModel) : null
  const currentTrack: MechAnnotationTrack =
    mode === 'annotate' ? 'weapons'
      : mode === 'limbs' ? 'limbs'
      : mode === 'texture' ? 'texture'
      : mode === 'footprint' ? 'footprint'
      : 'rig'
  // Real user request: "cuando acepto el estado de una parte, se vuelve
  // NO EDITABLE... si quiero editarlo tengo que volver a dar el botón
  // para devolverlo a Hecho" — a safeguard against accidentally messing
  // up something already reviewed. Only weapons/limbs actually have
  // save-able edits to lock; Rig has nothing destructive to guard.
  // Real user request (later): "los marcadores... deberian estar en el
  // chasis ahora" — keyed by selectedChassis (was modelUrl).
  const isTrackLocked = selectedChassis !== '' && reviewStatusFor(reviewByKey, selectedChassis, currentTrack) === 'accepted'

  // Seed the editable point set from whatever's already saved for this
  // model_url the moment it changes — re-picking an already-annotated
  // mech (or coming back to one) shows its real, persisted points.
  useEffect(() => {
    if (!modelUrl) {
      setPoints([])
      return
    }
    setPoints(
      allAnnotations
        .filter((a) => a.model_url === modelUrl)
        .map((a) => ({ kind: a.kind, location: a.location, x: a.x, y: a.y, z: a.z, mesh_names: a.mesh_names })),
    )
    setPbrSettings(findSavedPbrSettings(allPbrSettings, modelUrl) ?? MECH_PBR_DEFAULTS)
    const savedFootprint = allFootprintMasks.find((r) => r.model_url === modelUrl)
    setFootprintCapture(
      savedFootprint
        ? { dataUrl: savedFootprint.image_data_url, halfWidth: savedFootprint.half_width, halfDepth: savedFootprint.half_depth }
        : null,
    )
    setActiveSlot(null)
    setActiveLimb(null)
    setPreviewBreak(false)
    setFpvPreview(false)
    setSavedFlash(false)
    setMode('annotate')
    setRigActiveClip(null)
    setRigPlaying(false)
    setRigScrub(0)
    setSelectedBone(null)
    // allAnnotations/allPbrSettings/allFootprintMasks intentionally
    // excluded — only a real modelUrl change should reseed from the
    // server; a local save's own optimistic merge
    // below already keeps `points` in sync without needing this to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl])

  // Real user report: "en ver rig, los brazos estan mal colocados... y el
  // cristal de la cabina tambien" — this used to auto-select AND auto-play
  // `rigClipNames[0]` the instant clips loaded (a hand-rigged chassis's
  // own convention always ships "Idle" first, so this happened to look
  // like the neutral standing pose there — but a raw game-extracted
  // chassis's clips just come in export order, alphabetically, landing on
  // "attackFireBothMed" for the Warhammer). Auto-selecting even the real
  // Idle clip instead still doesn't help: ANY selected clip, including
  // Idle, poses the rig into ITS OWN real standing stance (arms held
  // forward, weapons ready — apparently the actual authored idle pose for
  // this chassis), which will always look different from the plain BIND
  // pose annotate/limbs/textura/huella all show with no animation applied
  // at all. Leaving this unselected keeps RigViewer on that exact same
  // bind pose by default too — genuinely consistent with every other tab
  // — until the user deliberately clicks a clip to preview it.


  // Real user request: 'rig' has no explicit save button (there's nothing
  // to persist besides the annotation points) — its own review status is
  // set to 'done' automatically the moment the tab is opened for a model
  // that actually has clips to look at.
  useEffect(() => {
    if (mode === 'rig' && selectedChassis && rigClipNames.length > 0) bumpReviewToDone(selectedChassis, 'rig')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedChassis, rigClipNames])

  const cockpitPoint = points.find((p) => p.kind === 'cockpit')
  const activeLimbPoint = points.find((p) => p.kind === 'limb' && p.location === activeLimb)
  // mesh_names holds a mix of real mesh-node names and bone names (see
  // LimbPainter's own doc comment) — activeLimbMeshNames is the full raw
  // membership (used for the "piezas marcadas" list and for the 3D
  // click-highlight, which checks against actual mesh object names);
  // activeLimbBoneNames is just the subset that are ALSO real bone names
  // of this model, for the skin-weight paint/cut-fragment path.
  //
  // Real bug found this session (screenshot: a genuinely separate,
  // directly-picked mesh piece stayed in place while a SECOND, contorted
  // red blob hovered uselessly nearby, unattached to anything —
  // "selecciono romper esta extremidad y NO PASA NADA"): a piece's own
  // glTF node name can ALSO happen to be a real bone name (Blender
  // commonly names a separated mesh object after the bone that used to
  // drive it), so it was landing in BOTH sets — LimbPainter then tried to
  // build a bone-cut FRAGMENT from whatever unrelated skinned mesh
  // findSkinnedMesh happened to pick (using that name as a bone
  // selector), on top of the real mesh node's own direct fall — two
  // different, uncoordinated things happening for one selection. A name
  // only means "paint by bone weight" when there's no real, directly-
  // selectable mesh node behind it — explicitly excluding anything
  // already in limbMeshNodeNames keeps the two paths mutually exclusive.
  const activeLimbMeshNames = useMemo(() => new Set(activeLimbPoint?.mesh_names ?? []), [activeLimbPoint])
  const activeLimbBoneNames = useMemo(
    () => new Set([...activeLimbMeshNames].filter((n) => limbBoneNames.includes(n) && !limbMeshNodeNames.includes(n))),
    [activeLimbMeshNames, limbBoneNames, limbMeshNodeNames],
  )

  const onModelClick = ([x, y, z]: [number, number, number]) => {
    if (!activeSlot || isTrackLocked) return
    setPoints((prev) => [
      ...prev.filter((p) => p.kind !== 'cockpit'),
      { kind: 'cockpit', location: null, x, y, z, mesh_names: null },
    ])
    setSavedFlash(false)
  }

  // Real user request: "tienes como sacar el punto desde donde disparan?
  // o te lo tengo que dar yo" — fills every weapon slot for the CURRENT
  // model at once from the real mesh geometry (computeWeaponMuzzlePoints),
  // same "Nth real weapon at a location -> arma N" slot convention
  // onModelClick's own weapon branch already uses, just computed instead
  // of clicked. Left as a reviewable prefill, not an auto-save: still
  // needs the normal "Guardar"/"Aceptar" step afterward, same as a
  // manually-clicked point.
  //
  // Real bug found live: a weapon with no detected mesh (an unmapped
  // WEAPON_VISUAL_BUCKETS entry — "Streak SRM 6" had none at the time)
  // used to just be skipped, silently shifting every LATER same-location
  // weapon's point one slot too early — wrong points, not just a missing
  // one, since these slots are purely positional with no per-point weapon
  // identity to keep them aligned on their own. Stopping at the first
  // miss per location instead (same gap-free invariant onModelClick's own
  // `Math.min(index, sameLocation.length)` clamp already enforces for a
  // manual click) means a real gap just leaves that location visibly
  // short (its later slots simply don't get filled) instead of silently
  // wrong.
  // Real user request: "necesito que detectar todos los cañones marque
  // todas las armas del chasis, incluso las que no estan visibles" — every
  // real MW5 variant of a chassis (BSW-L1, BSW-S2, BSW-X1, …) shares ONE
  // .glb (see mechAssets.ts's own per-chassis `models` map, every variant
  // key pointing at the same file), so a mount mesh the CURRENTLY selected
  // variant's own loadout happens to leave hidden (applyMechCombatVisibility)
  // still physically exists on this model and is worth detecting once,
  // here, instead of forcing a re-click per variant just to catch mounts
  // that variant's loadout doesn't use. Pulls every OTHER variant's own
  // loadout that resolves to this SAME model file, and for each location
  // keeps whichever variant asks for the MOST weapons there — the fullest
  // loadout at a location is the only one guaranteed to exercise every
  // mount mesh actually present there (a thinner loadout just reuses a
  // subset of the same mounts, never a mount the fullest one misses).
  const onAutoDetectWeaponPoints = async () => {
    if (!annotateInstanceRef.current || isTrackLocked || !selectedChassis) return
    // See autoDetectAll's own doc comment (WeaponMuzzleEditor above) for
    // the exact bug this guards against — cheap and harmless if the
    // scale was already correctly committed by the time this runs.
    annotateInstanceRef.current.scale.setScalar(MODEL_SCALE)

    const sameModelVariants = modelOptions.filter((m) => resolveMechModelUrl(selectedChassis, m.model) === modelUrl)
    const loadouts = await Promise.all(
      sameModelVariants.map((m) => getMechImport(m.file).then((data) => data.weapons).catch(() => [])),
    )
    const bestByLocation = new Map<string, { weapon_name: string; location: string }[]>()
    for (const weapons of loadouts) {
      const byLoc = new Map<string, { weapon_name: string; location: string }[]>()
      for (const w of weapons) byLoc.set(w.location, [...(byLoc.get(w.location) ?? []), w])
      for (const [loc, list] of byLoc) {
        if (list.length > (bestByLocation.get(loc)?.length ?? 0)) bestByLocation.set(loc, list)
      }
    }
    const allChassisWeapons = [...bestByLocation.values()].flat()
      .map((w) => ({ location: w.location, weaponName: w.weapon_name }))

    // annotateInstanceRef could point at a since-unmounted instance if the
    // chassis/model changed while the fetches above were in flight — the
    // usual "still relevant?" guard any async handler touching a ref needs.
    if (!annotateInstanceRef.current || isTrackLocked) return
    const detected = computeWeaponMuzzlePoints(annotateInstanceRef.current, allChassisWeapons)
    const byLocation = new Map<string, MechAnnotationPoint[]>()
    const stoppedLocations = new Set<string>()
    for (const d of detected) {
      if (stoppedLocations.has(d.location)) continue
      if (!d.point) { stoppedLocations.add(d.location); continue }
      const list = byLocation.get(d.location) ?? []
      list.push({
        kind: 'weapon', location: d.location as MechLocationCode,
        x: d.point[0], y: d.point[1], z: d.point[2], mesh_names: null,
      })
      byLocation.set(d.location, list)
    }
    if (byLocation.size === 0) return
    setPoints((prev) => {
      const untouched = prev.filter((p) => !(p.kind === 'weapon' && p.location != null && byLocation.has(p.location)))
      return [...untouched, ...[...byLocation.values()].flat()]
    })
    setSavedFlash(false)
  }

  // Same request, for the "Extremidades" tab: "encontrar las
  // extremidades porque los nuevos modelos están nombrados y separados?"
  // — the 4 detachable limb locations' own mesh_names, read straight off
  // the model's own body-part naming instead of clicking every mesh/bone
  // by hand. Overwrites whichever limb locations actually got a
  // detection; a chassis with no recognizable naming (the old
  // hand-authored pipeline) leaves every existing limb definition alone.
  const onAutoDetectLimbMeshes = () => {
    if (!limbInstanceRef.current || isTrackLocked) return
    const detected = computeLimbMeshNames(limbInstanceRef.current)
    const entries = Object.entries(detected) as [MechLocationCode, string[]][]
    if (entries.length === 0) return
    setPoints((prev) => {
      const others = prev.filter((p) => !(p.kind === 'limb' && p.location != null && detected[p.location] !== undefined))
      const newLimbPoints: MechAnnotationPoint[] = entries.map(([location, mesh_names]) => ({
        kind: 'limb', location, x: 0, y: 0, z: 0, mesh_names,
      }))
      return [...others, ...newLimbPoints]
    })
    setSavedFlash(false)
  }

  const onToggleLimbMesh = (meshName: string) => {
    if (!activeLimb || isTrackLocked) return
    // A bone toggle also drags in every descendant bone (see
    // getDescendantBoneNames's own doc comment for why) — a plain mesh
    // node name (the direct-3D-click path, for the rare model with actual
    // separate parts) has no descendants to speak of, so this is a no-op
    // single-name set for that case.
    const isBone = limbBoneInfo.some((b) => b.name === meshName)
    const affected = isBone ? getDescendantBoneNames(limbBoneInfo, meshName) : new Set([meshName])
    setPoints((prev) => {
      const existing = prev.find((p) => p.kind === 'limb' && p.location === activeLimb)
      const names = new Set(existing?.mesh_names ?? [])
      const turningOn = !names.has(meshName)
      for (const name of affected) {
        if (turningOn) names.add(name)
        else names.delete(name)
      }
      return [
        ...prev.filter((p) => !(p.kind === 'limb' && p.location === activeLimb)),
        { kind: 'limb', location: activeLimb, x: 0, y: 0, z: 0, mesh_names: [...names] },
      ]
    })
    setSavedFlash(false)
  }

  const removeCockpitPoint = () => {
    if (isTrackLocked) return
    setPoints((prev) => prev.filter((p) => p.kind !== 'cockpit'))
    setSavedFlash(false)
  }


  const removeWeaponSlot = (location: MechLocationCode, index: number) => {
    if (isTrackLocked) return
    setPoints((prev) => {
      const others = prev.filter((p) => !(p.kind === 'weapon' && p.location === location))
      const sameLocation = prev.filter((p) => p.kind === 'weapon' && p.location === location)
      sameLocation.splice(index, 1)
      return [...others, ...sameLocation]
    })
    setSavedFlash(false)
  }

  const onSave = async () => {
    if (!modelUrl || isTrackLocked) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveMechAnnotations(modelUrl, points)
      setAllAnnotations((prev) => [...prev.filter((a) => a.model_url !== modelUrl), ...saved])
      // The board reads these too now (a limb's real membership comes from
      // here -- see limbLocationLookup), and it holds them in a page-wide
      // cache. Without this, configuring a limb and walking straight back
      // to the map would show the data as it was when the tab opened.
      invalidateMechAnnotations()
      setSavedFlash(true)
      if (mode === 'annotate' && saved.some((p) => p.kind === 'weapon' || p.kind === 'cockpit' || p.kind === 'hit') && selectedChassis) {
        bumpReviewToDone(selectedChassis, 'weapons')
      }
      if (mode === 'limbs' && saved.some((p) => p.kind === 'limb' && (p.mesh_names?.length ?? 0) > 0) && selectedChassis) {
        bumpReviewToDone(selectedChassis, 'limbs')
      }
    } catch {
      setSaveError('No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  // Real user request: "quiero poder guardarlo desde el mechlab y como lo
  // demas, 3 estados y un marcador en el desplegable" — same shape as
  // onSave above (its own endpoint/payload, so kept separate rather than
  // branching one function three ways), sharing the same saving/saveError/
  // savedFlash UI state since only one tab is ever visible at a time.
  const onSavePbr = async () => {
    if (!modelUrl || isTrackLocked) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveMechPbrSettings({
        model_url: modelUrl,
        repeat: pbrSettings.repeat,
        body_normal_scale: pbrSettings.body.normalScale, body_roughness: pbrSettings.body.roughness,
        body_metalness: pbrSettings.body.metalness, body_color_boost: pbrSettings.body.colorBoost,
        body_ao_intensity: pbrSettings.body.aoIntensity,
        body_metal_roughness: pbrSettings.body.metalRoughness ?? pbrSettings.body.roughness,
        body_metal_metalness: pbrSettings.body.metalMetalness ?? pbrSettings.body.metalness,
        body_metal_normal_scale: pbrSettings.body.metalNormalScale ?? pbrSettings.body.normalScale,
        body_metal_color_boost: pbrSettings.body.metalColorBoost ?? pbrSettings.body.colorBoost,
        weapons_normal_scale: pbrSettings.weapons.normalScale, weapons_roughness: pbrSettings.weapons.roughness,
        weapons_metalness: pbrSettings.weapons.metalness, weapons_color_boost: pbrSettings.weapons.colorBoost,
        weapons_ao_intensity: pbrSettings.weapons.aoIntensity,
        weapons_metal_roughness: pbrSettings.weapons.metalRoughness ?? pbrSettings.weapons.roughness,
        weapons_metal_metalness: pbrSettings.weapons.metalMetalness ?? pbrSettings.weapons.metalness,
        weapons_metal_normal_scale: pbrSettings.weapons.metalNormalScale ?? pbrSettings.weapons.normalScale,
        weapons_metal_color_boost: pbrSettings.weapons.metalColorBoost ?? pbrSettings.weapons.colorBoost,
        cockpit_normal_scale: pbrSettings.cockpit.normalScale, cockpit_roughness: pbrSettings.cockpit.roughness,
        cockpit_metalness: pbrSettings.cockpit.metalness, cockpit_color_boost: pbrSettings.cockpit.colorBoost,
        cockpit_ao_intensity: pbrSettings.cockpit.aoIntensity,
      })
      setAllPbrSettings((prev) => [...prev.filter((r) => r.model_url !== modelUrl), saved])
      setSavedFlash(true)
      if (selectedChassis) bumpReviewToDone(selectedChassis, 'texture')
    } catch {
      setSaveError('No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  // Real user request: "en la seccion de huella, quiero un boton de
  // guardar, para cuando capture una, que se use esa siempre, ahora mismo
  // el descargar png me lo descarga en downloads y no quiero que sea así"
  // — same shape as onSavePbr above.
  // Real user request (later): "necesitamos 5, armas/extremidades/rig/
  // texturas y huella" — 'footprint' is now a real track (REVIEW_TRACK_ORDER),
  // so this gets the same isTrackLocked guard and bumpReviewToDone call
  // onSave/onSavePbr already have, instead of the "no review track" case
  // this comment used to describe.
  const onSaveFootprint = async () => {
    if (!modelUrl || !footprintCapture || isTrackLocked) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveMechFootprintMask({
        model_url: modelUrl,
        image_data_url: footprintCapture.dataUrl,
        half_width: footprintCapture.halfWidth,
        half_depth: footprintCapture.halfDepth,
      })
      setAllFootprintMasks((prev) => [...prev.filter((r) => r.model_url !== modelUrl), saved])
      setSavedFlash(true)
      if (selectedChassis) bumpReviewToDone(selectedChassis, 'footprint')
    } catch {
      setSaveError('No se pudo guardar.')
    } finally {
      setSaving(false)
    }
  }

  // Real user request: "en el desplegable de mechs, pinta el fondo de cada
  // opcion en amarillo si tiene algun modelo aceptado y en verde si tiene
  // todos los modelos aceptados".
  // Real user request (later): "los marcadores... deberian estar en el
  // chasis ahora, no en los modelos" — review status is tracked per
  // chassis directly now (not per model_url), so this no longer needs to
  // enumerate every catalog variant's own URL: "fully accepted" is simply
  // every one of the 5 REVIEW_TRACK_ORDER tracks being 'accepted' for the
  // chassis itself, "partially accepted" is at least one.
  const chassisOptionClassName = (chassis: string): string | undefined => {
    if (!(chassis in MECH_CHASSIS_ASSETS)) return undefined
    const acceptedCount = REVIEW_TRACK_ORDER.filter((t) => reviewStatusFor(reviewByKey, chassis, t) === 'accepted').length
    if (acceptedCount === REVIEW_TRACK_ORDER.length) return 'mechlab-chassis-fully-accepted'
    if (acceptedCount > 0) return 'mechlab-chassis-partially-accepted'
    return undefined
  }

  return (
    <div className="mechlab">
      <aside className="mechlab-sidebar">
        <h1>MechLab</h1>
        <p className="mechlab-hint">
          Editor de anotación de mechs (solo para desarrollo) — marca dónde está cada arma y la cabina
          sobre el modelo 3D real.
        </p>

        <h2>Mech</h2>
        <div className="row">
          <ChassisSelect
            value={selectedChassis} onChange={setSelectedChassis} options={chassisOptions}
            getOptionClassName={chassisOptionClassName}
          />
          {/* Real user request: "los marcadores... deberian estar en el
            * chasis ahora, no en los modelos" — one set of 5 icons for the
            * whole chassis (its curated asset is shared across every
            * catalog variant), not one per model option any more. */}
          {selectedChassis && (
            <span className="mechlab-chassis-review-icons" title="Progreso de revisión de este chasis">
              {REVIEW_TRACK_ORDER.map((t) => REVIEW_STATUS_ICON[reviewStatusFor(reviewByKey, selectedChassis, t)]).join('')}
            </span>
          )}
          <select
            className="mechlab-model-select"
            value={selectedModelFile}
            onChange={(e) => setSelectedModelFile(e.target.value)}
            disabled={modelOptions.length === 0}
          >
            <option value="">modelo…</option>
            {modelOptions.map((m) => (
              <option key={m.file} value={m.file}>{m.model}</option>
            ))}
          </select>
        </div>
        <p className="mechlab-hint">
          {REVIEW_STATUS_ICON.not_started} sin empezar · {REVIEW_STATUS_ICON.done} hecho · {REVIEW_STATUS_ICON.accepted}{' '}
          aceptado — orden: armas · extremidades · rig · textura · huella
        </p>

        {modelUrl && (
          <>
            <div className="mechlab-mode-tabs">
              <button type="button" className={mode === 'annotate' ? 'active' : ''} onClick={() => setMode('annotate')}>
                Anotar armas
              </button>
              <button type="button" className={mode === 'limbs' ? 'active' : ''} onClick={() => setMode('limbs')}>
                Extremidades
              </button>
              <button type="button" className={mode === 'rig' ? 'active' : ''} onClick={() => setMode('rig')}>
                Ver rig
              </button>
              <button type="button" className={mode === 'texture' ? 'active' : ''} onClick={() => setMode('texture')}>
                Textura
              </button>
              <button type="button" className={mode === 'footprint' ? 'active' : ''} onClick={() => setMode('footprint')}>
                Huella
              </button>
            </div>

            {selectedChassis && (
              <>
                <ReviewBadge
                  status={reviewStatusFor(reviewByKey, selectedChassis, currentTrack)}
                  onAccept={() => setReviewStatus(selectedChassis, currentTrack, 'accepted')}
                  onUnaccept={() => setReviewStatus(selectedChassis, currentTrack, 'done')}
                />
                {isTrackLocked && (
                  <p className="mechlab-hint">
                    Aceptado — bloqueado para edición. Pulsa "↺ Desmarcar" arriba para poder tocarlo de nuevo.
                  </p>
                )}
              </>
            )}

            {mode === 'annotate' && (
              <>
                <h2>Armas</h2>
                <p className="mechlab-hint">
                  Ya no hace falta marcar cada arma a mano — calcula el punto de disparo de todas a la vez
                  directamente desde la malla/esqueleto real. Revisa el resultado (lista de abajo, con un
                  punto en el visor por cada una) y guarda.
                </p>
                <div className="row">
                  <button
                    type="button" className="mechlab-save-btn"
                    onClick={onAutoDetectWeaponPoints} disabled={isTrackLocked}
                  >
                    🎯 Detectar todos los cañones
                  </button>
                </div>
                <div className="mechlab-slots">
                  {MECH_LOCATIONS.filter((loc) => (weaponsByLocation[loc]?.length ?? 0) > 0).map((loc) => {
                    const weapons = weaponsByLocation[loc] ?? []
                    const filledCount = points.filter((p) => p.kind === 'weapon' && p.location === loc).length
                    return weapons.map((weaponName, i) => (
                      <span key={`${loc}:${i}`} className={`mechlab-slot${i < filledCount ? ' filled' : ''}`}>
                        {SLOT_LABELS[loc]} · arma {i + 1}
                        <span className="mechlab-slot-weapons">{weaponName}</span>
                      </span>
                    ))
                  })}
                </div>

                <h2>Cabina</h2>
                <div className="mechlab-slots">
                  <button
                    type="button"
                    className={`mechlab-slot${activeSlot?.kind === 'cockpit' ? ' active' : ''}${cockpitPoint ? ' filled' : ''}`}
                    onClick={() => setActiveSlot({ kind: 'cockpit' })}
                    disabled={isTrackLocked}
                  >
                    {SLOT_LABELS.cockpit}
                  </button>
                </div>

                {activeSlot && (
                  <p className="mechlab-hint">
                    Clic en el modelo para colocar/mover «{SLOT_LABELS.cockpit}». Puedes seguir haciendo
                    clic para afinar la posición.
                  </p>
                )}

                <h2>Puntos colocados</h2>
                <ul className="mechlab-point-list">
                  {points.filter((p) => p.kind !== 'limb').length === 0 && (
                    <li className="mechlab-hint">Ninguno todavía.</li>
                  )}
                  {(() => {
                    const seen: Partial<Record<MechLocationCode, number>> = {}
                    return points
                      // Real user request: hit points dropped from this
                      // tab entirely (see ActiveSlot's own doc comment) —
                      // any 'hit' entry still in `points` here is only
                      // ever a pre-existing saved record loaded from the
                      // server, never something this tab can create or
                      // edit any more, so it's simply not shown.
                      .filter((p) => p.kind !== 'limb' && p.kind !== 'hit')
                      .map((p) => {
                        if (p.kind === 'cockpit') {
                          return (
                            <li key="cockpit">
                              <span>{SLOT_LABELS.cockpit}</span>
                              <button type="button" onClick={removeCockpitPoint}>✕</button>
                            </li>
                          )
                        }
                        const loc = p.location as MechLocationCode
                        const idx = seen[loc] ?? 0
                        seen[loc] = idx + 1
                        const weaponName = weaponsByLocation[loc]?.[idx]
                        return (
                          <li key={`${loc}:${idx}`}>
                            <span>
                              {SLOT_LABELS[loc]} · arma {idx + 1}
                              {weaponName ? ` — ${weaponName}` : ''}
                            </span>
                            <button type="button" onClick={() => removeWeaponSlot(loc, idx)}>✕</button>
                          </li>
                        )
                      })
                  })()}
                </ul>

                <div className="row">
                  <label className="mechlab-fpv-toggle" title={!cockpitPoint ? 'Marca antes el punto de cabina' : undefined}>
                    <input
                      type="checkbox" checked={fpvPreview} disabled={!cockpitPoint}
                      onChange={(e) => setFpvPreview(e.target.checked)}
                    />
                    {' '}Ver como FPV
                  </label>
                </div>

                <div className="row">
                  <button type="button" className="mechlab-save-btn" onClick={onSave} disabled={saving || isTrackLocked}>
                    {saving ? 'Guardando…' : 'Guardar'}
                  </button>
                  {savedFlash && <span className="mechlab-saved">✓ guardado</span>}
                  {saveError && <span className="mechlab-error">{saveError}</span>}
                </div>
              </>
            )}

            {mode === 'limbs' && (
              <>
                <h2>¿Qué extremidad?</h2>
                <div className="row">
                  <button
                    type="button" className="mechlab-save-btn"
                    onClick={onAutoDetectLimbMeshes} disabled={isTrackLocked}
                  >
                    🎯 Detectar automáticamente
                  </button>
                </div>
                <p className="mechlab-hint">
                  Agrupa las mallas del modelo por nombre de zona (solo chasis con el pipeline nuevo de
                  AssetStudio) — revisa el resultado y guarda igual que si lo hubieras marcado a mano.
                </p>
                <div className="mechlab-slots">
                  {LIMB_LOCATIONS.map((loc) => {
                    const count = points.find((p) => p.kind === 'limb' && p.location === loc)?.mesh_names?.length ?? 0
                    return (
                      <button
                        key={loc}
                        type="button"
                        className={`mechlab-slot${activeLimb === loc ? ' active' : ''}${count > 0 ? ' filled' : ''}`}
                        onClick={() => { setActiveLimb(loc); setPreviewBreak(false) }}
                        disabled={isTrackLocked}
                      >
                        {SLOT_LABELS[loc]}
                        {count > 0 && <span className="mechlab-slot-weapons">{count} pieza(s)</span>}
                      </button>
                    )
                  })}
                </div>
                {activeLimb ? (
                  <>
                    <p className="mechlab-hint">
                      La mayoría de estos modelos son UNA sola pieza — marca huesos abajo para «partirla»
                      por zona de influencia (el modelo se pinta en rojo donde ese hueso realmente mueve
                      vértices). Si el modelo SÍ tiene piezas separadas, clic directo en el modelo también
                      funciona.
                    </p>

                    <div className="row">
                      <label
                        className="mechlab-fpv-toggle"
                        title={activeLimbMeshNames.size === 0 ? 'Marca antes alguna pieza/hueso' : undefined}
                      >
                        <input
                          type="checkbox" checked={previewBreak}
                          disabled={activeLimbMeshNames.size === 0 || isTrackLocked}
                          onChange={(e) => setPreviewBreak(e.target.checked)}
                        />
                        {' '}Vista previa: romper esta extremidad
                      </label>
                    </div>

                    {limbBoneNames.length > 0 ? (
                      <>
                        <h2>Huesos ({limbBoneNames.length})</h2>
                        <ul className={`mechlab-point-list mechlab-bone-list${isTrackLocked ? ' mechlab-locked' : ''}`}>
                          {limbBoneNames.map((name) => (
                            <li
                              key={name}
                              className={activeLimbBoneNames.has(name) ? 'selected' : ''}
                              onClick={() => onToggleLimbMesh(name)}
                            >
                              <span>{activeLimbBoneNames.has(name) ? '☑' : '☐'} {name}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="mechlab-hint">Este modelo no tiene huesos detectados todavía.</p>
                    )}
                    <h2>Piezas marcadas</h2>
                    <ul className="mechlab-point-list">
                      {activeLimbMeshNames.size === 0 && <li className="mechlab-hint">Ninguna todavía.</li>}
                      {[...activeLimbMeshNames].map((name) => (
                        <li key={name}>
                          <span>{name}</span>
                          <button type="button" onClick={() => onToggleLimbMesh(name)} disabled={isTrackLocked}>✕</button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mechlab-hint">Elige primero qué extremidad vas a marcar.</p>
                )}

                <div className="row">
                  <button type="button" className="mechlab-save-btn" onClick={onSave} disabled={saving || isTrackLocked}>
                    {saving ? 'Guardando…' : 'Guardar'}
                  </button>
                  {savedFlash && <span className="mechlab-saved">✓ guardado</span>}
                  {saveError && <span className="mechlab-error">{saveError}</span>}
                </div>
              </>
            )}

            {mode === 'rig' && (
              <>
                <h2>Rig</h2>
                {rigClipNames.length === 0 ? (
                  <p className="mechlab-hint">Este modelo no tiene rig/animaciones todavía.</p>
                ) : (
                  <>
                    <div className="mechlab-slots">
                      {rigClipNames.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className={`mechlab-slot${rigActiveClip === name ? ' active' : ''}`}
                          onClick={() => { setRigActiveClip(name); setRigScrub(0) }}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <button type="button" className="mechlab-save-btn" onClick={() => setRigPlaying((p) => !p)}>
                        {rigPlaying ? '⏸ Pausa' : '▶ Reproducir'}
                      </button>
                    </div>
                    <input
                      type="range" min={0} max={1} step={0.001} value={rigScrub}
                      onChange={(e) => { setRigPlaying(false); setRigScrub(Number(e.target.value)) }}
                      className="mechlab-scrub"
                    />

                    {rigBoneNames.length > 0 && (
                      <>
                        <h2>Huesos ({rigBoneNames.length})</h2>
                        <p className="mechlab-hint">
                          Selecciona uno para ver dónde está en tiempo real mientras la animación corre,
                          la parte de la malla que mueve (pintada en rojo) y, con la animación en pausa,
                          arrastrar sus dos flechas (roja = eje X, azul = eje Z) para posarlo a mano —
                          Ctrl+Z deshace el último arrastre.
                        </p>
                        {selectedBone && (
                          <p className="mechlab-hint">
                            {rigInfluencePercent != null
                              ? `Afecta ~${rigInfluencePercent.toFixed(1)}% de los vértices del modelo.`
                              : 'Este modelo no tiene datos de peso por hueso para pintar.'}
                            {rigPlaying && ' Pausa la animación para poder arrastrarlo.'}
                          </p>
                        )}
                        <ul className="mechlab-point-list mechlab-bone-list">
                          {rigBoneNames.map((name) => (
                            <li
                              key={name}
                              className={selectedBone === name ? 'selected' : ''}
                              onClick={() => setSelectedBone(selectedBone === name ? null : name)}
                            >
                              <span>{name}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {mode === 'texture' && (
              <>
                <h2>PBR</h2>
                <p className="mechlab-hint">
                  Vista previa en directo del material PBR (detalle de metal escaneado, ver MECH_PBR_DEFAULTS).
                  Cuerpo, armas y cabina son materiales reales distintos — cada uno se ajusta por separado.
                </p>
                {/* Real user request: "los sliders... cambia todo a la vez,
                    cabina/armas y cuerpo, deberían ser cambios independientes"
                    — confirmed live (Bushwacker) these three really are
                    separate materials with different real baselines, not
                    just separate taste. One full slider set per zone,
                    reading/writing pbrSettings[zone][key] instead of the
                    old flat pbrSettings[key].
                    Real follow-up: "en textura debemos dejar solo los
                    sliders de detalle de relieve rugosidad metalicidad y
                    brillo" — repeat (shared tiling) and aoIntensity stay in
                    the data model/backend (still applied, at whatever was
                    last saved or the default) but are no longer exposed as
                    sliders here; same for the derived glossiness readout
                    (mathematically just 1-roughness, redundant with
                    rugosidad already being one of the four kept). */}
                {([
                  { zone: 'body', label: 'Cuerpo' },
                  { zone: 'weapons', label: 'Armas' },
                  { zone: 'cockpit', label: 'Cabina' },
                ] as const).map(({ zone, label: zoneLabel }) => (
                  <div key={zone}>
                    <h2>{zoneLabel}</h2>
                    {([
                      { key: 'normalScale', label: 'Detalle de relieve (normal)', min: 0, max: 1.5, step: 0.01 },
                      { key: 'roughness', label: 'Rugosidad (roughness)', min: 0, max: 1, step: 0.01 },
                      { key: 'metalness', label: 'Metalicidad (metalness)', min: 0, max: 1, step: 0.01 },
                      { key: 'colorBoost', label: 'Brillo (aclarar textura)', min: 0.5, max: 3, step: 0.01 },
                    ] as const).map(({ key, label: fieldLabel, min, max, step }) => (
                      <div key={key}>
                        <p className="mechlab-hint">{fieldLabel}: {pbrSettings[zone][key].toFixed(2)}</p>
                        <input
                          type="range" min={min} max={max} step={step} value={pbrSettings[zone][key]} disabled={isTrackLocked}
                          onChange={(e) => {
                            const v = Number(e.target.value)
                            setPbrSettings((prev) => ({ ...prev, [zone]: { ...prev[zone], [key]: v } }))
                            setSavedFlash(false)
                          }}
                          className="mechlab-scrub"
                        />
                      </div>
                    ))}
                    {/* Real user request: "el cuerpo, las armas... tienen
                        una máscara para aplicar las texturas. Los sliders
                        solo afectan a la parte de la máscara. Quiero otro
                        slider que afecte a las partes FUERA de la mask" —
                        Body/Weapons only (see MechPbrZoneSettings' own doc
                        comment on metalRoughness/metalMetalness for why
                        Cabina has no split). Rugosidad/Metalicidad above
                        keep meaning the PAINTED region; these two are the
                        bare-metal region specifically. */}
                    {zone !== 'cockpit' && (
                      <>
                        <h2>{zoneLabel} — fuera de la máscara (metal desnudo, aproximado)</h2>
                        {([
                          { key: 'metalNormalScale' as const, label: 'Detalle de relieve (metal desnudo)', min: 0, max: 1.5, step: 0.01 },
                          { key: 'metalRoughness' as const, label: 'Rugosidad (metal desnudo)', min: 0, max: 1, step: 0.01 },
                          { key: 'metalMetalness' as const, label: 'Metalicidad (metal desnudo)', min: 0, max: 1, step: 0.01 },
                          { key: 'metalColorBoost' as const, label: 'Brillo (metal desnudo)', min: 0.5, max: 3, step: 0.01 },
                        ]).map(({ key, label: fieldLabel, min, max, step }) => (
                          <div key={key}>
                            <p className="mechlab-hint">{fieldLabel}: {(pbrSettings[zone][key] ?? 0).toFixed(2)}</p>
                            <input
                              type="range" min={min} max={max} step={step} value={pbrSettings[zone][key] ?? 0} disabled={isTrackLocked}
                              onChange={(e) => {
                                const v = Number(e.target.value)
                                setPbrSettings((prev) => ({ ...prev, [zone]: { ...prev[zone], [key]: v } }))
                                setSavedFlash(false)
                              }}
                              className="mechlab-scrub"
                            />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ))}
                <div className="row">
                  <button
                    type="button" className="mechlab-save-btn" disabled={isTrackLocked}
                    onClick={() => { setPbrSettings(MECH_PBR_DEFAULTS); setSavedFlash(false) }}
                  >
                    ↺ Restablecer valores por defecto
                  </button>
                </div>
                <div className="row">
                  <button type="button" className="mechlab-save-btn" onClick={onSavePbr} disabled={saving || isTrackLocked}>
                    {saving ? 'Guardando…' : 'Guardar'}
                  </button>
                  {savedFlash && <span className="mechlab-saved">✓ guardado</span>}
                  {saveError && <span className="mechlab-error">{saveError}</span>}
                </div>
              </>
            )}


            {mode === 'footprint' && (
              <>
                <h2>Huella</h2>
                <p className="mechlab-hint">
                  Coloca el cuadro azul alrededor de un pie (muévelo/rotalo/escálalo con los ejes) — la cámara se
                  mueve como siempre, el cuadro es independiente. "Capturar" toma justo el volumen del cuadro, como
                  un corte/slice, y lo guarda como PNG en blanco sobre transparente: la silueta real de lo que haya
                  dentro. Sirve como máscara real de la huella para ese chasis, en vez de la elipse genérica.
                </p>
                <div className="mechlab-mode-tabs">
                  <button
                    type="button" className={footprintTransformMode === 'translate' ? 'active' : ''}
                    onClick={() => setFootprintTransformMode('translate')}
                  >
                    Mover
                  </button>
                  <button
                    type="button" className={footprintTransformMode === 'rotate' ? 'active' : ''}
                    onClick={() => setFootprintTransformMode('rotate')}
                  >
                    Rotar
                  </button>
                  <button
                    type="button" className={footprintTransformMode === 'scale' ? 'active' : ''}
                    onClick={() => setFootprintTransformMode('scale')}
                  >
                    Escalar
                  </button>
                </div>
                <div className="row">
                  <button
                    type="button" className="mechlab-save-btn"
                    onClick={() => footprintCaptureRef.current?.capture()}
                  >
                    📸 Capturar
                  </button>
                </div>
                {footprintCapture ? (
                  <>
                    <img
                      src={footprintCapture.dataUrl} alt="Captura de huella"
                      style={{ width: '100%', background: '#1c2624', border: '1px solid var(--border)' }}
                    />
                    <div className="row">
                      <button type="button" className="mechlab-save-btn" onClick={onSaveFootprint} disabled={saving}>
                        {saving ? 'Guardando…' : '💾 Guardar'}
                      </button>
                      {savedFlash && <span className="mechlab-saved">✓ guardado — esta es la huella real que usará el juego</span>}
                      {saveError && <span className="mechlab-error">{saveError}</span>}
                    </div>
                  </>
                ) : (
                  <p className="mechlab-hint">Todavía no hay ninguna captura.</p>
                )}
              </>
            )}
          </>
        )}
      </aside>

      <div className="mechlab-canvas-wrap">
        {webglContextLost && (
          <div className="mechlab-context-lost-banner">
            El visor 3D se ha bloqueado (WebGL context lost) — recarga la página completa (Ctrl+Shift+R),
            no basta con navegar dentro de la app. Nada de lo que hagas aquí va a renderizarse hasta entonces.
          </div>
        )}
        {modelUrl ? (
          <Canvas
            shadows camera={{ position: [2 * MODEL_SCALE, 1.4 * MODEL_SCALE, 2 * MODEL_SCALE], fov: 45 }}
            onCreated={(state) => {
              state.gl.domElement.addEventListener('webglcontextlost', (e) => {
                e.preventDefault()
                setWebglContextLost(true)
              })
              // A fresh mount (this callback only fires once per real
              // <canvas> element) means whatever context loss happened
              // before is moot now — clears a stale banner left over
              // from before a real page reload.
              setWebglContextLost(false)
            }}
          >
            <color attach="background" args={['#0f1a18']} />
            <ambientLight intensity={1.2} />
            <directionalLight position={[3, 5, 2]} intensity={1.6} castShadow />
            <gridHelper args={[4, 8]} />
            {/* Real user request: pieces should "caer por gravedad y
                golpear con todo lo que encuentre" — a real Rapier world,
                only mounted for 'limbs' (the only mode LimbPainter, its
                one consumer via useRapier(), ever renders in). Real user
                follow-up: "puedes poner suelo en el visor de
                extremidades para que se vea" — a real, VISIBLE floor
                (not just an invisible collider) at the same y the
                model's own feet already rest on, so a fallen piece has
                something to land on and be seen resting on. */}
            <Physics gravity={[0, -9.81, 0]}>
              {mode === 'limbs' && (
                <RigidBody type="fixed" colliders="cuboid">
                  <mesh position={[0, -0.05, 0]} receiveShadow>
                    <boxGeometry args={[4, 0.1, 4]} />
                    <meshStandardMaterial color="#1c2624" roughness={1} />
                  </mesh>
                </RigidBody>
              )}
              <Suspense fallback={null}>
                {mode === 'annotate' && (
                  <Mech3D
                    color="#9aa4a2" chassis={selectedChassis} model={selectedModel}
                    onSurfaceClick={onModelClick}
                    instanceRef={annotateInstanceRef}
                    playAnimation={false}
                    weapons={templateWeaponsForMech3D}
                  />
                )}
                {mode === 'limbs' && (
                  <LimbPainter
                    chassis={selectedChassis} model={selectedModel} weapons={templateWeaponsForMech3D}
                    instanceRef={limbInstanceRef}
                    selectedMeshNames={activeLimbMeshNames} selectedBoneNames={activeLimbBoneNames}
                    previewBreak={previewBreak}
                    onToggleMesh={onToggleLimbMesh} onBonesChange={setLimbBoneInfo}
                    onMeshNamesChange={setLimbMeshNodeNames}
                  />
                )}
                {mode === 'rig' && (
                  <RigViewer
                    chassis={selectedChassis} model={selectedModel} weapons={templateWeaponsForMech3D}
                    activeClip={rigActiveClip} playing={rigPlaying} scrub={rigScrub} selectedBone={selectedBone}
                    onClipsChange={setRigClipNames} onBonesChange={setRigBoneNames} onScrubChange={setRigScrub}
                    onInfluencePercentChange={setRigInfluencePercent} onBoneDragChange={setBoneDragging}
                  />
                )}
                {mode === 'texture' && (
                  <TextureTuner
                    chassis={selectedChassis} model={selectedModel} weapons={templateWeaponsForMech3D}
                    settings={pbrSettings}
                  />
                )}
                {mode === 'footprint' && (
                  <FootprintCapture
                    ref={footprintCaptureRef}
                    chassis={selectedChassis} model={selectedModel} weapons={templateWeaponsForMech3D}
                    transformMode={footprintTransformMode}
                    onDraggingChange={setFootprintDragging}
                    onCapture={(result) => { setFootprintCapture(result); setSavedFlash(false) }}
                  />
                )}
              </Suspense>
            </Physics>
            {mode === 'annotate' && points.map((p, i) => (p.kind !== 'limb' && p.kind !== 'hit' ? <PointMarker key={`${pointKey(p.kind, p.location)}:${i}`} point={p} /> : null))}
            {mode === 'annotate' && fpvPreview && cockpitPoint ? (
              <FpvPreviewCam cockpitLocal={[cockpitPoint.x, cockpitPoint.y, cockpitPoint.z]} />
            ) : (
              <OrbitControls target={[0, 0.5 * MODEL_SCALE, 0]} enabled={!boneDragging && !footprintDragging} />
            )}
          </Canvas>
        ) : (
          <div className="mechlab-empty">Elige un chasis y modelo para empezar.</div>
        )}
      </div>
    </div>
  )
}
