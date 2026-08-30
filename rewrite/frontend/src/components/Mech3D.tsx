import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAnimations, useGLTF, useTexture } from '@react-three/drei'
import {useThree} from '@react-three/fiber'
import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'
import {
  LIMB_LOCATIONS, listMechFootprintMasks, listMechPbrSettings,
  type MechFootprintMaskRecord, type MechPbrSettingsRecord,
} from '../api'
import { WALK_CYCLE_TIME_SCALE } from '../hexMath'
import type { StampMask } from '../terrainRelief'
import type { JumpPhase } from '../jumpFlight'
import { resolveMechModelUrl } from '../mechAssets'
import { limbLocationLookup, useMechAnnotationsCache } from '../mechAnnotations'
import { buildBakedPiece, recenterBakedPiece } from '../bakedPiece'
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
/** Everything needed to drop a limb on the ground: which location it was,
 * what it was being drawn with, and where in the world it was at the
 * instant it came off. */
export interface SeveredLimbInfo {
  location: string
  /** The .glb it belongs to, so the fallen piece can find the very same
   * mesh again without anything having to hold on to the geometry. */
  modelUrl: string
  /** Where the piece's own VISUAL BULK was, not where its node origin
   * was — see `piece` below. */
  worldX: number
  worldY: number
  worldZ: number
  facing: number
  /** The piece as a standalone object, ready to fall: skinning baked into
   * real vertex positions, recentered on its own bounding box, plus the
   * world orientation and scale it was being drawn at.
   *
   * Real user report: "las extremidades directamente desaparecen... debe
   * ser como en el mechlab, los brazos cayendo por gravedad hasta que
   * colisionan con el suelo." Handing over the raw geometry instead is the
   * bug MechLab already hit and documented (see bakeSkinnedGeometry): a
   * skinned mesh's vertex data lives near the armature origin, so an arm
   * drawn from it appears at the mech's centre in bind pose rather than
   * where the arm actually is. Baking has to happen HERE, in the one
   * moment the limb is still posed in the scene with a current world
   * matrix — a frame later it is hidden and its matrix goes stale.
   *
   * Undefined only for a limb restored from the server, which nobody
   * watched come off; FallenLimb bakes those from the model's rest pose
   * instead. */
  piece?: {
    geometry: THREE.BufferGeometry
    material: THREE.Material
    quaternion: THREE.Quaternion
    scale: number
  }
}

