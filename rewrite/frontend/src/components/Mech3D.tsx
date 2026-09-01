import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAnimations, useGLTF, useTexture } from '@react-three/drei'
import {useThree} from '@react-three/fiber'
import * as THREE from 'three'
import { SkeletonUtils } from 'three-stdlib'
import {
  LIMB_LOCATIONS, listMechFootprintMasks, listMechPbrSettings, listWeaponMuzzlePoints,
  type MechFootprintMaskRecord, type MechPbrSettingsRecord, type WeaponMuzzlePointRecord,
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
   * unaffected either way.
   * `twistAngle` is the real |offset| in radians behind that left/right
   * verdict (HexMap computes both from the same angleDelta call) — see
   * measureBakedTwistAngle's own doc comment for why this exists: without
   * it the twist overlay has no way to know a 40°-off target should turn
   * less than an 89°-off one, and always played its whole baked swing
   * regardless. Omitted/null plays the full baked swing (the old
   * behavior) — a caller that hasn't been updated changes nothing.
   * `aimVertical`/`aimVerticalAngle` (real user request: "apuntado
   * direccional por brazo") — same epsilon-cone convention as twist/
   * twistAngle, just the VERTICAL half of target bearing (HexMap's own
   * heightAt(target) vs heightAt(attacker) over the horizontal distance).
   * Combined with twist's own left/right verdict at this prop's own use
   * site to pick one of the MW5 pipeline's 8 directional arm-aim clips
   * (ArmLeft/RightAim{Up,Down,Left,Right,UpLeft,UpRight,DownLeft,
   * DownRight}) for a LA/RA shot — a torso-mounted weapon still only ever
   * uses twist (no per-torso aim clip exists on that pipeline). Omitted/
   * null (every caller before this existed) plays the plain centered pose,
   * unchanged. */
  attackSignal?: {
    id: string
    location?: string | null
    twist?: 'left' | 'right' | null
    twistAngle?: number | null
    aimVertical?: 'up' | 'down' | null
    aimVerticalAngle?: number | null
  } | null
  /** Same shape/semantics as attackSignal, for the moment a shot actually
   * LANDS on this mech (HexMap's own activeAttack.hit, matched to whichever
   * unit is the target) — `severity` picks the heavier or lighter flinch
   * reaction; omitted/'light' still plays something rather than nothing for
   * a caller with no damage-magnitude signal handy. Real user request:
   * "reacciones a impacto por dirección" — `direction` (the target's own
   * facing vs. bearing back toward the attacker, HexMap owns that
   * geometry same as attackSignal's own `twist`) picks which of the
   * fwd/bwd/left/right flinch variants plays; omitted defaults to 'fwd'.
   * `location` (real user request: "reacciones a impacto por zona+eje") is
   * the struck BT location (HD/CT/LT/RT/LA/RA/LL/RL, straight off
   * AttackResult.location) — tried FIRST against the MW5 pipeline's own
   * per-zone/per-axis hit clips (see the HitZone* resolution at this
   * prop's own use site), falling back to the plain severity/direction
   * clip above whenever that pipeline has no match (an arm hit — no
   * per-arm hit clip exists at all — or a location this chassis isn't on
   * that pipeline for). Omitted/null just skips straight to the fallback,
   * unchanged from before this existed. */
  hitSignal?: {
    id: string
    severity?: 'light' | 'heavy'
    direction?: 'fwd' | 'bwd' | 'left' | 'right'
    location?: string | null
  } | null
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
  // Jenner's own real catalog data has "LPPC" as an alternate spelling of
  // Light PPC (confirmed via mech_templates).
  'LPPC': 'lppc',
  // Griffin's own real catalog data has a literal typo, "PP Cp" instead of
  // "PPC" (confirmed via mech_templates) -- mapped as-is rather than
  // touching the source data.
  'PP Cp': 'ppc',
  'Machine Gun': 'mg', 'Heavy Machine Gun': 'hmg', 'Light Machine Gun': 'lmg',
  // Flea's real stock loadouts use "LMGA" and "Light MG" as alternate
  // catalog spellings of the same Light Machine Gun (Array) family already
  // mapped above.
  'LMGA': 'lmg', 'Light MG': 'lmg',
  // Javelin's own real catalog data has "MGA" as an alternate spelling of
  // Machine Gun (Array), same family as the plain Machine Gun bucket.
  'MGA': 'mg',
  // Locust's real stock loadouts carry Magshot, a small ballistic
  // sidearm with no distinct mesh of its own -- closest existing family.
  'Magshot': 'mg',
  'AC/2': 'ac2', 'AC/5': 'ac5', 'AC/10': 'ac10', 'AC/20': 'ac20',
  'LB 2-X AC': 'lbx2', 'LB 5-X AC': 'lbx5', 'LB 10-X AC': 'lbx10', 'LB 20-X AC': 'lbx20',
  // Hatamoto-Chi's own real catalog data has "LBXAC 10" as an alternate
  // spelling of LB 10-X AC (confirmed via mech_templates).
  'LBXAC 10': 'lbx10',
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
  'AMS': 'ams', 'Laser AMS': 'ams', 'Laser Anti Missile System': 'ams',
  'Narc': 'narc', 'Narc Beacon': 'narc',
  // Rotary AC and Rocket Launcher had NO bucket at all — same "aparece
  // siempre fija" failure mode as the PPC/Gauss/MG gap above, just from a
  // missing entry rather than a wrong one. Confirmed against
  // app/systems/battletech/weapons.py for the exact catalog names.
  'Rotary AC/2': 'rac2', 'Rotary AC/5': 'rac5',
  'Rocket Launcher 10': 'rl10', 'Rocket Launcher 15': 'rl15', 'Rocket Launcher 20': 'rl20',
  // Bushwacker's real stock loadouts (BSW-S2r, BSW-X4, synced from the
  // MegaMek catalog) carry Plasma Rifle and MML 5 — neither exists as a
  // distinct mesh anywhere in the MW5 source data (checked directly:
  // Bushwacker's own weapon set only ever modeled AC/Gauss/Laser/PPC/
  // Missile/MG/Narc/AMS/Flamer variants, no plasma or multi-missile
  // launcher at all). Same "shares the physical launcher, stat-only
  // difference" reasoning as Streak SRM above: Plasma Rifle is a single
  // big-barrel energy weapon like a PPC, MML 5 is a 5-tube launcher like
  // LRM 5 — reusing those buckets means the mount shows a real, present
  // mesh instead of silently staying empty for these two variants.
  'Plasma Rifle': 'ppc',
  'MML 5': 'missile5',
  // Annihilator's real stock loadouts (ANH-3A, ANH-4A) carry Light AC/2 —
  // no distinct "light" AC mesh exists anywhere in the MW5 source data
  // (checked directly: Annihilator's own weapon set only modeled plain
  // ac2/ac5/ac10/ac20 barrels, same as every other chassis). Same
  // "shares the physical launcher, stat-only difference" reasoning as
  // Plasma Rifle/MML 5 above — reuses the plain AC/2 mesh instead of
  // silently staying empty for these two variants.
  'Light AC/2': 'ac2',
  // Wolverine's real stock loadouts carry Light Machine Gun Array — no
  // distinct mesh exists (checked directly: Wolverine's own weapon set
  // only modeled a plain LMG barrel). Same "shares the physical launcher,
  // stat-only difference" reasoning as Plasma Rifle/MML 5/Light AC/2 above.
  'Light Machine Gun Array': 'lmg',
  // Catapult's own weapon set models a real distinct Arrow IV mesh
  // ("Arrowiv") with its own dedicated material slot name ("Arrow", not
  // "Weapons") — confirmed via its own _SKM.json. Atlas's stock loadout
  // carries the same weapon under the shorter catalog name.
  'Arrow IV System': 'arrowiv', 'Arrow IV': 'arrowiv',
  // Real numbered-tube meshes confirmed present in at least one chassis's
  // own weapon set (Catapult ships Missile9/Missile30, BattleMaster ships
  // Missile6/Missile15) — same numeric-tube-count convention as every
  // other LRM/SRM bucket above. A chassis whose own catalog lacks the
  // matching mesh just falls back to blank, same as any other unmodeled
  // visual (see this table's own doc comment).
  'MML 9': 'missile9', 'MRM 30': 'missile30', 'MRM 20': 'missile20', 'MRM 10': 'missile10',
  'Thunderbolt 15': 'missile15', 'Thunderbolt 10': 'missile10', 'ATM 6': 'missile6',
  'Enhanced LRM 10': 'missile10',
  // HVAC/10, Light AC/5 and HAG/30 are stat-only variants of an existing
  // physical barrel family (Hyper-Velocity/Light/Hyper-Assault are rules
  // differences, not a different in-game model) — same reasoning as
  // Light AC/2 above.
  'HVAC/10': 'ac10', 'Light AC/5': 'ac5', 'HAG/30': 'gauss', 'HAG/20': 'gauss',
  'ATM 3': 'missile3', 'MML 3': 'missile3',
}
for (const laser of [
  'Small Laser', 'Medium Laser', 'Large Laser', 'ER Small Laser', 'ER Medium Laser', 'ER Large Laser', 'ER Micro Laser',
  'Micro Pulse Laser', 'Small Pulse Laser', 'Medium Pulse Laser', 'Large Pulse Laser',
  'ER Medium Pulse Laser', 'ER Large Pulse Laser',
  'Small X-Pulse Laser', 'Medium X-Pulse Laser', 'Large X-Pulse Laser',
  'Heavy Small Laser', 'Heavy Medium Laser', 'Heavy Large Laser',
  // Bombast Laser (Banshee) and Large Re-engineered Laser (Blackjack) are
  // both single-barrel energy weapons with no distinct mesh of their own
  // — reuse the shared generic laser bucket, same reasoning as every
  // other laser variant in this list.
  'Bombast Laser', 'Large Re-engineered Laser', 'Medium Re-engineered Laser',
  // Marauder's real stock loadouts carry Blazer Cannon, an energy-based
  // cannon with no distinct mesh -- reuses the generic laser look.
  'Blazer Cannon',
]) WEAPON_VISUAL_BUCKETS[laser] = 'laser'

/** `null` for a weapon this chassis's game art never modeled a distinct
 * visual for — callers treat that exactly like an unfilled mount (falls
 * back to its own "blank" cover mesh). */
export function weaponVisualBucket(weaponName: string): string | null {
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
export function weaponMountOfMesh(meshName: string): { location: string; mountKey: string; visual: string } | null {
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
    // Toggling `.visible` on whatever object actually carries the name
    // (a real mesh, or — see assignWeaponMountMeshes' own
    // firstMeshDescendant doc comment — an empty wrapper node for a
    // weapon Blender's glTF export split in two) is enough either way:
    // three.js visibility cascades to children, so hiding the wrapper
    // hides its real-mesh children with it.
    for (const [visual, object] of byVisual) object.visible = visual === showVisual
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
/** The actual pairing rule behind assignWeaponMountMeshes below — "the Nth
 * real weapon at a location claims the Nth still-unclaimed mount that
 * actually has its own visual" — pulled out as a pure, MESH-FREE function
 * so it can run identically against either a live instance's own mount
 * map (assignWeaponMountMeshes, for visibility) or a cached, mesh-free
 * TOPOLOGY captured once per chassis (getWeaponMuzzleWorldPoint below,
 * for muzzle points — see its own doc comment on why that one can't
 * touch a live instance). Generic over the map's own value type so both
 * `Map<mountKey, Map<visual, THREE.Mesh>>` and `Map<mountKey, Map<visual,
 * THREE.Matrix4>>` work unchanged — only `.has(bucket)` ever matters
 * here, never what's actually stored. */
function assignMountKeysToWeapons<W extends { location: string; weaponName: string }>(
  mounts: Map<string, Map<string, unknown>>, weapons: readonly W[] | undefined,
): Map<W, string> {
  const assignment = new Map<W, string>()
  if (mounts.size === 0 || !weapons) return assignment

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
    const weaponsHere = weapons.filter((w) => w.location === location)
    for (const w of weaponsHere) {
      const bucket = weaponVisualBucket(w.weaponName)
      if (!bucket) continue
      const mountKey = mountsByLocation.get(location)!.find(
        (key) => !claimedMounts.has(key) && mounts.get(key)!.has(bucket),
      )
      if (!mountKey) continue // every mount for this visual already taken, or none exists
      claimedMounts.add(mountKey)
      assignment.set(w, mountKey)
    }
  }
  return assignment
}

/** First descendant (including `object` itself) that's a real Mesh with
 * actual vertex data — needed because of a real Blender/glTF-export bug
 * found live on Bushwacker (MW5-sourced weapons): a mesh with faces
 * spread across 2+ material slots sometimes gets silently split on
 * export into an EMPTY parent node carrying the correctly-named
 * "chrMdlWeap_..." string, with the real geometry pushed into un-renamed
 * child SkinnedMesh nodes underneath it. Muzzle-point computation
 * (computeWeaponMuzzlePoint) needs real `.geometry`, so it can't use the
 * empty wrapper directly — this finds the actual mesh data one level
 * down instead. */
function firstMeshDescendant(object: THREE.Object3D): THREE.Mesh | null {
  if ((object as THREE.Mesh).isMesh) return object as THREE.Mesh
  for (const child of object.children) {
    const found = firstMeshDescendant(child)
    if (found) return found
  }
  return null
}

function assignWeaponMountMeshes(
  instance: THREE.Object3D,
  weapons: readonly { location: string; weaponName: string }[] | undefined,
): {
  mounts: Map<string, Map<string, THREE.Object3D>>
  assignedVisualByMountKey: Map<string, string>
  meshByWeapon: Map<{ location: string; weaponName: string }, THREE.Mesh>
} {
  const mounts = new Map<string, Map<string, THREE.Object3D>>()
  instance.traverse((object) => {
    const info = weaponMountOfMesh(object.name)
    if (!info) return
    let byVisual = mounts.get(info.mountKey)
    if (!byVisual) {
      byVisual = new Map()
      mounts.set(info.mountKey, byVisual)
    }
    // The correctly-named object wins the slot even when it's an empty
    // wrapper (see firstMeshDescendant's own doc comment) - toggling
    // `.visible` on it still hides its real-mesh children, since
    // three.js visibility cascades down the hierarchy. Only fall back to
    // a same-key mesh already found (shouldn't normally happen - one
    // name per mount+visual) rather than let an unnamed geometry replace
    // a correctly-named wrapper.
    if (!byVisual.has(info.visual)) byVisual.set(info.visual, object)
  })

  const assignedVisualByMountKey = new Map<string, string>()
  const meshByWeapon = new Map<{ location: string; weaponName: string }, THREE.Mesh>()
  const assignment = assignMountKeysToWeapons(mounts, weapons)
  for (const [w, mountKey] of assignment) {
    const bucket = weaponVisualBucket(w.weaponName)!
    assignedVisualByMountKey.set(mountKey, bucket)
    const matched = mounts.get(mountKey)!.get(bucket)!
    const mesh = firstMeshDescendant(matched)
    if (mesh) meshByWeapon.set(w, mesh)
  }
  return { mounts, assignedVisualByMountKey, meshByWeapon }
}

/** Real bug found live: a THREE.SkinnedMesh's own `.matrixWorld` is
 * mostly irrelevant to where it actually renders — the GPU places each
 * vertex through a completely separate chain (bind pose × bone
 * matrixWorld × bone inverse), so using `.matrixWorld` to convert a
 * point between this mesh's "local" space and world space silently
 * produces a point many mech-heights away from the real geometry (this
 * is what was causing MechLab's own muzzle markers to float off to the
 * side of the model, AND — same root cause — the actual game's
 * getWeaponMuzzleWorldPoint, which is why every weapon fired "desde el
 * pecho": computeWeaponMountData was caching `mesh.matrixWorld` per
 * mount, and different weapons' own object-level transforms turned out
 * to cluster near a similar irrelevant point regardless of where they
 * actually render).
 *
 * Every MW5 weapon mesh collapses to single-bone skinning (this
 * session's own fix for the material-slot export-split bug), so there's
 * always exactly one influencing bone per mesh — this reconstructs the
 * one true affine transform that actually places its vertices
 * (`bone.matrixWorld × boneInverse × bindMatrix`, read directly off
 * three.js's own SkinnedMesh.applyBoneTransform formula) and returns it
 * in place of `.matrixWorld` for any local↔world conversion involving
 * this mesh. Falls back to `mesh.matrixWorld` for a genuinely
 * non-skinned/rigid mesh (the old AssetStudio pipeline this file
 * originally targeted) — unchanged there. `null` only if the mesh
 * claims to be skinned but has no skin data at all (shouldn't happen in
 * practice, defensive only). */
export function weaponMeshEffectiveMatrix(mesh: THREE.Mesh): THREE.Matrix4 | null {
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null
  if (!skinned) {
    mesh.updateWorldMatrix(true, false)
    return mesh.matrixWorld
  }
  const skinIndexAttr = skinned.geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
  if (!skinIndexAttr || skinIndexAttr.count === 0) return null
  skinned.skeleton.update()
  const boneIndex = skinIndexAttr.getX(0)
  const bone = skinned.skeleton.bones[boneIndex]
  const boneInverse = skinned.skeleton.boneInverses[boneIndex]
  if (!bone || !boneInverse) return null
  bone.updateWorldMatrix(true, false)
  return new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, boneInverse).multiply(skinned.bindMatrix)
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
/** Real user correction: "SIEMPRE el cañón está por delante" — picking
 * the muzzle end by "farther from the mounting bone" (the old rule)
 * assumes the bone sits at the barrel's own base, which isn't true for
 * every weapon shape (a bulky receiver/breech behind the mount point can
 * easily be the FARTHER end, not the muzzle). The physically reliable
 * fact is the mech's own facing direction — a mounted weapon never
 * points backward — so this uses THAT to break the tie instead: given a
 * known chassis forward vector, whichever end of the weapon's own
 * longest axis projects further along it wins, regardless of which one
 * is geometrically farther from the bone.
 *
 * `forward` is null for a chassis detectChassisForward couldn't read (no
 * Cockpit bone — the old HBS-pipeline chassis, which this function has
 * served correctly for a long time already) — falls back to the
 * original distance-from-bone rule unchanged, zero regression there. */
export function computeWeaponMuzzlePoint(mesh: THREE.Mesh, forward: THREE.Vector3 | null = null): THREE.Vector3 | null {
  const position = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined
  if (!position || position.count === 0) return null

  // Real bug found live (Bushwacker BSW-X1, the two Machine Gun mounts):
  // per-vertex `SkinnedMesh.applyBoneTransform` honors EVERY bone each
  // vertex is actually weighted to (up to 4, blended) — real, correct
  // skinning, but it means a single bad weight on even one vertex (a
  // stray influence toward some unrelated, wrongly-posed bone — the
  // Right Torso Machine Gun's own vertices came out with a whole ~2-unit
  // NEGATIVE-Y offset relative to every sibling weapon, including its own
  // mirror twin on the left) drags the computed bounding box wherever
  // that bad weight points, nowhere near the real weapon. The user
  // confirmed this exact mesh positioned correctly under the OLD
  // "Cañones" tab (now-removed WeaponMuzzleEditor), which never called
  // applyBoneTransform at all — it built ONE effective matrix from the
  // FIRST vertex's own bone only (weaponMeshEffectiveMatrix, below) and
  // applied that SAME matrix to every vertex uniformly, so a bad weight
  // on any vertex past the first was simply never consulted. Matching
  // that already-proven approach here (instead of the technically-more-
  // correct-but-data-fragile per-vertex blend) is the actual fix — not a
  // Blender/export problem to chase, since the working tab never touched
  // this mesh's per-vertex weights either.
  const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null
  const effectiveMatrix = skinned ? weaponMeshEffectiveMatrix(mesh) : null
  if (!effectiveMatrix) mesh.updateWorldMatrix(true, false) // only reached for a genuinely non-skinned mesh
  const worldMatrix = effectiveMatrix ?? mesh.matrixWorld
  const boneWorldPos = new THREE.Vector3().setFromMatrixPosition(worldMatrix)

  const vertex = new THREE.Vector3()
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  // A weapon prop is a tiny mesh (dozens to low hundreds of verts) — no
  // need for computeVisualBoundingBox's own every-Nth-vertex sampling,
  // walking all of them is cheap and exact.
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i)
    vertex.applyMatrix4(worldMatrix)
    min.min(vertex)
    max.max(vertex)
  }

  const size = new THREE.Vector3().subVectors(max, min)
  const axis: 'x' | 'y' | 'z' = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
  const muzzle = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5)
  let farIsFarther: boolean
  if (forward) {
    // Project both candidate tips onto the chassis's own forward vector
    // (relative to the mount, so a weapon mounted well forward/aft of
    // the torso's own origin doesn't skew the comparison) — whichever
    // sits further along "outward" is the muzzle, full stop.
    const maxTip = new THREE.Vector3(max.x, max.y, max.z)
    const minTip = new THREE.Vector3(min.x, min.y, min.z)
    const maxProj = maxTip.sub(boneWorldPos).dot(forward)
    const minProj = minTip.sub(boneWorldPos).dot(forward)
    farIsFarther = maxProj >= minProj
  } else {
    farIsFarther = Math.abs(max[axis] - boneWorldPos[axis]) >= Math.abs(min[axis] - boneWorldPos[axis])
  }
  muzzle[axis] = farIsFarther ? max[axis] : min[axis]
  return muzzle
}

