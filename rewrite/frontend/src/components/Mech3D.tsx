import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useAnimations, useGLTF, useTexture } from '@react-three/drei'
import {useThree} from '@react-three/fiber'
import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'
import { WALK_CYCLE_TIME_SCALE } from '../hexMath'
import type { JumpPhase } from '../jumpFlight'
import { resolveMechModelUrl } from '../mechAssets'
import { useProfiledFrame } from './PerfProbe'

// Real user request: "añade un PBR para el Jenner", then: "PBR van a
// tener todos los mechs, así que esto tiene que ser genérico" — this
// curated asset (first one tested) ships with only a flat base-color
// texture, confirmed by inspecting its own .glb directly: one material,
// roughnessFactor 0.5, metallicFactor 0, no normal/roughness/metalness
// maps at all — true of every OTHER curated asset in mechAssets.ts too, so
// this now applies to every chassis, not just the one it was prototyped
// on. Reuses the SAME real scanned metal PBR set already downloaded for
// the dice (public/textures/dice/dice-chrome-*, ambientCG Metal032 — see
// CREDITS.md) as a TILED detail layer with its own UV repeat, rather than
// trying to match any one model's own irregular unwrap with a decal —
// same reasoning as Die.tsx's own chrome style.
//
// Real user follow-up: "el PBR oscurece mucho el modelo... solo aparece
// en el mechlab en selección de armas, no aparece en el resto de sitios".
// Two distinct bugs behind that one report — (1) this effect used to live
// ONLY inside Mech3DModel below, so MechLabView's own LimbPainter/RigViewer
// (Extremidades/Rig tabs — they load+normalize the GLTF themselves,
// bypassing Mech3D entirely) never applied it at all, and neither did any
// other mech instance rendered outside a real <Mech3D>; fixed by lifting
// it into useMechPbr below so every consumer can call it explicitly.
// (2) metalness without a scene environment map has no IBL to reflect —
// three.js's metallic workflow scales diffuse response down by metalness
// with nothing but ambient/directional light to fill the gap, which read
// as "PBR = darker" in every scene except the one already running an
// unusually bright ambientLight. Lowered metalness (0.35→0.12) so the
// surface stays readably lit under plain ambient/directional light in
// every scene, not just a brightly-lit one.
const MECH_PBR_URLS = {
  normalMap: '/textures/dice/dice-chrome-normal.jpg',
  roughnessMap: '/textures/dice/dice-chrome-roughness.jpg',
  metalnessMap: '/textures/dice/dice-chrome-metalness.jpg',
}
// How many times the detail texture tiles across the model's own UV
// space — fine enough to read as brushed-metal surface grain rather than
// a single smeared decal, without going so fine it looks like static
// noise at normal camera distance.
const MECH_PBR_REPEAT = 8

// Real user report: "el PBR oscurece mucho el modelo" — turned out to have
// nothing to do with the PBR maps themselves (see useMechPbr's own doc
// comment on this constant's use site for how that was confirmed live, on
// the Jenner specifically); that model's own base-color texture just
// measures dark (~19% average brightness) on its own, in every mode, PBR
// or not. A flat multiplier compensates without touching hue/detail —
// live-tested against the same scene that model actually renders in until
// it read as close to the pre-PBR "un-tinted, plainly lit" look already
// confirmed to look right. Applied generically (every chassis, not just
// the one it was tuned on) per the same "esto tiene que ser genérico"
// request above — a reasonable starting point everywhere, but genuinely
// only verified against the one model that's this dark; the Textura tab
// (MechLabView) exposes it as a live slider precisely so it can be
// re-tuned per chassis instead of everyone silently inheriting one mech's
// own calibration.
const MECH_COLOR_BOOST = 1.7

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
  /** True while HexMap's UnitMarker is easing this mech's position toward
   * a new hex — drives the real WalkStart→Walk→WalkEnd or WalkStart→
   * RunStart→Run→RunEnd chain (see the locomotion effect below) instead
   * of Idle. Rigged assets missing any clip in the chain just skip that
   * step (never a crash) — a not-yet-rigged model with no clips at all
   * simply never leaves its bind pose. */
  isMoving?: boolean
  /** Only meaningful while `isMoving` — which chain to play. Real user
   * request: proper Correr animation, not the same Walk crossfade for
   * every move. Fixed for the whole duration of one continuous
   * `isMoving` stretch (a single move command has one movement_type for
   * its entire path) — changing it mid-walk is not a supported case,
   * since no real move ever does that. Omitted/'walk' when moving. */
  movementType?: 'walk' | 'run'
  /** Real user request: real Despegar→Saltar→Aterrizar instead of a
   * jump animating identically to a one-hex walk. Set by whoever is
   * animating this mech's own group position through a jump arc
   * (HexMap's UnitMarker, FirstPersonView's own cockpit stepping) — see
   * jumpFlight.ts's own JumpPhase. null/omitted outside of an active
   * jump. Takes priority over isMoving/movementType (a jumping mech's
   * position IS changing, but not via the walk-chain machinery). */
  jumpPhase?: Exclude<JumpPhase, 'done'> | null
  /** mechs.is_prone OR destroyed — real user request: real Caerse/
   * Levantarse instead of an instant static tilt with Idle quietly
   * playing underneath. This component detects the false→true and
   * true→false EDGES itself (a ref, not derived state) to know when to
   * fire Caerse/Levantarse — passing the current boolean each render is
   * enough, no separate "just fell"/"just stood up" event needed. Also
   * owns the actual tilt rotation now (previously an external wrapper
   * `<group>` in HexMap.tsx) so it can stay in sync with Caerse/
   * Levantarse's own playback progress instead of snapping instantly. */
  fallen?: boolean
  /** Real user report: "los muertos no deben tener animacion idle" — a
   * destroyed mech never resumes Idle once its fall settles (`fallen`
   * still drives the Caerse/tilt-down itself; this only suppresses the
   * Idle/Idle2 breathing loop a live-but-prone mech would otherwise keep
   * doing once its own fall/hold finishes). */
  dead?: boolean
  /** Overrides FACTION_TINT_STRENGTH below — real user request: a
   * destroyed/overheated mech's own `color` (HexMap's own UnitMarker)
   * needs to actually READ as "black/dark grey, chamuscado, por encima
   * de su textura" instead of the same faint 22% wash every mech gets
   * from its side color, which diluted it down to barely visible (the
   * emissive ember glow, applied at full strength regardless, ended up
   * dominating the look instead — "se ve naranja" was this, not a bug in
   * the color value itself). Omitted/undefined keeps the normal subtle
   * faction wash. */
  tintStrength?: number
  /** Fires once this instance has something real on screen (the curated
   * model resolved, or — on a load failure — the box-geometry fallback).
   * Real user report: an enemy's red FPV outline sometimes didn't show
   * until "algo lo actualiza más adelante" — HexMap's own <Select> (see
   * its own doc comment) scans its children for meshes to claim in a
   * useEffect keyed on its `children` prop reference; that reference only
   * changes when UnitMarker itself re-renders, which does NOT happen just
   * because a Suspense boundary two levels down resolved a still-loading
   * .glb — so if the model was still loading the moment `outlined` first
   * became true, its mesh was never there to find and never got a second
   * chance to be. UnitMarker uses this callback to force that re-render
   * once there's actually something to select. */
  onLoaded?: () => void
  /** Real user request (MechLab, the mech-annotation editor): a way to
   * click a point on the model's own surface and get back where that is
   * in the SAME normalized local space this component already puts every
   * model into (see Mech3DModel's own `instance` useMemo — 1 unit tall,
   * centered on X/Z, resting on y=0), not raw world space. Manually
   * raycast (a raw DOM 'click' listener on the canvas, not r3f's own
   * per-object onClick — see the effect below) instead of the simpler
   * `<primitive onClick>` this started as: real user report — these
   * curated assets can be dense/messy enough (miniature-scan-derived
   * geometry, overlapping armor plates at joints) that a single exact
   * raycast misses real surface at several specific spots, especially at
   * arm/leg joints, no matter the camera angle. Retries a small spiral of
   * nearby screen offsets before giving up, so a near-miss still lands
   * instead of silently doing nothing. undefined/omitted (every existing
   * caller) changes nothing — the effect below no-ops entirely. */
  onSurfaceClick?: (localPoint: [number, number, number], event: MouseEvent) => void
  /** false freezes the model at its imported bind pose instead of
   * auto-playing Idle/Walk — real user report (MechLab): annotating a
   * rigged mech's weapon/limb points while Idle quietly bobs the arms
   * and legs made most clicks land somewhere other than where the point
   * actually was BY THE TIME the click resolved, since onSurfaceClick's
   * local-space conversion assumes the static normalized pose, not a
   * mid-animation one. Omitted/true (every other caller — HexMap,
   * FirstPersonView, GMView previews) keeps today's animated behavior
   * exactly as-is. */
  playAnimation?: boolean
  /** Real user request: "recuerda que te pedi que fuera la impresion del
   * pie del mech donde pisa, no un punto random en un hex... Si las
   * huellas IK cogen la forma de la planta del pie de la malla, me
   * valen" — fires once per real footfall (a foot bone's world Y
   * hitting a local minimum while walking), giving the caller the real
   * bone position plus the real per-chassis sole shape (see
   * `getFootShape`'s own doc comment) instead of a geometric
   * approximation. Only fires for chassis actually rigged with `PieD`/
   * `PieI` bones (only the Jenner today) — HexMap's own UnitMarker keeps
   * its existing path-interpolation fallback for every other chassis. */
  onFootstep?: (worldPos: [number, number, number], footHalfWidth: number, footHalfDepth: number, rotationY: number) => void
}