interface Mech3DProps {
  color: string
  /** Location codes whose structure has reached 0. Any mesh named for one
   * of them (see LIMB_MESH_NAMES) stops being drawn. Models that do not
   * carry separate limb meshes ignore this entirely. */
  severedLocations?: ReadonlySet<string>
  /** Location codes whose armor has reached 0 (but structure hasn't, yet —
   * once it does, the location is in `severedLocations` above instead). A
   * raw game-extracted placeholder model (see damageTierOfMesh/
   * guessMeshLocation above) swaps that location's sub-parts to their own
   * `_dmg` variant, where one exists; a hand-authored model (the Jenner) or
   * a sub-part with no `_dmg` counterpart simply ignores this. */
  damagedLocations?: ReadonlySet<string>
  /** Real user request: "quiero que mire que armas tiene en la ficha y se
   * las ponga al modelo" — the mech's own real loadout (Mech.weapons),
   * reduced to just what this file needs. A raw game-extracted placeholder
   * model with weapon-mount sub-parts (see weaponMountOfMesh above) shows
   * the matching visual at each mount and covers every other mount with its
   * own "blank" mesh; a model with no weapon-mount sub-parts at all (every
   * hand-authored chassis today) ignores this entirely. Order matters when
   * a location has more weapons than distinct mount points — same
   * "location array order = mount assignment order" convention HexMap's own
   * useAttackVfxQueue already uses for weaponIndexAtLocation, so a weapon's
   * visual mount and its muzzle-flash origin point never disagree. */
  weapons?: readonly { location: string; weaponName: string }[]
  /** mechs.is_shutdown — real user request: reproducir shutdownPwroff/
   * shutdownIdle/shutdownPwron en vez de quedarse en el estado de
   * locomoción que tuviera cuando el calor apagó el mech. Edge-detected
   * igual que `fallen` (un ref, no estado derivado) — un mech ya apagado
   * cuando esto monta (estado restaurado del servidor) salta directo al
   * shutdownIdle sostenido en vez de reproducir shutdownPwroff para un
   * evento que nadie vio pasar. Tiene prioridad sobre salto/caminar/reposo
   * pero NO sobre una caída/levantada en curso (Caerse/Levantarse) — un
   * mech puede estar caído Y apagado a la vez, y la caída física siempre
   * gana visualmente. Un chasis sin estos clips simplemente se queda en
   * el Idle/Walk normal de siempre. */
  shutdown?: boolean
  /** HexMap's UnitMarker own in-place-reface detection (real user request:
   * "locomoción extra para los giros") — 'left'/'right' while the model is
   * pivoting toward a new facing_deg with NO hex translation (see
   * TURN_IDLE_EPSILON there), null the rest of the time including mid-walk
   * (a walk's own turning happens as part of Walk/WalkStart, not this).
   * Lowest priority of every state this file tracks — only replaces a
   * plain static Idle, never interrupts fall/jump/shutdown/movement. A
   * chassis with no idle-turn clips just stays on Idle, same as any other
   * missing clip. */
  turning?: 'left' | 'right' | null
  /** Called the moment a limb is newly cut off, with everything needed to
   * drop it on the ground: which location, the geometry and material it was
   * being drawn with, and where in the world it was at that instant. Not
   * called for limbs already missing when this mounts — those are wreckage
   * that fell before anyone was watching. */
  onLimbSevered?: (info: SeveredLimbInfo) => void
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
  /** Real user request: "tienes como sacar el punto desde donde disparan?"
   * — MechLabView's "Anotar armas" tab passes a ref here to get the SAME
   * live, MODEL_SCALE-rendered instance this component itself draws with,
   * so it can call computeWeaponMuzzlePoints (this file's own export)
   * against it on demand (a button click, not a raycast) instead of
   * requiring a manual click per weapon. Populated once per model load,
   * same timing as onLoaded. undefined/omitted (every other caller)
   * changes nothing. */
  instanceRef?: { current: THREE.Object3D | null }
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
  /** One-shot weapon-fire pose, fired the instant `id` changes to a new
   * value — same "id changes per shot" convention as HexMap's own
   * ActiveAttackVfx.id, so a second shot from the same location still
   * retriggers instead of being a no-op repeat of an unchanged prop.
   * `location` picks which body region's own fire clip plays (LA/RA -> that
   * arm's clip, anything else -> the generic torso clip — every chassis in
   * the shared HBS suffix vocabulary ships at least the torso one). Ignored
   * (never queued, never interrupts) while dead, mid-fall, or another
   * one-shot (Caerse/Levantarse/a jump leg) is already in flight — a purely
   * cosmetic flourish that never fights gameplay-critical state for
   * control. null/omitted (every caller before this existed) changes
   * nothing.
   * Real user request: "con el torso twist vamos a hacer una cosa, a la
   * hora de atacar tendra que ponerse defrente al enemigo, que lo use" —
   * `twist` (computed by the caller from attacker-facing vs bearing to
   * target, HexMap owns that geometry) substitutes the whole fire pose for
   * the corresponding held torsoTwistLeft/Right clip instead of the plain
   * front-facing one when the target isn't roughly ahead already. Same
   * `resolveAs` substitution mechanism as cojera/reposo herido elsewhere in
   * this file — the bookkeeping name (AttackLeftArm/RightArm/Torso) is
   * unaffected either way. */
  attackSignal?: { id: string; location?: string | null; twist?: 'left' | 'right' | null } | null
  /** Same shape/semantics as attackSignal, for the moment a shot actually
   * LANDS on this mech (HexMap's own activeAttack.hit, matched to whichever
   * unit is the target) — `severity` picks the heavier or lighter flinch
   * reaction; omitted/'light' still plays something rather than nothing for
   * a caller with no damage-magnitude signal handy. Real user request:
   * "reacciones a impacto por dirección" — `direction` (the target's own
   * facing vs. bearing back toward the attacker, HexMap owns that
   * geometry same as attackSignal's own `twist`) picks which of the
   * fwd/bwd/left/right flinch variants plays; omitted defaults to 'fwd'. */
  hitSignal?: { id: string; severity?: 'light' | 'heavy'; direction?: 'fwd' | 'bwd' | 'left' | 'right' } | null
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

/** Which mesh in a model is which BattleTech location.
 *
 * Real user request: "el modelo Jenner tiene las diferentes mallas para
 * ruptura de extremidades, en el mechlab funciona bien, pero en el juego no
 * pierde las extremidades cuando su estructura llega a 0" — and, on the
 * scope: "tiene que funcionar para todos los mechs que tengan las
 * extremidades configuradas, no solo para el Jenner, lo que pasa es que el
 * Jenner es el unico que lo tiene ahora".
 *
 * So this is a CONVENTION, not a special case. A model whose meshes are
 * split and named this way loses those limbs; a model that arrives as one
 * mesh — which today is every chassis but the Jenner — simply has nothing
 * matching and keeps its shape. Nothing needs a per-chassis table, and a
 * newly split model works the day it lands.
 *
 * D/I are derecha/izquierda, the naming the Jenner already uses. The
 * English spellings ride along so a model exported from an English rig
 * works too, since the alternative is silently doing nothing.
 *
 * Matched lowercase and by whole name, never by substring: "BrazoI" must
 * not match a mesh called "BrazoIzquierdoDetalle" by accident, and a torso
 * must never be hideable — a mech with no torso is not a wreck, it is a
 * hole. */
const LIMB_MESH_NAMES: Record<string, readonly string[]> = {
  LA: ['brazoi', 'leftarm', 'arm_l', 'armleft'],
  RA: ['brazod', 'rightarm', 'arm_r', 'armright'],
  LL: ['piernai', 'leftleg', 'leg_l', 'legleft'],
  RL: ['piernad', 'rightleg', 'leg_r', 'legright'],
}

/** Fallback only, for a chassis nobody has annotated in MechLab yet.
 *
 * The real source of truth is the model's own saved `kind: 'limb'`
 * annotation -- see limbLocationLookup in ../mechAnnotations for why a
 * hardcoded list of guessed names cannot work (three.js renames a node at
 * load time when it collides with a bone, which is exactly what happens to
 * the Jenner's legs).
 */
/** Every location this file knows how to take off a mech -- the keys of
 * LIMB_MESH_NAMES above. Exported so anything that needs to talk about
 * "the limbs" (GMView's debug tooling) asks the code that actually hides
 * them instead of keeping a second list that can drift out of step. */
export const SEVERABLE_LOCATIONS: readonly string[] = Object.keys(LIMB_MESH_NAMES)

/** The location a mesh stands for, or null if it is not a severable limb. */
export function limbLocationOfMesh(name: string): string | null {
  const key = name.trim().toLowerCase()
  for (const [location, names] of Object.entries(LIMB_MESH_NAMES)) {
    if (names.includes(key)) return location
  }
  return null
}

/** Real user request: "vamos a replicar el efecto de daño/explosion...
 * podemos mantener el modelo con los 3 [normal/dañado/explotado] y que el
 * juego los discrimine y sustituya cuando necesita?" — a raw game-extracted
 * placeholder model (unlike a hand-authored one like the Jenner, which is
 * one mesh per whole limb) ships EVERY body sub-part in up to three variants
 * under the same shared HBS suffix convention already leaned on for
 * animations (GAME_CLIP_SUFFIXES, below): `<part>`, `<part>_dmg`,
 * `<part>_explode`. This guesses which BT location (HD/CT/LT/RT/LA/RA/LL/
 * RL) a sub-part belongs to from its own name — checked as a SUBSTRING,
 * unlike LIMB_MESH_NAMES's whole-name match above, because a raw model
 * splits one location into many named sub-parts (shoulder/forearm/elbow...)
 * rather than shipping one mesh per limb. Order matters: the specific
 * "left_arm"/"right_leg"-style hints must be checked before anything that
 * could also match a broader substring, though none of these particular
 * hints collide with each other in practice. */
const LOCATION_NAME_HINTS: readonly (readonly [string, string])[] = [
  ['left_arm', 'LA'],
  ['right_arm', 'RA'],
  ['left_leg', 'LL'],
  ['right_leg', 'RL'],
  ['left_torso', 'LT'],
  ['right_torso', 'RT'],
  ['centre_torso', 'CT'],
  ['center_torso', 'CT'],
  ['pelvis', 'CT'],
  ['head', 'HD'],
]

/** null for anything this convention doesn't recognize (weapon-mount props,
 * the UI radar-blip marker, stray primitive debris meshes) — those are left
 * alone entirely by the damage-tier effect below, same as a mesh that
 * doesn't match LIMB_MESH_NAMES is left alone by the severed-limb effect. */
function guessMeshLocation(meshName: string): string | null {
  const name = meshName.trim().toLowerCase()
  for (const [hint, location] of LOCATION_NAME_HINTS) {
    if (name.includes(hint)) return location
  }
  return null
}

type DamageTier = 'normal' | 'dmg' | 'explode'

/** `baseKey` identifies the sub-part independent of which tier this
 * particular mesh IS — e.g. "warhammer_left_torso_rear_dmg" and
 * "warhammer_left_torso_rear" share the baseKey
 * "warhammer_left_torso_rear", so the damage-tier effect can tell they're
 * the same sub-part at different damage tiers, not two unrelated meshes. */
function damageTierOfMesh(meshName: string): { tier: DamageTier; baseKey: string } {
  const name = meshName.trim().toLowerCase()
  if (name.endsWith('_explode')) return { tier: 'explode', baseKey: name.slice(0, -'_explode'.length) }
  if (name.endsWith('_dmg')) return { tier: 'dmg', baseKey: name.slice(0, -'_dmg'.length) }
  return { tier: 'normal', baseKey: name }
}

/** Real user request: "quiero que mire que armas tiene [el mech] en la
 * ficha y se las ponga al modelo" — a raw game-extracted placeholder ships
 * a separate mesh per WEAPON-VISUAL at every mount point (e.g.
 * `chrPrfWeap_warhammer_leftarm_ppc_eh1`, `..._laser_eh1`, `..._blank_eh1`
 * all sitting at the SAME mount "leftarm eh1", one visual per weapon type
 * that could occupy it) — the ficha's own catalog has dozens of named
 * variants (Small Laser, ER PPC, Heavy Gauss Rifle...) but the game only
 * ever modeled a handful of VISUAL buckets. This collapses the full
 * app/systems/battletech/weapons.py catalog down to those buckets — "laser"
 * covers every laser subtype (the game never modeled a visually distinct
 * barrel per laser tier), "ac10"/"ac20"/etc. are exact tonnage matches, and
 * anything genuinely unmodeled (Narc, TAG, most missile/ballistic exotics)
 * simply has no bucket, which the mount-assignment logic below treats the
 * same as no match: that slot falls back to its own "blank" cover mesh
 * rather than showing nothing at all or crashing.
 */
// Real user report: "hay algunas [armas] que aparecen siempre fijas y no
// deberian" — the values below used to be guessed (srm6/lrm10/plain ac5 for
// Ultra AC/plain lbx) instead of read off the game's own mesh names.
// Confirmed directly against the Warhammer's real torso mount names: the
// game shares ONE "missileN" token space for both SRM and LRM (keyed by
// tube count, not by SRM/LRM identity — e.g. `missile6` for SRM 6,
// `missile10` for LRM 10, no chassis ships both at the same count), and
// Ultra/LB-X autocannons get their OWN `uacN`/`lbxN` tokens distinct from a
// plain `acN` of the same tonnage. A weapon whose bucket has no matching
// mesh at a given mount is harmless (falls back to blank, same as an
// entirely unmapped weapon) — but a mesh whose real token was never in this
// table at all is the actual bug: weaponMountOfMesh never recognizes it, so
// this effect never touches its visibility and it just keeps whatever the
// glTF loaded it as (visible), which is exactly "aparece siempre fija".
//
// PARA EL PRÓXIMO MECH: cuando se agreguen los weapon-mount props en
// Blender, sus materiales suelen salir en Blend Mode "Alpha Blend"/"Alpha
// Hashed" por defecto (canal Alpha de la textura conectado sin querer) en
// vez de "Opaque" — mismo bug real encontrado y arreglado en el Warhammer
// (96 materiales en BLEND, causaba transparencia dependiente del ángulo de
// cámara). Revisar esto ANTES de exportar, no después: Material Properties
// → Settings → Blend Mode → Opaque, en cada material de arma nuevo.
const WEAPON_VISUAL_BUCKETS: Record<string, string> = {
  // Real user report: "el assassin sin escoger modelo 'no deberia mostrar
  // ningun arma' aparece con armas". PPC/Gauss/MG used to collapse their
  // Heavy/Light/Snub-Nose variants into ONE shared bucket ('ppc'/'gauss'/
  // 'mg'), on the assumption the game only ever modeled one barrel look per
  // family — wrong: confirmed live (Assassin, right arm energy hardpoint)
  // the game ships FOUR separate meshes at the exact same mount —
  // `..._ppc_eh1`, `..._hppc_eh1`, `..._lppc_eh1`, `..._snppc_eh1` — each
  // its own distinct visual. Collapsing them made weaponMountOfMesh's
  // `mounts` map collide on one shared key per mount (Map.set silently
  // drops all but the last mesh written to that key), so 3 of the 4 never
  // got touched by the show/hide pass at all and just stayed at whatever
  // visibility the glTF loaded them with — permanently visible, regardless
  // of loadout. Every PPC/Gauss/MG size now keeps its own bucket, equal to
  // its own literal mesh token, same pattern the AC/LB-X/Ultra AC families
  // already used correctly below.
  'PPC': 'ppc', 'ER PPC': 'ppc', 'Heavy PPC': 'hppc', 'Light PPC': 'lppc', 'Snub-Nose PPC': 'snppc',
  'Machine Gun': 'mg', 'Heavy Machine Gun': 'hmg', 'Light Machine Gun': 'lmg',
  'AC/2': 'ac2', 'AC/5': 'ac5', 'AC/10': 'ac10', 'AC/20': 'ac20',
  'LB 2-X AC': 'lbx2', 'LB 5-X AC': 'lbx5', 'LB 10-X AC': 'lbx10', 'LB 20-X AC': 'lbx20',
  'Ultra AC/2': 'uac2', 'Ultra AC/5': 'uac5', 'Ultra AC/10': 'uac10', 'Ultra AC/20': 'uac20',
  'Gauss Rifle': 'gauss', 'Heavy Gauss Rifle': 'hgauss', 'Light Gauss Rifle': 'lgauss', 'Silver Bullet Gauss Rifle': 'gauss',
  'SRM 2': 'missile2', 'SRM 4': 'missile4', 'SRM 6': 'missile6',
  // Real bug found via the weapon-muzzle auto-detect feature: "Streak SRM
  // 6" had NO bucket at all (missing from this table entirely, not just
  // wrong) — same "aparece siempre fija"/invisible-weapon failure as the
  // PPC/Gauss/MG gap above, PLUS it silently broke per-location index
  // alignment for auto-detected muzzle points (a skipped weapon shifted
  // every LATER same-location weapon's detected point down one slot).
  // Streak is the same physical launcher as plain SRM, just guided —
  // shares its visual/tube-count bucket.
  'Streak SRM 2': 'missile2', 'Streak SRM 4': 'missile4', 'Streak SRM 6': 'missile6',
  'LRM 5': 'missile5', 'LRM 10': 'missile10', 'LRM 15': 'missile15', 'LRM 20': 'missile20',
  'Flamer': 'flamer', 'ER Flamer': 'flamer',
  'AMS': 'ams', 'Laser AMS': 'ams',
  'Narc': 'narc',
  // Rotary AC and Rocket Launcher had NO bucket at all — same "aparece
  // siempre fija" failure mode as the PPC/Gauss/MG gap above, just from a
  // missing entry rather than a wrong one. Confirmed against
  // app/systems/battletech/weapons.py for the exact catalog names.
  'Rotary AC/2': 'rac2', 'Rotary AC/5': 'rac5',
  'Rocket Launcher 10': 'rl10', 'Rocket Launcher 15': 'rl15', 'Rocket Launcher 20': 'rl20',
}
for (const laser of [
  'Small Laser', 'Medium Laser', 'Large Laser', 'ER Small Laser', 'ER Medium Laser', 'ER Large Laser', 'ER Micro Laser',
  'Micro Pulse Laser', 'Small Pulse Laser', 'Medium Pulse Laser', 'Large Pulse Laser',
  'ER Medium Pulse Laser', 'ER Large Pulse Laser',
  'Small X-Pulse Laser', 'Medium X-Pulse Laser', 'Large X-Pulse Laser',
  'Heavy Small Laser', 'Heavy Medium Laser', 'Heavy Large Laser',
]) WEAPON_VISUAL_BUCKETS[laser] = 'laser'

/** `null` for a weapon this chassis's game art never modeled a distinct
 * visual for — callers treat that exactly like an unfilled mount (falls
 * back to its own "blank" cover mesh). */
function weaponVisualBucket(weaponName: string): string | null {
  return WEAPON_VISUAL_BUCKETS[weaponName] ?? null
}

// "Reacciones a impacto por dirección" needs a light/heavy split too, but
// AttackResult carries no real damage number — approximated from the
// weapon itself (BT weapon damage is fixed per weapon anyway, this is just
// that table collapsed to the two flinch buckets HitLight/HitHeavy already
// cover) rather than guessing from context. Exported for HexMap's own
// hitSignal construction (see ActiveAttackVfx's own doc comment).
const HEAVY_HIT_WEAPONS = new Set([
  'AC/20', 'Ultra AC/20', 'LB 20-X AC',
  'AC/10', 'Ultra AC/10', 'LB 10-X AC',
  'Gauss Rifle', 'Heavy Gauss Rifle', 'Silver Bullet Gauss Rifle',
  'PPC', 'Heavy PPC',
  'LRM 20', 'LRM 15', 'SRM 6',
])
export function weaponHitSeverity(weaponName: string): 'light' | 'heavy' {
  return HEAVY_HIT_WEAPONS.has(weaponName) ? 'heavy' : 'light'
}

/** A weapon-mount sub-part's own name decomposed into which BT location and
 * which physical mount point (e.g. "eh1") it belongs to, plus which weapon
 * visual (or 'blank') this PARTICULAR mesh represents — mirrors
 * damageTierOfMesh's baseKey idea, just keyed by mount instead of by body
 * sub-part. `null` for anything that isn't a weapon-mount mesh at all (a
 * body sub-part, the UI radar blip, stray debris) — every known visual
 * bucket name plus "blank" is checked as a literal underscore-delimited
 * token, never a bare substring, so a chassis nickname or location word
 * can never be mistaken for a weapon token. */
function weaponMountOfMesh(meshName: string): { location: string; mountKey: string; visual: string } | null {
  const name = meshName.trim().toLowerCase()
  const location = guessMeshLocation(name)
  if (!location) return null
  const tokens = name.split('_')
  // Same real user report as WEAPON_VISUAL_BUCKETS' own doc comment: Atlas/
  // Banshee/BattleMaster each ship exactly one bare `lbx` mesh at an LB-X
  // mount, with no lbx2/5/10/20-numbered sibling — the game never modeled a
  // per-size visual there, just one generic LB-X look. No single named
  // weapon maps to it (an equipped LB-X of any size still falls back to
  // blank/hidden at that mount, same as any other unmodeled visual — see
  // this function's own doc comment), it just needs to stop being invisible
  // to the recognizer, or it stays permanently visible like the rest of
  // this bug class.
  const knownVisuals = new Set([...Object.values(WEAPON_VISUAL_BUCKETS), 'blank', 'lbx'])
  const visual = tokens.find((t) => knownVisuals.has(t))
  if (!visual) return null
  // Everything after the visual token is the mount's own slot code (e.g.
  // "eh1") — join back in case a slot code itself ever contains an
  // underscore, though every known one so far is a single token.
  const visualIndex = tokens.lastIndexOf(visual)
  const slot = tokens.slice(visualIndex + 1).join('_') || '0'
  return { location, mountKey: `${location}:${slot}`, visual }
}

/** Applies BOTH the damage-tier swap (normal/`_dmg`/`_explode` sub-parts)
 * and the weapon-mount visual assignment (which weapon, or "blank", shows
 * at each mount point) directly onto an already-normalized model instance
 * — the exact same two independent effects Mech3DModel itself runs (see
 * their own doc comments, right below this function's call sites there),
 * pulled out so MechLabView's other raw-instance viewers (LimbPainter,
 * RigViewer, FootprintCapture — none of which render through Mech3D
 * itself) can apply the SAME real per-model loadout and "always normal
 * condition" state instead of showing a raw extraction's every weapon
 * mount and every damage tier all visible at once. Real user report: "en
 * extremidades ahora mismo aparece el modelo con TODAS las armas...
 * quiero que solo aparezca con las armas del modelo seleccionado, y con
 * el modelo bien, ni dañado ni destruido, ahora mismo tambien esas partes
 * se muestran" — pass `severedLocations`/`damagedLocations` as
 * undefined/empty for an always-undamaged preview, same as this
 * function's own callers that have no real battle state to reflect. */
export function applyMechCombatVisibility(
  instance: THREE.Object3D,
  weapons: readonly { location: string; weaponName: string }[] | undefined,
  severedLocations: ReadonlySet<string> | undefined,
  damagedLocations: ReadonlySet<string> | undefined,
) {
  const hasDmgVariant = new Set<string>()
  const hasExplodeVariant = new Set<string>()
  instance.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const { tier, baseKey } = damageTierOfMesh(mesh.name)
    if (tier === 'dmg') hasDmgVariant.add(baseKey)
    else if (tier === 'explode') hasExplodeVariant.add(baseKey)
  })
  if (hasDmgVariant.size > 0 || hasExplodeVariant.size > 0) {
    instance.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const location = guessMeshLocation(mesh.name)
      if (!location) return
      const { tier, baseKey } = damageTierOfMesh(mesh.name)
      if (severedLocations?.has(location)) {
        mesh.visible = hasExplodeVariant.has(baseKey) ? tier === 'explode' : false
      } else if (damagedLocations?.has(location)) {
        mesh.visible = hasDmgVariant.has(baseKey) ? tier === 'dmg' : tier === 'normal'
      } else {
        mesh.visible = tier === 'normal'
      }
    })
  }

  const { assignedVisualByMountKey, mounts } = assignWeaponMountMeshes(instance, weapons)
  for (const [mountKey, byVisual] of mounts) {
    const showVisual = assignedVisualByMountKey.get(mountKey) ?? 'blank'
    for (const [visual, mesh] of byVisual) mesh.visible = visual === showVisual
  }
}