/** See computeWeaponMuzzlePoint's own doc comment for why this exists.
 * The Cockpit bone sits forward of the torso's own root by design (the
 * pilot has to see forward) on every MW5-sourced chassis checked so far
 * — a real, physical fact, not a per-chassis authoring convention that
 * could vary (unlike a fixed local axis, which this file's own
 * computeWalkGaitCurve doc comment already found DOES vary chassis to
 * chassis: "veo literalmente las partes de atras alante"). Returns null
 * for a chassis with no Cockpit bone at all (the old HBS pipeline),
 * which callers treat as "keep the old behavior", not an error. */
export function detectChassisForward(instance: THREE.Object3D): THREE.Vector3 | null {
  const cockpit = findBoneByName(instance, ['Cockpit'])
  const root = findBoneByName(instance, ['Torso_Pitch', 'Torso_Animation', 'Torso_Twist', 'Pelvis', 'Root'])
  if (!cockpit || !root) return null
  const cockpitPos = new THREE.Vector3()
  const rootPos = new THREE.Vector3()
  cockpit.updateWorldMatrix(true, false)
  root.updateWorldMatrix(true, false)
  cockpit.getWorldPosition(cockpitPos)
  root.getWorldPosition(rootPos)
  const offset = cockpitPos.sub(rootPos)
  offset.y = 0 // horizontal-plane forward only — up/down offset isn't "facing"
  if (offset.lengthSq() < 1e-8) return null // cockpit sits ~on the root — not a usable signal
  return offset.normalize()
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
  const forward = detectChassisForward(instance)
  return weapons.map((w) => {
    const mesh = meshByWeapon.get(w)
    const muzzle = mesh ? computeWeaponMuzzlePoint(mesh, forward) : null
    return {
      location: w.location,
      weaponName: w.weaponName,
      point: muzzle ? [muzzle.x / MODEL_SCALE, muzzle.y / MODEL_SCALE, muzzle.z / MODEL_SCALE] : null,
    }
  })
}

/** Real user request: MechLab's "Anotar armas" tab dropping manual
 * click-to-place entirely in favor of auto-detect-only for both weapons
 * AND the cockpit point ("ya no hay modo manual... que mostrará con un
 * punto donde ha detectado los cañones... y la cabina"). Same bone-based
 * approach as detectChassisForward/LOCATION_BONE_NAMES above — the
 * Cockpit bone's own world position IS the real pilot-eye reference
 * point already used to derive "forward" elsewhere in this file, so
 * reusing it here needs no invented offset. `null` for a chassis with no
 * Cockpit bone at all (old HBS pipeline) — caller falls back to
 * whatever's already saved/manual, same "changes nothing" contract as
 * this file's other optional detectors. */
export function computeCockpitPoint(instance: THREE.Object3D): [number, number, number] | null {
  const bone = findBoneByName(instance, ['Cockpit'])
  if (!bone) return null
  bone.updateWorldMatrix(true, false)
  const worldPos = new THREE.Vector3()
  bone.getWorldPosition(worldPos)
  return [worldPos.x / MODEL_SCALE, worldPos.y / MODEL_SCALE, worldPos.z / MODEL_SCALE]
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

/** Real user finding: the MW5-sourced pipeline (Bushwacker onward — "esta
 * sera la unica forma en el futuro... todos los modelos seran como este")
 * ships the whole body as ONE fused, single-material mesh, not separate
 * per-location objects — bodyMeshNamesByLocation finds nothing on these,
 * same "recognizes nothing, changes nothing" empty-map result as any
 * other unrecognized-naming chassis. What it DOES always have is a real,
 * consistently-named skeleton (verified against Bushwacker's own rig,
 * and this naming reads as MW5's own shared humanoid-mech convention,
 * not chassis-specific): Torso_Head, Torso_Pitch, Torso_Left_Front,
 * Torso_Right_Front, Forearm_Left/Right, Calf_Left/Right. A bone's own
 * world position is a perfectly reasonable stand-in for "the center of
 * that location" when there's no separate mesh to measure a bounding
 * box from — first candidate name found wins, tried in the order below,
 * so a future chassis missing one exact name still has a fallback
 * before giving up on that location entirely. */
const LOCATION_BONE_NAMES: Record<string, readonly string[]> = {
  HD: ['Torso_Head', 'Head'],
  CT: ['Torso_Pitch', 'Torso_Center_Front', 'Torso_Animation'],
  LT: ['Torso_Left_Front', 'Torso_Left_Rear'],
  RT: ['Torso_Right_Front', 'Torso_Right_Rear'],
  LA: ['Forearm_Left', 'Upperarm_Left', 'Hand_Left'],
  RA: ['Forearm_Right', 'Upperarm_Right', 'Hand_Right'],
  LL: ['Calf_Left', 'Thigh_Left'],
  RL: ['Calf_Right', 'Thigh_Right'],
}

function findBoneByName(instance: THREE.Object3D, names: readonly string[]): THREE.Bone | null {
  let found: THREE.Bone | null = null
  instance.traverse((object) => {
    if (found || !(object as THREE.Bone).isBone) return
    if (names.includes(object.name)) found = object as THREE.Bone
  })
  return found
}

/** Real user request, same message as computeLimbMeshNames above: "también
 * podremos localizar los impactos...?" — the "¿Dónde impacta un ataque a
 * esa zona?" hit-point slots (all 8 MECH_LOCATIONS, unlike the 4-limb
 * restriction above — HD/CT can visually be hit same as any limb, see
 * MechAnnotationPoint's own 'hit' kind doc comment) computed as the
 * combined posed bounding box CENTER of that location's own real body
 * meshes, instead of a manual click. Point is already divided back down
 * by MODEL_SCALE, same onSurfaceClick convention every other point in
 * this file's own detectors already follows. Falls back to
 * LOCATION_BONE_NAMES (a bone's own world position) for any location a
 * fused single-mesh chassis has no separate mesh names for — see that
 * constant's own doc comment. */
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

  const worldPos = new THREE.Vector3()
  for (const location of Object.keys(LOCATION_BONE_NAMES)) {
    if (result[location]) continue
    const bone = findBoneByName(instance, LOCATION_BONE_NAMES[location])
    if (!bone) continue
    bone.updateWorldMatrix(true, false)
    bone.getWorldPosition(worldPos)
    result[location] = [worldPos.x / MODEL_SCALE, worldPos.y / MODEL_SCALE, worldPos.z / MODEL_SCALE]
  }
  return result
}