const GENERIC_MODEL_URL = '/models/mech-placeholder.glb'

// Real user report: "cuando corre, la parte de WalkStart se tiene que
// reproducir mucho mas rapido" — see its own use site (the locomotion
// state machine's run branch) for why this only ever applies there, never
// to a plain walk's own WalkStart.
const RUN_WALK_START_SPEED = 2.2

// Real user request: "vamos a seguir una escala real de juego... un mech
// mide entre 8 y 14 [metros]" — real BattleTech canon (confirmed:
// BattleMechs stand 8-14m tall, average often cited around 10m). This
// used to be 1.65 (a "tabletop miniature" stylization tuned by eye
// against the hex grid, not real proportions — the hex grid was 1 world
// unit back then too, so a 1.65-unit mech read as absurdly hex-
// overhanging once hexMath.ts's own HEX_SIZE made a hex genuinely 30m).
// Every OTHER prop in the scene (trees, buildings, missiles, fog,
// explosions...) was in turn tuned by eye against THIS mech, never
// against the hex — so those all get the SAME multiplier this constant
// just did (1.65 → 10, ×6.06) rather than the hex's own ×30, or a real
// forest/mech scene would suddenly read as a forest of 66m trees. See
// each of those files' own doc comments for the same reasoning applied
// locally. No per-chassis height variation yet (every mech still renders
// at this one height regardless of tonnage) — mechAssets.ts has no
// height/tonnage field to key off today; real 8m-light vs 14m-assault
// variation is a natural, cheap follow-up once wanted, not part of this
// pass (scoped to "la normalizacion de alturas" as asked).
export const MODEL_SCALE = 10

// Local bounding box top is y=1 (see above) — this is roughly where a
// head/cockpit sits rather than the very topmost point, so
// FirstPersonView can derive its camera eye height as MODEL_SCALE *
// MODEL_HEAD_FRACTION instead of a hardcoded number that would silently
// drift out of sync whenever MODEL_SCALE changes.
export const MODEL_HEAD_FRACTION = 0.9

// Roughly torso-center height — HexMap's attack-beam VFX starts/ends
// here (MODEL_SCALE * MODEL_CHEST_FRACTION) so a shot lands on the
// chest regardless of how MODEL_SCALE is tuned, instead of a fixed
// offset that silently drifts toward the legs as the model grows.
export const MODEL_CHEST_FRACTION = 0.6

// How strongly the faction color (player/enemy/pilot color) tints the
// model — blended over white, so 1 would fully replace the model's own
// paint job and 0 would show no tint at all. Kept low so it reads as a
// faint wash rather than recoloring the mech outright.
const FACTION_TINT_STRENGTH = 0.22

// A destroyed mech's own charred-wreck color (HexMap's own DEAD_CHAR_COLOR
// — kept here, exported, as the one shared source both it and MechLabView's
// broken-limb pieces blend toward, real user request: "quiero que las
// extremidades rotas se pongan del color de los mechs muertos, así como
// carbonizado"). Deliberately near-black rather than a dark grey — a grey
// still reads as "mostly the faction color", this reads as burnt.
export const DEAD_MECH_CHAR_COLOR = '#17140f'

// useGLTF caches and shares a single scene graph across every mech on the
// board — mutating a shared material's color would recolor every other
// instance using it too. Clone the hierarchy AND each mesh's own material
// (geometry/textures stay shared, only the lightweight material needs its
// own copy) so each instance's faction tint is independent. SkeletonUtils.
// clone (not the plain Object3D.clone a non-rigged model could get away
// with) — a rigged model's SkinnedMesh.skeleton still points at the
// ORIGINAL bones after a plain clone, so every instance sharing one URL
// would silently share (and fight over) one skeleton instead of animating
// independently.
//
// Also normalizes every model to the same local convention the original
// placeholder happened to already be in (1 unit tall, centered on X/Z,
// resting on y=0) — curated per-chassis assets (mechAssets.ts) come from
// all kinds of sources with their own scale/units/pivot, and this keeps
// MODEL_SCALE and the MODEL_HEAD_FRACTION/MODEL_CHEST_FRACTION derived
// heights meaningful for any model, not just the placeholder — a newly
// dropped-in .glb never needs its own hand-tuned scale/offset entry.
//
// Exported (not just Mech3DModel's own internal useMemo) so MechLabView's
// rig viewer can put the exact same normalized instance under a
// SkeletonHelper/animation scrubber — real user request: "quiero una
// opcion para que me muestres el rig que hiciste para la anim de idle y
// movimiento" — without silently drifting out of sync with whatever this
// component itself renders in the actual game.
export function normalizeMechInstance(scene: THREE.Object3D): THREE.Group {
  const clone = SkeletonUtils.clone(scene) as THREE.Group
  clone.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.material = (obj.material as THREE.Material).clone()
      obj.castShadow = true
    }
  })
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
}