/** Shared weapon-mount-matching core behind both applyMechCombatVisibility
 * above (which mesh to SHOW at each mount) and computeWeaponMuzzlePoints
 * below (which mesh IS a given real weapon, to measure its muzzle from) —
 * same "Nth real weapon at this location claims the Nth still-unclaimed
 * mount that actually has its visual" logic either caller needs, kept in
 * one place so the two can never quietly disagree about which mesh
 * represents which weapon. `mounts`: mountKey -> (visual -> mesh), every
 * weapon-mount sub-part found on this instance, regardless of whether
 * anything claims it. `assignedVisualByMountKey`: mountKey -> the visual
 * bucket actually claiming it (absent = nothing claims it, caller shows
 * "blank"). `meshByWeapon`: the SAME assignment, keyed by weapon object
 * identity instead of mountKey — a weapon whose bucket has no match on
 * this chassis (a raw model missing that visual, or weaponVisualBucket
 * returning null) is simply absent from this map. */
function assignWeaponMountMeshes(
  instance: THREE.Object3D,
  weapons: readonly { location: string; weaponName: string }[] | undefined,
): {
  mounts: Map<string, Map<string, THREE.Mesh>>
  assignedVisualByMountKey: Map<string, string>
  meshByWeapon: Map<{ location: string; weaponName: string }, THREE.Mesh>
} {
  const mounts = new Map<string, Map<string, THREE.Mesh>>()
  instance.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const info = weaponMountOfMesh(mesh.name)
    if (!info) return
    let byVisual = mounts.get(info.mountKey)
    if (!byVisual) {
      byVisual = new Map()
      mounts.set(info.mountKey, byVisual)
    }
    byVisual.set(info.visual, mesh)
  })

  const assignedVisualByMountKey = new Map<string, string>()
  const meshByWeapon = new Map<{ location: string; weaponName: string }, THREE.Mesh>()
  if (mounts.size === 0) return { mounts, assignedVisualByMountKey, meshByWeapon } // no weapon-mount sub-parts on this model at all

  const mountsByLocation = new Map<string, string[]>()
  for (const key of mounts.keys()) {
    const [location] = key.split(':')
    const list = mountsByLocation.get(location) ?? []
    list.push(key)
    mountsByLocation.set(location, list)
  }
  for (const list of mountsByLocation.values()) list.sort()

  const claimedMounts = new Set<string>()
  for (const location of mountsByLocation.keys()) {
    const weaponsHere = (weapons ?? []).filter((w) => w.location === location)
    for (const w of weaponsHere) {
      const bucket = weaponVisualBucket(w.weaponName)
      if (!bucket) continue
      const mountKey = mountsByLocation.get(location)!.find(
        (key) => !claimedMounts.has(key) && mounts.get(key)!.has(bucket),
      )
      if (!mountKey) continue // every mount for this visual already taken, or none exists
      claimedMounts.add(mountKey)
      assignedVisualByMountKey.set(mountKey, bucket)
      meshByWeapon.set(w, mounts.get(mountKey)!.get(bucket)!)
    }
  }
  return { mounts, assignedVisualByMountKey, meshByWeapon }
}

/** Real user request: "con el cambio de modelos... tienes como sacar el
 * punto desde donde disparan? o te lo tengo que dar yo" — YES: every
 * weapon-mount prop on a real AssetStudio-extracted chassis is its own
 * separate, RIGID (never skinned — verified directly against the
 * Warhammer's own glb: none of these meshes carry skin weights at all),
 * elongated mesh parented straight onto a real bone (verified too: e.g.
 * whm_left_torso_ac10_bh1 sits 3 parent levels below j_Spine2). That
 * geometry alone is enough to find the muzzle without a human ever
 * clicking it: measure the mesh's own posed bounding box, the barrel's
 * own length is whichever axis is longest, and the muzzle tip is
 * whichever END of that axis sits FARTHER from the mounting bone's own
 * position (the base end is necessarily right at the bone; a real barrel
 * only extends away from it in one direction). Returns null for a mesh
 * with no geometry or (defensively) no vertices to measure — never thrown,
 * same "changes nothing, don't crash the caller" spirit as this file's
 * other optional-detection helpers (getFootShape, weaponVisualBucket). */
function computeWeaponMuzzlePoint(mesh: THREE.Mesh): THREE.Vector3 | null {
  const position = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined
  if (!position || position.count === 0) return null
  mesh.updateWorldMatrix(true, false)

  let boneAncestor: THREE.Object3D | null = mesh.parent
  while (boneAncestor && !(boneAncestor as THREE.Bone).isBone) boneAncestor = boneAncestor.parent
  const boneWorldPos = new THREE.Vector3()
  if (boneAncestor) boneAncestor.getWorldPosition(boneWorldPos)
  else mesh.getWorldPosition(boneWorldPos) // no bone ancestor found — falls back to the mesh's own origin

  const vertex = new THREE.Vector3()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  // A weapon prop is a tiny mesh (dozens to low hundreds of verts) — no
  // need for computeVisualBoundingBox's own every-Nth-vertex sampling,
  // walking all of them is cheap and exact.
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i)
    vertex.applyMatrix4(mesh.matrixWorld)
    min.min(vertex)
    max.max(vertex)
  }

  const size = new THREE.Vector3().subVectors(max, min)
  const axis: 'x' | 'y' | 'z' = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
  const muzzle = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5)
  const farIsFarther = Math.abs(max[axis] - boneWorldPos[axis]) >= Math.abs(min[axis] - boneWorldPos[axis])
  muzzle[axis] = farIsFarther ? max[axis] : min[axis]
  return muzzle
}