// Keyed by chassis/model URL — same "compute once per chassis, share
// across every mounted instance" rationale as footShapeCache/
// walkGaitCurveCache above. `null` would mean "computed, chassis has no
// recognizable body-part mesh names at all" (see computeLocationHitPoints'
// own "changes nothing" contract), but that case is stored as `{}`
// instead (computeLocationHitPoints never returns null) — getMeshDetected
// HitPoint below treats a missing per-location entry in either case the
// same way (falls through to null), so this is never distinguished.
const meshDetectedHitPointCache = new Map<string, Partial<Record<string, [number, number, number]>>>()

/** Real user request: "el área de recibir el golpe, podemos sustituir el
 * punto fijo con detección de malla por nombre?" — computeLocationHitPoints
 * above already does exactly that (built for MechLabView's own auto-detect
 * button), just never wired into the actual game path, which still read a
 * manually-clicked-and-saved MechAnnotation. Computed once per chassis URL
 * ever, off a disposable never-rendered clone (same throwaway-rig pattern
 * as computeWalkGaitCurve, so this is independent of whatever pose the
 * REAL mixer happens to be in whenever this fires) — see the population
 * effect inside Mech3DModel below. `null` while not yet computed (first
 * frames right after a chassis first loads) or for a location this
 * chassis's own mesh names don't recognize — HexMap.tsx's own hit-point
 * lookup falls back to the old saved-annotation path in both cases,
 * exactly the same "best effort, never a hard requirement" contract every
 * other optional detector in this file already follows. */