// ---------------------------------------------------------------------
// Real footstep tracking — real user request: "recuerda que te pedi que
// fuera la impresion del pie del mech donde pisa, no un punto random en
// un hex... Si las huellas IK cogen la forma de la planta del pie de la
// malla, me valen." The rig's own foot bones are named `PieD` (derecho)
// / `PieI` (izquierdo) — a real convention the user confirmed directly
// ("asi se van a llamar... lo usaran todos"), not a heuristic guess.
// Today only the Jenner has them; any chassis without them simply
// returns nulls here and HexMap.tsx falls back to its existing
// geometric-approximation footprint system.

/** Same "most curated assets are one monolithic SkinnedMesh, no separate
 * per-limb mesh node" constraint MechLabView.tsx's own `findSkinnedMesh`
 * already documents (real user report there: "en el selector de
 * extremidades selecciona siempre todo el mech") — this is that same
 * function, needed here too since gameplay never had a reason to reach
 * the skeleton before now. */
function findSkinnedMeshInGroup(root: THREE.Object3D): THREE.SkinnedMesh | null {
  const found: THREE.SkinnedMesh[] = []
  root.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) found.push(obj as THREE.SkinnedMesh)
  })
  return found[0] ?? null
}

/** Exact-name lookup, not a positional heuristic — `null` for either
 * side a given chassis hasn't been rigged with yet. Cheap (a handful of
 * bones to scan) and safe to call fresh per mounted instance — unlike
 * `getFootShape` below, there's no reason to cache bone OBJECT
 * references across instances, since each mounted Mech3D already needs
 * its own independent clone/skeleton for its own animation state
 * regardless. */
function findFootBones(skinnedMesh: THREE.SkinnedMesh | null): { left: THREE.Bone | null; right: THREE.Bone | null } {
  if (!skinnedMesh) return { left: null, right: null }
  let left: THREE.Bone | null = null
  let right: THREE.Bone | null = null
  for (const bone of skinnedMesh.skeleton.bones) {
    if (bone.name === 'PieI') left = bone
    else if (bone.name === 'PieD') right = bone
  }
  return { left, right }
}

interface FootShape {
  halfWidth: number
  halfDepth: number
}

// Keyed by `${url}:${boneName}` — the bind-pose geometry (and therefore
// the real foot shape) is identical across every instance of the same
// chassis, so this is computed once per chassis ever, not once per
// mounted mech. Same "cache per chassis, not per instance" pattern
// TerrainDecor.tsx's own rockUnitScale/rockRawOffset Maps already use.
const footShapeCache = new Map<string, FootShape | null>()

/** Real per-chassis foot size, derived from the ACTUAL mesh — not a
 * generic guess. Selects every vertex whose skin weight favors this one
 * bone (same `boneInfluenceMask`-style skin-weight membership technique
 * MechLabView.tsx's own limb-paint/RigViewer features already use to
 * answer "which vertices does this bone actually drive," since there's
 * no separate foot mesh node to just grab directly — see
 * findSkinnedMeshInGroup's own doc comment) and takes the local-space
 * bounding box of just those vertices. `null` if the mesh has no real
 * skin-weight data, or the bone influences nothing (shouldn't happen
 * for a bone that's actually part of the working rig, but a missing/
 * corrupt weight paint should degrade to "no shape," not a crash). */
function getFootShape(url: string, mesh: THREE.SkinnedMesh, bone: THREE.Bone): FootShape | null {
  const key = `${url}:${bone.name}`
  if (footShapeCache.has(key)) return footShapeCache.get(key) ?? null

  const geometry = mesh.geometry
  const skinIndex = geometry.getAttribute('skinIndex')
  const skinWeight = geometry.getAttribute('skinWeight')
  const position = geometry.getAttribute('position')
  if (!skinIndex || !skinWeight || !position) {
    footShapeCache.set(key, null)
    return null
  }
  const boneIndex = mesh.skeleton.bones.indexOf(bone)
  if (boneIndex < 0) {
    footShapeCache.set(key, null)
    return null
  }

  const FOOT_WEIGHT_THRESHOLD = 0.25
  const box = new THREE.Box3()
  let found = false
  for (let i = 0; i < position.count; i++) {
    let influenced = false
    for (let j = 0; j < 4; j++) {
      if (skinIndex.getComponent(i, j) === boneIndex && skinWeight.getComponent(i, j) >= FOOT_WEIGHT_THRESHOLD) {
        influenced = true
        break
      }
    }
    if (!influenced) continue
    found = true
    box.expandByPoint(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)))
  }
  if (!found) {
    // Real rig fact, confirmed by directly inspecting the Jenner GLB's
    // own skin data (offline analysis, not a guess): PieD/PieI have
    // ZERO vertices at ANY weight — they're pure IK end-effector/socket
    // bones, not skinning bones. The actual foot geometry is skinned to
    // their PARENT (TibiaD/TibiaI, the shin+foot combined segment), so
    // there is no distinct "foot" vertex group this rig exposes at all.
    // This is exactly why footsteps stopped firing entirely (real user
    // report: "no está dejando ninguna huella") once the Y-motion timing
    // itself was fixed — `getFootShape` returning null here made the
    // caller's `if (!bone || !shape) continue` skip the foot outright,
    // with no shape to report regardless of how correct the touchdown
    // detection was. The bone's own POSITION still tracks correctly
    // (plain forward-kinematics, unrelated to skin weights — verified
    // against the same real GLB), so rather than silently killing every
    // footstep for a whole chassis, fall back to a generic oval sized
    // off the mesh's own overall bind-pose height — proportionate
    // regardless of a given chassis's raw unit scale, same "fraction of
    // total height" convention MODEL_HEAD_FRACTION/MODEL_CHEST_FRACTION
    // already use elsewhere in this file. HexMap.tsx's own
    // MIN_FOOTPRINT_HALF_SIZE floors the final world-space size anyway,
    // so this only needs to be in the right ballpark.
    geometry.computeBoundingBox()
    const meshHeight = geometry.boundingBox ? geometry.boundingBox.max.y - geometry.boundingBox.min.y : 1
    const fallbackShape: FootShape = { halfWidth: meshHeight * 0.05, halfDepth: meshHeight * 0.08 }
    footShapeCache.set(key, fallbackShape)
    return fallbackShape
  }
  const size = new THREE.Vector3()
  box.getSize(size)
  // X/Z only — the sole's own footprint on the ground plane, in the
  // SkinnedMesh's own local (bind-pose) space, same normalized space
  // normalizeMechInstance already puts the whole model into. Callers
  // multiply by MODEL_SCALE for real world units, same convention every
  // other local-space measurement in this file already follows (see
  // MODEL_HEAD_FRACTION/MODEL_CHEST_FRACTION's own use sites).
  const shape: FootShape = { halfWidth: size.x / 2, halfDepth: size.z / 2 }
  footShapeCache.set(key, shape)
  return shape
}