/** High-level entry point for the auto-detect feature above —
 * MechLabView's own "Anotar armas" tab calls this instead of requiring a
 * manual click per weapon. `instance` must be the SAME normalized,
 * MODEL_SCALE-rendered object Mech3D itself renders (expose it via the
 * `instanceRef` prop below) — the returned points are already divided
 * back down by MODEL_SCALE, exactly matching onSurfaceClick's own
 * convention, so they drop straight into the existing points state
 * unchanged. A weapon with no matching mount mesh on this chassis (an
 * unbucketed weapon type, or every mount for its bucket already claimed)
 * is simply absent from the result — same "best effort" contract as
 * every other optional lookup in this file. */
// Real bug found live (Warhammer, "Torso der" location): this used to
// SKIP a weapon with no detected mesh entirely instead of returning a
// same-length, same-order result — MechLabView's own weapon points are
// positional ("arma N" = the Nth entry among same-location points, no
// per-point weapon identity — see onModelClick's own doc comment), so
// dropping "Streak SRM 6" (no WEAPON_VISUAL_BUCKETS entry at the time)
// silently shifted every LATER same-location weapon's own detected point
// one slot too early — the 4th real weapon's point landed in "arma 3",
// leaving "arma 4" empty and "arma 3" wrong, not just one missing point.
// One-to-one correspondence with the input array (point: null for a miss)
// lets the caller preserve true positional alignment instead.
export function computeWeaponMuzzlePoints(
  instance: THREE.Object3D,
  weapons: readonly { location: string; weaponName: string }[],
): { location: string; weaponName: string; point: [number, number, number] | null }[] {
  const { meshByWeapon } = assignWeaponMountMeshes(instance, weapons)
  return weapons.map((w) => {
    const mesh = meshByWeapon.get(w)
    const muzzle = mesh ? computeWeaponMuzzlePoint(mesh) : null
    return {
      location: w.location,
      weaponName: w.weaponName,
      point: muzzle ? [muzzle.x / MODEL_SCALE, muzzle.y / MODEL_SCALE, muzzle.z / MODEL_SCALE] : null,
    }
  })
}

/** Every NORMAL-tier, non-weapon-mount mesh on `instance`, grouped by
 * guessMeshLocation's own body-part naming convention — reuses the exact
 * same location-detection this file's damage-tier swap already relies on
 * (verified against the Warhammer's own 44 body meshes: all 8 locations
 * resolved cleanly, nothing orphaned). `_dmg`/`_explode` variants are
 * excluded on purpose — they're alternate representations of the SAME
 * part (damageTierOfMesh's own baseKey groups them), not additional
 * geometry a dropped-limb piece should also carry. */
function bodyMeshNamesByLocation(instance: THREE.Object3D): Map<string, string[]> {
  const byLocation = new Map<string, string[]>()
  instance.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (weaponMountOfMesh(mesh.name)) return
    if (damageTierOfMesh(mesh.name).tier !== 'normal') return
    const location = guessMeshLocation(mesh.name)
    if (!location) return
    const list = byLocation.get(location) ?? []
    list.push(mesh.name)
    byLocation.set(location, list)
  })
  return byLocation
}

/** Real user request: "también podremos localizar... encontrar las
 * extremidades porque los nuevos modelos están nombrados y separados?" —
 * yes: MechLabView's "Extremidades" tab (LimbPainter) currently requires
 * clicking every mesh/bone that makes up each limb by hand; a raw
 * AssetStudio extraction already names its own sub-parts by location (see
 * bodyMeshNamesByLocation above), so LA/RA/LL/RL's own mesh_names can be
 * read straight off the model instead. Only the 4 detachable limb
 * locations (api.ts's own LIMB_LOCATIONS) — HD/CT/LT/RT are never a
 * "limb" in this app's own rules (losing them is mech death outright, not
 * a piece falling off), same restriction MechLabView's own activeLimb
 * picker already enforces. A chassis with no recognizable body-part
 * naming at all (still the old hand-authored pipeline) returns an empty
 * object — same "changes nothing" contract as this file's other optional
 * detectors. */
export function computeLimbMeshNames(instance: THREE.Object3D): Partial<Record<string, string[]>> {
  const byLocation = bodyMeshNamesByLocation(instance)
  const result: Partial<Record<string, string[]>> = {}
  for (const location of LIMB_LOCATIONS) {
    const names = byLocation.get(location)
    if (names && names.length > 0) result[location] = names
  }
  return result
}

/** Real user request, same message as computeLimbMeshNames above: "también
 * podremos localizar los impactos...?" — the "¿Dónde impacta un ataque a
 * esa zona?" hit-point slots (all 8 MECH_LOCATIONS, unlike the 4-limb
 * restriction above — HD/CT can visually be hit same as any limb, see
 * MechAnnotationPoint's own 'hit' kind doc comment) computed as the
 * combined posed bounding box CENTER of that location's own real body
 * meshes, instead of a manual click. Point is already divided back down
 * by MODEL_SCALE, same onSurfaceClick convention every other point in
 * this file's own detectors already follows. */
export function computeLocationHitPoints(instance: THREE.Object3D): Partial<Record<string, [number, number, number]>> {
  const byLocation = bodyMeshNamesByLocation(instance)
  const meshByName = new Map<string, THREE.Mesh>()
  instance.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) meshByName.set(mesh.name, mesh)
  })

  const result: Partial<Record<string, [number, number, number]>> = {}
  for (const [location, names] of byLocation) {
    const box = new THREE.Box3()
    let found = false
    for (const name of names) {
      const mesh = meshByName.get(name)
      if (!mesh) continue
      mesh.updateWorldMatrix(true, false)
      box.expandByObject(mesh)
      found = true
    }
    if (!found) continue
    const center = new THREE.Vector3()
    box.getCenter(center)
    result[location] = [center.x / MODEL_SCALE, center.y / MODEL_SCALE, center.z / MODEL_SCALE]
  }
  return result
}

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
// Real bug found live (the Warhammer placeholder, a raw AssetStudio
// extraction): three.js's Box3.setFromObject measures a SkinnedMesh from its
// RAW, un-posed geometry positions transformed by the mesh node's own
// matrixWorld — it never consults the skeleton at all. That's normally
// harmless (a well-formed rig's raw bind-pose positions roughly match its
// final silhouette either way), but this asset's Armature and its meshes
// disagree on Object Scale (confirmed directly in Blender — one sits at
// 1, the other at ~0.001/0.01 depending on which object). Blender's own
// viewport (and its Armature modifier evaluation) compensates for that
// transparently, which is why it always looked right there; the naive box
// calculation does not, so it measured roughly three orders of magnitude
// taller than the mesh actually renders once real skinning applies — every
// chassis normalized off that wrong number came out tiny. Measuring from
// ACTUAL posed (skin-transformed) vertex positions instead — the same math
// the GPU does every frame via applyBoneTransform — fixes this generically
// for any future extraction with the same per-object scale mismatch, not
// just this one chassis, and gives an unskinned/hand-authored model (the
// Jenner, the generic placeholder) the exact same result as before, since a
// model with no SkinnedMesh never enters the skin-aware branch below.
function computeVisualBoundingBox(clone: THREE.Object3D): THREE.Box3 {
  clone.updateMatrixWorld(true)
  const box = new THREE.Box3()
  const vertex = new THREE.Vector3()
  clone.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const position = obj.geometry.attributes.position as THREE.BufferAttribute | undefined
    if (!position) return
    const skinned = (obj as THREE.SkinnedMesh).isSkinnedMesh ? (obj as THREE.SkinnedMesh) : null
    if (skinned) {
      skinned.skeleton.update()
      // Every Nth vertex is plenty for a bounding estimate (only the real
      // extremes matter here) — this runs once per model load, not per
      // frame, but a dense mesh still has no reason to walk every vertex.
      const step = Math.max(1, Math.floor(position.count / 2000))
      for (let i = 0; i < position.count; i += step) {
        // applyBoneTransform reads/mutates ITS SECOND ARGUMENT in place —
        // it does not look up the vertex's own position itself, so it must
        // be seeded with the raw local position first or it silently
        // transforms whatever the vector already held (real bug found here
        // the first time: an unseeded vector defaults to the origin, so
        // this measured "where does (0,0,0) end up under each vertex's own
        // bone weights" instead of the vertex's real posed position —
        // collapsed everything toward a single point regardless of the
        // mesh's actual shape).
        vertex.fromBufferAttribute(position, i)
        skinned.applyBoneTransform(i, vertex)
        vertex.applyMatrix4(skinned.matrixWorld)
        box.expandByPoint(vertex)
      }
    } else {
      obj.geometry.computeBoundingBox()
      if (obj.geometry.boundingBox) box.union(obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld))
    }
  })
  return box
}

export function normalizeMechInstance(scene: THREE.Object3D): THREE.Group {
  const clone = SkeletonUtils.clone(scene) as THREE.Group
  clone.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.material = (obj.material as THREE.Material).clone()
      obj.castShadow = true
      // Real user report: "veo literalmente las partes de atras alante" —
      // turned out to be a raw AssetStudio extraction quirk unrelated to
      // this file (dozens of the Warhammer's own weapon-mount materials had
      // alphaMode BLEND baked in from Blender, several nearly-coincident
      // semi-transparent meshes at the same mount point sorting differently
      // per camera angle — fixed at the source by setting those materials
      // back to Opaque). DoubleSide/frustumCulled=false below predate that
      // finding (dead ends chasing the same report) but are harmless and
      // still a reasonable safety net given how little this chassis's raw
      // bind-pose bounds resemble its actual posed extent (see
      // computeVisualBoundingBox's own doc comment above), so left in.
      const mat = obj.material as THREE.MeshStandardMaterial
      mat.side = THREE.DoubleSide
      obj.frustumCulled = false
      // Real bug found live (MechLabView's Ver rig/Extremidades/Textura/
      // Huella tabs, none of which render through Mech3D itself): every
      // one of the Warhammer's 148 meshes came out of the AssetStudio ->
      // Blender export with emissive baked to solid white AT 2x intensity
      // — an angle-independent flat glow that swamps the diffuse texture
      // completely regardless of lighting or viewing direction (unlike
      // the alphaMode/BLEND weapon-material bug above, this one shows the
      // SAME flat white on every surface, torso or feet alike, since
      // emissive adds directly to the final color with no N·L falloff to
      // vary it). Mech3D's own faction-tint effect happens to zero
      // emissive itself on every render (it needs to, for its own dynamic
      // shutdown/dead glow), which is why 'annotate' mode never showed
      // this — but that's a side effect of unrelated code, not a fix, and
      // every OTHER raw-instance consumer (LimbPainter/RigViewer/
      // TextureTuner/FootprintCapture, none of which touch emissive at
      // all) inherited the raw broken value untouched. Zeroed once here,
      // at the one shared place every consumer's instance already passes
      // through — same reasoning as DoubleSide/frustumCulled above.
      mat.emissive.set(0x000000)
      mat.emissiveIntensity = 0
    }
  })
  const box = computeVisualBoundingBox(clone)
  const size = new THREE.Vector3()
  box.getSize(size)
  if (size.y > 0) {
    const s = 1 / size.y
    clone.scale.setScalar(s)
    const center = new THREE.Vector3()
    box.getCenter(center)
    clone.position.set(-center.x * s, -box.min.y * s, -center.z * s)
  }
  // Real bug found live (the Warhammer placeholder): every caller renders
  // this via `<primitive object={instance} scale={MODEL_SCALE}>` (Mech3D
  // itself, and MechLabView's LimbPainter/RigViewer/model preview) — react-
  // three-fiber's declarative `scale` prop sets `.scale` on whatever object
  // it's given, UNCONDITIONALLY, on every commit. Handing `clone` itself
  // back as `instance` meant that prop silently overwrote the `s` this
  // function just computed the instant it mounted — dead code for every
  // asset that happened to already measure close to 1 unit tall raw (every
  // existing curated .glb, by simple convention/coincidence), but very much
  // NOT dead for this one (~0.18 units raw — see computeVisualBoundingBox's
  // own doc comment), which rendered at its raw size × MODEL_SCALE instead
  // of normalized-to-1-unit × MODEL_SCALE: about 5x too small. A thin outer
  // wrapper keeps the normalization on a DIFFERENT object than the one the
  // scale prop touches, so the two can never collide again regardless of
  // any future model's own raw scale.
  const wrapper = new THREE.Group()
  wrapper.add(clone)
  return wrapper
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