export function getMeshDetectedHitPoint(url: string, location: string): [number, number, number] | null {
  return meshDetectedHitPointCache.get(url)?.[location] ?? null
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
// `skinnedOnly`: real bug found live comparing Bushwacker (98 mounted
// weapon meshes) against Annihilator (216) — this function originally
// unioned EVERY mesh in the scene, weapons included, regardless of
// which loadout is actually equipped (applyMechCombatVisibility hasn't
// run yet the first time normalizeMechInstance computes this; even once
// it has, a hidden mesh's geometry still measures the same). A chassis
// whose full 216-mesh weapon catalog happens to reach further on one
// side than its mirror (a bigger/longer barrel mesh at one hardpoint
// than the visually-equivalent one on the opposite side) skews the
// UNIONED box's own center away from the body's real center — reported
// live as "el Bushwacker está perfectamente centrado, pero el
// Annihilator no" (feet visibly off the hex's own centered footprint).
// A mech's true centerline is its own body, never its incidental
// weapon loadout, so X/Z centering now measures ONLY the skinned body
// mesh (skinnedOnly=true) while the full-scene box (every mesh,
// weapons included) is kept for the Y/height scale factor — a very
// long weapon SHOULD still count toward "how tall does this render",
// just not toward "where is its centerline".
function computeVisualBoundingBox(clone: THREE.Object3D, skinnedOnly = false): THREE.Box3 {
  clone.updateMatrixWorld(true)
  const box = new THREE.Box3()
  const vertex = new THREE.Vector3()
  clone.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const position = obj.geometry.attributes.position as THREE.BufferAttribute | undefined
    if (!position) return
    const skinned = (obj as THREE.SkinnedMesh).isSkinnedMesh ? (obj as THREE.SkinnedMesh) : null
    if (skinnedOnly && !skinned) return
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
      // Real user report chain: tried getting the cockpit glass to render
      // correctly (transmission needs an environment map none of our
      // viewers set up; the real MW5 material turned out to be a fully
      // metallic, opaque tinted visor built from a shared master material
      // this export never captured; its per-chassis mesh transform also
      // came out of Blender's own glTF exporter wrong — confirmed live in
      // Blender the object itself has zero local rotation, parented
      // directly to the Cockpit BONE rather than properly skinned, a
      // known Blender exporter limitation for that specific parenting
      // type). Re-parenting it to armature-deform in Blender (see
      // models/Bushwacker_glassfix.blend) fixed the geometry, but between
      // that and the material never quite landing right, the user's call:
      // "quita el cristal, no somos capaces de arreglarlo, no quiero que
      // se vea en el juego" — just hide it. Generic on material name
      // (every future chassis's own `_CockpitGlass` hits the same MW5
      // authoring pattern), not hardcoded to Bushwacker.
      if (/glass/i.test(mat.name)) {
        obj.visible = false
      }
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
    // Body-only box for X/Z centering (see computeVisualBoundingBox's own
    // doc comment) — falls back to the full box's own center for a
    // chassis with no skinned mesh at all (nothing to measure body-only),
    // same as before this existed.
    const bodyBox = computeVisualBoundingBox(clone, true)
    const centerSource = bodyBox.isEmpty() ? box : bodyBox
    const center = new THREE.Vector3()
    centerSource.getCenter(center)
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

// Real user report: the walk cycle plays at the right OVERALL pace now
// (WALK_CYCLE_TIME_SCALE — one full stride per hex crossed), but the feet
// still visibly skate against the ground mid-stride. Root cause: HexMap's
// stepToward moves the mech at a flat, constant WALK_SPEED every frame,
// completely blind to which foot the Walk clip currently has planted —
// during a real stride the grounded foot should stay glued to one spot
// while the body pivots forward over it (fast advance during the OTHER
// foot's swing, near-zero advance right at footfall/toe-off), not slide
// at one unchanging rate the whole cycle.
//
// Fix: measure the REAL required body-advance curve directly from this
// chassis's own Walk clip — for whichever foot bone (PieI/PieD) is
// grounded at each sampled instant, its LOCAL position (relative to the
// mesh root, which never itself translates in an authored loop) still
// visibly slides backward under a fixed root exactly as far as the body
// would need to advance in the real world to keep that same foot glued
// to the ground. Accumulating that backward slide across the whole cycle
// gives an exact, chassis-specific normalized speed profile — no baked
// root motion required, and no guessed easing curve either. HexMap's
// stepToward (see its own use of getWalkGaitProgress) then walks this
// curve by real elapsed time instead of a flat rate.
//
// Sampled on a disposable, never-rendered clone (normalizeMechInstance
// already gives every mounted instance its own skeleton — reused here
// purely as a detached rig to scrub through the clip on) so this never
// glitches a real, currently-visible mech's pose. Cheap (a few dozen
// samples on a small skeleton) and done once per chassis URL ever, not
// per mounted instance — see walkGaitCurveCache below.
const WALK_GAIT_SAMPLES = 48
// A foot counts as "grounded" for a sample while its own height sits in
// the bottom fifth of its total swing range for this clip — cheap and
// scale-independent (works whether a chassis's feet lift 0.3m or 3m),
// unlike a fixed absolute epsilon.
const WALK_GAIT_GROUND_FRACTION = 0.2

function computeWalkGaitCurve(scene: THREE.Object3D, walkClip: THREE.AnimationClip): ((phase: number) => number) | null {
  if (walkClip.duration <= 0) return null
  const rig = normalizeMechInstance(scene)
  const skinnedMesh = findSkinnedMeshInGroup(rig)
  const { left, right } = findFootBones(skinnedMesh)
  if (!left || !right) return null

  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(walkClip).play()

  const n = WALK_GAIT_SAMPLES
  const leftPos: THREE.Vector3[] = []
  const rightPos: THREE.Vector3[] = []
  const scratch = new THREE.Vector3()
  for (let i = 0; i <= n; i++) {
    mixer.setTime((i / n) * walkClip.duration)
    rig.updateMatrixWorld(true)
    left.getWorldPosition(scratch); leftPos.push(scratch.clone())
    right.getWorldPosition(scratch); rightPos.push(scratch.clone())
  }
  mixer.stopAllAction()

  const groundedMask = (positions: THREE.Vector3[]) => {
    const ys = positions.map((p) => p.y)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const threshold = minY + (maxY - minY) * WALK_GAIT_GROUND_FRACTION
    return ys.map((y) => y <= threshold)
  }
  const leftGrounded = groundedMask(leftPos)
  const rightGrounded = groundedMask(rightPos)

  // Forward axis/sign isn't assumed — different chassis exports have
  // ended up authored along either local axis (real prior bug in this
  // same pipeline: "veo literalmente las partes de atras alante"), so
  // instead of guessing, every axis/sign combination is tried and
  // whichever produces the largest accumulated grounded-foot slide wins.
  // A wrong axis/sign only ever nets a near-zero curve (grounded-frame
  // deltas cancel out or clip to zero), never a WRONG-but-confident one.
  let best: number[] | null = null
  let bestTotal = 0
  for (const axis of ['x', 'z'] as const) {
    for (const sign of [1, -1] as const) {
      const raw = [0]
      for (let i = 1; i <= n; i++) {
        const contribs: number[] = []
        if (leftGrounded[i] && leftGrounded[i - 1]) {
          contribs.push(sign * (leftPos[i - 1][axis] - leftPos[i][axis]))
        }
        if (rightGrounded[i] && rightGrounded[i - 1]) {
          contribs.push(sign * (rightPos[i - 1][axis] - rightPos[i][axis]))
        }
        const delta = contribs.length > 0 ? contribs.reduce((a, b) => a + b, 0) / contribs.length : 0
        raw.push(raw[i - 1] + Math.max(0, delta))
      }
      const total = raw[raw.length - 1]
      if (total > bestTotal) {
        bestTotal = total
        best = raw
      }
    }
  }
  if (!best || bestTotal <= 1e-6) return null

  const normalized = best.map((v) => v / bestTotal)
  return (phase: number) => {
    const p = Math.max(0, Math.min(1, phase))
    const idx = p * n
    const i0 = Math.floor(idx)
    const i1 = Math.min(n, i0 + 1)
    const frac = idx - i0
    return normalized[i0] + (normalized[i1] - normalized[i0]) * frac
  }
}

// Real user request: "mira como podemos implementar estas animaciones en
// nuestro juego" (BSW_FP_* clips) — FirstPersonView's own cockpit bob was
// a hand-tuned synthetic sine wave (BOB_AMPLITUDE/BOB_FREQUENCY there,
// several rounds of retuning per that file's own comments) purely because
// nothing else was available. This extracts the REAL vertical motion of
// the Cockpit bone from the chassis's own first-person walk clip instead
// — same "sample the real animation instead of faking its shape" fix
// computeWalkGaitCurve already applied to the walk-skating bug, just
// tracking a bone's Y instead of a foot's grounded XZ slide. Normalized
// to peak amplitude 1 in both directions (not to MODEL_SCALE world
// units) so FirstPersonView's own BOB_AMPLITUDE constant keeps its
// existing meaning — only the WAVE SHAPE changes, never the overall
// intensity knob. `null` for a chassis with no Cockpit bone, no matching
// clip, or a clip that doesn't actually move that bone (old HBS-pipeline
// chassis, or any chassis missing this one clip) — caller falls back to
// its own synthetic sine, zero regression there.
export function computeCameraBobCurve(scene: THREE.Object3D, clip: THREE.AnimationClip): ((phase: number) => number) | null {
  if (clip.duration <= 0) return null
  const rig = normalizeMechInstance(scene)
  const cockpit = findBoneByName(rig, ['Cockpit'])
  if (!cockpit) return null

  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(clip).play()

  const n = WALK_GAIT_SAMPLES
  const ys: number[] = []
  const scratch = new THREE.Vector3()
  for (let i = 0; i <= n; i++) {
    mixer.setTime((i / n) * clip.duration)
    rig.updateMatrixWorld(true)
    cockpit.getWorldPosition(scratch)
    ys.push(scratch.y)
  }
  mixer.stopAllAction()

  const mean = ys.reduce((a, b) => a + b, 0) / ys.length
  const centered = ys.map((y) => y - mean)
  const peak = Math.max(...centered.map(Math.abs))
  if (peak <= 1e-6) return null
  const normalized = centered.map((v) => v / peak)

  return (phase: number) => {
    const p = ((phase % 1) + 1) % 1
    const idx = p * n
    const i0 = Math.floor(idx)
    const i1 = Math.min(n, i0 + 1)
    const frac = idx - i0
    return normalized[i0] + (normalized[i1] - normalized[i0]) * frac
  }
}

// The MW5 pipeline's own first-person walk clip suffix — see
// MW5_CLIP_SUFFIXES's own doc comment for the naming convention. Kept
// separate from that table (not just another entry resolved via
// resolveClipKey) because resolveClipKeyForSuffix deliberately EXCLUDES
// every `_FP_` clip from third-person resolution — this is the one place
// that specifically wants the first-person twin, not its non-FP sibling.
export const MW5_FP_WALK_SUFFIX = 'FP_WalkForward_Straight_ANI'

// Keyed by chassis/model URL — same "compute once per chassis, share
// across every mounted instance" rationale as footShapeCache above.
// `null` means "analyzed, no usable curve" (unrigged chassis, or a clip
// that failed to yield a real signal) — HexMap.tsx's own
// getWalkGaitProgress caller falls back to its old flat WALK_SPEED
// stepping in that case, exactly as it always did before this existed.
const walkGaitCurveCache = new Map<string, ((phase: number) => number) | null>()

/** `phase` is 0..1 progress through crossing ONE hex at WALK_SPEED (see
 * hexMath.ts's own ONE_HEX_SECONDS) — returns 0..1 real progress along
 * that hex, reshaped to match this chassis's own Walk clip footfall
 * timing instead of a flat ramp. `null` while the curve for this url
 * hasn't been computed yet (first frames right after a chassis first
 * loads) or never will be (unrigged model) — caller falls back to plain
 * linear progress in both cases, so there's no "no data yet" glitch. */
export function getWalkGaitProgress(url: string, phase: number): number | null {
  const curve = walkGaitCurveCache.get(url)
  return curve ? curve(phase) : null
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

// Real user request: "los mechs pueden tener varias armas de un tipo...
// el autodetectar solo está detectando 1" — confirmed the fix needed:
// a saved point is now keyed per INDIVIDUAL mount (model_url + mountKey +
// visual), not per weapon-visual-bucket alone — two lasers on the same
// chassis (one per arm) are two separate mounts with two separate mesh
// instances, and don't necessarily share the exact same local offset.
// See WeaponMuzzlePointRecord's own doc comment in api.ts. Same "load
// once, best effort, null until it lands" module-level cache as
// footprintMaskRecords above.
let weaponMuzzlePointRecords: WeaponMuzzlePointRecord[] | null = null
let weaponMuzzlePointRecordsPromise: Promise<void> | null = null
function ensureWeaponMuzzlePointRecordsLoading(): void {
  if (weaponMuzzlePointRecords || weaponMuzzlePointRecordsPromise) return
  weaponMuzzlePointRecordsPromise = listWeaponMuzzlePoints()
    .then((rows) => { weaponMuzzlePointRecords = rows })
    .catch(() => { weaponMuzzlePointRecordsPromise = null })
}

/** `null` means "nothing saved for this exact mount yet, or the list
 * hasn't loaded" — caller falls back to the old per-chassis manual/auto-
 * detected muzzle annotation in either case, same best-effort contract
 * as getSavedFootprintMask above. The point is in the weapon mount
 * mesh's OWN local space (see WeaponMuzzlePointRecord's own doc comment)
 * — converting that into a world/mech-relative position is the caller's
 * job, once it has that specific mount's own world matrix. */
export function getSavedWeaponMuzzlePoint(
  url: string, mountKey: string, visual: string,
): [number, number, number] | null {
  ensureWeaponMuzzlePointRecordsLoading()
  const record = weaponMuzzlePointRecords?.find(
    (r) => r.model_url === url && r.mount_key === mountKey && r.visual === visual,
  )
  return record ? [record.x, record.y, record.z] : null
}

// url -> mountKey -> visual -> that exact mount's own bind-pose world
// matrix on THIS chassis. Unlike the old per-bucket cache, this keeps
// EVERY mount separately (two lasers in two different arms stay two
// distinct entries) — needed now that a saved point is per-mount, not
// per-bucket. Computed once per chassis URL ever, off a throwaway clone
// (see getMeshDetectedHitPoint's own doc comment on why its scale is set
// to MODEL_SCALE explicitly). Also doubles as this chassis's own mount
// TOPOLOGY (which (mountKey, visual) combinations even exist) for
// assignMountKeysToWeapons below — same map, no separate structure needed.
const weaponMountDataCache = new Map<string, Map<string, Map<string, THREE.Matrix4>>>()

function computeWeaponMountData(scene: THREE.Object3D): Map<string, Map<string, THREE.Matrix4>> {
  const rig = normalizeMechInstance(scene)
  rig.scale.setScalar(MODEL_SCALE)
  rig.updateMatrixWorld(true)
  const result = new Map<string, Map<string, THREE.Matrix4>>()
  rig.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const info = weaponMountOfMesh(mesh.name)
    if (!info) return
    let byVisual = result.get(info.mountKey)
    if (!byVisual) { byVisual = new Map(); result.set(info.mountKey, byVisual) }
    // See weaponMeshEffectiveMatrix's own doc comment — this cache used
    // to store the mesh's own (mostly irrelevant, for a skinned MW5
    // weapon) matrixWorld, which is the confirmed root cause behind
    // every weapon firing "desde el pecho" in the real game: the actual
    // consumer, getWeaponMuzzleWorldPoint, converts a saved LOCAL point
    // back to world through whatever matrix is cached here.
    const effective = weaponMeshEffectiveMatrix(mesh)
    if (!byVisual.has(info.visual) && effective) byVisual.set(info.visual, effective.clone())
  })
  return result
}

/** Real user request: "quiero poder ir viendo los modelos de cada arma,
 * poner su punto de disparo y que eso lo traslades al modelo montado" —
 * plus the follow-up fix once several-of-the-same-weapon chassis exposed
 * the gap: "los mechs pueden tener varias armas de un tipo... el
 * autodetectar solo está detectando 1". Given this attacker's own FULL
 * weapon loadout (so the exact same "Nth weapon at a location claims the
 * Nth unclaimed matching mount" pairing applyMechCombatVisibility's own
 * assignWeaponMountMeshes already uses for VISIBILITY runs here too — the
 * muzzle point always matches whichever mesh is actually shown, even
 * when two weapons share a bucket) and which weapon is actually firing
 * (must be the SAME object reference as one entry in `weapons` — HexMap's
 * own caller gets both from the same attackerMech.weapons array, so this
 * holds automatically), finds that weapon's own real mount and combines
 * the saved LOCAL point with that mount's own bind-pose world matrix.
 * `null` if nothing's saved for that exact mount yet, this weapon didn't
 * resolve to any mount at all, or this chassis's own mount data hasn't
 * been analyzed yet — HexMap.tsx's own caller falls back to the old
 * per-mech annotation in every case. */
export function getWeaponMuzzleWorldPoint(
  url: string,
  weapons: readonly { location: string; weaponName: string }[] | undefined,
  firingWeapon: { location: string; weaponName: string },
): [number, number, number] | null {
  const mountData = weaponMountDataCache.get(url)
  if (!mountData) return null
  const assignment = assignMountKeysToWeapons(mountData, weapons)
  const mountKey = assignment.get(firingWeapon)
  if (!mountKey) return null
  const bucket = weaponVisualBucket(firingWeapon.weaponName)
  if (!bucket) return null
  const matrix = mountData.get(mountKey)?.get(bucket)
  if (!matrix) return null
  const savedLocal = getSavedWeaponMuzzlePoint(url, mountKey, bucket)
  if (!savedLocal) return null
  const point = new THREE.Vector3(savedLocal[0], savedLocal[1], savedLocal[2]).applyMatrix4(matrix)
  return [point.x / MODEL_SCALE, point.y / MODEL_SCALE, point.z / MODEL_SCALE]
}

/** Live-tunable knobs for useMechPbr, below — pulled out into their own
 * type so MechLabView's Textura tab can expose them as sliders instead of
 * these being fixed constants only this file can change.
 *
 * Real user request: "los sliders... cambia todo a la vez, cabina/armas y
 * cuerpo, deberían ser cambios independientes" — confirmed live
 * (Bushwacker's own materials): Body/Weapons/Cockpit genuinely need
 * separate calibration, not just separate taste — the Weapons materials
 * ship with NO real roughness/metallic factor at all (glTF's bare 1.0/1.0
 * default), which reads as "doesn't respond to the slider" sitting next
 * to the Body's own already-reasonable baked values under one shared
 * knob. Each zone gets its own full set now; only `repeat` (tiling
 * density of the generic placeholder overlay — never a per-material
 * calibration value to begin with) stays shared. */
export interface MechPbrZoneSettings {
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
  /** Real user request: "el cuerpo, las armas... tienen una máscara para
   * aplicar las texturas. Los sliders solo afectan a la parte de la
   * máscara. Quiero otro slider que afecte a las partes FUERA de la
   * mask" — Body/Weapons only (undefined on Cockpit, no split requested
   * there). The real RGBPaintMask doesn't survive export (baked away —
   * see MECH_PBR_URLS's own doc comment on what patterns actually
   * survive) — this is a confirmed-with-the-user APPROXIMATION using the
   * already-baked metallicRoughness texture's own metalness (blue)
   * channel as a stand-in mask: it's derived from the same MetalID data,
   * so a high sample there already means "bare/unpainted metal," a low
   * one "painted panel" — see applyMechPbrMaskPatch's own doc comment
   * for the shader-level blend this actually drives. `roughness`/
   * `metalness` above keep meaning the PAINTED region (unchanged
   * behavior/defaults) when this is set; these two apply only where that
   * mask sample reads as bare metal.
   * Real follow-up: "los generales afectan a TODO a la vez" (Detalle de
   * relieve / Brillo specifically) — those two didn't get a mask split
   * in the first version, so they always touched the WHOLE zone
   * material regardless of the mask. metalNormalScale/metalColorBoost
   * close that gap, same painted/metal pairing as the two above. */
  metalRoughness?: number
  metalMetalness?: number
  metalNormalScale?: number
  metalColorBoost?: number
}

export interface MechPbrSettings {
  /** UV tiling repeat for the detail maps — shared across zones, see this
   * type's own doc comment for why. */
  repeat: number
  body: MechPbrZoneSettings
  weapons: MechPbrZoneSettings
  cockpit: MechPbrZoneSettings
}

/** Which of the three tunable zones a given material belongs to — pure
 * name-substring matching against the real material names this pipeline
 * ships (verified live on Bushwacker: every cockpit-related material,
 * shared library ones included, contains "cockpit"/"Cockpit"; both
 * weapon materials contain "Weapon"). Falls back to 'body' for anything
 * else (the actual Body material, and any small shared prop like
 * Clan_Greeble_A_MTI that doesn't fit either of the other two) — 'body'
 * is deliberately the catch-all, not a fourth "unknown" bucket, since a
 * mis-classified small prop is far less noticeable riding along with the
 * body's own tuning than left completely uncontrolled. */
function mechPbrZoneOfMaterial(materialName: string | undefined): 'body' | 'weapons' | 'cockpit' {
  const name = (materialName ?? '').toLowerCase()
  if (name.includes('cockpit')) return 'cockpit'
  if (name.includes('weapon')) return 'weapons'
  return 'body'
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
export function findSavedPbrSettings(records: MechPbrSettingsRecord[], url: string): MechPbrSettings | undefined {
  const rec = records.find((r) => r.model_url === url)
  if (!rec) return undefined
  return {
    repeat: rec.repeat,
    body: {
      normalScale: rec.body_normal_scale, roughness: rec.body_roughness, metalness: rec.body_metalness,
      colorBoost: rec.body_color_boost, aoIntensity: rec.body_ao_intensity,
      metalRoughness: rec.body_metal_roughness ?? rec.body_roughness,
      metalMetalness: rec.body_metal_metalness ?? rec.body_metalness,
      metalNormalScale: rec.body_metal_normal_scale ?? rec.body_normal_scale,
      metalColorBoost: rec.body_metal_color_boost ?? rec.body_color_boost,
    },
    // weapons_*/cockpit_* are only ever null on a row saved before these
    // zones existed — see MechPbrSettingsRecord's own doc comment.
    weapons: {
      normalScale: rec.weapons_normal_scale ?? MECH_PBR_DEFAULTS.weapons.normalScale,
      roughness: rec.weapons_roughness ?? MECH_PBR_DEFAULTS.weapons.roughness,
      metalness: rec.weapons_metalness ?? MECH_PBR_DEFAULTS.weapons.metalness,
      colorBoost: rec.weapons_color_boost ?? MECH_PBR_DEFAULTS.weapons.colorBoost,
      aoIntensity: rec.weapons_ao_intensity ?? MECH_PBR_DEFAULTS.weapons.aoIntensity,
      metalRoughness: rec.weapons_metal_roughness ?? rec.weapons_roughness ?? MECH_PBR_DEFAULTS.weapons.metalRoughness,
      metalMetalness: rec.weapons_metal_metalness ?? rec.weapons_metalness ?? MECH_PBR_DEFAULTS.weapons.metalMetalness,
      metalNormalScale: rec.weapons_metal_normal_scale ?? rec.weapons_normal_scale ?? MECH_PBR_DEFAULTS.weapons.metalNormalScale,
      metalColorBoost: rec.weapons_metal_color_boost ?? rec.weapons_color_boost ?? MECH_PBR_DEFAULTS.weapons.metalColorBoost,
    },
    cockpit: {
      normalScale: rec.cockpit_normal_scale ?? MECH_PBR_DEFAULTS.cockpit.normalScale,
      roughness: rec.cockpit_roughness ?? MECH_PBR_DEFAULTS.cockpit.roughness,
      metalness: rec.cockpit_metalness ?? MECH_PBR_DEFAULTS.cockpit.metalness,
      colorBoost: rec.cockpit_color_boost ?? MECH_PBR_DEFAULTS.cockpit.colorBoost,
      aoIntensity: rec.cockpit_ao_intensity ?? MECH_PBR_DEFAULTS.cockpit.aoIntensity,
    },
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
// Same starting numbers for all three zones (matches this app's own
// pre-split behavior exactly, so an already-saved chassis' DEFAULT look
// doesn't shift just because the zones became independently tunable) —
// deliberately NOT re-tuned per zone here. Live testing already showed
// the Weapons zone's own real baseline (glTF's bare 1.0/1.0 default —
// see mechPbrZoneOfMaterial's own doc comment) needs a genuinely
// different target than the Body's own calibrated maps, but picking
// that number blind, without a live render to check it against, would
// just trade one unverified guess for another — the whole point of
// splitting these was to let it be tuned per zone in MechLab with real
// visual feedback, not to have this file guess it up front.
const MECH_PBR_ZONE_DEFAULTS: MechPbrZoneSettings = {
  normalScale: 0.6,
  roughness: 0.6,
  metalness: 0.24,
  colorBoost: MECH_COLOR_BOOST,
  aoIntensity: 0.6,
}
export const MECH_PBR_DEFAULTS: MechPbrSettings = {
  repeat: MECH_PBR_REPEAT,
  // metalRoughness/metalMetalness start EQUAL to their painted-region
  // sibling (not a separately-guessed number, same reasoning as the doc
  // comment just above) — the mask-aware blend this drives is then a
  // pure no-op at default slider positions, only moving either one away
  // from the other reveals the split. Cockpit gets no mask split at all
  // (never requested there) — undefined on that zone.
  body: {
    ...MECH_PBR_ZONE_DEFAULTS,
    metalRoughness: MECH_PBR_ZONE_DEFAULTS.roughness, metalMetalness: MECH_PBR_ZONE_DEFAULTS.metalness,
    metalNormalScale: MECH_PBR_ZONE_DEFAULTS.normalScale, metalColorBoost: MECH_PBR_ZONE_DEFAULTS.colorBoost,
  },
  weapons: {
    ...MECH_PBR_ZONE_DEFAULTS,
    metalRoughness: MECH_PBR_ZONE_DEFAULTS.roughness, metalMetalness: MECH_PBR_ZONE_DEFAULTS.metalness,
    metalNormalScale: MECH_PBR_ZONE_DEFAULTS.normalScale, metalColorBoost: MECH_PBR_ZONE_DEFAULTS.colorBoost,
  },
  cockpit: { ...MECH_PBR_ZONE_DEFAULTS },
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
/** Real user request: "el cuerpo, las armas... tienen una máscara para
 * aplicar las texturas. Los sliders solo afectan a la parte de la
 * máscara. Quiero otro slider que afecte a las partes FUERA de la mask"
 * — confirmed with the user this is an APPROXIMATION (the real
 * RGBPaintMask doesn't survive export, see MechPbrZoneSettings' own doc
 * comment on metalRoughness/metalMetalness for why), using the ALREADY-
 * baked metallicRoughness texture's own blue (metalness) channel as the
 * mask signal — exactly the same texel `metalnessmap_fragment` already
 * samples for the normal metalness calculation, just also used to blend
 * toward a SECOND target instead of only multiplying the one scalar.
 * `mix(paintedValue, metalValue, maskWeight)`: at maskWeight 0 (a fully
 * painted texel) this is identical to the plain single-target behavior
 * above; at maskWeight 1 (fully bare metal) it's entirely the new
 * target. Chunk source verified against this project's own installed
 * three.js version (node_modules/.../ShaderChunk/roughnessmap_fragment.
 * glsl.js, metalnessmap_fragment.glsl.js) before writing this — reusing
 * it wholesale (not just appending to it) is what keeps the existing,
 * already-correct painted-side math (`roughnessFactor *= texelRoughness.
 * g`) unchanged for maskWeight 0.
 *
 * Real bug found via this exact feature's own live testing: "cuerpo
 * general modifica toda la malla, y fuera de máscara NO MODIFICA NADA"
 * — root cause was NOT the shader math (verified correct on paper) but
 * the update mechanism. Reassigning `material.onBeforeCompile` to a new
 * closure and setting `material.needsUpdate = true` does NOT make
 * three.js re-invoke `onBeforeCompile` once a program with matching
 * source text is already cached — confirmed live (console instrumented):
 * it fires exactly once per material, at the very first compile, never
 * again on later slider nudges. Every uniform this patch injects
 * (mechPbrMetal*) is therefore captured ONCE at whatever the mask
 * sliders happened to be at mount and frozen forever after, while the
 * material's own NATIVE uniforms (roughness/metalness/diffuse/
 * normalScale) keep updating live every frame regardless of
 * onBeforeCompile — because three.js refreshes those through its own
 * standard per-frame uniform upload, unrelated to shader recompilation.
 * That combination is exactly the reported symptom: the general
 * (painted) sliders visibly move the whole mesh via the native uniform
 * path, while the mask sliders drive a custom uniform nothing ever
 * re-reads. Fixed by keeping a stable reference to the injected uniform
 * objects (in `mat.userData`) and, on every re-run after the first,
 * mutating `.value` on those SAME objects directly instead of trying to
 * force a recompile — the standard three.js pattern for a live-tunable
 * onBeforeCompile uniform. */
function applyMechPbrMaskPatch(mat: THREE.MeshStandardMaterial, options: {
  metalRoughness: number
  metalMetalness: number
  /** Real user report, right after shipping roughness/metalness-only:
   * "los generales afectan a TODO a la vez" (Detalle de relieve / Brillo
   * specifically) — those two never got a mask split at all in the first
   * version, so moving them always touched the WHOLE zone material
   * (painted AND bare-metal region together, since they're one texture)
   * — not a bug, just an incomplete scope that didn't match what was
   * actually asked for. Both now blend too, via a RATIO against
   * whatever the plain painted-side JS code already computed (see this
   * option's own use site below) — cheaper than a second full
   * uniform, and automatically consistent with the painted value's own
   * baseline-relative scaling from the caller. */
  normalScaleRatio: number
  colorBoostRatio: number
}) {
  const { metalRoughness, metalMetalness, normalScaleRatio, colorBoostRatio } = options
  const userData = mat.userData as { __mechPbrMaskUniforms?: {
    mechPbrMetalRoughness: { value: number }
    mechPbrMetalMetalness: { value: number }
    mechPbrMetalNormalScaleRatio: { value: number }
    mechPbrMetalColorBoostRatio: { value: number }
  } }
  if (userData.__mechPbrMaskUniforms) {
    const u = userData.__mechPbrMaskUniforms
    u.mechPbrMetalRoughness.value = metalRoughness
    u.mechPbrMetalMetalness.value = metalMetalness
    u.mechPbrMetalNormalScaleRatio.value = normalScaleRatio
    u.mechPbrMetalColorBoostRatio.value = colorBoostRatio
    return
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.mechPbrMetalRoughness = { value: metalRoughness }
    shader.uniforms.mechPbrMetalMetalness = { value: metalMetalness }
    shader.uniforms.mechPbrMetalNormalScaleRatio = { value: normalScaleRatio }
    shader.uniforms.mechPbrMetalColorBoostRatio = { value: colorBoostRatio }
    userData.__mechPbrMaskUniforms = {
      mechPbrMetalRoughness: shader.uniforms.mechPbrMetalRoughness,
      mechPbrMetalMetalness: shader.uniforms.mechPbrMetalMetalness,
      mechPbrMetalNormalScaleRatio: shader.uniforms.mechPbrMetalNormalScaleRatio,
      mechPbrMetalColorBoostRatio: shader.uniforms.mechPbrMetalColorBoostRatio,
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float mechPbrMetalRoughness;\nuniform float mechPbrMetalMetalness;'
          + '\nuniform float mechPbrMetalNormalScaleRatio;\nuniform float mechPbrMetalColorBoostRatio;',
      )
      // Real user request: "otro slider que afecte a las partes FUERA de
      // la mask" for Brillo too — diffuseColor.rgb is already `texel *
      // diffuse` at this point (map_fragment ran first in this
      // pipeline — verified against this project's own installed
      // three.js ShaderLib/meshphysical.glsl.js include order — and
      // `diffuse` is the JS side's own PAINTED colorBoost already baked
      // in, see applyColorBoost's own call site). Rescaling by the
      // metal/painted RATIO reproduces `texel * metalColorBoost`
      // without needing a second base-color uniform.
      .replace(
        '#include <map_fragment>',
        `
        #include <map_fragment>
        #ifdef USE_METALNESSMAP
          float mechPbrColorMaskWeight = texture2D( metalnessMap, vMetalnessMapUv ).b;
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * mechPbrMetalColorBoostRatio, mechPbrColorMaskWeight );
        #endif
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
          roughnessFactor *= texelRoughness.g;
        #endif
        #ifdef USE_METALNESSMAP
          float mechPbrMaskWeight = texture2D( metalnessMap, vMetalnessMapUv ).b;
          roughnessFactor = mix( roughnessFactor, mechPbrMetalRoughness, mechPbrMaskWeight );
        #endif
        `,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `
        float metalnessFactor = metalness;
        #ifdef USE_METALNESSMAP
          vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
          metalnessFactor *= texelMetalness.b;
          metalnessFactor = mix( metalnessFactor, mechPbrMetalMetalness, texelMetalness.b );
        #endif
        `,
      )
      // Real user request: mask split for Detalle de relieve too —
      // `mapN.xy *= normalScale` is three.js's own built-in line here;
      // this rescales that SAME built-in `normalScale` uniform (already
      // the painted value, set JS-side) by the metal/painted ratio
      // wherever the mask reads as bare metal, same reasoning as the
      // color rescale above.
      .replace(
        'mapN.xy *= normalScale;',
        `
        #ifdef USE_METALNESSMAP
          float mechPbrNormalMaskWeight = texture2D( metalnessMap, vMetalnessMapUv ).b;
          mapN.xy *= normalScale * mix( 1.0, mechPbrMetalNormalScaleRatio, mechPbrNormalMaskWeight );
        #else
          mapN.xy *= normalScale;
        #endif
        `,
      )
  }
  mat.needsUpdate = true
}

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
  // One full set per zone (Body/Weapons/Cockpit — see MechPbrSettings'
  // own doc comment) instead of one shared set — mechPbrZoneOfMaterial
  // below picks which of these three a given material actually uses.
  const zoneBody = options?.settings?.body ?? MECH_PBR_DEFAULTS.body
  const zoneWeapons = options?.settings?.weapons ?? MECH_PBR_DEFAULTS.weapons
  const zoneCockpit = options?.settings?.cockpit ?? MECH_PBR_DEFAULTS.cockpit
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
      const zone = mechPbrZoneOfMaterial(mat.name)
      const {
        normalScale, roughness, metalness, colorBoost, aoIntensity,
        metalRoughness, metalMetalness, metalNormalScale, metalColorBoost,
      } = zone === 'weapons' ? zoneWeapons : zone === 'cockpit' ? zoneCockpit : zoneBody
      const aoMap = aoSource.clone()
      aoMap.wrapS = aoMap.wrapT = THREE.RepeatWrapping
      aoMap.repeat.set(repeat, repeat)
      aoMap.colorSpace = THREE.NoColorSpace
      aoMap.needsUpdate = true
      mat.aoMap = aoMap
      mat.aoMapIntensity = aoIntensity
      // Real per-chassis PBR maps (Bushwacker onward, MW5-sourced) ship
      // their own normal/roughness/metalness textures baked from real
      // game data and land on `mat` straight off the GLTFLoader before
      // this hook ever runs. This generic tiled overlay exists only to
      // give placeholder chassis — which ship with NO real maps at all,
      // see MECH_PBR_URLS's own doc comment — something to look at, and
      // must never clobber a chassis that already has the real thing.
      // Tag every texture (and the scalar pairing that came with it) this
      // hook itself assigns so a later re-run (e.g. a Textura-tab slider
      // change) can tell "mine, safe to replace" apart from "the model's
      // own, never touch" — `mat.normalMap` is real on the FIRST run for
      // Bushwacker, but would look identical to an overlay on later runs
      // without this tag.
      const hasRealNormal = !!mat.normalMap && !mat.normalMap.userData?.isMechPbrOverlay
      const hasRealRoughness = !!mat.roughnessMap && !mat.roughnessMap.userData?.isMechPbrOverlay
      const hasRealMetalness = !!mat.metalnessMap && !mat.metalnessMap.userData?.isMechPbrOverlay

      if (!hasRealNormal) {
        const normalMap = mechPbrTextures.normalMap.clone()
        normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping
        normalMap.repeat.set(repeat, repeat)
        normalMap.colorSpace = THREE.NoColorSpace
        normalMap.needsUpdate = true
        normalMap.userData.isMechPbrOverlay = true
        mat.normalMap = normalMap
        // Live-tested (Playwright) at normalScale 1: the tiled detail normal
        // map, at full strength, faceted the surface into hard dark creases
        // under a single directional light — read as "the whole model went
        // blotchy/black", not a subtle scratched-metal detail. Turned way
        // down so it stays a faint surface-grain hint instead of visibly
        // reshaping the model's own silhouette shading.
        mat.normalScale.set(normalScale, normalScale)
      } else {
        // Real user report: "los sliders tienen que dejarnos configurar
        // algunas características de las texturas del mech" — a chassis
        // WITH its own real normal map (Bushwacker onward) used to just
        // skip this slider entirely (the map itself was correctly left
        // alone, but so was normalScale, the one part of it this slider
        // was always meant to reach — normalScale multiplies whatever the
        // map already encodes, it never replaces per-texel detail, so
        // there's no reason to gate it the same way the MAP REPLACEMENT
        // above needs to be gated). Same snapshot-then-multiply pattern
        // applyColorBoost already uses for mat.color just below — captured
        // ONCE (this material's real, GLTFLoader-set baseline) so re-runs
        // scale FROM that fixed point instead of compounding, and divided
        // by MECH_PBR_DEFAULTS.normalScale so the slider's OWN default
        // position reproduces the untouched baseline exactly (only moving
        // the slider away from default changes anything) — the calibrated
        // per-chassis detail this chassis already ships never quietly
        // shifts just because this hook ran again.
        const userData = mat.userData as { __mechPbrBaseNormalScale?: THREE.Vector2 }
        if (!userData.__mechPbrBaseNormalScale) userData.__mechPbrBaseNormalScale = mat.normalScale.clone()
        mat.normalScale.copy(userData.__mechPbrBaseNormalScale).multiplyScalar(normalScale / MECH_PBR_DEFAULTS[zone].normalScale)
      }
      if (!hasRealRoughness) {
        const roughnessMap = mechPbrTextures.roughnessMap.clone()
        roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping
        roughnessMap.repeat.set(repeat, repeat)
        roughnessMap.colorSpace = THREE.NoColorSpace
        roughnessMap.needsUpdate = true
        roughnessMap.userData.isMechPbrOverlay = true
        mat.roughnessMap = roughnessMap
      }
      if (!hasRealMetalness) {
        const metalnessMap = mechPbrTextures.metalnessMap.clone()
        metalnessMap.wrapS = metalnessMap.wrapT = THREE.RepeatWrapping
        metalnessMap.repeat.set(repeat, repeat)
        metalnessMap.colorSpace = THREE.NoColorSpace
        metalnessMap.needsUpdate = true
        metalnessMap.userData.isMechPbrOverlay = true
        mat.metalnessMap = metalnessMap
      }
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
      //
      // Real user report: "los sliders tienen que dejarnos configurar
      // algunas características de las texturas del mech" — a chassis
      // WITH its own real roughness/metalness map used to skip these two
      // scalars entirely, on the theory that "it already carries the
      // right scalar factor from its own glTF material." True, but
      // roughness/metalness are MULTIPLIERS on the map sample in this
      // material model (finalRoughness = mat.roughness * mapSample), never
      // a replacement for it — there was never a real reason these
      // sliders couldn't ALSO scale a real chassis's own calibrated
      // baseline up/down, same idea as normalScale just above. Same
      // snapshot-then-multiply-from-default pattern: captured once (the
      // real, GLTFLoader-set value), divided by MECH_PBR_DEFAULTS' own
      // roughness/metalness so each slider's OWN default position
      // reproduces that calibrated baseline exactly untouched, and only
      // moving a slider away from default scales it.
      const baseUserData = mat.userData as { __mechPbrBaseRoughness?: number; __mechPbrBaseMetalness?: number }
      if (hasRealRoughness) {
        if (baseUserData.__mechPbrBaseRoughness == null) baseUserData.__mechPbrBaseRoughness = mat.roughness
        mat.roughness = baseUserData.__mechPbrBaseRoughness * (roughness / MECH_PBR_DEFAULTS[zone].roughness)
      } else {
        mat.roughness = roughness
      }
      if (hasRealMetalness) {
        if (baseUserData.__mechPbrBaseMetalness == null) baseUserData.__mechPbrBaseMetalness = mat.metalness
        mat.metalness = baseUserData.__mechPbrBaseMetalness * (metalness / MECH_PBR_DEFAULTS[zone].metalness)
      } else {
        mat.metalness = metalness
      }
      // See applyMechPbrMaskPatch's own doc comment. Only meaningful with
      // a real metalnessMap to sample as the mask signal in the first
      // place (hasRealMetalness) — a chassis/material with no real map at
      // all (the generic placeholder overlay case) has no per-texel mask
      // to blend against, same "nothing to split" reasoning as
      // metalRoughness/metalMetalness being undefined on the Cockpit
      // zone entirely.
      if (hasRealMetalness && metalRoughness != null && metalMetalness != null) {
        const normalScaleRatio = normalScale > 0 && metalNormalScale != null ? metalNormalScale / normalScale : 1
        const colorBoostRatio = colorBoost > 0 && metalColorBoost != null ? metalColorBoost / colorBoost : 1
        applyMechPbrMaskPatch(mat, {
          metalRoughness, metalMetalness,
          // Ratio, not the raw value — see applyMechPbrMaskPatch's own
          // doc comment on why (rescales whatever the painted-side JS
          // code above already computed, no second base uniform needed).
          // Guards against a somehow-zero painted value (would divide by
          // zero) by just skipping the metal-side rescale in that
          // degenerate case — ratio 1 is a no-op mix, same as "no mask".
          normalScaleRatio, colorBoostRatio,
        })
      }
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
  }, [instance, mechPbrTextures, applyColorBoost, repeat, zoneBody, zoneWeapons, zoneCockpit])
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

const TORSO_TWIST_BONE = 'j_Spine2'

/** Samples a bone's own LOCAL quaternion directly out of a clip's raw
 * keyframe track at an arbitrary time — no skeleton/mixer needed, since a
 * bone's OWN rotation track already IS its local-space rotation (unlike a
 * bone's world POSITION, which needs the whole ancestor chain evaluated —
 * see computeWalkGaitCurve's own doc comment for why that one DOES need a
 * throwaway rig). `null` if this clip doesn't animate that bone at all. */
function sampleBoneQuaternion(clip: THREE.AnimationClip, boneName: string, time: number): THREE.Quaternion | null {
  const track = clip.tracks.find((t) => t.name === `${boneName}.quaternion`)
  if (!track) return null
  const result = track.createInterpolant().evaluate(time)
  return new THREE.Quaternion(result[0], result[1], result[2], result[3])
}

/** Real user report: the torso-twist overlay always rotated the exact
 * same amount (read as a fixed ~90°) no matter how far off the real
 * target actually was — HexMap only ever decides a DIRECTION (left/
 * right, see attackSignal's own `twist` doc comment); the overlay used
 * to always play at full weight regardless of how many degrees were
 * actually needed. Since the overlay is an ADDITIVE layer (see
 * twistOverlayActionsRef's own doc comment), its `weight` is exactly the
 * right knob to scale it down — but that needs to know how many radians
 * THIS chassis's own twist clip actually bakes in, to turn "the real
 * target is 40° off" into "40° is what fraction of this clip's own full
 * swing." Measured once per chassis (same "sample the real clip data
 * instead of guessing" approach as computeWalkGaitCurve above) straight
 * off the raw (non-additive) twist clip vs the idle clip's own rest
 * pose — no live rig needed here, unlike that one, since a single bone's
 * OWN rotation track doesn't need forward kinematics. `null` if either
 * clip is missing the bone, or the two poses are identical (a badly-
 * authored clip that doesn't actually rotate it) — callers fall back to
 * full weight rather than dividing by zero. */
function measureBakedTwistAngle(idleClip: THREE.AnimationClip, twistClip: THREE.AnimationClip): number | null {
  const restQuat = sampleBoneQuaternion(idleClip, TORSO_TWIST_BONE, 0)
  const twistQuat = sampleBoneQuaternion(twistClip, TORSO_TWIST_BONE, twistClip.duration)
  if (!restQuat || !twistQuat) return null
  const angle = restQuat.angleTo(twistQuat)
  return angle > 1e-3 ? angle : null
}

// See resolveClipKey's own doc comment on the "brazos separados" bug this
// guards against — the literal, verified prefix every one of the 15
// affected placeholder chassis' borrowed clips carry.
export const KNOWN_BORROWED_CLIP_PREFIX = 'atlas'

/** Marks a clip built by buildRetargetedBorrowedClip below — never a raw
 * glTF clip name, so resolveClipKey can tell "the corrected version of a
 * borrowed clip" apart from "the raw borrowed clip itself" just by
 * string suffix. */
const RETARGET_SUFFIX = '__retargeted'

/** Atlas.glb's own bind-pose LOCAL rotation per joint, read directly off
 * its glTF nodes (never sampled from a clip — a clip's own first frame
 * isn't reliably at rest, e.g. an attack pose). Real user report
 * (Commando, screenshot): letting a borrowed atlas_ clip play as-is sent
 * both arms flying up near the head, fully detached at the shoulder,
 * while the legs stayed attached. Root cause, found by comparing raw
 * glTF node rotations directly: a borrowed clip's `.quaternion` tracks
 * are ABSOLUTE local rotations, authored against ATLAS's own bind pose.
 * j_LClavicle rests at (0,0,-0.827,0.562) in Atlas but (0,0,-0.707,0.707)
 * in Commando — a real ~30° difference that keeps compounding down the
 * UpperArm/Forearm chain. Writing Atlas's absolute value straight into
 * Commando's clavicle doesn't reproduce the intended POSE, it just picks
 * a different absolute orientation for a joint whose own rest already
 * points elsewhere. Legs differ far less between the two rigs (a few
 * degrees), so the same issue is there too, just small enough to read as
 * "looks fine" — and it's exactly why Warhammer/Assassin/Catapult (same
 * borrowed-only situation as Commando, just with body proportions closer
 * to Atlas's own) got away with playing the raw clip for a long time
 * before anyone noticed, right up until resolveClipKey's own
 * isBorrowed guard (below) started refusing to play it for ANY of them —
 * trading "plays looking slightly off" for "doesn't play at all", which
 * is strictly worse for a chassis where it never looked broken.
 * buildRetargetedBorrowedClip removes each joint's own
 * Atlas-vs-this-chassis bind-pose offset before playback, so what plays
 * is the actual authored MOTION (the delta from Atlas's own rest)
 * reapplied on top of THIS chassis's own rest — correct for all of them
 * at once, not a per-chassis judgment call. */
const ATLAS_REST_QUATS: Record<string, [number, number, number, number]> = {
  j_Head: [-0.707107, 0.000005, 0.000001, 0.707106],
  j_LCalf: [-0.175796, 0.000001, 0, 0.984427],
  j_LClavicle: [-0.000004, -0.000004, -0.827211, 0.561891],
  j_LFoot: [0.135445, 0.000025, -0.000209, 0.990785],
  j_LForearm: [0.325986, 0, -0.000001, 0.945375],
  j_LHip: [0.000022, -0.000022, -0.707361, 0.706853],
  j_LThigh: [0.02583, -0.025856, -0.70638, 0.706889],
  j_LToe0: [0.671128, -0.009855, -0.011082, 0.741193],
  j_LUpperArm: [0.000011, -0.00001, -0.56189, 0.827212],
  j_Neck: [0.707104, 0, 0, 0.70711],
  j_Pelvis: [0, 0, 0, 1],
  j_Pitch: [0.707109, 0, -0.000004, 0.707104],
  j_RCalf: [-0.175804, 0, 0.000001, 0.984425],
  j_RClavicle: [0.000002, 0, 0.827214, 0.561887],
  j_RFoot: [0.135972, 0.00003, -0.00018, 0.990713],
  j_RForearm: [0.326011, -0.000004, 0.000001, 0.945366],
  j_RHip: [0, 0, 0.707107, 0.707107],
  j_Root: [-0.707107, 0, 0, 0.707107],
  j_RThigh: [0.025844, 0.025842, 0.706635, 0.706634],
  j_RToe0: [0.671162, -0.008112, -0.00909, 0.74121],
  j_RUpperArm: [0.004981, 0.003386, 0.561784, 0.827262],
  j_Spine: [-0.707618, 0.000368, 0.000375, 0.706595],
  j_Spine1: [0.000724, 0, -0.000526, 1],
  j_Spine2: [0, 0, 0, 1],
}

/** Bind-pose LOCAL quaternion of every bone THIS chassis actually has,
 * for the bones ATLAS_REST_QUATS knows about — read straight off `scene`
 * (the raw useGLTF result, never itself driven by a mixer, so its bones
 * are still exactly the file's own bind pose no matter what any rendered
 * clone's AnimationMixer has done elsewhere). */
export interface ChassisRestPose {
  quaternion: THREE.Quaternion
  /** Real bug found live (Commando's atlas_attackMeleeIdle): j_LClavicle's
   * OWN `.position` (translation) track in that clip holds (3.077, 4.495,
   * -1.311) — Atlas's own shoulder-mount offset, nowhere close to
   * Commando's actual rest translation (1.199, 2.100, -0.339). Every
   * other arm bone checked earlier (UpperArm, Forearm) happened to hold
   * its OWN chassis's rest translation constant throughout — which is
   * what led to the wrong assumption that translation never needs
   * retargeting. It isn't universal: whichever mount point differs most
   * between Atlas's and this chassis's proportions (the shoulder anchor,
   * for a mech a fraction of Atlas's size) carries Atlas's raw number
   * too. Recorded here so buildRetargetedBorrowedClip can force any
   * `.position` track back to THIS chassis's own bind-pose translation
   * whenever it doesn't already match it. */
  position: THREE.Vector3
}

export function getChassisRestQuats(scene: THREE.Object3D): Map<string, ChassisRestPose> {
  const out = new Map<string, ChassisRestPose>()
  for (const boneName of Object.keys(ATLAS_REST_QUATS)) {
    const bone = scene.getObjectByName(boneName)
    if (bone) out.set(boneName, { quaternion: bone.quaternion.clone(), position: bone.position.clone() })
  }
  return out
}

/** Builds a NEW clip — new tracks, new typed arrays — with every
 * `.quaternion` track re-expressed relative to THIS chassis's own bind
 * pose instead of Atlas's (see ATLAS_REST_QUATS' own doc comment for
 * why). Never mutates `clip` or any of its existing tracks: an earlier
 * attempt at this wrote corrected values directly into the original
 * track's `.values` array and broke OTHER, previously-correct clips
 * (Hatchetman's own included) that happened to share that exact
 * underlying typed array — GLTFLoader can alias the same buffer across
 * multiple tracks when their keyframe data is byte-identical, which
 * every one of these borrowed atlas_ clips is by construction. Building
 * a standalone clip instead means nothing already cached by useGLTF is
 * ever touched, no matter how its buffers are shared internally.
 * `.scale` tracks are reused by reference (read-only, sharing is safe) —
 * every one checked stays at (1,1,1) throughout. `.position` (translation)
 * tracks get the same "force to this chassis's own rest" treatment as
 * rotation — see ChassisRestPose's own doc comment for the real bug
 * (Commando's shoulder mount) this exists to fix. */
export function buildRetargetedBorrowedClip(clip: THREE.AnimationClip, chassisRestPose: Map<string, ChassisRestPose>): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = clip.tracks.map((track) => {
    if (track.name.endsWith('.position')) {
      const boneName = track.name.slice(0, -'.position'.length)
      const rest = chassisRestPose.get(boneName)
      if (!rest) return track
      // See ChassisRestPose's own doc comment (j_LClavicle/atlas_attack
      // MeleeIdle) — a borrowed clip's translation is either already this
      // chassis's own constant bind-pose offset (the common case) or
      // Atlas's own mount-point number wholesale. There's no "authored
      // motion" case to preserve either way — this rig never actually
      // animates bone length/offset — so any translation keyframe that
      // doesn't already match this chassis's own rest gets forced to it.
      let matchesRest = true
      for (let i = 0; i + 2 < track.values.length; i += 3) {
        if (
          Math.abs(track.values[i] - rest.position.x) > 1e-4
          || Math.abs(track.values[i + 1] - rest.position.y) > 1e-4
          || Math.abs(track.values[i + 2] - rest.position.z) > 1e-4
        ) { matchesRest = false; break }
      }
      if (matchesRest) return track
      const values = new Float32Array(track.values.length)
      for (let i = 0; i + 2 < track.values.length; i += 3) {
        values[i] = rest.position.x
        values[i + 1] = rest.position.y
        values[i + 2] = rest.position.z
      }
      return new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), values)
    }

    if (!track.name.endsWith('.quaternion')) return track
    const boneName = track.name.slice(0, -'.quaternion'.length)
    const atlasRest = ATLAS_REST_QUATS[boneName]
    const chassisRest = chassisRestPose.get(boneName)?.quaternion
    if (!atlasRest || !chassisRest) return track

    // Real user finding (Commando's atlas_torsoTwistLeft): a bone this
    // PARTICULAR clip never actually poses holds a CONSTANT value equal
    // to THIS chassis's own rest — Blender's ordinary behavior for a bone
    // with no keyframes of its own, not borrowed Atlas data. Only a bone
    // this clip genuinely moves away from rest carries Atlas's authored
    // (and therefore Atlas-frame) numbers. Correcting the untouched one
    // anyway would rotate an already-correct hold AWAY from rest by the
    // same offset instead of leaving it alone — exactly the regression
    // that made torsoTwist look right and everything else look wrong
    // side by side, once spotted. Checked once per track (every
    // keyframe within ~0.6° of this chassis's own rest), not per
    // keyframe — a clip that only grazes rest in passing still needs
    // correcting; one that never leaves it doesn't.
    let posesAwayFromRest = false
    const sample = new THREE.Quaternion()
    for (let i = 0; i + 3 < track.values.length; i += 4) {
      sample.set(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3])
      if (sample.angleTo(chassisRest) > 0.01) { posesAwayFromRest = true; break }
    }
    if (!posesAwayFromRest) return track

    const correction = chassisRest.clone().multiply(
      new THREE.Quaternion(atlasRest[0], atlasRest[1], atlasRest[2], atlasRest[3]).invert(),
    )
    const values = new Float32Array(track.values.length)
    const q = new THREE.Quaternion()
    for (let i = 0; i + 3 < track.values.length; i += 4) {
      q.set(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]).premultiply(correction)
      values[i] = q.x
      values[i + 1] = q.y
      values[i + 2] = q.z
      values[i + 3] = q.w
    }
    return new THREE.QuaternionKeyframeTrack(track.name, Array.from(track.times), values)
  })
  return new THREE.AnimationClip(`${clip.name}${RETARGET_SUFFIX}`, clip.duration, tracks)
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
 * this step", never a crash, same as a chassis with no animations at all.
 *
 * Real user report + direct file inspection: the Assassin's arms visibly
 * tore away from its own body the instant ANY animation played — traced
 * to a genuine content bug, not a rendering one: EVERY one of the 15
 * newly added placeholder .glb chassis ships the exact same animation
 * library under a literal `atlas_` prefix (Archer, Assassin, Awesome,
 * Banshee, Battlemaster, Warhammer, Annihilator, Cicada, Blackjack,
 * Blackknight, Bullshark, Cataphract, Catapult, Centurion — verified by
 * reading each .glb's own animation names directly), copied wholesale
 * from the Atlas's own export instead of each chassis's own game data.
 * Only Atlas.glb is actually correct (it IS the real source). Applying
 * the Atlas's own joint rotations — tuned for the Atlas's own skeleton —
 * onto a differently-proportioned chassis' bones is exactly what tears a
 * limb away from the body once the clip actually moves it; MechLab's own
 * preview never plays an animation at all, so it never surfaced this.
 *
 * No code fix can reconstruct the animation data that was never actually
 * exported for these chassis, so this refuses to resolve a clip whose
 * prefix is the KNOWN-borrowed `atlas_` one on any chassis that isn't
 * actually the Atlas — every caller already treats "no clip" as "skip
 * this step, no animation", the same graceful fallback a chassis with
 * genuinely zero clips gets today, which beats visibly tearing itself
 * apart.
 *
 * Real user report (Hatchetman): the hatchet — a hinge-jointed prop
 * clearly meant to be POSED by an animation, not to look right sitting in
 * a raw bind pose — kept floating away from the hand no matter how many
 * times its bind-pose bone translations got hand-corrected. Root cause,
 * found by actually listing every clip this file ships: Hatchetman has
 * BOTH the borrowed `atlas_*` library AND its own real, correctly-named
 * `hatchetman_*` one (verified: hatchetman_moveCoreIdle, _moveCoreWalkFwd,
 * every attack/melee/twist clip) — but the OLD version of this function
 * used `.find()`, which stops at the FIRST `_moveCoreIdle`-suffixed key it
 * sees. Since the borrowed atlas_ clips happen to appear earlier in the
 * glTF's own animations array, `.find()` grabbed `atlas_moveCoreIdle`,
 * saw it was borrowed, and gave up — never even looking far enough to
 * find `hatchetman_moveCoreIdle` sitting right there. Collecting every
 * same-suffix candidate first and preferring a non-borrowed one fixes
 * this for any chassis in the same situation, not just this one — while
 * a chassis with ONLY the borrowed clip (the other 20 or so from the same
 * pipeline pass) keeps falling back to "no animation" exactly as before.
 * Remove the whole borrowed-prefix check once every affected file is
 * re-exported with its own real per-chassis animation library.
 *
 * Commando update: headless-Blender forensics on its raw source FBX
 * (chrPrfMech_commandoBase-001.fbx) proved this isn't a leftover-session
 * artifact like the Hatchetman case — the atlas_ library is the ONLY
 * animation data that file has ever contained, baked in at the
 * AssetStudio extraction stage itself. Real user report: with this guard
 * in place, EVERY chassis in that situation — not just Commando, but
 * Warhammer/Assassin/Catapult/etc., which had been playing the raw
 * borrowed clip and looking fine for a long time before this guard
 * existed — went completely still. Freezing was the safe fallback while
 * the only alternative was "plays with its arms in the wrong place", but
 * it's strictly worse for a chassis the raw clip never actually broke.
 * buildRetargetedBorrowedClip (see its own + ATLAS_REST_QUATS' doc
 * comments) removes the actual root cause instead: each borrowed
 * keyframe re-expressed as a delta from ATLAS's own rest, reapplied on
 * top of THIS chassis's own rest — correct for the ones that already
 * looked fine (the correction is near-identity there) and for Commando
 * (where it isn't) alike, so this no longer has to choose between "wrong
 * pose" and "no pose" — it prefers the corrected clip whenever the raw
 * one would otherwise have been rejected. */
// Real user request: "investiga bien las animaciones del modelo... mira
// como podemos implementar estas animaciones en nuestro juego" — the real
// MW5-extracted-via-FModel/Blender pipeline (Bushwacker being the first
// chassis on it, see MW5_MECH_TEXTURING_PIPELINE.md) ships its own clips
// under a completely different naming convention than GAME_CLIP_SUFFIXES
// above was ever built for: `<CHASSIS_PREFIX>_<Acción>_ANI` (e.g.
// `BSW_WalkForward_Straight_ANI`), nothing like the AssetStudio-extracted
// `<chassis>_moveCoreWalkFwd` style. Before this table existed, NONE of a
// chassis's own 80+ real clips ever matched — resolveClipKey silently
// found nothing for every bookkeeping name, and the chassis played
// whatever borrowed/retargeted Atlas clip its fallback path found (or sat
// in bind pose if it had none). Only the bookkeeping names that actually
// have a same-purpose clip on this pipeline today are mapped — a name
// with no entry here just falls through resolveClipKey exactly like it
// already does for a legacy chassis missing that clip, no regression.
// TorsoTwistLeft/Right, Levantarse, Despegar/Aterrizar, Shutdown*,
// Idle2/IdleFlavor2-3, DeathKnockdown/Idle deliberately have no MW5 entry
// here: Bushwacker has no matching clip for any of them. AttackLeftArm/
// RightArm/Torso DO now resolve on this pipeline too, but not via a plain
// 1:1 entry here — see the generated ArmLeft/RightAim* entries just below
// and their own use site (attackSignal's own doc comment) for why a
// directional AIM blend-space needed real target-bearing data, not just a
// name swap.
const MW5_CLIP_SUFFIXES: Record<string, string> = {
  Idle: 'Stand_ANI',
  Walk: 'WalkForward_Straight_ANI',
  Run: 'RunForward_Straight_ANI',
  TurnLeft: 'Stand_Turn_Left_ANI',
  TurnRight: 'Stand_Turn_Right_ANI',
  WalkLimpLeft: 'WalkForward_LeftLimp_ANI',
  WalkLimpRight: 'WalkForward_RightLimp_ANI',
  Caerse: 'Falling_ANI',
  Saltar: 'Jumpjetting_Neutral_ANI',
}

// Real user request: "reacciones a impacto por zona+eje" — generated
// rather than hand-listed, one HitZone<Zone><Axis><Sign> entry per real
// BSW_Hit<Zone>_<Axis><Sign>_ANI clip naming slot. Not every combination
// this generates actually exists on Bushwacker (LeftLeg/RightLeg only
// ship Pitch/Roll, never Yaw — see hitSignal's own use site for why a
// lateral leg hit falls through to the old system) — resolveClipKeyForSuffix
// already treats a suffix with no matching clip as "nothing found," the
// same graceful miss every other optional lookup in this file gets, so a
// combination that doesn't exist on this (or any future) chassis is
// simply never reached, not a bug.
for (const zone of ['Torso', 'Hips', 'LeftLeg', 'RightLeg'] as const) {
  for (const axis of ['Pitch', 'Roll', 'Yaw'] as const) {
    for (const sign of ['Positive', 'Negative'] as const) {
      MW5_CLIP_SUFFIXES[`HitZone${zone}${axis}${sign}`] = `Hit${zone}_${axis}${sign}_ANI`
    }
  }
}

// Real user request: "apuntado direccional por brazo" — generated the
// same way HitZone* above is, one Arm<Left/Right>Aim<Direction> entry per
// real BSW_Arm<Left/Right>_Aim<Direction>_ANI clip naming slot. Known gap:
// the LEFT arm's own AimLeft clip is exported as `BSW_Armleft_AimLeft_ANI`
// (lowercase "l" in "Armleft", unlike every one of its 7 siblings'
// "ArmLeft") — a genuine typo in the source .glb, not this table.
// ArmLeftAimLeft below simply won't resolve because of it (same graceful
// "no match" fallback as everything else here) until that's fixed at the
// source — not worth a bespoke case-insensitive path for one known clip.
for (const arm of ['Left', 'Right'] as const) {
  for (const dir of ['Up', 'Down', 'Left', 'Right', 'UpLeft', 'UpRight', 'DownLeft', 'DownRight'] as const) {
    MW5_CLIP_SUFFIXES[`Arm${arm}Aim${dir}`] = `Arm${arm}_Aim${dir}_ANI`
  }
}
// The "roughly centered, no real bearing offset" case doesn't fit the
// systematic loop above — it's shipped as a differently-worded Montage
// clip (`BSW_LeftArm_AimNeutral_Montage`/`BSW_RightArm_AimNeutral_
// Montage`, word order AND suffix both differ from the 8 directional
// ones), not an `ArmLeft/Right_AimNeutral_ANI` following the same
// pattern — two explicit entries instead of trying to fold it in.
MW5_CLIP_SUFFIXES.ArmLeftAimNeutral = 'LeftArm_AimNeutral_Montage'
MW5_CLIP_SUFFIXES.ArmRightAimNeutral = 'RightArm_AimNeutral_Montage'

function resolveClipKeyForSuffix(
  actions: Record<string, THREE.AnimationAction | null>, suffix: string, chassis?: string | null,
): string | undefined {
  // Real bug found live: several MW5 suffixes above collide with their own
  // first-person twin — `BSW_WalkForward_Straight_ANI` AND
  // `BSW_FP_WalkForward_Straight_ANI` both end with
  // `_WalkForward_Straight_ANI` — without this exclusion, which one wins
  // depends on `Object.keys` iteration order, not intent: third-person
  // could silently end up playing the FP-framed clip. `_FP_` clips are
  // reserved for a dedicated FirstPersonView resolver, never this one.
  const candidates = Object.keys(actions)
    .filter((k) => k.endsWith(`_${suffix}`) && !k.endsWith(RETARGET_SUFFIX) && !k.includes('_FP_'))
  const isBorrowed = (key: string) => {
    const prefix = key.slice(0, key.length - suffix.length - 1).toLowerCase()
    return prefix === KNOWN_BORROWED_CLIP_PREFIX && chassis?.toLowerCase() !== KNOWN_BORROWED_CLIP_PREFIX
  }
  const nonBorrowed = candidates.find((k) => !isBorrowed(k))
  if (nonBorrowed) return nonBorrowed
  const borrowed = candidates.find(isBorrowed)
  if (!borrowed) return undefined
  const retargetedKey = `${borrowed}${RETARGET_SUFFIX}`
  return actions[retargetedKey] ? retargetedKey : undefined
}

function resolveClipKey(
  actions: Record<string, THREE.AnimationAction | null>, appName: string, chassis?: string | null,
): string | undefined {
  if (actions[appName]) return appName
  const legacySuffix = GAME_CLIP_SUFFIXES[appName]
  const legacyMatch = legacySuffix ? resolveClipKeyForSuffix(actions, legacySuffix, chassis) : undefined
  if (legacyMatch) return legacyMatch
  const mw5Suffix = MW5_CLIP_SUFFIXES[appName]
  return mw5Suffix ? resolveClipKeyForSuffix(actions, mw5Suffix, chassis) : undefined
}

function Mech3DModel({
  color, emissive, emissiveIntensity, chassis, model, isMoving, movementType, jumpPhase, fallen, dead,
  tintStrength, onLoaded, onSurfaceClick, instanceRef, playAnimation, onFootstep, severedLocations, onLimbSevered,
  damagedLocations, weapons, shutdown, turning, attackSignal, hitSignal,
}: Mech3DProps) {
  const url = resolveMechModelUrl(chassis, model)
  const { scene, animations: gltfAnimations } = useGLTF(url)
  // Adds a corrected copy of every borrowed atlas_ clip (see
  // buildRetargetedBorrowedClip's own doc comment) alongside the
  // originals — resolveClipKey reaches for `${name}__retargeted` only
  // when nothing chassis-specific exists, so a chassis with its own real
  // library (Hatchetman) is completely unaffected by this running at all.
  // Atlas itself is skipped: its own bind pose IS ATLAS_REST_QUATS, so
  // every correction would already be an identity no-op.
  const animations = useMemo(() => {
    if (chassis?.toLowerCase() === KNOWN_BORROWED_CLIP_PREFIX) return gltfAnimations
    const borrowed = gltfAnimations.filter((c) => c.name.toLowerCase().startsWith(`${KNOWN_BORROWED_CLIP_PREFIX}_`))
    if (borrowed.length === 0) return gltfAnimations
    const chassisRestQuats = getChassisRestQuats(scene)
    return [...gltfAnimations, ...borrowed.map((c) => buildRetargetedBorrowedClip(c, chassisRestQuats))]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltfAnimations, scene])
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

  // See computeWalkGaitCurve's own doc comment (the foot-skating fix) —
  // analyzed once per chassis URL, ever, then cached; every later mount
  // of the same chassis (and every later render of this one) just hits
  // walkGaitCurveCache.has(url) and returns immediately.
  useEffect(() => {
    if (walkGaitCurveCache.has(url)) return
    const walkKey = resolveClipKey(actions, 'Walk', chassis)
    const walkClip = walkKey ? actions[walkKey]?.getClip() : undefined
    walkGaitCurveCache.set(url, walkClip ? computeWalkGaitCurve(scene, walkClip) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, actions])

  // See getMeshDetectedHitPoint's own doc comment — same "once per
  // chassis URL ever" cache population as the walk-gait-curve effect just
  // above, just off a fresh throwaway clone (bind pose, no mixer/actions
  // needed at all) instead of a specific animation clip.
  //
  // computeLocationHitPoints (like computeWeaponMuzzlePoint) always
  // divides its result by MODEL_SCALE, on the assumption its caller
  // handed it a REAL, currently-rendered instance — one whose `.scale`
  // R3F's own `<primitive scale={MODEL_SCALE}>` already set (see
  // normalizeMechInstance's own doc comment on why that scale lives on
  // an outer wrapper distinct from the object R3F touches). This
  // throwaway clone is never mounted, so nothing ever sets that scale —
  // without it, points would come out MODEL_SCALE times too small
  // (found live: an early version of this effect did exactly that).
  // Setting it explicitly here matches the real convention instead.
  useEffect(() => {
    if (meshDetectedHitPointCache.has(url)) return
    const rig = normalizeMechInstance(scene)
    rig.scale.setScalar(MODEL_SCALE)
    meshDetectedHitPointCache.set(url, computeLocationHitPoints(rig))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // See getWeaponMuzzleWorldPoint's own doc comment — same "once per
  // chassis URL ever" population as the hit-point effect just above.
  useEffect(() => {
    if (weaponMountDataCache.has(url)) return
    weaponMountDataCache.set(url, computeWeaponMountData(scene))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

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
  // See measureBakedTwistAngle's own doc comment — how many radians each
  // side's own overlay clip bakes in, so the attack handler below can
  // turn a real target offset into a proportional overlay `weight`
  // instead of always playing it at full weight.
  const bakedTwistAngleRef = useRef<{ left: number | null; right: number | null }>({ left: null, right: null })
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
    const buildTwistOverlay = (
      appName: 'TorsoTwistLeft' | 'TorsoTwistRight',
    ): { overlay: THREE.AnimationAction; bakedAngle: number | null } | null => {
      const idleKey = resolveClipKey(actions, 'Idle', chassis)
      const idleClip = idleKey ? actions[idleKey]?.getClip() : undefined
      const twistKey = resolveClipKey(actions, appName, chassis)
      const twistAction = twistKey ? actions[twistKey] : undefined
      if (!idleClip || !twistAction) return null
      const rawTwistClip = twistAction.getClip()
      const bakedAngle = measureBakedTwistAngle(idleClip, rawTwistClip)
      // .clone() first — makeClipAdditive mutates its target's tracks in
      // place, and this clip's own object is the SAME one shared (via
      // useGLTF's cache) by every OTHER mech instance of this chassis on
      // the board; converting the shared original would corrupt it for
      // all of them.
      const additiveClip = THREE.AnimationUtils.makeClipAdditive(rawTwistClip.clone(), 0, idleClip, 30)
      const overlay = twistAction.getMixer().clipAction(additiveClip)
      overlay.blendMode = THREE.AdditiveAnimationBlendMode
      overlay.setLoop(THREE.LoopOnce, 1)
      overlay.clampWhenFinished = true
      return { overlay, bakedAngle }
    }
    const leftTwist = buildTwistOverlay('TorsoTwistLeft')
    const rightTwist = buildTwistOverlay('TorsoTwistRight')
    twistOverlayActionsRef.current = { left: leftTwist?.overlay ?? null, right: rightTwist?.overlay ?? null }
    bakedTwistAngleRef.current = { left: leftTwist?.bakedAngle ?? null, right: rightTwist?.bakedAngle ?? null }

    const crossFadeTo = (
      name: string | undefined, loop: boolean, timeScale = 1, resolveAs?: string,
    ): THREE.AnimationAction | null => {
      if (!name) return null
      // `resolveAs` lets a caller keep the state machine's own bookkeeping
      // name (e.g. 'Walk', so every `current === 'Walk'`-style chain check
      // elsewhere keeps working unchanged) while actually resolving to a
      // DIFFERENT real clip — see pickWalkClipSuffix's own call site below.
      const resolvedKey = resolveClipKey(actions, resolveAs ?? name, chassis)
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
          // See measureBakedTwistAngle's own doc comment — scale the
          // overlay's own additive weight down to whatever fraction of
          // its full baked swing the real target offset actually needs,
          // instead of always applying it at weight 1 (the old "always
          // ~90°" bug). No fadeIn here (unlike before) — an
          // AnimationAction's fadeIn always ramps toward weight 1
          // specifically, which would fight a smaller target weight;
          // setting `.weight` directly applies it from this frame on,
          // which at these short (150ms-ish) timescales reads the same.
          if (newTwist === 'left') {
            rightOverlay?.stop()
            const bakedAngle = bakedTwistAngleRef.current.left
            leftOverlay?.reset().play()
            if (leftOverlay) {
              leftOverlay.weight = bakedAngle && attack.twistAngle != null
                ? Math.min(1, Math.abs(attack.twistAngle) / bakedAngle)
                : 1
            }
          } else if (newTwist === 'right') {
            leftOverlay?.stop()
            const bakedAngle = bakedTwistAngleRef.current.right
            rightOverlay?.reset().play()
            if (rightOverlay) {
              rightOverlay.weight = bakedAngle && attack.twistAngle != null
                ? Math.min(1, Math.abs(attack.twistAngle) / bakedAngle)
                : 1
            }
          } else {
            leftOverlay?.stop(); rightOverlay?.stop()
          }
        }
        // MW5 pipeline's own directional arm-aim clip — tried FIRST for a
        // LA/RA shot. `twist`'s own left/right verdict is REUSED as the
        // horizontal half (a target "to the mech's own left" is to the
        // left regardless of which arm is firing at it — no per-arm
        // mirroring needed); `aimVertical` is the new vertical half. A
        // torso shot always skips straight to the plain AttackTorso
        // fallback below — no per-torso aim clip exists on this pipeline.
        if (attack.location === 'LA' || attack.location === 'RA') {
          const arm = attack.location === 'LA' ? 'Left' : 'Right'
          const horiz = attack.twist === 'left' ? 'Left' : attack.twist === 'right' ? 'Right' : ''
          const vert = attack.aimVertical === 'up' ? 'Up' : attack.aimVertical === 'down' ? 'Down' : ''
          const dir = `${vert}${horiz}` || 'Neutral'
          if (crossFadeTo(`AttackArm${arm}Aim`, false, 1, `Arm${arm}Aim${dir}`)) return
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
        // MW5 pipeline's own zone+axis hit reaction — tried FIRST. Zone:
        // CT is the mech's own pelvis/core, closer to "Hips" than the
        // upper-body "Torso" bucket LT/RT/HD share; LA/RA have no zone at
        // all (no per-arm hit clip exists on this pipeline), same
        // "nothing to try" as a location this pipeline doesn't cover.
        // Axis: left/right → Yaw, fwd/bwd → Pitch (Roll deliberately
        // unused — see MW5_CLIP_SUFFIXES's own generated HitZone* doc
        // comment). Sign (Positive = fwd/left, Negative = bwd/right) is a
        // documented CONVENTION, not verified against the rendered pose —
        // flip it here if a live hit ever reads backward.
        const zone = hit.location === 'CT' ? 'Hips'
          : hit.location === 'HD' || hit.location === 'LT' || hit.location === 'RT' ? 'Torso'
          : hit.location === 'LL' ? 'LeftLeg'
          : hit.location === 'RL' ? 'RightLeg'
          : null
        const axis = hit.direction === 'left' || hit.direction === 'right' ? 'Yaw' : 'Pitch'
        const sign = hit.direction === 'fwd' || hit.direction === 'left' ? 'Positive' : 'Negative'
        if (zone && crossFadeTo(`HitZone${zone}${axis}${sign}`, false)) return

        const severity = hit.severity === 'heavy' ? 'Heavy' : 'Light'
        const direction = hit.direction === 'bwd' ? 'Bwd' : hit.direction === 'left' ? 'Left' : hit.direction === 'right' ? 'Right' : 'Fwd'
        if (crossFadeTo(`Hit${severity}${direction}`, false)) return
      }

      // Real bug found live (Bushwacker): item 1's own MW5_CLIP_SUFFIXES
      // only maps 'Saltar' (flight) — Bushwacker has no dedicated takeoff/
      // landing clip, only the one neutral jetting pose, so 'Despegar'/
      // 'Aterrizar' silently failed to resolve on their own the whole
      // 0.35s of each phase (jumpFlight.ts's own TAKEOFF_DURATION/
      // LANDING_DURATION) — crossFadeTo no-ops on a miss, so the mech sat
      // frozen on its PRE-jump pose through all of takeoff, popped
      // abruptly into the jetting pose only once 'flight' began, then
      // stayed frozen IN that pose through all of landing instead of
      // settling back to idle/walk. Falling back to the SAME 'Saltar'
      // clip (via resolveAs) for takeoff/landing too — only when this
      // chassis truly has no dedicated Despegar/Aterrizar clip of its own
      // (tried FIRST, unchanged for every old-pipeline chassis that DOES
      // have one) — means the jetting pose fades in immediately at
      // takeoff and holds cleanly through landing instead of both.
      const jump = inputsRef.current.jumpPhase
      if (jump === 'takeoff') {
        if (crossFadeTo('Despegar', false)) return
        crossFadeTo('Despegar', false, 1, 'Saltar')
        return
      }
      if (jump === 'flight') { crossFadeTo('Saltar', true); return }
      if (jump === 'landing') {
        if (crossFadeTo('Aterrizar', false)) return
        crossFadeTo('Aterrizar', false, 1, 'Saltar')
        return
      }

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
    const idleKey = resolveClipKey(actions, 'Idle', chassis)
    const idle = idleKey ? actions[idleKey] : undefined
    const isWounded = (severedLocations?.size ?? 0) > 0 || (damagedLocations?.size ?? 0) > 0
    const flavors = (['Idle2', 'IdleFlavor2', 'IdleFlavor3'] as const)
      .map((name) => { const key = resolveClipKey(actions, name, chassis); return key ? actions[key] : undefined })
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
    // MECH_COLOR_BOOST fallback as before for everything else. This
    // faction-tint effect applies ONE shared value across the whole mesh
    // (unlike useMechPbr's own per-zone application) — the Body zone's
    // own value stands in for that single number, since Body is this
    // effect's dominant, most visually representative surface.
    const colorBoost = savedPbrSettings?.body.colorBoost ?? MECH_COLOR_BOOST
    instance.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mat = obj.material as THREE.MeshStandardMaterial
        // Real user report (Bushwacker weapons rendering pale/white in
        // MechLab's "Anotar armas" tab): resetting to a hardcoded white
        // before lerping toward the tint is harmless for a TEXTURED
        // material (mat.color is a multiplier on top of the map, so
        // white leaves the texture's own colors alone, per this effect's
        // own doc comment above) — but Bushwacker's weapon material has
        // NO base color texture, only a flat baseColorFactor loaded
        // straight into mat.color by GLTFLoader (real data: "Black Metal
        // Color" 0.23074/848484, from Weapon_Clan_MTI.json). For that
        // material mat.color IS the entire visible color, so resetting
        // it to white before tinting throws the real value away outright
        // instead of leaving it alone. Snapshot the material's own
        // as-loaded color once (same pattern as useMechPbr's own
        // __mechPbrBaseColor snapshot above) and always lerp from THAT,
        // never from a hardcoded white.
        const userData = mat.userData as { __factionTintBaseColor?: THREE.Color }
        if (!userData.__factionTintBaseColor) userData.__factionTintBaseColor = mat.color.clone()
        mat.color.copy(userData.__factionTintBaseColor).lerp(tint, tintStrength ?? FACTION_TINT_STRENGTH)
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