/** Live-tunable knobs for useMechPbr, below — pulled out into their own
 * type so MechLabView's Textura tab can expose them as sliders instead of
 * these being fixed constants only this file can change. */
export interface MechPbrSettings {
  /** UV tiling repeat for the detail maps. */
  repeat: number
  /** Multiplies normalMap's own perturbation strength — see the default's
   * own doc comment below for why it's turned down from three.js's own
   * default of 1. */
  normalScale: number
  roughness: number
  metalness: number
  /** See MECH_COLOR_BOOST's own doc comment. */
  colorBoost: number
  /** Strength of the procedural ambient-occlusion map — see
   * buildProceduralAoTexture's own doc comment for how it's derived (no
   * real scanned AO map exists for this texture set). 0 disables it
   * entirely (no darkening in cavities); 1 is three.js's own full
   * strength. */
  aoIntensity: number
}

// Real bug found via the Textura tab's own sliders: "el detalle de
// relieve... no hace nada y la repeticion de texturas tampoco" — measured
// live (Playwright, pixel-diffing two full-page screenshots at repeat=1
// vs repeat=20): there WAS a real, non-zero difference, just a tiny one
// (~0.07% of pixels, small magnitude) — the sliders were never inert,
// they were just drowned out. Root cause: MeshStandardMaterial multiplies
// each map sample by its own scalar (finalRoughness = roughness *
// roughnessMapSample, finalMetalness = metalness * metalnessMapSample);
// at metalness 0.06 the metalnessMap's entire 0..1 range only ever moves
// the final value across 0..0.06 — visually nothing, regardless of
// normalScale or repeat. That low metalness was chosen for a SEPARATE
// reason (the earlier "el PBR oscurece" report) — but MECH_COLOR_BOOST
// already exists to fix brightness independently of metalness now, so
// metalness/roughness no longer need to stay this low just to keep the
// model readable. Raised back toward values where the maps' own spatial
// variation actually shows (confirmed live: metalness 1 vs 0 changes the
// WHOLE model dramatically, so somewhere well above 0.06 is required for
// per-pixel variation to read at all).
export const MECH_PBR_DEFAULTS: MechPbrSettings = {
  repeat: MECH_PBR_REPEAT,
  normalScale: 0.6,
  roughness: 0.6,
  metalness: 0.24,
  colorBoost: MECH_COLOR_BOOST,
  aoIntensity: 0.6,
}