// Real user request: "en la seccion de huella, quiero un boton de
// guardar... quiero que ademas se use ya como forma real de la pisada" —
// MechLabView's Huella tab persists one real captured silhouette per
// model_url (see the backend's mech_footprint_masks doc comment);
// HexMap.tsx's own stampDeformation calls (both the real per-bone
// onFootstep path and the geometric-fallback one) look it up via
// getSavedFootprintMask below instead of always falling back to
// getFootShape's plain bounding-box ellipse.
//
// Two-stage cache, same reasoning as footShapeCache above but split in
// two because this one has a real network fetch in front of it: the
// RECORD LIST (fetched once, lazily, on first-ever call — no react hook
// needed since this is read from an imperative footstep callback, not a
// render) tells us WHETHER a chassis/model has a saved mask at all;
// decoding that record's own data URL into real per-pixel alpha (the
// actual `Uint8ClampedArray` stampedDepthAt can cheaply sample) happens
// separately, once per URL, the first time it's actually needed. Both
// stages return null while still pending — a caller mid-decode (or before
// the initial fetch lands) just uses the plain ellipse for that one
// footstep, same "best effort, no blocking" spirit as footShapeCache's
// own null-until-measured contract.
let footprintMaskRecords: MechFootprintMaskRecord[] | null = null
let footprintMaskRecordsPromise: Promise<void> | null = null
function ensureFootprintMaskRecordsLoading(): void {
  if (footprintMaskRecords || footprintMaskRecordsPromise) return
  footprintMaskRecordsPromise = listMechFootprintMasks()
    .then((rows) => { footprintMaskRecords = rows })
    .catch(() => { footprintMaskRecordsPromise = null })
}

const decodedFootprintMaskCache = new Map<string, StampMask | null>()
function decodeFootprintMask(url: string, imageDataUrl: string): void {
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx || canvas.width === 0 || canvas.height === 0) return
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const alpha = new Uint8ClampedArray(canvas.width * canvas.height)
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
    decodedFootprintMaskCache.set(url, { width: canvas.width, height: canvas.height, alpha })
  }
  // Left as "still pending" (null) on a decode failure — already marked
  // in the cache by the caller before this fires, so this is a no-op
  // fallback rather than a retry loop.
  img.src = imageDataUrl
}

/** See the block comment above. `null` means "nothing saved, or not
 * decoded yet — use the plain ellipse for now". `halfWidth`/`halfDepth`
 * are in the SAME normalized (pre-MODEL_SCALE) units as FootShape's own —
 * multiply by MODEL_SCALE (and boardgameScale, where relevant) exactly
 * like every other caller of getFootShape already does. */
export function getSavedFootprintMask(
  chassis: string | null | undefined, model: string | null | undefined,
): { mask: StampMask; halfWidth: number; halfDepth: number } | null {
  ensureFootprintMaskRecordsLoading()
  if (!footprintMaskRecords) return null
  const url = resolveMechModelUrl(chassis, model)
  const record = footprintMaskRecords.find((r) => r.model_url === url)
  if (!record) return null
  if (!decodedFootprintMaskCache.has(url)) {
    decodedFootprintMaskCache.set(url, null)
    decodeFootprintMask(url, record.image_data_url)
  }
  const mask = decodedFootprintMaskCache.get(url)
  if (!mask) return null
  return { mask, halfWidth: record.half_width, halfDepth: record.half_depth }
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

// Same module-level cache/subscriber pattern as mechAnnotations.ts's own
// useMechAnnotationsCache — fetched once, shared across every mounted
// Mech3D instance on the board (dozens of units otherwise each firing
// their own GET on mount), never re-fetched once populated (a later
// MechLabView save updates its own local allPbrSettings state directly;
// this cache picking up that change too would need real invalidation,
// not attempted here — matches every other real-game consumer's own
// "reload the page to see a freshly-saved MechLab annotation" precedent).
let pbrSettingsCache: MechPbrSettingsRecord[] | null = null
let pbrSettingsInFlight: Promise<MechPbrSettingsRecord[]> | null = null
const pbrSettingsWaiting = new Set<(rows: MechPbrSettingsRecord[]) => void>()
const EMPTY_PBR_RECORDS: MechPbrSettingsRecord[] = []

function useMechPbrSettingsCache(): MechPbrSettingsRecord[] {
  const [records, setRecords] = useState<MechPbrSettingsRecord[]>(pbrSettingsCache ?? EMPTY_PBR_RECORDS)
  useEffect(() => {
    if (pbrSettingsCache) {
      setRecords(pbrSettingsCache)
      return
    }
    pbrSettingsWaiting.add(setRecords)
    if (!pbrSettingsInFlight) {
      pbrSettingsInFlight = listMechPbrSettings()
      pbrSettingsInFlight
        .then((rows) => {
          pbrSettingsCache = rows
          for (const notify of [...pbrSettingsWaiting]) notify(rows)
          pbrSettingsWaiting.clear()
        })
        .catch(() => { pbrSettingsInFlight = null })
    }
    return () => { pbrSettingsWaiting.delete(setRecords) }
  }, [])
  return records
}

/** MechLabView's Textura tab's own saved record (snake_case, the backend's
 * column names) converted to Mech3D's own camelCase MechPbrSettings shape
 * — `undefined` when this chassis/model has nothing saved yet, so callers
 * fall back to MECH_PBR_DEFAULTS exactly as before this existed. Real user
 * request: "en textura, cuando acepto, quiero que ese sea el mapa PBR que
 * se aplique a ese mech en la partida" — MechLabView's own "Aceptar"
 * already persisted these (saveMechPbrSettings), the real game simply
 * never read them back; this closes that loop for every Mech3D instance
 * (HexMap/FirstPersonView/anywhere else one mounts), not just MechLabView
 * itself. */
function findSavedPbrSettings(records: MechPbrSettingsRecord[], url: string): MechPbrSettings | undefined {
  const rec = records.find((r) => r.model_url === url)
  if (!rec) return undefined
  return {
    repeat: rec.repeat, normalScale: rec.normal_scale, roughness: rec.roughness,
    metalness: rec.metalness, colorBoost: rec.color_boost, aoIntensity: rec.ao_intensity,
  }
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

// Real user question: "como lo hace battletech? no hay un archivo que
// ordene las animaciones?" — there is no separate lookup asset; verified
// directly against the game's own extracted clips (Atlas, Warhammer,
// Locust, UrbanMech, Jenner, Zeus) that every chassis ships its animation
// library under the SAME fixed suffix vocabulary regardless of chassis
// name — `<chassis>_moveCoreIdle`, `<chassis>_moveCoreWalkFwd`,
// `<chassis>_moveCoreSprintFwd`, `<chassis>_moveJumpUpStart/Idle`,
// `<chassis>_moveJumpDownLand`, `<chassis>_hitReactKnockdownInpl`,
// `<chassis>_downedGetup`. That prefix+suffix convention IS the game's own
// animation map, just baked into its C# code instead of a data asset.
const GAME_CLIP_SUFFIXES: Record<string, string> = {
  Idle: 'moveCoreIdle',
  Idle2: 'moveCoreIdleFlavor1',
  Walk: 'moveCoreWalkFwd',
  Run: 'moveCoreSprintFwd',
  Despegar: 'moveJumpUpStart',
  Saltar: 'moveJumpUpIdle',
  Aterrizar: 'moveJumpDownLand',
  Caerse: 'hitReactKnockdownInpl',
  Levantarse: 'downedGetup',
  // Real user request: "añade todas las animaciones pertinentes, ataque,
  // vuelo... aprovechemos todo" — every chassis in this same shared
  // vocabulary also ships per-limb weapon-fire poses and hit reactions;
  // wired up below via attackSignal/hitSignal (Mech3DProps) as one-shot
  // overlays on top of whatever locomotion/fall state is already playing.
  AttackLeftArm: 'attackFireLarmMed',
  AttackRightArm: 'attackFireRarmMed',
  AttackTorso: 'attackFireTorsoMed',
  // Reacciones a impacto por dirección — see hitSignal's own `direction`
  // doc comment. Every chassis in the shared vocabulary ships all 8.
  HitLightFwd: 'hitReactLgtFwd',
  HitLightBwd: 'hitReactLgtBwd',
  HitLightLeft: 'hitReactLgtLeft',
  HitLightRight: 'hitReactLgtRight',
  HitHeavyFwd: 'hitReactHvyFwd',
  HitHeavyBwd: 'hitReactHvyBwd',
  HitHeavyLeft: 'hitReactHvyLeft',
  HitHeavyRight: 'hitReactHvyRight',
  // Apagado (mechs.is_shutdown) — see the `shutdown` prop's own doc comment.
  ShutdownPwroff: 'shutdownPwroff',
  ShutdownIdle: 'shutdownIdle',
  ShutdownPwron: 'shutdownPwron',
  // Giro en el lugar — see the `turning` prop's own doc comment.
  TurnLeft: 'moveCoreTurnLeftIdle',
  TurnRight: 'moveCoreTurnRightIdle',
  // Cojera — resolved via crossFadeTo's own `resolveAs` param, never used
  // as a bookkeeping name directly, so 'Walk' itself keeps driving every
  // chain-transition check unchanged while quietly playing one of these
  // instead. Only the forward variant exists in this app (no BT rule here
  // ever walks a mech backwards), so the *Bwd* clips are left unused.
  WalkLimpLeft: 'moveCoreWalkLimpFwdLeft',
  WalkLimpRight: 'moveCoreWalkLimpFwdRight',
  // Reposo herido / variedad extra — IdleUnsteady resolved via `resolveAs`
  // (see the `isWounded` check above), same mechanism as cojera; Flavor2/3
  // are extra "de vez en cuando" variety clips alongside the existing
  // Flavor1/Idle2, picked randomly by the variety effect below instead of
  // it always being the same one clip every time.
  IdleUnsteady: 'moveCoreIdleUnsteady',
  IdleFlavor2: 'moveCoreIdleFlavor2',
  IdleFlavor3: 'moveCoreIdleFlavor3',
  // Muerte — see deathStateRef's own doc comment.
  DeathKnockdown: 'deathKnockdown',
  DeathIdle: 'deathIdle',
  // Giro de torso — see attackSignal's own `twist` doc comment. Resolved
  // via `resolveAs` the same way cojera/reposo herido are, substituted in
  // for the plain AttackLeftArm/RightArm/Torso bookkeeping name whenever
  // the target isn't roughly in front of the attacker already.
  TorsoTwistLeft: 'torsoTwistLeft',
  TorsoTwistRight: 'torsoTwistRight',
}

/** This file's own Idle/Walk/Run/Caerse/Levantarse/... vocabulary resolved
 * to whatever key actually exists in `actions`. An exact match always wins
 * first — a hand-authored asset (the Jenner) that already ships a clip
 * literally named "Idle" keeps matching that, unaffected. Otherwise falls
 * back to the shared HBS suffix convention (GAME_CLIP_SUFFIXES above), so a
 * game-extracted placeholder model that ships every clip completely
 * unmodified (real user request: "no les quiero hacer seguir mi regimen de
 * animaciones... tiene que usar las que traiga, sin modificar, todas
 * ellas") still animates without anyone renaming a single clip. `undefined`
 * if neither exists — every caller already treats a missing clip as "skip
 * this step", never a crash, same as a chassis with no animations at all. */
function resolveClipKey(actions: Record<string, THREE.AnimationAction | null>, appName: string): string | undefined {
  if (actions[appName]) return appName
  const suffix = GAME_CLIP_SUFFIXES[appName]
  if (!suffix) return undefined
  return Object.keys(actions).find((key) => key.endsWith(`_${suffix}`))
}

function Mech3DModel({
  color, emissive, emissiveIntensity, chassis, model, isMoving, movementType, jumpPhase, fallen, dead,
  tintStrength, onLoaded, onSurfaceClick, instanceRef, playAnimation, onFootstep, severedLocations, onLimbSevered,
  damagedLocations, weapons, shutdown, turning, attackSignal, hitSignal,
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
  // See instanceRef's own doc comment. Set synchronously during render
  // (not an effect) so it's already correct the instant a caller's OWN
  // effect/click-handler runs right after this component mounts/updates —
  // same "just assign it" pattern refs are meant for.
  if (instanceRef) instanceRef.current = instance

  // Which of THIS model's nodes make up each limb, straight out of what
  // was configured for it in MechLab -- the same list that screen hides
  // when it previews a break, so the board and the lab now agree by
  // construction instead of by two lists happening to say the same thing.
  const annotations = useMechAnnotationsCache()
  const limbLookup = useMemo(() => limbLocationLookup(annotations, url), [annotations, url])

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

  // Real user request: "en textura, cuando acepto, quiero que ese sea el
  // mapa PBR que se aplique a ese mech en la partida" — see
  // findSavedPbrSettings's own doc comment. undefined (nothing saved for
  // this chassis/model yet) falls through to useMechPbr's own
  // MECH_PBR_DEFAULTS, unchanged from before this existed.
  const pbrSettingsRecords = useMechPbrSettingsCache()
  const savedPbrSettings = useMemo(
    () => findSavedPbrSettings(pbrSettingsRecords, url),
    [pbrSettingsRecords, url],
  )
  // applyColorBoost: false — this component's own tint effect below owns
  // `mat.color` (it resets it from scratch on every faction/destroyed/
  // shutdown change, unlike LimbPainter/RigViewer's static preview), so
  // it applies the same brightness boost itself (savedPbrSettings?.
  // colorBoost ?? MECH_COLOR_BOOST, same fallback), in the one place
  // that's already reactive to those changes. See useMechPbr's own doc
  // comment on the option.
  useMechPbr(instance, { applyColorBoost: false, settings: savedPbrSettings })

  // Blown-off limbs. Visibility rather than removal, because a location can
  // come back: the map editor and an undone action both restore structure,
  // and a mesh detached from the scene would need re-attaching in the right
  // place in the hierarchy. Re-evaluated from scratch every time rather
  // than toggled, so a mech that gets an arm back gets it back.
  //
  // Keyed on the set's CONTENTS, not the set itself — the views rebuild
  // these maps on every poll, and depending on identity would walk the
  // whole model several times a second for nothing.
  const severedKey = severedLocations ? [...severedLocations].sort().join(',') : ''
  // What was already missing when this mounted. Those limbs fell before
  // this component existed, so they must not be dropped again — otherwise
  // every remount (and the views remount on every poll) would rain arms.
  const knownSeveredRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const severed = new Set(severedKey ? severedKey.split(',') : [])
    const firstRun = knownSeveredRef.current === null
    const known = knownSeveredRef.current ?? severed
    instance.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const location = limbLookup.get(mesh.name.trim().toLowerCase())
        ?? limbLocationOfMesh(mesh.name)
      if (!location) return
      const gone = severed.has(location)
      // Reported BEFORE hiding it, while its world transform is still the
      // arm's own — once it is invisible its matrix is no longer updated
      // and the piece would fall from wherever it last happened to be.
      if (gone && !known.has(location) && !firstRun && onLimbSevered) {
        mesh.updateWorldMatrix(true, false)
        const skinned = mesh as THREE.SkinnedMesh
        // Baked exactly the way MechLab bakes it for the same preview, so
        // the piece that falls on the board and the piece that falls in the
        // lab are built by the same code.
        const baked = skinned.isSkinnedMesh
          ? buildBakedPiece(skinned, skinned.geometry)
          : recenterBakedPiece(mesh.geometry.clone(), mesh.matrixWorld)
        const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        onLimbSevered({
          location,
          modelUrl: url,
          // The bulk's own centre, not the node origin — for this rig every
          // limb node sits at the armature origin, so the old world
          // position was the same point for all four of them.
          worldX: baked.worldPosition.x,
          worldY: baked.worldPosition.y,
          worldZ: baked.worldPosition.z,
          facing: groupRef.current?.rotation.y ?? 0,
          piece: {
            geometry: baked.geometry,
            // Cloned: this instance's material is disposed with it, and the
            // limb outlives the mech that dropped it.
            material: source.clone(),
            quaternion: baked.worldQuaternion,
            scale: baked.scale,
          },
        })
      }
      mesh.visible = !gone
    })
    knownSeveredRef.current = severed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, severedKey, limbLookup])

  // Damage-tier variant swap for a raw game-extracted placeholder model —
  // see guessMeshLocation/damageTierOfMesh's own doc comments above. Fully
  // independent of the severed-limb effect just above: that one only ever
  // hides a HAND-AUTHORED chassis's single per-limb mesh by exact name
  // (LIMB_MESH_NAMES), while this one swaps between a raw model's own
  // `<part>`/`<part>_dmg`/`<part>_explode` sub-mesh trio across all 8
  // locations, torso/head included — the two conventions never match the
  // same mesh on any real chassis, so there's nothing to reconcile between
  // them. A sub-part with no `_dmg`/`_explode` counterpart, or a location
  // this effect can't guess (weapon-mount props, the UI radar-blip marker),
  // is simply left showing its normal form untouched.
  const damagedKey = damagedLocations ? [...damagedLocations].sort().join(',') : ''
  const weaponsKey = weapons ? weapons.map((w) => `${w.location}:${w.weaponName}`).join(',') : ''
  // Both the damage-tier swap and the weapon-mount visual assignment now
  // live in the shared, exported applyMechCombatVisibility (see its own
  // doc comment) — MechLabView's other raw-instance viewers (LimbPainter/
  // RigViewer/FootprintCapture) call the exact same function directly,
  // instead of duplicating this logic and risking it drifting out of sync.
  useEffect(() => {
    applyMechCombatVisibility(instance, weapons, severedLocations, damagedLocations)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance, severedKey, damagedKey, weaponsKey])

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
  const inputsRef = useRef({
    isMoving, movementType, jumpPhase, fallen, dead, turning, severedLocations, damagedLocations,
    attackSignal, hitSignal,
  })
  inputsRef.current = {
    isMoving, movementType, jumpPhase, fallen, dead, turning, severedLocations, damagedLocations,
    attackSignal, hitSignal,
  }
  // Which clip is currently active, and whether it's a one-shot in
  // flight (walking chains prevent a mid-flight prop change — e.g.
  // isMoving flipping false while still in "WalkStart" — from cutting
  // the current clip off; the 'finished' handler re-decides once it
  // actually ends, reading inputsRef fresh at that point).
  const currentClipRef = useRef<string | null>(null)
  // The ACTUAL key crossFadeTo resolved `currentClipRef` to inside
  // `actions` — needed as its own ref (not re-derived via resolveClipKey
  // from currentClipRef whenever something needs "whatever's playing right
  // now") because a bookkeeping name can resolve to a DIFFERENT real clip
  // depending on other state — e.g. 'Walk' resolves to a limp variant while
  // a leg is damaged (see the `pickWalkClipSuffix` call site below) — so
  // re-resolving from the name alone, later, once that state has since
  // changed, could silently point at the wrong action.
  const currentResolvedKeyRef = useRef<string | null>(null)
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
  // Own state machine for shutdown — same edge-detected-ref pattern as
  // fallStateRef above, for the same reason (a caller shouldn't have to
  // compute "just shut down" vs "still off" itself). Starts at 'down'
  // rather than 'off' when a mech is ALREADY shutdown on mount (server-
  // restored state) — that skips shutdownPwroff (an event nobody watched
  // happen) and settles straight on the held shutdownIdle.
  const shutdownStateRef = useRef<'off' | 'poweringDown' | 'down' | 'poweringUp'>(shutdown ? 'down' : 'off')
  const prevShutdownRef = useRef(shutdown ?? false)
  // Own state machine for death — same edge-detected-ref pattern as
  // fallStateRef/shutdownStateRef above. Starts at 'dead' rather than
  // 'alive' when destroyed_reason is ALREADY set on mount (server-restored
  // state) — skips deathKnockdown (an event nobody watched happen) and
  // settles straight on the held deathIdle. Never transitions back to
  // 'alive' — matches the app's own real rule that destroyed_reason, once
  // set, never clears (see the `dead` prop's own callers).
  const deathStateRef = useRef<'alive' | 'dying' | 'dead'>(dead ? 'dead' : 'alive')
  const prevDeadRef = useRef(dead ?? false)
  // Last attackSignal.id/hitSignal.id already consumed — these aren't a
  // held STATE like fall/shutdown/death above, just a one-shot overlay
  // that fires once per new id and then lets advance() fall straight
  // through to whatever locomotion/idle branch is next, same as any other
  // one-shot finishing (see the attack/hit block inside advance() below).
  const firedAttackIdRef = useRef<string | null>(attackSignal?.id ?? null)
  const firedHitIdRef = useRef<string | null>(hitSignal?.id ?? null)
  // UNLIKE the two above, this one IS a held state — real user follow-up:
  // "quiero que se mantenga girado durante todo el ataque" (the torso used
  // to snap back to a plain Idle the instant the brief torsoTwist clip's
  // own one-shot finished, well before the attack's beam/impact VFX had
  // even resolved), then later: "sigue sin hacerlo bien... la animacion de
  // disparar le obliga? podemos blendear para que haga las 2?" — dead on:
  // atlas_attackFireLarmMed/RarmMed/TorsoMed all keyframe j_Spine2 (the
  // SAME bone torsoTwistLeft/Right themselves animate, confirmed by
  // inspecting the real clip tracks) to its own fixed "fire straight
  // ahead" rotation, so crossFadeTo-ing to the fire clip while twisted
  // silently overwrote the twist the instant it started playing — a
  // single active clip can't hold two different rotations for the same
  // bone at once. Set the moment an attack with a real `twist` fires,
  // cleared by the dedicated effect further down the instant HexMap's own
  // activeAttack clears (attackSignal prop goes back to null) — i.e. held
  // for exactly as long as this shot is still the one playing out. Now
  // only drives twistOverlayActionsRef below (an ADDITIVE action layered
  // on top of whatever the main state machine plays — fire clip included
  // — instead of trying to BE the base clip), so it survives the fire
  // clip instead of being overwritten by it.
  const heldTwistRef = useRef<'left' | 'right' | null>(null)
  // The additive twist layer itself — see heldTwistRef's own doc comment.
  // Built once per model load (inside the setup effect below, where
  // `actions` is available) via THREE.AnimationUtils.makeClipAdditive:
  // each holds the DELTA between torsoTwistLeft/Right's own j_Spine2
  // rotation and the plain Idle clip's own (frame 0, "neutral standing"),
  // so playing it ADDITIVELY on top of ANY base action rotates that
  // base's own j_Spine2 by the twist amount instead of replacing it
  // outright — exactly what lets the fire clip's own arm/torso motion and
  // the twist coexist. `null` for a chassis missing either clip (no twist
  // possible there — same "changes nothing" fallback as everywhere else
  // in this file a chassis doesn't ship some optional clip).
  const twistOverlayActionsRef = useRef<{ left: THREE.AnimationAction | null; right: THREE.AnimationAction | null }>({
    left: null, right: null,
  })
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

    // See twistOverlayActionsRef's own doc comment. Built once here (this
    // effect only re-runs when `actions` itself changes identity, i.e.
    // once per real model load) rather than lazily on first attack, so
    // the very first shot on a freshly-loaded mech already has it ready.
    const buildTwistOverlay = (appName: 'TorsoTwistLeft' | 'TorsoTwistRight'): THREE.AnimationAction | null => {
      const idleKey = resolveClipKey(actions, 'Idle')
      const idleClip = idleKey ? actions[idleKey]?.getClip() : undefined
      const twistKey = resolveClipKey(actions, appName)
      const twistAction = twistKey ? actions[twistKey] : undefined
      if (!idleClip || !twistAction) return null
      // .clone() first — makeClipAdditive mutates its target's tracks in
      // place, and this clip's own object is the SAME one shared (via
      // useGLTF's cache) by every OTHER mech instance of this chassis on
      // the board; converting the shared original would corrupt it for
      // all of them.
      const additiveClip = THREE.AnimationUtils.makeClipAdditive(twistAction.getClip().clone(), 0, idleClip, 30)
      const overlay = twistAction.getMixer().clipAction(additiveClip)
      overlay.blendMode = THREE.AdditiveAnimationBlendMode
      overlay.setLoop(THREE.LoopOnce, 1)
      overlay.clampWhenFinished = true
      return overlay
    }
    twistOverlayActionsRef.current = { left: buildTwistOverlay('TorsoTwistLeft'), right: buildTwistOverlay('TorsoTwistRight') }

    const crossFadeTo = (
      name: string | undefined, loop: boolean, timeScale = 1, resolveAs?: string,
    ): THREE.AnimationAction | null => {
      if (!name) return null
      // `resolveAs` lets a caller keep the state machine's own bookkeeping
      // name (e.g. 'Walk', so every `current === 'Walk'`-style chain check
      // elsewhere keeps working unchanged) while actually resolving to a
      // DIFFERENT real clip — see pickWalkClipSuffix's own call site below.
      const resolvedKey = resolveClipKey(actions, resolveAs ?? name)
      if (!resolvedKey) return null
      const next = actions[resolvedKey]
      if (!next) return null
      // Always set (not just on a fresh play) — AnimationAction objects
      // are reused across plays, so a previous run's own timeScale would
      // otherwise leak into a later plain-walk use of this same clip.
      next.timeScale = timeScale
      // currentClipRef always holds THIS FILE'S OWN name (e.g. 'Walk'),
      // never the resolved game clip key — every chain-transition check
      // below (`current === 'WalkStart'` etc.) compares against that
      // vocabulary, and must keep working identically for a placeholder
      // model whose real key is `warhammer_moveCoreWalkFwd`.
      if (currentClipRef.current === name && currentResolvedKeyRef.current === resolvedKey && next.isRunning()) {
        return next
      }
      // Real bug found live (React 18 StrictMode dev double-invoke): drei's
      // own useAnimations effect ALSO double-runs under StrictMode, and its
      // cleanup (mixer.stopAllAction() + uncacheAction + wiping its lazy
      // action cache) rebuilds a FRESH AnimationAction for every clip on the
      // second pass — but currentResolvedKeyRef here (this file's own ref,
      // untouched by that cleanup) still points at the OLD resolved key.
      // Since `resolvedKey` is just a string, `currentResolvedKeyRef.current
      // === resolvedKey` stays true, so without this guard `prev` resolved
      // to the exact SAME (fresh, not-yet-playing) action as `next` — the
      // early-return above already failed once (next.isRunning() was false,
      // a brand new object), so this fell through and called
      // `next.fadeIn(0.2).play()` immediately followed by
      // `prev.fadeOut(0.2)` on ITSELF, undoing the play and leaving the clip
      // permanently disabled at weight 0 the instant that fade completed —
      // "el mech anda pero no reproduce animación", reproduced 100% of the
      // time in dev (StrictMode is dev-only) the moment enough mount-time
      // effects (fallen/shutdown/dead/turning/attackSignal/hitSignal, every
      // one of which calls advanceRef.current?.() once at mount) raced
      // drei's own remount. Comparing the KEY (not just object identity,
      // which would always differ here) is what actually catches this.
      const prev = currentResolvedKeyRef.current && currentResolvedKeyRef.current !== resolvedKey
        ? actions[currentResolvedKeyRef.current] : null
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
      currentResolvedKeyRef.current = resolvedKey
      oneShotInFlightRef.current = !loop
      return next
    }

    // One step at a time — called at mount, whenever a relevant prop
    // changes AND nothing one-shot is currently in flight, and every
    // time a one-shot clip's own 'finished' event fires (which always
    // re-reads inputsRef/fallStateRef fresh, so it naturally advances a
    // multi-step chain like WalkStart→RunStart→Run one link per call).
    const advance = () => {
      // Real user request: "muerte" — a real deathKnockdown→deathIdle
      // sequence instead of just fading whatever was playing to nothing.
      // Falls through to that same old fade-to-nothing behavior on either
      // step if this chassis doesn't ship the matching clip (a hand-
      // authored asset almost certainly doesn't have anything literally
      // named 'DeathKnockdown'/'DeathIdle') — a chassis with neither clip
      // dies exactly like it always has.
      if (deathStateRef.current === 'dying') {
        if (crossFadeTo('DeathKnockdown', false)) return
        deathStateRef.current = 'dead' // nothing to wait for finishing
      }
      if (deathStateRef.current === 'dead') {
        if (crossFadeTo('DeathIdle', true)) return
        // Real bug found alongside the cojera work: this used to index
        // `actions` by the bookkeeping name directly (e.g. 'Walk') instead
        // of via currentResolvedKeyRef — 'Walk' is never a literal key in
        // `actions` for a placeholder-tier chassis (only ever true for a
        // hand-authored one that ships a clip actually NAMED 'Walk'), so
        // this fade-out silently no-op'd for every raw-extracted mech's
        // death.
        const prev = currentResolvedKeyRef.current ? actions[currentResolvedKeyRef.current] : null
        prev?.fadeOut(0.3)
        currentClipRef.current = null
        currentResolvedKeyRef.current = null
        oneShotInFlightRef.current = false
        return
      }
      // Real user request: "reposo herido" — any real damage anywhere
      // swaps the plain looping Idle for its Unsteady variant, same
      // resolveAs mechanism as cojera above (bookkeeping name stays
      // 'Idle', every check against it elsewhere is unaffected).
      const isWounded = (
        (inputsRef.current.severedLocations?.size ?? 0) > 0 || (inputsRef.current.damagedLocations?.size ?? 0) > 0
      )
      const idleResolveAs = isWounded ? 'IdleUnsteady' : undefined
      const legHurt = (loc: string) => (
        inputsRef.current.severedLocations?.has(loc) || inputsRef.current.damagedLocations?.has(loc)
      )
      const fall = fallStateRef.current
      if (fall === 'falling') { crossFadeTo('Caerse', false); return }
      if (fall === 'prone') { oneShotInFlightRef.current = false; return } // held wherever Caerse left it
      if (fall === 'standingUp') { crossFadeTo('Levantarse', false); return }

      const shutdownState = shutdownStateRef.current
      if (shutdownState === 'poweringDown') { crossFadeTo('ShutdownPwroff', false); return }
      if (shutdownState === 'down') { crossFadeTo('ShutdownIdle', true); return }
      if (shutdownState === 'poweringUp') { crossFadeTo('ShutdownPwron', false); return }

      // Real user request: "ataque a distancia" — a fresh attackSignal.id
      // plays this chassis's own weapon-fire one-shot, gated (by reaching
      // this point at all) behind dead/fall/shutdown above so a shot that
      // resolves mid-Caerse/mid-shutdown never fights those for control.
      // `firedAttackIdRef` marks the id consumed unconditionally (even if
      // this chassis has no matching clip, per attackSignal's own "changes
      // nothing" doc comment) so a chassis with none never re-checks it
      // every advance() call.
      const attack = inputsRef.current.attackSignal
      if (attack && attack.id !== firedAttackIdRef.current) {
        firedAttackIdRef.current = attack.id
        // heldTwistRef, not a resolveAs substitution on THIS one-shot —
        // see its own doc comment for why (the twist needs to survive past
        // this brief fire clip, not just flash for its own short duration).
        // twistOverlayActionsRef — not a resolveAs substitution either —
        // is what actually makes it survive: an ADDITIVE layer keeps
        // contributing its own j_Spine2 delta on top of whatever the fire
        // clip below plays for that same bone, instead of being replaced
        // by it (see twistOverlayActionsRef's own doc comment for why a
        // plain substitution couldn't work here).
        // Real user follow-up: "se mantiene girado MIENTRAS dispara, pero
        // no entre disparo y disparo... desde que empiece a atacar hasta
        // que termine, se mantenga girado" — a multi-weapon attack fires
        // several attackSignal ids back to back (HexMap's own queued
        // shots), each landing HERE again; unconditionally reset+fadeIn-
        // ing the overlay every single time briefly dipped its weight
        // back toward 0 between shots even when the twist direction never
        // actually changed (same target, same side, whole volley). Only
        // touch the overlay when the direction is genuinely NEW —
        // otherwise it's already sitting at full weight from the
        // PREVIOUS shot in this same attack and needs nothing done to it.
        const previousTwist = heldTwistRef.current
        const newTwist = attack.twist ?? null
        heldTwistRef.current = newTwist
        if (newTwist !== previousTwist) {
          const { left: leftOverlay, right: rightOverlay } = twistOverlayActionsRef.current
          if (newTwist === 'left') { rightOverlay?.stop(); leftOverlay?.reset().fadeIn(0.15).play() }
          else if (newTwist === 'right') { leftOverlay?.stop(); rightOverlay?.reset().fadeIn(0.15).play() }
          else { leftOverlay?.stop(); rightOverlay?.stop() }
        }
        const clipName = attack.location === 'LA' ? 'AttackLeftArm' : attack.location === 'RA' ? 'AttackRightArm' : 'AttackTorso'
        if (crossFadeTo(clipName, false)) return
      }
      // Same one-shot-by-id convention as the attack block above, for the
      // moment a shot actually LANDS on this mech instead of the moment it
      // was fired — see hitSignal's own doc comment for `severity`/
      // `direction`.
      const hit = inputsRef.current.hitSignal
      if (hit && hit.id !== firedHitIdRef.current) {
        firedHitIdRef.current = hit.id
        const severity = hit.severity === 'heavy' ? 'Heavy' : 'Light'
        const direction = hit.direction === 'bwd' ? 'Bwd' : hit.direction === 'left' ? 'Left' : hit.direction === 'right' ? 'Right' : 'Fwd'
        if (crossFadeTo(`Hit${severity}${direction}`, false)) return
      }

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
        // Real user request: "cojera" — a damaged/destroyed leg swaps the
        // plain walk cycle for its limp variant, resolved via `resolveAs`
        // so the bookkeeping name stays 'Walk' (every chain check above/
        // below keeps comparing against that, unaffected). Left leg checked
        // first if somehow both are hurt — arbitrary but consistent; there
        // is no "limp on both legs" clip to prefer instead.
        const walkResolveAs = legHurt('LL') ? 'WalkLimpLeft' : legHurt('RL') ? 'WalkLimpRight' : undefined
        if (current === 'WalkStart' || current === 'Walk') {
          crossFadeTo('Walk', true, WALK_CYCLE_TIME_SCALE, walkResolveAs); return
        }
        if (crossFadeTo('WalkStart', false)) return
        crossFadeTo('Walk', true, WALK_CYCLE_TIME_SCALE, walkResolveAs)
        return
      }

      // Not moving — wind down through *End if we were actually
      // walking/running, otherwise straight to Idle.
      const current = currentClipRef.current
      if (current === 'Run' || current === 'RunStart' || (runningTripRef.current && current === 'WalkStart')) {
        runningTripRef.current = false
        if (crossFadeTo('RunEnd', false)) return
        crossFadeTo('Idle', true, 1, idleResolveAs)
        return
      }
      if (current === 'Walk' || current === 'WalkStart') {
        if (crossFadeTo('WalkEnd', false)) return
        crossFadeTo('Idle', true, 1, idleResolveAs)
        return
      }
      // Real user request: "locomoción extra para los giros" — a pure
      // in-place reface (see HexMap's own turning prop/TURN_IDLE_EPSILON)
      // gets its own idle-turn clip instead of a plain static Idle while
      // the model visually pivots underneath it.
      if (inputsRef.current.turning === 'left') { crossFadeTo('TurnLeft', true); return }
      if (inputsRef.current.turning === 'right') { crossFadeTo('TurnRight', true); return }
      crossFadeTo('Idle', true, 1, idleResolveAs)
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
      const finishedKey = currentResolvedKeyRef.current
      if (finishedClip == null || !finishedKey || event.action !== actions[finishedKey]) return
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
      // Same "gate on which clip actually just finished" reasoning as the
      // fall state above, for the shutdown power-transition one-shots.
      if (finishedClip === 'ShutdownPwroff' && shutdownStateRef.current === 'poweringDown') shutdownStateRef.current = 'down'
      else if (finishedClip === 'ShutdownPwron' && shutdownStateRef.current === 'poweringUp') shutdownStateRef.current = 'off'
      // Same reasoning, for deathKnockdown finishing into the held deathIdle.
      if (finishedClip === 'DeathKnockdown' && deathStateRef.current === 'dying') deathStateRef.current = 'dead'
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

  // Same edge-detection pattern as the `fallen` effect just above, for
  // shutdown — advanceRef (not syncRef) for the same reason: a shutdown
  // toggling right now should react immediately, not wait for a walk-chain
  // step or another one-shot to finish first.
  useEffect(() => {
    const was = prevShutdownRef.current
    const now = shutdown ?? false
    if (!was && now) shutdownStateRef.current = 'poweringDown'
    else if (was && !now) shutdownStateRef.current = 'poweringUp'
    prevShutdownRef.current = now
    advanceRef.current?.()
  }, [shutdown])

  // Same edge-detection pattern as fallen/shutdown above, for death — see
  // deathStateRef's own doc comment for why there's no reverse transition.
  useEffect(() => {
    const was = prevDeadRef.current
    const now = dead ?? false
    if (!was && now) deathStateRef.current = 'dying'
    prevDeadRef.current = now
    advanceRef.current?.()
  }, [dead])

  // attackSignal/hitSignal are one-shots keyed by `id`, not a held state,
  // so there's no was/now flag to flip here — advance() itself (see the
  // attack/hit block above) is what checks firedAttackIdRef/firedHitIdRef
  // against the latest id and decides whether this is actually new.
  // advanceRef (not syncRef) for the same immediacy reason as fallen/
  // shutdown/dead: a shot fired (or landed) right now should show right
  // away, not wait for whatever walk-chain step was mid-flight.
  useEffect(() => {
    advanceRef.current?.()
  }, [attackSignal?.id, hitSignal?.id])

  // heldTwistRef IS a held state (see its own doc comment) — this is its
  // was/now flip, separate from the effect just above: HexMap keeps
  // attackSignal's own `id` unchanged for as long as this shot is still
  // the one playing (activeAttack), and only sets the prop back to
  // null/undefined once that VFX fully resolves — exactly the moment the
  // additive twist layer should fade out and stop contributing.
  useEffect(() => {
    if (!attackSignal) {
      heldTwistRef.current = null
      twistOverlayActionsRef.current.left?.fadeOut(0.3)
      twistOverlayActionsRef.current.right?.fadeOut(0.3)
      advanceRef.current?.()
    }
  }, [attackSignal])

  // The rest of the real inputs (isMoving/movementType/jumpPhase/turning) —
  // kept separate from the fallen/shutdown/dead effects above because
  // THESE should respect a walk-chain one-shot already in flight (syncRef),
  // unlike a fall/shutdown/death request. `dead` has its own dedicated
  // advanceRef-based effect now (immediate, like fallen/shutdown), so it's
  // deliberately not repeated here too.
  useEffect(() => {
    syncRef.current?.()
  }, [isMoving, movementType, jumpPhase, turning])

  // Real user request: quería una segunda pose de reposo ("Idle2") que se
  // reproduzca "de vez en cuando" (cada 30s-1min) en vez de mezclada
  // siempre en el mismo loop — así no se nota repetitivo. Extended (real
  // user request: "reposo herido/variedad extra") to pick randomly among
  // every flavor variant this chassis actually ships (Idle2/Flavor2/
  // Flavor3), not always the same one, so a long idle stretch doesn't
  // repeat identically every time either. Only while Idle (not Walk, not
  // fallen, not jumping, not frozen, not wounded — a wounded mech's own
  // IdleUnsteady base in `advance()` above is its own thing, this doesn't
  // layer variety on top of it) is genuinely the active clip, and only for
  // a chassis that ships at least one flavor variant — a chassis with none
  // just loops plain Idle exactly as before.
  useEffect(() => {
    const idleKey = resolveClipKey(actions, 'Idle')
    const idle = idleKey ? actions[idleKey] : undefined
    const isWounded = (severedLocations?.size ?? 0) > 0 || (damagedLocations?.size ?? 0) > 0
    const flavors = (['Idle2', 'IdleFlavor2', 'IdleFlavor3'] as const)
      .map((name) => { const key = resolveClipKey(actions, name); return key ? actions[key] : undefined })
      .filter((a): a is THREE.AnimationAction => !!a)
    if (playAnimation === false || isMoving || jumpPhase != null || fallen || dead || isWounded || !idle || flavors.length === 0) {
      return
    }

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>
    let activeFlavor: THREE.AnimationAction | null = null

    const scheduleNext = () => {
      const delay = 30_000 + Math.random() * 30_000
      timeoutId = setTimeout(playVariation, delay)
    }

    const playVariation = () => {
      if (cancelled) return
      const flavor = flavors[Math.floor(Math.random() * flavors.length)]
      activeFlavor = flavor
      flavor.reset().setLoop(THREE.LoopOnce, 1)
      flavor.clampWhenFinished = true
      idle.fadeOut(0.3)
      flavor.fadeIn(0.3).play()
    }

    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== activeFlavor || cancelled) return
      activeFlavor.fadeOut(0.3)
      activeFlavor = null
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
      // to hand back to Idle/Walk cleanly instead of leaving a flavor clip
      // stuck playing alongside whatever the OTHER effect just started.
      if (activeFlavor?.isRunning()) activeFlavor.fadeOut(0.2)
    }
  }, [actions, isMoving, jumpPhase, fallen, dead, playAnimation, severedLocations, damagedLocations])

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
    // Real user request: "en textura, cuando acepto, quiero que ese sea
    // el mapa PBR que se aplique... en la partida" — this chassis/model's
    // own saved colorBoost (Textura tab's slider) if one exists, same
    // MECH_COLOR_BOOST fallback as before for everything else.
    const colorBoost = savedPbrSettings?.colorBoost ?? MECH_COLOR_BOOST
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
        mat.color.multiplyScalar(colorBoost)
        mat.emissive.set(emissive ?? '#000000')
        mat.emissiveIntensity = emissiveIntensity ?? 0
      }
    })
  }, [instance, color, emissive, emissiveIntensity, tintStrength, savedPbrSettings])

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