// Real user request: "y el ambient occlusion?" — this texture set only
// ever shipped color/normal/roughness/metalness (see MECH_PBR_URLS's own
// doc comment), no scanned AO map. Rather than fake it with an unrelated
// map (the roughness map LOOKS like it could pass as one but doesn't
// measure the same thing) or skip it, this derives a real occlusion
// approximation from the normal map's own tangent-space X/Y: a texel
// where the surface leans away from straight-up (large X/Y deviation —
// an edge or cavity wall) is darkened; a flat texel (normal pointing
// straight out, X/Y near zero) stays bright. Computed ONCE (module-level
// cache, keyed by nothing but its own one input — this texture set never
// changes at runtime) via a throwaway 2D canvas, not per mech instance.
let cachedProceduralAo: THREE.Texture | null = null
function getProceduralAoTexture(normalTexture: THREE.Texture): THREE.Texture {
  if (cachedProceduralAo) return cachedProceduralAo
  const img = normalTexture.image as HTMLImageElement
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, img.width, img.height)
  const src = ctx.getImageData(0, 0, img.width, img.height)
  const out = ctx.createImageData(img.width, img.height)
  for (let i = 0; i < src.data.length; i += 4) {
    const nx = (src.data[i] / 255) * 2 - 1
    const ny = (src.data[i + 1] / 255) * 2 - 1
    const slope = Math.min(1, Math.sqrt(nx * nx + ny * ny))
    const ao = Math.round((1 - slope) * 255)
    out.data[i] = out.data[i + 1] = out.data[i + 2] = ao
    out.data[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  // Data, not color — same reasoning as the normal/roughness/metalness
  // maps' own colorSpace assignment below.
  texture.colorSpace = THREE.NoColorSpace
  cachedProceduralAo = texture
  return texture
}

// Real user request: "añade un PBR para el Jenner" — see MECH_PBR_URLS's
// own doc comment. Exported (not just an effect private to Mech3DModel)
// so every OTHER place that loads+normalizes a mech instance itself —
// MechLabView's own LimbPainter and RigViewer, neither of which renders
// through <Mech3D> — can apply the exact same surface detail instead of
// silently missing it (real user report: "solo aparece en el mechlab en
// selección de armas, no aparece en el resto de sitios"). Generic — every
// chassis gets this now ("PBR van a tener todos los mechs... esto tiene
// que ser genérico"), not gated to one chassis name.
export function useMechPbr(
  instance: THREE.Group,
  options?: {
    /** Mech3DModel's own faction-tint effect (below) resets `mat.color`
     * from scratch on every faction/destroyed/shutdown change, so IT owns
     * applying the brightness boost there (see that effect's own doc
     * comment) — passing false here stops this hook from ALSO touching
     * color and fighting that effect. LimbPainter/RigViewer have no such
     * effect (their mech's color never changes after mount), so they leave
     * this at its default (true) and this hook is the only thing that ever
     * sets color for them. */
    applyColorBoost?: boolean
    /** Overrides any subset of MECH_PBR_DEFAULTS — MechLabView's Textura
     * tab passes its own live slider state here; every other caller omits
     * this and gets the plain defaults. */
    settings?: Partial<MechPbrSettings>
  },
) {
  const applyColorBoost = options?.applyColorBoost ?? true
  const repeat = options?.settings?.repeat ?? MECH_PBR_DEFAULTS.repeat
  const normalScale = options?.settings?.normalScale ?? MECH_PBR_DEFAULTS.normalScale
  const roughness = options?.settings?.roughness ?? MECH_PBR_DEFAULTS.roughness
  const metalness = options?.settings?.metalness ?? MECH_PBR_DEFAULTS.metalness
  const colorBoost = options?.settings?.colorBoost ?? MECH_PBR_DEFAULTS.colorBoost
  const aoIntensity = options?.settings?.aoIntensity ?? MECH_PBR_DEFAULTS.aoIntensity
  // Always loaded (drei's useTexture cache is global/keyed by URL, so
  // every OTHER mech — or any die using this same chrome set — pays for
  // this exactly once) rather than conditionally — hooks can't be called
  // conditionally anyway.
  const mechPbrTextures = useTexture(MECH_PBR_URLS)

  useEffect(() => {
    const aoSource = getProceduralAoTexture(mechPbrTextures.normalMap)
    instance.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      const mat = obj.material as THREE.MeshStandardMaterial
      const normalMap = mechPbrTextures.normalMap.clone()
      const roughnessMap = mechPbrTextures.roughnessMap.clone()
      const metalnessMap = mechPbrTextures.metalnessMap.clone()
      const aoMap = aoSource.clone()
      for (const tex of [normalMap, roughnessMap, metalnessMap, aoMap]) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(repeat, repeat)
        // Normal/roughness/metalness/AO are DATA, not color — must never
        // be sRGB-decoded (that would wash out/skew their actual values).
        tex.colorSpace = THREE.NoColorSpace
        tex.needsUpdate = true
      }
      mat.normalMap = normalMap
      mat.aoMap = aoMap
      mat.aoMapIntensity = aoIntensity
      // Live-tested (Playwright) at normalScale 1: the tiled detail normal
      // map, at full strength, faceted the surface into hard dark creases
      // under a single directional light — read as "the whole model went
      // blotchy/black", not a subtle scratched-metal detail. Turned way
      // down so it stays a faint surface-grain hint instead of visibly
      // reshaping the model's own silhouette shading.
      mat.normalScale.set(normalScale, normalScale)
      mat.roughnessMap = roughnessMap
      mat.metalnessMap = metalnessMap
      // Real scanned surface detail (fine scratches/wear) layered under
      // the model's own painted base-color texture, not a full chrome
      // finish — a battle mech reads as painted metal, not a mirror.
      // Real user report: "el PBR oscurece mucho el modelo" — metalness
      // without a scene environment map has nothing to reflect, so any
      // metallic fraction just eats diffuse brightness with no IBL to
      // give it back, and the roughnessMap's own darker/smoother spots
      // read as near-black gaps between the direct-light highlights with
      // nothing else to fill them in. Both scalars (each multiplies its
      // own map sample, so lowering them pulls every texel down, not just
      // the average) cut well below the map's own range so the result
      // stays legible under plain ambient/directional light, no
      // environment map required anywhere this renders.
      mat.roughness = roughness
      mat.metalness = metalness
      // Real, separate finding (measured live: the Jenner's own base-color
      // texture averages ~19% brightness — genuinely a dark, near-black
      // camo paint job baked into that .glb) — turning metalness/
      // roughness/normalScale down (above) did NOT fix the "oscurece"
      // report on its own, because the maps were never the real cause.
      // Confirmed by disabling them entirely and finding the render just
      // as dark. Multiplying (never replacing — see `applyColorBoost`'s
      // own doc comment above for why this is conditional) whatever color
      // is already on the material.
      //
      // Real bug found via the Textura tab's own sliders: "da igual en
      // que direccion le mueva, siempre hace lo mismo" — this effect
      // reruns on EVERY slider change (repeat/normalScale/roughness/
      // metalness/colorBoost are all in one dependency array below), and
      // multiplying the material's CURRENT color each run compounds it —
      // a few slider nudges later the color's already past white and
      // clipping, so every further change looks identical (saturated).
      // Snapshotting the ORIGINAL color once (on this material's very
      // first PBR pass) and always multiplying from THAT fixed snapshot,
      // never from whatever multiplyScalar left behind last run, makes
      // this idempotent — rerunning with the same colorBoost twice gives
      // the same result instead of doubling it.
      if (applyColorBoost) {
        const userData = mat.userData as { __mechPbrBaseColor?: THREE.Color }
        if (!userData.__mechPbrBaseColor) userData.__mechPbrBaseColor = mat.color.clone()
        mat.color.copy(userData.__mechPbrBaseColor).multiplyScalar(colorBoost)
      }
      mat.needsUpdate = true
    })
  }, [instance, mechPbrTextures, applyColorBoost, repeat, normalScale, roughness, metalness, colorBoost, aoIntensity])
}

function Mech3DModel({
  color, emissive, emissiveIntensity, chassis, model, isMoving, movementType, jumpPhase, fallen, dead,
  tintStrength, onLoaded, onSurfaceClick, playAnimation, onFootstep,
}: Mech3DProps) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene, animations } = useGLTF(url)
  const groupRef = useRef<THREE.Group>(null)

  // This function body only runs once useGLTF has real data (Suspense
  // guarantees it — see onLoaded's own doc comment above), so firing
  // once per mount here is exactly "this instance's mesh now exists".
  useEffect(() => {
    onLoaded?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const instance = useMemo(() => normalizeMechInstance(scene), [scene])

  // Real foot-bone lookup + real sole shape (see this file's own
  // findFootBones/getFootShape doc comments) — bones re-found fresh per
  // mounted instance (SkeletonUtils.clone gives each instance its own
  // bone objects, and this lookup is cheap), shape cached per chasis URL
  // (expensive-ish, identical across every instance of one chasis).
  // `null` sides for any chassis not yet rigged with PieD/PieI — the
  // footstep-detection useFrame below simply never fires for those.
  const footRig = useMemo(() => {
    const skinnedMesh = findSkinnedMeshInGroup(instance)
    const { left, right } = findFootBones(skinnedMesh)
    const leftShape = skinnedMesh && left ? getFootShape(url, skinnedMesh, left) : null
    const rightShape = skinnedMesh && right ? getFootShape(url, skinnedMesh, right) : null
    return { skinnedMesh, left, right, leftShape, rightShape }
  }, [instance, url])

  // applyColorBoost: false — this component's own tint effect below owns
  // `mat.color` (it resets it from scratch on every faction/destroyed/
  // shutdown change, unlike LimbPainter/RigViewer's static preview), so
  // it applies the same brightness boost itself, in the one place that's
  // already reactive to those changes. See useMechPbr's own doc comment
  // on the option.
  useMechPbr(instance, { applyColorBoost: false })

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

  // Real user request: proper Walk/Run/Jump/Caerse-Levantarse chains
  // instead of the old straight Idle/Walk ternary — see this file's own
  // Mech3DProps doc comments (isMoving/movementType/jumpPhase/fallen/dead)
  // for what drives each. Latest prop values live in a ref (`inputsRef`)
  // so the mixer's own 'finished' listener — registered ONCE per model
  // load, not re-created on every prop change — always reacts to
  // whatever's current when a one-shot clip actually ends, not whatever
  // was current when the listener was first set up.
  const inputsRef = useRef({ isMoving, movementType, jumpPhase, fallen, dead })
  inputsRef.current = { isMoving, movementType, jumpPhase, fallen, dead }
  // Which clip is currently active, and whether it's a one-shot in
  // flight (walking chains prevent a mid-flight prop change — e.g.
  // isMoving flipping false while still in "WalkStart" — from cutting
  // the current clip off; the 'finished' handler re-decides once it
  // actually ends, reading inputsRef fresh at that point).
  const currentClipRef = useRef<string | null>(null)
  const oneShotInFlightRef = useRef(false)
  // Sticky per-trip flag: which chain (walk vs run) this continuous
  // isMoving stretch is using — movementType is only read when a NEW
  // trip starts (isMoving false→true), matching that a single real move
  // command never changes type mid-path.
  const runningTripRef = useRef(false)
  // Own state machine for fallen — 'standing' the rest of the time.
  // Edge-detected from the plain `fallen` boolean prop (see its own doc
  // comment) rather than driven by a three-state prop, so HexMap/
  // FirstPersonView never have to compute "just fell" vs "still down"
  // themselves.
  const fallStateRef = useRef<'standing' | 'falling' | 'prone' | 'standingUp'>(fallen ? 'prone' : 'standing')
  const prevFallenRef = useRef(fallen ?? false)
  // Set inside the setup effect below (to the real `sync`/`advance`
  // closures, which need `actions` — only available there) so the
  // separate prop-watching effects further down can trigger a resync
  // without re-registering the mixer's own 'finished' listener on every
  // prop tick. syncRef respects oneShotInFlightRef (won't cut off a
  // WalkStart/RunStart mid-flight just because isMoving flickered);
  // advanceRef always acts immediately — used only for fallen (Caerse/
  // Levantarse), where a real user click (Tirarse/Levantarse) should
  // react right away, not wait for whatever one-shot happened to be
  // playing. onFinished's own identity check (event.action vs
  // actions[currentClipRef.current]) safely ignores a 'finished' event
  // from a clip that got abandoned mid-flight this way.
  const syncRef = useRef<(() => void) | null>(null)
  const advanceRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (Object.keys(actions).length === 0) return

    const crossFadeTo = (name: string | undefined, loop: boolean, timeScale = 1): THREE.AnimationAction | null => {
      if (!name) return null
      const next = actions[name]
      if (!next) return null
      // Always set (not just on a fresh play) — AnimationAction objects
      // are reused across plays, so a previous run's own timeScale would
      // otherwise leak into a later plain-walk use of this same clip.
      next.timeScale = timeScale
      if (currentClipRef.current === name && next.isRunning()) return next
      const prev = currentClipRef.current ? actions[currentClipRef.current] : null
      next.reset()
      if (loop) {
        next.setLoop(THREE.LoopRepeat, Infinity)
        // Real user request: "imaginate que hay 2 jenners jugando, quiero
        // asegurarme de que sus animaciones no estan sincronizadas" — see
        // this same reasoning documented in more depth in this file's
        // git history; a random phase into the loop's own duration reads
        // identically to starting from the top, just desynced.
        next.time = Math.random() * next.getClip().duration
      } else {
        next.setLoop(THREE.LoopOnce, 1)
        next.clampWhenFinished = true
      }
      next.fadeIn(0.2).play()
      prev?.fadeOut(0.2)
      currentClipRef.current = name
      oneShotInFlightRef.current = !loop
      return next
    }

    // One step at a time — called at mount, whenever a relevant prop
    // changes AND nothing one-shot is currently in flight, and every
    // time a one-shot clip's own 'finished' event fires (which always
    // re-reads inputsRef/fallStateRef fresh, so it naturally advances a
    // multi-step chain like WalkStart→RunStart→Run one link per call).
    const advance = () => {
      if (inputsRef.current.dead) {
        const prev = currentClipRef.current ? actions[currentClipRef.current] : null
        prev?.fadeOut(0.3)
        currentClipRef.current = null
        oneShotInFlightRef.current = false
        return
      }
      const fall = fallStateRef.current
      if (fall === 'falling') { crossFadeTo('Caerse', false); return }
      if (fall === 'prone') { oneShotInFlightRef.current = false; return } // held wherever Caerse left it
      if (fall === 'standingUp') { crossFadeTo('Levantarse', false); return }

      const jump = inputsRef.current.jumpPhase
      if (jump === 'takeoff') { crossFadeTo('Despegar', false); return }
      if (jump === 'flight') { crossFadeTo('Saltar', true); return }
      if (jump === 'landing') { crossFadeTo('Aterrizar', false); return }

      if (inputsRef.current.isMoving) {
        const current = currentClipRef.current
        if (runningTripRef.current) {
          if (current === 'WalkStart') { crossFadeTo('RunStart', false); return }
          if (current === 'RunStart' || current === 'Run') { crossFadeTo('Run', true); return }
          // Real user report: "cuando corre, la parte de WalkStart se
          // tiene que reproducir mucho mas rapido" — WalkStart is the
          // same wind-up clip a plain walk uses at normal speed, but a
          // mech about to RUN shouldn't linger through it at that pace;
          // sped up only on this branch (RUN_WALK_START_SPEED), never on
          // the plain-walk path below.
          if (crossFadeTo('WalkStart', false, RUN_WALK_START_SPEED)) return
          if (crossFadeTo('RunStart', false)) return
          crossFadeTo('Run', true)
          return
        }
        // Real user report: a multi-hex walk only ever left one footprint
        // pair, always near the destination, nothing along the path (and
        // "no lo hace siempre" — inconsistent) — the Walk clip's own
        // authored pace (2s/cycle) is decoupled from how fast the mech
        // actually crosses the board, so a fast multi-hex move finishes
        // before the legs even complete one real stride cycle. See
        // hexMath.ts's own WALK_CYCLE_TIME_SCALE doc comment for the real
        // derivation (measured against the actual Jenner GLB, not
        // guessed) — playing the clip that much faster makes roughly one
        // real touchdown happen per hex crossed, matching a real gait.
        if (current === 'WalkStart' || current === 'Walk') { crossFadeTo('Walk', true, WALK_CYCLE_TIME_SCALE); return }
        if (crossFadeTo('WalkStart', false)) return
        crossFadeTo('Walk', true, WALK_CYCLE_TIME_SCALE)
        return
      }

      // Not moving — wind down through *End if we were actually
      // walking/running, otherwise straight to Idle.
      const current = currentClipRef.current
      if (current === 'Run' || current === 'RunStart' || (runningTripRef.current && current === 'WalkStart')) {
        runningTripRef.current = false
        if (crossFadeTo('RunEnd', false)) return
        crossFadeTo('Idle', true)
        return
      }
      if (current === 'Walk' || current === 'WalkStart') {
        if (crossFadeTo('WalkEnd', false)) return
        crossFadeTo('Idle', true)
        return
      }
      crossFadeTo('Idle', true)
    }
    advanceRef.current = advance

    const sync = () => {
      if (playAnimation === false) {
        Object.values(actions).forEach((a) => a?.stop())
        currentClipRef.current = null
        oneShotInFlightRef.current = false
        return
      }
      // A brand-new trip (not already mid walk/run chain, and free to
      // start one — not fallen, not jumping): latch which chain
      // (walk/run) it uses now, before advance() reads runningTripRef.
      // Fixed for the rest of THIS trip even if movementType somehow
      // changed since — matches that a real move command never changes
      // type mid-path.
      if (
        inputsRef.current.isMoving && fallStateRef.current === 'standing' && inputsRef.current.jumpPhase == null
        && !['WalkStart', 'Walk', 'RunStart', 'Run'].includes(currentClipRef.current ?? '')
      ) {
        runningTripRef.current = inputsRef.current.movementType === 'run'
      }
      if (!oneShotInFlightRef.current) advance()
    }
    syncRef.current = sync

    const onFinished = (event: { action: THREE.AnimationAction }) => {
      const finishedClip = currentClipRef.current
      if (finishedClip == null || event.action !== actions[finishedClip]) return
      oneShotInFlightRef.current = false
      // A one-shot fall/stand transition just completed — settle into
      // its terminal held state before the normal advance() runs. Real
      // bug fixed here: this used to check fallStateRef.current instead
      // of `finishedClip` — if the user stood up (advanceRef, below,
      // fires immediately and abandons Caerse mid-flight) BEFORE Caerse's
      // own 'finished' ever arrived, fallStateRef was already
      // 'standingUp' by the time Caerse's (now stale/abandoned) finished
      // event landed, so the old `fallStateRef.current === 'falling'`
      // check silently failed AND the `=== 'standingUp'` check below it
      // matched instead — jumping straight to 'standing' without ever
      // actually playing Levantarse. Gating on which clip ACTUALLY just
      // finished (matched against what fallStateRef wanted AT THAT
      // CLIP's own start) makes this correct regardless of how many
      // times the user changed their mind mid-animation.
      if (finishedClip === 'Caerse' && fallStateRef.current === 'falling') fallStateRef.current = 'prone'
      else if (finishedClip === 'Levantarse' && fallStateRef.current === 'standingUp') fallStateRef.current = 'standing'
      advance()
    }

    const mixer = Object.values(actions)[0]?.getMixer()
    mixer?.addEventListener('finished', onFinished)
    sync()

    return () => {
      mixer?.removeEventListener('finished', onFinished)
      syncRef.current = null
      advanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, playAnimation])

  // The effect above only fires on mount (its own deps are just
  // [actions, playAnimation], both stable per model load) — this is the
  // one that actually re-runs `sync()` whenever any of the real inputs
  // change. Kept separate so the mixer 'finished' listener above is
  // never torn down/re-registered on every single prop tick.
  useEffect(() => {
    const was = prevFallenRef.current
    const now = fallen ?? false
    if (!was && now) fallStateRef.current = 'falling'
    else if (was && !now) fallStateRef.current = 'standingUp'
    prevFallenRef.current = now
    // advanceRef, not syncRef — real user report: "Tirarse"/"Levantarse"
    // must react right away, not wait for whatever one-shot (a walk-chain
    // step, an earlier Caerse still finishing) happened to be mid-flight;
    // crossFadeTo's own fadeOut of whatever was playing makes abandoning
    // it mid-clip a clean crossfade, not a jump-cut.
    advanceRef.current?.()
  }, [fallen])

  // The rest of the real inputs (isMoving/movementType/jumpPhase/dead) —
  // kept separate from the fallen effect above because THESE should
  // respect a walk-chain one-shot already in flight (syncRef), unlike a
  // fall/stand request.
  useEffect(() => {
    syncRef.current?.()
  }, [isMoving, movementType, jumpPhase, dead])

  // Real user request: quería una segunda pose de reposo ("Idle2") que se
  // reproduzca "de vez en cuando" (cada 30s-1min) en vez de mezclada
  // siempre en el mismo loop — así no se nota repetitivo. Only while
  // Idle (not Walk, not fallen, not jumping, not frozen) is genuinely the
  // active clip, and only for a mech that actually ships an "Idle2" —
  // every other mech's Idle just loops exactly as before.
  useEffect(() => {
    const idle = actions['Idle']
    const idle2 = actions['Idle2']
    if (playAnimation === false || isMoving || jumpPhase != null || fallen || dead || !idle || !idle2) return

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>

    const scheduleNext = () => {
      const delay = 30_000 + Math.random() * 30_000
      timeoutId = setTimeout(playVariation, delay)
    }

    const playVariation = () => {
      if (cancelled) return
      idle2.reset().setLoop(THREE.LoopOnce, 1)
      idle2.clampWhenFinished = true
      idle.fadeOut(0.3)
      idle2.fadeIn(0.3).play()
    }

    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== idle2 || cancelled) return
      idle2.fadeOut(0.3)
      idle.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.3).play()
      scheduleNext()
    }

    const mixer = idle.getMixer()
    mixer.addEventListener('finished', onFinished)
    scheduleNext()

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
      mixer.removeEventListener('finished', onFinished)
      // isMoving/playAnimation flipping mid-variation (or unmount) needs
      // to hand back to Idle/Walk cleanly instead of leaving Idle2 stuck
      // playing alongside whatever the OTHER effect just started.
      if (idle2.isRunning()) idle2.fadeOut(0.2)
    }
  }, [actions, isMoving, jumpPhase, fallen, dead, playAnimation])

  // Real user request: real Caerse/Levantarse instead of an instantly-
  // snapped static tilt — this now lives here (previously an external
  // wrapper `<group>` in HexMap.tsx). Real bug found live: a rig that
  // actually ships Caerse/Levantarse already animates the fall/stand
  // itself (real root/bone motion, ending properly on the ground) — ALSO
  // applying this synthetic rigid-body tilt on top double-rotated the
  // model, driving it straight through the floor ("cuando se cae clipea
  // con el suelo"). Now this only ever synthesizes a tilt as a FALLBACK
  // for a rig with no Caerse clip at all (nothing else would show it
  // falling over); whenever the real clip exists, this stays at 0 for
  // the model's own animation to do 100% of the work, held at whatever
  // pose Caerse's own clampWhenFinished left it in once it ends ("se debe
  // quedar en el ultimo frame del caerse").
  const FALL_TILT_Z = Math.PI * 0.42
  useProfiledFrame('mechs', () => {
    const group = groupRef.current
    if (!group) return
    const state = fallStateRef.current
    if (state === 'falling' || state === 'prone') {
      group.rotation.z = actions['Caerse'] ? 0 : FALL_TILT_Z
      return
    }
    group.rotation.z = 0
  })

  // Real footstep detection — see this file's own onFootstep doc
  // comment. Tracks each rigged foot bone's world-space Y per frame and
  // fires the instant it stops descending and starts rising again (a
  // local minimum = the real moment the sole meets the ground), rather
  // than a fixed timer/position along the walk path. Only while
  // `isMoving` (via `inputsRef`, same live-value pattern the locomotion
  // effect above already uses) — a still mech's feet don't leave marks,
  // and resets tracking state whenever it stops so the next walk's first
  // frame doesn't read a stale descent from a previous, unrelated move.
  // Real bug found live, twice (user reports): a first version compared
  // only the PER-FRAME delta against a small epsilon, which is fragile
  // in both directions at once — animation-curve interpolation jitter
  // near the flat stance phase was enough to cross a small epsilon
  // (dozens of spurious footprints stamped before the mech left its
  // first hex), but raising the epsilon to reject that jitter also
  // rejected real motion during the eased-in/eased-out top and bottom of
  // a natural stride arc, where the per-frame delta is smallest exactly
  // when it needs to cross the threshold cleanly (no footprints at all).
  // A single per-frame threshold can't be both, because it doesn't know
  // the difference between "real motion, sampled during its slow part"
  // and "no real motion, just noise" — only the CUMULATIVE range since
  // the last apex tells them apart, regardless of animation speed or
  // frame rate: track each foot's own running peak Y (`peakY`, the top
  // of its current swing); once it has dropped at least
  // FOOT_ARM_DROP below that peak, it's `armed` — a real, deliberate
  // descent has now happened (jitter alone never accumulates a
  // consistent one-directional drop that big); once armed, the first
  // frame the foot stops sinking (`y >= prevY`) is the real touchdown —
  // fire there, then start tracking a fresh peak from that landing spot
  // for the next swing. Immune to jitter (never arms on it) and immune
  // to slow real motion (arms on cumulative range, not any single
  // frame's delta).
  const FOOT_ARM_DROP = 0.15
  const footTrackRef = useRef<{
    left: { prevY: number | null; peakY: number; armed: boolean }
    right: { prevY: number | null; peakY: number; armed: boolean }
  }>({ left: { prevY: null, peakY: 0, armed: false }, right: { prevY: null, peakY: 0, armed: false } })
  const footWorldScratch = useRef(new THREE.Vector3()).current
  const footScaleScratch = useRef(new THREE.Vector3()).current
  useProfiledFrame('mechs', () => {
    if (!onFootstep || !inputsRef.current.isMoving) {
      footTrackRef.current.left.prevY = null
      footTrackRef.current.left.armed = false
      footTrackRef.current.right.prevY = null
      footTrackRef.current.right.armed = false
      return
    }
    const group = groupRef.current
    const { skinnedMesh, left, leftShape, right, rightShape } = footRig
    if (!group || !skinnedMesh) return
    skinnedMesh.getWorldScale(footScaleScratch)
    const worldScale = (footScaleScratch.x + footScaleScratch.z) / 2
    const sides: Array<['left' | 'right', THREE.Bone | null, FootShape | null]> = [
      ['left', left, leftShape],
      ['right', right, rightShape],
    ]
    for (const [side, bone, shape] of sides) {
      if (!bone || !shape) continue
      bone.getWorldPosition(footWorldScratch)
      const y = footWorldScratch.y
      const track = footTrackRef.current[side]
      if (track.prevY == null) {
        track.prevY = y
        track.peakY = y
        continue
      }
      if (y > track.peakY) {
        track.peakY = y
      } else if (!track.armed && track.peakY - y >= FOOT_ARM_DROP) {
        track.armed = true
      } else if (track.armed && y >= track.prevY) {
        onFootstep(
          [footWorldScratch.x, y, footWorldScratch.z],
          shape.halfWidth * worldScale,
          shape.halfDepth * worldScale,
          group.rotation.y,
        )
        track.armed = false
        track.peakY = y
      }
      track.prevY = y
    }
  })

  useEffect(() => {
    // A full-strength color replacement washed out the model's own
    // paint/detail entirely — this blends only a faint amount of the
    // faction color over white (i.e. the texture's own colors
    // untouched) instead, just enough to read as a tint at a glance.
    const tint = new THREE.Color(color)
    instance.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material as THREE.MeshStandardMaterial
        mat.color.set(0xffffff).lerp(tint, tintStrength ?? FACTION_TINT_STRENGTH)
        // See MECH_COLOR_BOOST's own doc comment — applied generically
        // (every chassis, not just the one it was measured/tuned against)
        // in every state this effect ever sets color for (alive,
        // destroyed, shutdown...), not just once at mount — which is why
        // it lives here (this effect already reruns on every one of
        // those) rather than in useMechPbr.
        mat.color.multiplyScalar(MECH_COLOR_BOOST)
        mat.emissive.set(emissive ?? '#000000')
        mat.emissiveIntensity = emissiveIntensity ?? 0
      }
    })
  }, [instance, color, emissive, emissiveIntensity, tintStrength])

  // A small spiral of NDC offsets (screen-space fractions) to retry at if
  // the exact click point misses all geometry — [0,0] (the real click)
  // always goes first, so a clean hit never pays for the retries.
  const { camera, raycaster, gl } = useThree()
  useEffect(() => {
    if (!onSurfaceClick) return
    const canvas = gl.domElement
    const OFFSETS: [number, number][] = [
      [0, 0],
      [0.006, 0], [-0.006, 0], [0, 0.006], [0, -0.006],
      [0.006, 0.006], [-0.006, 0.006], [0.006, -0.006], [-0.006, -0.006],
      [0.014, 0], [-0.014, 0], [0, 0.014], [0, -0.014],
      [0.014, 0.014], [-0.014, 0.014], [0.014, -0.014], [-0.014, -0.014],
    ]
    const ndc = new THREE.Vector2()
    const onClickNative = (event: MouseEvent) => {
      const group = groupRef.current
      if (!group) return
      const rect = canvas.getBoundingClientRect()
      const baseX = ((event.clientX - rect.left) / rect.width) * 2 - 1
      const baseY = -((event.clientY - rect.top) / rect.height) * 2 + 1
      for (const [dx, dy] of OFFSETS) {
        ndc.set(baseX + dx, baseY + dy)
        raycaster.setFromCamera(ndc, camera)
        const hits = raycaster.intersectObject(group, true)
        if (hits.length > 0) {
          const p = hits[0].point
          onSurfaceClick([p.x / MODEL_SCALE, p.y / MODEL_SCALE, p.z / MODEL_SCALE], event)
          return
        }
      }
    }
    canvas.addEventListener('click', onClickNative)
    return () => canvas.removeEventListener('click', onClickNative)
  }, [onSurfaceClick, camera, raycaster, gl])

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
function Mech3DFallback({ color, emissive, emissiveIntensity, onLoaded }: Mech3DProps) {
  const mat = { color, emissive, emissiveIntensity }
  // Same "something real now exists to select" signal as Mech3DModel's
  // own onLoaded — a failed load still needs the outline to latch onto
  // this box-geometry stand-in instead of never registering at all.
  useEffect(() => {
    onLoaded?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
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
    <group userData={{ perfGroup: 'mechs' }}>
      <Mech3DBoundary fallback={<Mech3DFallback {...props} />}>
        <Mech3DModel {...props} />
      </Mech3DBoundary>
    </group>
  )
}
