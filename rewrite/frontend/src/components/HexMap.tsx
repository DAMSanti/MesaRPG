import {
  memo, Suspense, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { CuboidCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier'
import { Select } from '@react-three/postprocessing'
import * as THREE from 'three'
import type {
  AttackResult, HexTileData, MapData, Mech, MechAnnotation, Unit,
} from '../api'
import { listMechAnnotations } from '../api'
import { Mech3D } from './Mech3D'
import { TerrainDecor, terrainSinkY } from './TerrainDecor'
import { RoadMarkings } from './RoadMarkings'
import { terrainColor, terrainRotation, terrainTexture } from '../terrain'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import { hexToWorld, mapCenter, worldToHex } from '../hexMath'
import { jumpFlight, type JumpPhase } from '../jumpFlight'
import { DEAD_MECH_CHAR_COLOR, MODEL_CHEST_FRACTION, MODEL_SCALE } from './Mech3D'
import { resolveMechModelUrl } from '../mechAssets'
import { AttackEffect, getGlowTexture, ImpactFlash } from './AttackEffects'

// Real user request: "no es muy largo hacer que las armas disparen de esas
// zonas y los impactos se hagan en esos puntos?" — MechLab's own
// mech_model_annotations only ever get written by that editor; loaded
// once per mounted view (GMView/TableView/FirstPersonView each hold their
// own copy) since they change rarely and this only needs to be "close
// enough," not live-reactive to someone editing MechLab in another tab.
export function useMechAnnotationsCache() {
  const [annotations, setAnnotations] = useState<MechAnnotation[]>([])
  useEffect(() => {
    listMechAnnotations().then(setAnnotations).catch(() => {})
  }, [])
  return annotations
}

/** The local point (Mech3D's own normalized space, pre-MODEL_SCALE — see
 * normalizeMechInstance) an attack should visually originate from/land
 * on for `unit`, real user-annotated data where it exists. `kind`/
 * `location` pick which annotation: 'weapon' + the firing weapon's own
 * location for the attacker, 'hit' + the target's struck location for
 * the target, 'cockpit' for the pilot's own eye point (location is
 * ignored — MechLab only ever saves one cockpit point per model, with
 * `location: null` — real user request: "la posicion que selecciono de
 * 'cabina' es donde tiene que estar la camara en FPV"). `index` picks
 * WHICH of possibly several weapon points at that same location (real
 * user report: two lasers in the same arm both collapsed onto the
 * first-saved point) — MechLab itself has no better source of truth for
 * "which physical weapon is which annotated point" than insertion order
 * (see mech_annotations.py's own save_annotations docstring), so this
 * assumes the attacker's own weapons array is in the same order
 * MechLab's weapon-slot UI was in in when it saved them — true whenever
 * nobody's hand-edited that mech's weapon list out of the order the
 * chassis template originally gave it. Out-of-range clamps to the last
 * real point rather than null, so a mech with fewer annotated points
 * than actual weapons still gets SOME real point instead of falling back
 * to the generic chest guess. null whenever the mech isn't annotated at
 * all (the common case today) or has no point for that location/kind —
 * callers fall back to their own generic guess (MODEL_CHEST_FRACTION for
 * weapons/hits, the old fixed eye-height formula for cockpit) in that
 * case, so an unannotated mech looks exactly like it always has. */
export function findAnnotatedLocalPoint(
  annotations: MechAnnotation[], unit: Unit, kind: 'weapon' | 'hit' | 'cockpit', location: string | null, index = 0,
): [number, number, number] | null {
  if (kind !== 'cockpit' && !location) return null
  const modelUrl = resolveMechModelUrl(unit.mech_chassis, unit.mech_model)
  const matches = annotations.filter(
    (a) => a.model_url === modelUrl && a.kind === kind && (kind === 'cockpit' || a.location === location),
  )
  if (matches.length === 0) return null
  const point = matches[Math.min(index, matches.length - 1)]
  return [point.x, point.y, point.z]
}

/** Rotates a local point (already scaled by MODEL_SCALE) by a world yaw
 * in radians, same convention UnitMarker's own facingRotationY/animatedRot
 * use (0 rad = world +X … Math.PI/2 - facing_deg*π/180 for a static
 * facing) — the offset to add on top of hexToWorld(q, r) and
 * groundYAt(q, r) to place it correctly in the world. Split out from
 * rotateLocalOffset below so a caller already tracking its own live yaw
 * (FirstPersonView's WalkingFirstPersonCam, mid-turn) doesn't have to
 * round-trip it back through degrees every frame. */
export function rotateLocalOffsetByYaw(local: [number, number, number], yawRadians: number) {
  const vec = new THREE.Vector3(local[0] * MODEL_SCALE, local[1] * MODEL_SCALE, local[2] * MODEL_SCALE)
  vec.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawRadians)
  return vec
}

/** Rotates a local point by a unit's own static facing_deg — see
 * rotateLocalOffsetByYaw above for the actual math and the live-yaw
 * variant. */
function rotateLocalOffset(local: [number, number, number], facingDeg: number) {
  return rotateLocalOffsetByYaw(local, Math.PI / 2 - (facingDeg * Math.PI) / 180)
}

// FIXED, not a floor that yields to a taller natural elevation — two
// earlier versions of this (elevation 2's own 0.74, then elevation
// 0.5's 0.41) both still let the tile's own `elevation` data drive the
// platform's height, and mapgen.py/MapEditorView's 'Edificio' palette
// entry both default that to 2 — so in the common case the "floor" was
// never actually the limiting factor, the elevation value was, and the
// platform kept reading as a tall pedestal every real building model
// sat on top of instead of a sidewalk (real user report, twice, with
// screenshots — most recently blunt enough that a third guess wasn't
// worth risking). A real sidewalk doesn't get taller because a
// building's LOS-blocking elevation happens to be high — that height
// already reads from the real, now-dramatically-tall building model
// standing on it, not from the ground it stands on. Flush with plain
// ground level (elevation 0's own 0.3) settles it for good, unconditionally.
export const BUILDING_MIN_HEIGHT = 0.3

/** One weapon's worth of attack VFX to play right now, in hex
 * coordinates — HexMap resolves these to real world positions itself
 * (same elevation formula UnitMarker/FirstPersonView already use) so
 * callers don't need to duplicate that math. `id` must change for every
 * new shot (e.g. a counter or `${roll}-${Date.now()}`) so React mounts
 * a fresh AttackEffect instead of reusing one whose animation already
 * finished. */
export interface ActiveAttackVfx {
  id: string
  attackerQ: number
  attackerR: number
  targetQ: number
  targetR: number
  weaponName: string
  hit: boolean
  /** Real user request: "no es muy largo hacer que las armas disparen de
   * esas zonas y los impactos se hagan en esos puntos?" — the attacker's
   * own weapon-mount point (kind='weapon') and the target's own
   * struck-location point (kind='hit'), both from MechLab's real
   * annotations, already rotated by each unit's own facing_deg into a
   * world-space OFFSET (not yet added to hexToWorld/groundYAt — the
   * consumer still owns that, same as the plain hex-coordinate fields
   * above). null on either one falls back to the old MODEL_CHEST_FRACTION
   * guess for THAT side specifically. */
  attackerOffset: THREE.Vector3 | null
  targetOffset: THREE.Vector3 | null
}

/** Turns a raw `lastAttack` broadcast into a QUEUED sequence of
 * ActiveAttackVfx, one full animation at a time — GMView/TableView/
 * FirstPersonView each used to hold this in a single `useState` that a
 * new `lastAttack` immediately overwrote, which remounts HexMap's
 * `AttackEffect` (its `key` changes) and kills whatever animation was
 * still mid-flight. A real user report caught this directly: "si un
 * laser se dispara antes de que los misiles lleguen al objetivo, parece
 * que estos desaparecen" — a laser resolves near-instantly (~420ms)
 * while a missile volley can still be arcing toward its target
 * (~1.3-2s) when the next attack_result broadcast arrives; overwriting
 * cut the missile's flight off mid-air. Now a new attack only starts
 * playing immediately if nothing is currently animating; otherwise it
 * queues and `onAttackEffectDone` (AttackEffect's own finish callback)
 * advances to the next one — every attack's full VFX plays out in
 * server-resolution order instead of the newest one clobbering
 * whatever came before it. */
export function useAttackVfxQueue(lastAttack: AttackResult | null | undefined, units: Unit[], mechs: Mech[]) {
  const seq = useRef(0)
  const queueRef = useRef<ActiveAttackVfx[]>([])
  const activeRef = useRef<ActiveAttackVfx | null>(null)
  const [activeAttack, setActiveAttackState] = useState<ActiveAttackVfx | null>(null)
  const annotations = useMechAnnotationsCache()

  const setActive = (vfx: ActiveAttackVfx | null) => {
    activeRef.current = vfx
    setActiveAttackState(vfx)
  }

  // Real user report: FirstPersonView remounts this hook fresh every time
  // it's reopened, but `lastAttack` itself is a parent-held prop that
  // just keeps holding whatever the most recent attack WAS — with no
  // guard, this effect's dependency-array still fires once on that fresh
  // mount (React always runs a new effect instance on mount, changed or
  // not) and replays a stale attack's VFX. seenRef captures whatever
  // `lastAttack` already was the moment this hook was created, so the
  // mount-time run is treated as "already known," not new; only a
  // genuinely different object arriving afterward counts as new.
  const seenRef = useRef(lastAttack)
  useEffect(() => {
    if (lastAttack === seenRef.current) return
    seenRef.current = lastAttack
    if (!lastAttack || lastAttack.attacker_unit_id == null || lastAttack.target_unit_id == null) return
    const attackerUnit = units.find((u) => u.id === lastAttack.attacker_unit_id)
    const targetUnit = units.find((u) => u.id === lastAttack.target_unit_id)
    if (!attackerUnit || !targetUnit) return
    seq.current += 1

    // Which LOCATION the firing weapon actually mounts at, AND which of
    // possibly several weapons at that same location it is — match by
    // weapon_id (a specific instance), not weapon_name (real user report:
    // two lasers in the same arm both fired from the same visual point,
    // because matching by name alone can't tell identical weapons apart).
    // The index is this weapon's own position among same-location
    // weapons in the attacker's OWN weapons array — see
    // findAnnotatedLocalPoint's own doc comment for why that's assumed to
    // line up with MechLab's own insertion order.
    const attackerMech = mechs.find((m) => m.id === attackerUnit.mech_id)
    const firingWeapon = attackerMech?.weapons.find((w) => w.id === lastAttack.weapon_id) ?? null
    const weaponLocation = firingWeapon?.location ?? null
    const weaponIndexAtLocation = firingWeapon && attackerMech
      ? attackerMech.weapons.filter((w) => w.location === weaponLocation).findIndex((w) => w.id === firingWeapon.id)
      : 0
    const attackerLocal = findAnnotatedLocalPoint(
      annotations, attackerUnit, 'weapon', weaponLocation, Math.max(0, weaponIndexAtLocation),
    )
    const targetLocal = findAnnotatedLocalPoint(annotations, targetUnit, 'hit', lastAttack.location)

    const vfx: ActiveAttackVfx = {
      id: `${seq.current}`,
      attackerQ: attackerUnit.q,
      attackerR: attackerUnit.r,
      targetQ: targetUnit.q,
      targetR: targetUnit.r,
      weaponName: lastAttack.weapon_name ?? '',
      hit: lastAttack.hit,
      attackerOffset: attackerLocal ? rotateLocalOffset(attackerLocal, attackerUnit.facing_deg) : null,
      targetOffset: targetLocal ? rotateLocalOffset(targetLocal, targetUnit.facing_deg) : null,
    }
    if (activeRef.current === null) {
      setActive(vfx)
    } else {
      queueRef.current.push(vfx)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttack])

  // Resolvers waiting on waitForDrain below — settled the instant the
  // queue AND the currently-playing shot both go empty, whichever of
  // onAttackEffectDone's calls happens to be the one that empties them.
  const drainResolversRef = useRef<(() => void)[]>([])

  const onAttackEffectDone = () => {
    const next = queueRef.current.shift() ?? null
    setActive(next)
    if (next === null) {
      drainResolversRef.current.forEach((resolve) => resolve())
      drainResolversRef.current = []
    }
  }

  // Real user request: "el turno de ataque debe durar hasta que TODAS las
  // animaciones de ataque terminen" — a volley firing several weapons
  // resolves them all server-side in one go (or one physical-dice pause
  // per shot), well before this queue has finished actually PLAYING each
  // one's VFX in order. Callers await this right before whatever closes
  // the turn (mark_acted) instead of doing so the instant the last HTTP
  // response/broadcast lands.
  const waitForDrain = () => new Promise<void>((resolve) => {
    if (activeRef.current === null && queueRef.current.length === 0) {
      resolve()
      return
    }
    drainResolversRef.current.push(resolve)
  })

  return { activeAttack, onAttackEffectDone, waitForDrain }
}

// World units per second a unit visually walks between hexes at — hex
// center-to-center spacing is √3 (hexMath.ts's hexToWorld). Real user
// report: "el movimiento de los mechs ahora mismo es MUUUUY rapido" —
// cut to well under half its old value (was 3.5, ~one hex every 0.5s)
// so a multi-hex path actually reads as a mech stepping across the
// board instead of a blur.
export const WALK_SPEED = 1.4
// Below this distance (world units) a move is considered "arrived" —
// small enough to be visually indistinguishable from exact, avoids the
// interpolation asymptotically crawling the last fraction of a unit
// forever.
export const ARRIVE_EPSILON = 0.01
// Radians/sec the mech's model turns at while walking a real path — a
// mech pivots to face each leg of its route before advancing along it,
// not just at the destination, so a dogleg path visibly reads as a turn
// then a step rather than a diagonal slide.
export const TURN_SPEED = Math.PI * 2.2
// A turn bigger than this (radians) before the first leg of a fresh walk
// counts as "basically turning in place" for fog-reveal purposes — see
// UnitMarker's/WalkingFirstPersonCam's own firstStepFiredEarlyRef.
export const BIG_TURN_THRESHOLD = Math.PI / 2

/** Shortest signed angular difference from `from` to `to` (radians), in
 * (-π, π] — e.g. 350°→10° comes out as +20°, not -340°. The delta
 * lerpAngle below steps by; also exported standalone so a caller can ask
 * "how much turn would this be" without actually stepping toward it (see
 * UnitMarker's/WalkingFirstPersonCam's own big-turn fog-reveal check). */
export function angleDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2
  return ((to - from + Math.PI) % twoPi + twoPi) % twoPi - Math.PI
}

/** Shortest-path interpolation between two angles (radians), so turning
 * from e.g. 350° to 10° goes the short way through 0° instead of the
 * long way around through 180°. Exported — FirstPersonView's own walking
 * camera (real user request: "el movimiento paso a paso... tambien en
 * FPV") reuses this same turn math so the cockpit's own view of the
 * world turns at the same rate everyone else sees the mech's body turn. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t
}

/** Pure-Y-axis angle -> quaternion, for Rapier's setNextKinematicRotation
 * (a {x,y,z,w} Rotation, not the [x,y,z] Euler triple Three.js props
 * take) — standard axis-angle-to-quaternion for a single axis. */
function quaternionFromY(angle: number): { x: number; y: number; z: number; w: number } {
  const half = angle / 2
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
}

// React.memo with a custom comparator — plain shallow-equal memo
// wouldn't help here since onPointerMove/onPointerUp are fresh closures
// every render (they capture this tile's own q/r), so a default
// comparator would still see "different props" on every parent render
// and re-render anyway. Those two are deliberately excluded from the
// comparison: they always do the same thing for the same tile identity,
// so their closure identity churning is irrelevant to whether Tile's
// own OUTPUT needs to change.
function tilePropsEqual(prev: Readonly<TileProps>, next: Readonly<TileProps>) {
  return prev.tile === next.tile
    && prev.lookup === next.lookup
    && prev.losHighlighted === next.losHighlighted
    && prev.dragHighlighted === next.dragHighlighted
    && prev.needsInitiativeHighlighted === next.needsInitiativeHighlighted
    && prev.activeMoverHighlighted === next.activeMoverHighlighted
    && prev.moveHighlighted === next.moveHighlighted
    && prev.pathPreviewHighlighted === next.pathPreviewHighlighted
    && prev.targetableHighlighted === next.targetableHighlighted
    && prev.physics === next.physics
    && prev.fogged === next.fogged
}

type TileProps = {
  tile: HexTileData
  lookup: Map<string, HexTileData>
  losHighlighted: boolean
  dragHighlighted: boolean
  /** A unit standing on this tile has a pilot who hasn't rolled
   * initiative yet this round (manual per-pilot rolling, individual mode
   * only) — a full-hex translucent red wash, same technique as the LoS
   * debug overlay, sized to the actual tile instead of a small ring
   * around the unit marker. */
  needsInitiativeHighlighted: boolean
  /** The unit standing here is whoever's turn it is to move right now
   * (rounds.ts's activeMoverPilotId) — amber wash, same technique, so
   * "who do I move next" reads at a glance on both the shared table and
   * the GM's own map instead of only being visible in a side panel. */
  activeMoverHighlighted: boolean
  /** This hex is within the current mover's reachable range this
   * movement phase (app/systems/battletech/movement.py) — blue wash,
   * same LosDebugOverlay technique. Clicking it is handled by the
   * caller's own onTileClick, same as every other tile click. */
  moveHighlighted: boolean
  /** This hex is one of the exact steps of the route the mover is about
   * to take — populated once a specific destination has been picked
   * (real user request: "quiero un overlay sobre el path exacto que
   * debería seguir", so the chosen route reads clearly on the board
   * instead of only being implied by the reachable-range wash). Distinct
   * bright-white wash, drawn on top of moveHighlighted so it stays
   * readable even where the two overlap; cleared the instant the move is
   * confirmed or cancelled (both close out the same pendingFacing/
   * equivalent state this is derived from, no separate cleanup needed). */
  pathPreviewHighlighted: boolean
  /** The unit standing here is a valid target for the attack currently
   * being declared — populated once the attacker is picked (GMView's
   * pickingTargetFor), filtered client-side against real weapon range
   * (ranged phase) or adjacency (melee phase) using the same
   * visible-enemies data FirstPersonView already fetches. Danger-red
   * wash, same LosDebugOverlay technique — distinct from moveHighlighted
   * (blue) and activeMoverHighlighted (amber) so the three never read as
   * the same kind of hex. */
  targetableHighlighted: boolean
  /** This tile is currently under the merged fog-of-war volume (HexMap's
   * own teamVisibleHexes computation, see buildFogRegions) — real user
   * request: "que no se muestren las
   * decoraciones de tile que esten cubiertas por niebla". Terrain/groove
   * still render underneath (fog needs real ground to sit on, and
   * TableView's physics collider shouldn't disappear just because a tile
   * is unseen), only TerrainDecor's trees/buildings/rubble skip —
   * doubles as a perf win, since decor is real (sometimes tens of
   * thousands of triangles) GLTF geometry that a hidden tile has no
   * reason to pay for. */
  fogged?: boolean
  /** Give this tile a real physics collider matching its own hex/height
   * (TableView only, for the initiative dice to land and roll across
   * the actual board instead of a flat invisible floor) — must only be
   * true when HexMap is rendered inside a <Physics> provider, so GMView/
   * MapEditorView's plain (non-physics) Canvas never sets this. */
  physics?: boolean
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
}

const Tile = memo(function Tile({
  tile, lookup, losHighlighted, dragHighlighted, needsInitiativeHighlighted, activeMoverHighlighted, moveHighlighted,
  pathPreviewHighlighted, targetableHighlighted, physics, fogged,
  onPointerMove, onPointerUp,
}: TileProps) {
  const [x, z] = hexToWorld(tile.q, tile.r)
  // Building tiles render their own ground platform at a FIXED height —
  // see BUILDING_MIN_HEIGHT's own comment for why this doesn't read
  // tile.elevation at all, unlike every other terrain. Elevation still
  // does its normal job for LOS/movement rules (untouched here, purely
  // a render decision); the building model standing on this platform is
  // what visually carries "this is tall/blocks sightlines" now.
  const height = tile.terrain === 'building' ? BUILDING_MIN_HEIGHT : 0.3 + tile.elevation * 0.22
  // Terrain cylinders are drawn at 0.95 of the true hex spacing (radius
  // 1.0), leaving a small gap at every seam — harmless against a flat
  // background color, but a visible sliver of raw wood table once
  // TableBackground gave that gap something to show through. This sits
  // just under every tile at the FULL 1.0 radius, so neighboring tiles'
  // own undersized tops leave only a thin ring of it showing — a
  // continuous grid of grooves across the whole board, like the tiles
  // are inset into it, instead of an empty seam.
  const groove = (
    <mesh position={[0, -0.03, 0]} receiveShadow>
      <cylinderGeometry args={[1, 1, 0.04, 6]} />
      <meshStandardMaterial color="#241a10" roughness={0.9} />
    </mesh>
  )
  const terrainMesh = (
    <mesh
      position={[0, height / 2, 0]}
      rotation={[0, terrainRotation(tile.terrain, tile.q, tile.r), 0]}
      receiveShadow
      castShadow
      onPointerMove={onPointerMove}
      onPointerUp={(e) => {
        e.stopPropagation()
        onPointerUp?.(e)
      }}
    >
      <cylinderGeometry args={[0.95, 0.95, height, 6]} />
      <meshStandardMaterial
        color={terrainColor(tile.terrain, tile.q, tile.r)}
        map={terrainTexture(tile.terrain, tile.q, tile.r)}
      />
    </mesh>
  )
  return (
    <group position={[x, 0, z]}>
      {groove}
      {physics ? <RigidBody type="fixed" colliders="hull">{terrainMesh}</RigidBody> : terrainMesh}
      {tile.terrain === 'road' && !fogged && (
        <RoadMarkings q={tile.q} r={tile.r} height={height} lookup={lookup} gridType="hex" worldPos={hexToWorld} />
      )}
      {/* forest/light_forest/building stay OUT of this tile's own hull-
          collider set — a hull built from TerrainDecor's real .glb
          trees/buildings (tens of thousands to a few hundred thousand
          triangles each) was tried and was a real cost, on top of the
          geometry's own render cost. TerrainDecor now brings its OWN
          cheap approximate colliders instead (a plain cylinder for a
          tree trunk, a plain box for a building footprint — real user
          report: dice used to pass straight through both) — solid
          enough for dice to bounce off without hulling the actual
          model. The flat ground plane above still gets a (cheap,
          hex-shaped) collider for every tile regardless, so dice always
          land on the table correctly either way. */}
      {!fogged && <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} physics={physics} />}
      {losHighlighted && <LosDebugOverlay height={height} color="#39ff8f" />}
      {dragHighlighted && <LosDebugOverlay height={height} color="#f5c542" y={height + 0.03} />}
      {needsInitiativeHighlighted && <LosDebugOverlay height={height} color="#ff3b3b" opacity={0.45} y={height + 0.04} />}
      {activeMoverHighlighted && <LosDebugOverlay height={height} color="#ffb020" opacity={0.5} y={height + 0.05} />}
      {/* Real user request: from FirstPersonView's near-ground eye-level
          camera, the old +0.12 gap read as visibly floating above the
          hex — a small perspective effect a top-down camera never
          revealed. Halving the whole stack (still staggered, just
          tighter) keeps every highlight type distinguishable without
          the floating look, in both this and GMView's own top-down use. */}
      {moveHighlighted && <LosDebugOverlay height={height} color="#4a9eff" opacity={0.4} y={height + 0.06} />}
      {pathPreviewHighlighted && <LosDebugOverlay height={height} color="#ffffff" opacity={0.55} y={height + 0.065} />}
      {targetableHighlighted && <LosDebugOverlay height={height} color="#e35d5d" opacity={0.45} y={height + 0.07} />}
    </group>
  )
}, tilePropsEqual)

// Debug-only stand-in for VISION.md §4.2's real per-player vision-cone
// fog (still unbuilt) — a flat translucent hex over every tile a chosen
// unit currently has LoS to, so "does this mech see anything" is at least
// answerable by eye today instead of invisible until the real feature
// lands. See useUnitLosDebug in TableView.tsx.
//
// Uses cylinderGeometry, same as the tile mesh above, not circleGeometry —
// circleGeometry's hexagon starts its first vertex along +X (cos/sin), while
// cylinderGeometry's radial cross-section starts along +Z (sin/cos), a 90°
// mismatch between the two geometry types' own conventions. Mixing them
// made this overlay visibly rotated relative to the tile it's sitting on.
function LosDebugOverlay({
  height, color, y = height + 0.03, opacity = 0.32,
}: { height: number; color: string; y?: number; opacity?: number }) {
  return (
    <mesh position={[0, y, 0]}>
      <cylinderGeometry args={[0.92, 0.92, 0.02, 6]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  )
}

// Distinct body-part vent points (local, pre-MODEL_SCALE units — same
// 0..1-tall convention Mech3D normalizes every model to) — real user
// follow-up: "que salgan de distintas partes del mech, 3 o 4", the
// original single-point-with-tiny-jitter version read as one vague haze
// instead of a mech actually venting from several spots.
const STEAM_ORIGINS: [number, number, number][] = [
  [-0.28, 0.78, 0.05], // left shoulder
  [0.28, 0.78, 0.05], // right shoulder
  [0, 0.95, -0.12], // head/back
  [0, 0.55, 0.18], // chest/front
]

/** A handful of soft puffs drifting straight up off a mech and fading
 * out, looping continuously — real user request: "los mechs en esta
 * fase desprenderán vapor en todas las vistas de mapa" for any mech
 * at/above the Heat Scale's first real threshold (5 — see movement.py's
 * _HEAT_MP_PENALTY_BRACKETS, the first bracket that isn't 0), and
 * separately "un mech sobrecalentado suelta pufs de vapor
 * constantemente" for a shutdown one regardless of phase (see this
 * component's own caller in UnitMarker). Real user follow-up: the
 * original version was "demasiado sutil" (a single origin point, faint
 * opacity) — now guarantees at least 3 puffs cycling through
 * STEAM_ORIGINS' distinct vent points, at noticeably higher opacity.
 * Reuses AttackEffects' baked glow texture but with plain alpha blending
 * (not additive) so overlapping puffs read as smoke/vapor instead of
 * brightening toward white-hot like a muzzle flash. */
function SteamPuffs({ heat }: { heat: number }) {
  const count = Math.min(6, Math.max(3, 2 + Math.floor(heat / 8)))
  const particles = useMemo(
    () => Array.from({ length: count }, (_, i) => {
      const [ox, oy, oz] = STEAM_ORIGINS[i % STEAM_ORIGINS.length]
      return {
        seed: Math.random() * 10,
        xOff: ox * MODEL_SCALE + (Math.random() - 0.5) * 0.08,
        yBase: oy * MODEL_SCALE,
        zOff: oz * MODEL_SCALE + (Math.random() - 0.5) * 0.08,
        size: 0.4 + Math.random() * 0.3,
      }
    }),
    [count],
  )
  return (
    <>
      {particles.map((p, i) => <SteamPuff key={i} {...p} />)}
    </>
  )
}

function SteamPuff({
  seed, xOff, yBase, zOff, size,
}: { seed: number; xOff: number; yBase: number; zOff: number; size: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const cycleSeconds = 2.2
  useFrame((state) => {
    const t = ((state.clock.elapsedTime + seed) % cycleSeconds) / cycleSeconds
    if (!ref.current) return
    ref.current.position.set(xOff, yBase + t * 0.9, zOff)
    ref.current.quaternion.copy(state.camera.quaternion)
    const mat = ref.current.material as THREE.MeshBasicMaterial
    mat.opacity = 0.7 * Math.sin(t * Math.PI)
    const s = size * (0.6 + t * 0.6)
    ref.current.scale.set(s, s, s)
  })
  return (
    <mesh ref={ref}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={getGlowTexture()} color="#d8dde0" transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

// One-shot explosion VFX for a mech's own destroyed_reason turning
// 'structural' (Fase D — real user request: replace the old picture-in-
// picture KillReplay inset, which played nowhere near the mech's actual
// board position, with something anchored in place and visible in every
// view, not just TableView's own inset). Mounts exactly once (its parent
// JSX conditional stays true forever once a mech is destroyed, so this
// never remounts/replays) — a bright flash + an outward burst of fire
// sprites, done animating within ~1.2s, after which it just sits there
// rendering nothing (still mounted, near-zero further cost) while the
// mech itself keeps rendering as a static charred wreck (see UnitMarker's
// own glowEmissive/color).
function MechExplosionOnce({ position }: { position: [number, number, number] }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDone(true), 1300)
    return () => clearTimeout(t)
  }, [])
  const debris = useMemo(
    () => Array.from({ length: 12 }, () => ({
      dir: new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.4, (Math.random() - 0.5) * 2).normalize(),
      speed: 0.6 + Math.random() * 0.8,
      size: 0.3 + Math.random() * 0.35,
      delay: Math.random() * 0.15,
    })),
    [],
  )
  if (done) return null
  return (
    <group position={position}>
      <ImpactFlash position={new THREE.Vector3(0, 0, 0)} color="#ffcf6b" />
      {debris.map((d, i) => <ExplosionDebris key={i} {...d} />)}
    </group>
  )
}

function ExplosionDebris({
  dir, speed, size, delay,
}: { dir: THREE.Vector3; speed: number; size: number; delay: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const start = useRef<number | null>(null)
  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsed = state.clock.elapsedTime - start.current - delay
    if (elapsed < 0 || !ref.current) {
      if (ref.current) ref.current.visible = false
      return
    }
    const duration = 1.0
    const t = Math.min(1, elapsed / duration)
    ref.current.visible = true
    ref.current.position.copy(dir).multiplyScalar(speed * t)
    ref.current.quaternion.copy(state.camera.quaternion)
    const mat = ref.current.material as THREE.MeshBasicMaterial
    mat.opacity = 1 - t
    const s = size * (1 - t * 0.4)
    ref.current.scale.set(s, s, s)
  })
  return (
    <mesh ref={ref}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={getGlowTexture()} color="#ff7a2a" transparent opacity={1}
        blending={THREE.AdditiveBlending} depthWrite={false}
      />
    </mesh>
  )
}

// Same rationale as tilePropsEqual above: onPointerDown/onPointerUp are
// fresh closures every render, deliberately excluded here too.
// worldOffset/dragPosition are freshly-literal tuples at the call site
// (`worldOffset={[centerX, centerZ]}`), so they need value comparison,
// not reference — a plain shallow memo would never match on those and
// silently defeat itself.
function unitMarkerPropsEqual(prev: Readonly<UnitMarkerProps>, next: Readonly<UnitMarkerProps>) {
  return prev.unit === next.unit
    && prev.elevation === next.elevation
    && prev.terrain === next.terrain
    && prev.physics === next.physics
    && prev.walkPath === next.walkPath
    && prev.movementType === next.movementType
    && prev.heightAt === next.heightAt
    && prev.outlined === next.outlined
    && prev.heat === next.heat
    && prev.prone === next.prone
    && prev.shutdown === next.shutdown
    && prev.destroyedReason === next.destroyedReason
    && prev.worldOffset[0] === next.worldOffset[0] && prev.worldOffset[1] === next.worldOffset[1]
    && (prev.dragPosition === next.dragPosition
      || (prev.dragPosition != null && next.dragPosition != null
        && prev.dragPosition[0] === next.dragPosition[0] && prev.dragPosition[1] === next.dragPosition[1]))
}

type UnitMarkerProps = {
  unit: Unit
  elevation: number
  /** The terrain of the tile this unit is currently standing on — only
   * consulted to sink a unit's resting height into water/mud (terrainSinkY),
   * so a mech visibly wades/sinks instead of standing on an invisible
   * floor at the dry-land elevation height while the surface covers its
   * ankles. */
  terrain: string
  /** While this unit is the one being dragged, its local x/z follows the
   * pointer continuously (see HexMap's dragWorldPos) instead of snapping
   * to its stored q/r — "se mueve con el ratón" instead of only updating
   * on hex-crossing. Final drop position still snaps to a hex (resolveAt
   * uses the discrete tile under the cursor, not this raw position). Also
   * lifts the model slightly, like picking a miniature up off the table,
   * so it's visually unambiguous which unit is airborne mid-drag. */
  dragPosition?: [number, number]
  /** Same physics-collider opt-in as Tile above, so the initiative dice
   * also bounce off the mech models actually standing on the board, not
   * just the terrain. TableView only — see Tile's doc comment. */
  physics?: boolean
  /** HexMap's own [centerX, centerZ] (mapCenter(map.tiles)) — every
   * child here (this one included) sits under a <group position={[
   * -centerX, 0, -centerZ]}>, so a q/r-derived position is in that
   * group's LOCAL space, not world space. Three.js composes local ->
   * world through the scene graph automatically, so this never
   * mattered before — but Rapier's kinematic API (setNextKinematic
   * Translation/Rotation, used below for physics-tracked units) sets
   * the body's position directly in WORLD space, bypassing that
   * composition entirely. Skipping this conversion there silently
   * shifted every physics-tracked mech by (centerX, centerZ) — visible
   * as units sitting on the wrong tile despite unit.q/r (and every
   * non-physics view) being correct. */
  worldOffset: [number, number]
  /** The real hex-by-hex route for the move currently in flight
   * (movement.py's ReachableHex.path, threaded down from HexMap's own
   * walkPaths prop) — origin excluded, destination included, in travel
   * order. Undefined/omitted means "no route data for this move" (a
   * free-form drag/place), which falls back to a direct line at
   * `target`, identical to this component's behavior before walkPath
   * existed. */
  walkPath?: { q: number; r: number }[]
  /** Which chain of clips this walk actually plays (real user request:
   * proper Walk/Run/Jump animations, not the same Idle/Walk crossfade for
   * every move) — threaded down from HexMap's own walkMovementTypes prop,
   * itself populated straight off unit_walked's own movement_type.
   * Undefined/omitted (no route data for this move, same case walkPath's
   * own doc comment describes) defaults to 'walk'. */
  movementType?: 'walk' | 'run' | 'jump'
  /** Resolves any hex's own resting height (HexMap's own heightAt) — used
   * to look up each intermediate walkPath waypoint's elevation so the
   * mech's Y can interpolate through the path leg by leg instead of
   * snapping straight to the destination's height. */
  heightAt: (q: number, r: number) => number
  /** Claims this unit's mesh for the caller's own <Selection>'s <Outline>
   * effect (real-time edge-detected silhouette outline — FirstPersonView's
   * detected enemies, HexMap's own outlineUnitIds prop resolved per-unit
   * here). A no-op everywhere else (Select gracefully ignores having no
   * <Selection> ancestor), so this is always safe to set. */
  outlined?: boolean
  /** This unit's mech.heat_current, if known — real user request: "los
   * mechs en esta fase desprenderán vapor en todas las vistas de mapa".
   * Undefined (caller has no heat data handy) or below the Heat Scale's
   * first real threshold (5) both just render nothing. */
  heat?: number
  /** mechs.is_prone — psr.py's apply_fall marks this on a failed PSR.
   * Tilts the model over instead of standing it upright (level of detail
   * deliberately kept simple, per the approved plan: "nivel de detalle
   * a decidir en implementación, no bloqueante"). */
  prone?: boolean
  /** mechs.is_shutdown — turns.py's resolve_heat_phase / a destroyed
   * gyro. Darkens the model's faction tint AND adds an orange overheat
   * glow (real user request: "deberían tener una apariencia obvia de
   * sobrecalentamiento... asi naranja [como los muertos]" — reusing the
   * same emissive language destroyedReason='structural' already uses,
   * just softer, so a shutdown mech reads as "dangerously hot" without
   * being confused for an actual wreck). */
  shutdown?: boolean
  /** mechs.destroyed_reason (Fase D) — a real, permanent kill, distinct
   * from is_shutdown/is_prone (both recoverable). BOTH reasons tilt the
   * model onto the ground the same way a failed-PSR prone does (real
   * user request: "los mechs muertos caen al suelo como si estuviesen en
   * prone"). 'structural' additionally plays a one-shot explosion the
   * instant it's first observed and leaves a permanently charred/glowing
   * wreck tint; 'pilot_killed' just darkens the faction tint further,
   * no explosion — see this component's own render body for exactly how
   * each looks. null/undefined = still standing. */
  destroyedReason?: 'structural' | 'pilot_killed' | null
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
  /** Fires once this unit finishes walking a real leg of movement (the
   * queue-driven branch of stepToward below reaching its end, not the
   * drag-interrupt branch) — see HexMap's own onUnitWalkDone doc comment
   * for what this drives (the movement phase's turn now holds on the
   * animation, not just the server's moved_pilot_ids). Deliberately left
   * out of unitMarkerPropsEqual, same as onPointerDown/onPointerUp above —
   * a fresh closure every render is fine since it's never compared. */
  onWalkDone?: () => void
  /** Fires each time this unit's walk animation ARRIVES at one waypoint
   * of a real path (before advancing to the next) — real user request:
   * "la niebla se tiene que ir disipando con cada movimiento... cada
   * paso del mech tiene que actualizar la niebla, tanto en TableView
   * como en FPV. Ahora mismo calcula la de la posicion final nada mas
   * empezar el movimiento". `index` is this waypoint's 0-based position
   * in the ORIGINAL walkPath array, letting the caller look up the
   * matching fog_steps/cockpit_fog_steps entry from the same
   * unit_walked broadcast walkPath itself came from. Same
   * unitMarkerPropsEqual exclusion as onWalkDone above. */
  onWalkStep?: (index: number) => void
}

const UnitMarker = memo(function UnitMarker({
  unit, elevation, terrain, dragPosition, physics, worldOffset, walkPath, movementType, heightAt, outlined, heat,
  prone, shutdown, destroyedReason,
  onPointerDown, onPointerUp, onWalkDone, onWalkStep,
}: UnitMarkerProps) {
  const target = dragPosition ?? hexToWorld(unit.q, unit.r)
  // 'building' matches Tile's own fixed platform height (BUILDING_MIN_
  // HEIGHT), not the elevation formula every other terrain uses here —
  // a mech standing on a building tile needs to rest on the SAME
  // surface height that tile actually renders at, or it visibly floats
  // above (a real elevation-2 building tile's platform sits at 0.3 now,
  // not 0.3+2*0.22).
  const restY = terrainSinkY(terrain) ?? (terrain === 'building' ? BUILDING_MIN_HEIGHT : 0.3 + elevation * 0.22)
  const baseY = restY + (dragPosition ? 0.5 : 0)
  // Forces one extra render once this marker's own Mech3D mesh actually
  // exists — see Mech3D's own onLoaded doc comment for the <Select>
  // outline race this closes (real user report: FPV's red enemy outline
  // sometimes didn't show until "algo lo actualiza más adelante").
  const [, forceMeshRegistered] = useState(0)
  // Ghosts stay red regardless of faction — before reveal, "hidden threat"
  // is the point, not who it turns out to be.
  const baseColor = unit.is_ghost
    ? '#e35d5d'
    : unit.pilot_faction != null
      ? FACTION_COLORS[unit.pilot_faction]
      : NEUTRAL_UNIT_COLOR
  // A destroyed mech's own charred-wreck color — real user follow-up,
  // twice now: "cambia el color de los putos muertos", a DEAD mech (both
  // reasons — a real kill is a real kill regardless of which one) must
  // read as black/dark grey, period, not orange. Reused for shutdown too
  // (real user request: "los mechs sobrecalentados deberían tener el
  // color de los muertos pero con menos opacidad"), just lerped back
  // toward the faction color instead of applied at full strength. Shared
  // with MechLabView's own broken-limb pieces via Mech3D's exported
  // DEAD_MECH_CHAR_COLOR — one source of truth for "what charred looks
  // like" on this rig.
  const color =
    destroyedReason != null ? DEAD_MECH_CHAR_COLOR
      : shutdown ? new THREE.Color(DEAD_MECH_CHAR_COLOR).lerp(new THREE.Color(baseColor), 0.45).getStyle()
        : baseColor
  // Real user follow-up: even with the dark `color` above actually
  // applying (see tintStrength below), a lingering emissive glow on the
  // model — an ADDITIVE light contribution, rendered at its exact color
  // regardless of how dark the base material is — kept the whole mech
  // reading as "mostly orange" anyway. A dead mech doesn't keep glowing
  // once it's a cold wreck (the one-shot MechExplosionOnce below already
  // covers the "this just happened" flash for 1.3s); only shutdown
  // (still hot, still running) keeps a real, modest ember glow.
  // Real user report: a mech that died WHILE shutdown kept the shutdown
  // look (ember glow + steam, see SteamPuffs' own render condition below)
  // forever after — is_shutdown never gets cleared by death, so `shutdown`
  // alone stayed true. Dead has to win outright once destroyedReason is
  // set, matching what the comment above already assumed but the code
  // never actually checked.
  const glowEmissive = destroyedReason == null && shutdown ? '#e35d2a' : undefined
  const glowEmissiveIntensity = destroyedReason == null && shutdown ? 0.18 : undefined
  // Real user follow-up: "el color de los muertos... tiene que ser negro
  // o gris oscuro POR ENCIMA de su textura, como si estuviese
  // chamuscado" — Mech3D's own faction-tint wash is deliberately faint
  // (FACTION_TINT_STRENGTH, ~22%, blended back toward white) so a living
  // mech's own paint job stays legible under its side color; applying
  // that SAME weak blend to `color` above (already a fully-computed
  // charred/dimmed value, not a side color) diluted it right back down
  // toward washed-out — the real reason a "black" wreck kept reading as
  // "mostly its emissive glow's color" instead. Any of the three special
  // states below needs its OWN `color` applied at much closer to full
  // strength; only a plain living mech keeps the normal faint wash.
  // Real user follow-up, the other direction this time: "el color de
  // muerto es completamente negro, quiero que sea negro con opacidad
  // sobre la textura real" — 0.9 overshot past "charred" into "solid
  // color, texture gone". Dropped enough that the model's own panel
  // lines/plating stay visibly readable underneath the char.
  const tintStrength = destroyedReason != null || shutdown ? 0.55 : undefined
  // Real user request: "los mechs muertos caen al suelo como si
  // estuviesen en prone" — BOTH destruction reasons tilt over now, not
  // just pilot_killed (a structural kill still gets its own explosion +
  // charred wreck look on top of this same tilt, just via `color`/
  // `glowEmissive` above — the tilt itself is shared, same as it always
  // was with a failed-PSR prone).
  const tiltProne = prone || destroyedReason != null

  // Mech3D's unrotated model faces +Z (legs/shoulders are wide along X,
  // narrow front-to-back along Z) — rotate it to match facing_deg using
  // the same 0°=+X, counter-clockwise convention as the LoS debug overlay
  // (see units.py's _world_delta/_within_facing_arc), so a mech's visible
  // "which way it's looking" agrees with which way its vision cone points.
  const facingRotationY = Math.PI / 2 - (unit.facing_deg * Math.PI) / 180

  // Walk the mech across the board instead of teleporting it the instant
  // unit.q/r changes. Dragging (dragPosition set) already follows the
  // pointer continuously, so it skips easing entirely.
  const animatedPos = useRef<[number, number]>(target)
  // Interpolates alongside animatedPos's X/Z, through the same per-leg
  // heights the queue below carries — see heightAt's own doc comment for
  // the bug this fixes (Y used to snap to the destination's elevation
  // immediately, independent of how far X/Z had actually walked).
  const animatedY = useRef<number>(baseY)
  const [isMoving, setIsMoving] = useState(false)
  const canWalk = !dragPosition

  // Turns to face the direction it's actually walking at each leg of a
  // real path, not just at the final destination — see TURN_SPEED/
  // lerpAngle above. Settles onto the unit's real commanded facing_deg
  // (facingRotationY) once there's no more route left to walk.
  const animatedRot = useRef<number>(facingRotationY)

  // The real route (ReachableHex.path from movement.py, threaded down
  // as walkPath) — a queue of world-space waypoints (each carrying its
  // own resting height, via heightAt) stepToward below walks through one
  // at a time, instead of sliding straight from the old hex to the new
  // one through anything in between. Replaced wholesale whenever a
  // genuinely new walkPath prop arrives (a fresh move was just
  // initiated); a caller with no path data (a free-form drag/move) never
  // sets one, so the queue stays empty and stepToward just falls back to
  // a direct line at `target`/baseY — the exact behavior this had before
  // walkPath existed.
  const pathQueueRef = useRef<{ x: number; z: number; y: number }[]>([])
  const lastWalkPathRef = useRef<{ q: number; r: number }[] | undefined>(undefined)
  // Real user request: real Despegar→Saltar→Aterrizar with the miniature
  // actually rising and falling, not the same ground-hugging slide a
  // walk/run uses — movement.py's own jump resolution never produces a
  // real hex-by-hex route (RAW: a jump arcs over whatever's in between,
  // terrain-blind), walkPath for a jump is just the single landing hex,
  // so this is a completely separate stepping path from pathQueueRef
  // above, driven by jumpFlight.ts's own time-based arc instead of
  // WALK_SPEED distance-based stepping. Set (and cleared) by the walkPath
  // effect below whenever a fresh jump move arrives; stepToward checks
  // this FIRST, before the queue/direct-line fallback.
  const jumpFlightRef = useRef<{ origin: [number, number, number]; destination: [number, number, number]; elapsed: number } | null>(null)
  const [jumpPhase, setJumpPhase] = useState<Exclude<JumpPhase, 'done'> | null>(null)
  // Real user report: turning to reach a hex well behind the mech (a big
  // in-place-feeling rotation before much actual sliding) left fog stale
  // through the whole turn — the matching fog_steps entry only ever
  // applied on ARRIVAL at that hex, so it popped all at once right as the
  // (short) slide finished, well after the turn had already played out.
  // Set true below when the FIRST leg of a fresh walk needs a big turn
  // from wherever the mech is actually facing right now — in that case
  // its fog step fires immediately here instead of waiting for arrival;
  // stepToward's own arrival branch then skips re-firing index 0. A small
  // turn (the common case — already roughly facing that way) keeps the
  // existing arrival-synced reveal, which stays visually accurate for it.
  const firstStepFiredEarlyRef = useRef(false)
  useEffect(() => {
    if (walkPath && walkPath !== lastWalkPathRef.current) {
      lastWalkPathRef.current = walkPath
      if (movementType === 'jump') {
        // Real Despegar/Saltar/Aterrizar arc — see jumpFlightRef's own
        // doc comment. A jump's own walkPath is always a single landing
        // hex (movement.py never produces a real route for one), so
        // there's no per-leg queue to build, just origin→destination.
        pathQueueRef.current = []
        const [ox, oz] = animatedPos.current
        const dest = walkPath[walkPath.length - 1]
        const [dx, dz] = hexToWorld(dest.q, dest.r)
        jumpFlightRef.current = {
          origin: [ox, animatedY.current, oz],
          destination: [dx, heightAt(dest.q, dest.r), dz],
          elapsed: 0,
        }
        firstStepFiredEarlyRef.current = false
        return
      }
      jumpFlightRef.current = null
      pathQueueRef.current = walkPath.map((p) => {
        const [x, z] = hexToWorld(p.q, p.r)
        return { x, z, y: heightAt(p.q, p.r) }
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
  }, [walkPath, movementType, heightAt])

  const stepToward = (delta: number) => {
    if (!canWalk) {
      animatedPos.current = target
      animatedY.current = baseY
      animatedRot.current = facingRotationY
      pathQueueRef.current = []
      jumpFlightRef.current = null
      if (jumpPhase !== null) setJumpPhase(null)
      if (isMoving) setIsMoving(false)
      return
    }
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
      return
    }
    const queue = pathQueueRef.current
    const immediateTarget = queue.length > 0 ? queue[0] : { x: target[0], z: target[1], y: baseY }
    const [cx, cz] = animatedPos.current
    const cy = animatedY.current
    const dx = immediateTarget.x - cx
    const dz = immediateTarget.z - cz
    const dist = Math.hypot(dx, dz)
    const headingTarget = dist > ARRIVE_EPSILON ? Math.atan2(dx, dz) : facingRotationY
    animatedRot.current = lerpAngle(
      animatedRot.current,
      headingTarget,
      Math.min(1, TURN_SPEED * delta),
    )
    if (dist <= ARRIVE_EPSILON) {
      animatedPos.current = [immediateTarget.x, immediateTarget.z]
      animatedY.current = immediateTarget.y
      if (queue.length > 0) {
        // queue.length here is BEFORE the slice below — still counts
        // the waypoint just arrived at, so walkPath.length - queue.length
        // is that waypoint's own 0-based index in the original array.
        // Index 0 may have already fired early (see firstStepFiredEarlyRef
        // above, for a big in-place-feeling turn) — skip it here so its
        // fog step doesn't apply twice.
        if (walkPath) {
          const idx = walkPath.length - queue.length
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

  // Physics-tracked units (TableView, so dice roll and bounce across
  // the actual board) are driven through Rapier's own kinematic API
  // instead of a plain Object3D transform — a "fixed" body's collider
  // doesn't follow its Three.js transform after creation (fixed means
  // exactly that), so nudging one every frame used to only move the
  // *visual* mesh while the dice kept bouncing off its original spot.
  // kinematicPosition bodies are explicitly meant to be relocated by
  // the app while still colliding correctly, which is what
  // setNextKinematicTranslation/Rotation below actually do each frame.
  const rigidBodyRef = useRef<RapierRigidBody>(null)
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_state, delta) => {
    stepToward(delta)
    const [x, z] = animatedPos.current
    const y = animatedY.current
    const rot = animatedRot.current
    if (physics) {
      const body = rigidBodyRef.current
      if (body) {
        // World space, not this group's local space — see worldOffset's
        // own doc comment above for why the subtraction is required here.
        const [centerX, centerZ] = worldOffset
        body.setNextKinematicTranslation({ x: x - centerX, y, z: z - centerZ })
        body.setNextKinematicRotation(quaternionFromY(rot))
      }
    } else {
      groupRef.current?.position.set(x, y, z)
      groupRef.current?.rotation.set(0, rot, 0)
    }
  })

  // Select is a no-op group wrapper when there's no <Selection> ancestor
  // (GMView/TableView/plain PlayerView never render one) — safe to
  // always wrap, not just when this specific view actually uses
  // outlines. FirstPersonView's own <Selection>+<EffectComposer><Outline
  // /> (real user request, with a reference image: "resalte el contorno
  // del mech enemigo, del modelo 3D" — a real edge-detected silhouette
  // outline, not a shape drawn over its screen projection) is what
  // actually turns a claimed selection into a visible red rim; this is
  // just the per-unit "claim me" toggle.
  const mechOrMarker = (
    <>
      <Select enabled={!!outlined}>
        {unit.mech_id != null ? (
          <>
          {/* Real user report: placing a mech whose chassis/model glTF
              hadn't loaded yet blanked the WHOLE map (every tile,
              every other unit) for a beat — the single Suspense
              boundary wrapping all of <HexMap> in TableView/GMView
              unmounts everything under it while any one thing inside
              suspends. An already-loaded chassis (drei's useGLTF
              cache, keyed by URL) never suspends, which is why re-
              placing a mech that had appeared before looked fine. A
              boundary scoped to just this one marker's model isolates
              the blip to itself. */}
          <Suspense fallback={null}>
            <Mech3D
              color={color} chassis={unit.mech_chassis} model={unit.mech_model}
              isMoving={isMoving} movementType={movementType === 'run' ? 'run' : 'walk'}
              jumpPhase={jumpPhase} fallen={tiltProne} dead={destroyedReason != null}
              emissive={glowEmissive} emissiveIntensity={glowEmissiveIntensity}
              tintStrength={tintStrength}
              onLoaded={() => forceMeshRegistered((n) => n + 1)}
            />
          </Suspense>
          {destroyedReason === 'structural' && (
            // Local space (this whole subtree already sits inside the
            // marker's own position-tracking group/RigidBody above) — NOT
            // animatedPos/animatedY, which are world-space and would
            // double-offset it.
            <MechExplosionOnce position={[0, MODEL_SCALE * MODEL_CHEST_FRACTION, 0]} />
          )}
          </>
        ) : (
          <mesh position={[0, 0.35, 0]} castShadow>
            <coneGeometry args={[0.35, 0.7, 4]} />
            <meshStandardMaterial color={color} />
          </mesh>
        )}
      </Select>
      {/* Real user report: this used to show whenever heat_current>=5 in
          ANY phase — the actual request was "los mechs EN ESTA FASE
          [Heat] desprenderán vapor", i.e. only DURING the Heat phase,
          for any mech carrying real heat (>0). Callers only pass a
          non-zero `heat` prop while the round is actually in its Heat
          phase (see heatByUnitId's own doc comment at each of GMView/
          TableView/FirstPersonView) — HexMap itself has no notion of
          round phase, so the gating lives entirely in what's handed to
          this prop. Shutdown is a SEPARATE, later real user request:
          "un mech sobrecalentado suelta pufs de vapor constantemente" —
          an overheated (shutdown) mech steams EVERY phase, not just
          during Heat, so this OR's in regardless of the `heat` prop
          (falls back to a fixed intensity — shutdown itself already
          implies serious heat, whatever phase-gated `heat` happens to
          be right now). Real user report: a mech that died while
          shutdown/overheated kept puffing forever after — destroyedReason
          wins outright, same reasoning as glowEmissive above. */}
      {unit.mech_id != null && destroyedReason == null && ((heat != null && heat > 0) || shutdown) && (
        <SteamPuffs heat={heat ?? 20} />
      )}
    </>
  )

  if (physics) {
    // Owns its own world-space transform via the kinematic API above —
    // deliberately NOT nested inside the pointer-handling group below
    // (TableView, the only physics caller, never wires up
    // onUnitClick/onUnitDragEnd — the shared board is passive).
    //
    // Real user report: dice were passing straight through mechs.
    // colliders="hull" used to auto-build a collider from this body's
    // own child geometry — but Mech3D's real model loads inside its OWN
    // local <Suspense> (mechOrMarker above), so on first mount there's
    // nothing there yet (fallback={null}) for the hull to wrap; rapier's
    // own hull-scan only runs once, keyed off the `colliders` prop
    // STRING itself (never re-fires just because the Suspense content
    // showed up later), so the mech was left permanently collider-less
    // once its model finished loading. An explicit box sized off Mech3D's
    // own documented bounding box (X ±0.374, Y 0..1, Z ±0.310, scaled by
    // MODEL_SCALE) mounts synchronously, independent of whether the
    // visual model has loaded yet.
    return (
      <RigidBody
        ref={rigidBodyRef}
        type="kinematicPosition"
        colliders={false}
        position={[animatedPos.current[0], animatedY.current, animatedPos.current[1]]}
        rotation={[0, facingRotationY, 0]}
      >
        {unit.mech_id != null ? (
          <CuboidCollider args={[0.374 * MODEL_SCALE, 0.5 * MODEL_SCALE, 0.310 * MODEL_SCALE]} position={[0, 0.5 * MODEL_SCALE, 0]} />
        ) : (
          <CuboidCollider args={[0.35, 0.35, 0.35]} position={[0, 0.35, 0]} />
        )}
        {mechOrMarker}
        {unit.is_ghost && (
          <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.5, 0.62, 24]} />
            <meshBasicMaterial color="#e35d5d" />
          </mesh>
        )}
      </RigidBody>
    )
  }

  return (
    <group
      ref={groupRef}
      position={[animatedPos.current[0], animatedY.current, animatedPos.current[1]]}
      rotation={[0, facingRotationY, 0]}
      onPointerDown={(e) => {
        e.stopPropagation()
        onPointerDown?.(e)
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        onPointerUp?.(e)
      }}
    >
      {mechOrMarker}
      {unit.is_ghost && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.62, 24]} />
          <meshBasicMaterial color="#e35d5d" />
        </mesh>
      )}
    </group>
  )
}, unitMarkerPropsEqual)

/**
 * Terrain is always rendered — the physical analogy is a real table, and
 * you can always see the table. Only UNITS are subject to fog: a ghost
 * unit (GM-placed, no physical miniature yet) stays hidden from this
 * view entirely until `unit.revealed` flips server-side (see
 * app/units.py combined_visibility). Real per-player vision-cone
 * outlines (VISION.md's colored contour) are future work — this shows
 * the combined/GM view only.
 */
// A unit-pointer-down that never crosses to a different hex before
// release is a click (open the context menu); one that does is a drag
// (reposition it there). Tracked in a ref, not state, so rapid
// pointermove events during a drag never race a stale closure — `hover`
// state exists purely to drive the visual highlight and is read back out
// at drop time too (same value the ref would have, just re-render-visible).
interface DragState {
  unit: Unit
  startQ: number
  startR: number
}

interface FootprintMark {
  id: number
  x: number
  y: number
  z: number
  rot: number
}

// Standard cube-coordinate hex line-drawing (lerp in cube space, round
// each step the same "fix up the largest-error axis" way worldToHex
// already does for a raw continuous point) — every hex a straight walk
// from (q1,r1) to (q2,r2) actually crosses, INCLUSIVE of the destination
// but not the origin (same convention UnitMarker's own walkPath prop
// doc comment describes). Used as the snow-footprint trail's path
// source instead of trusting `walkPaths` alone: a real user report
// ("las huellas no solo se tienen que dejar cuando se llegue a la
// casilla de nieve... tambien tienen que quedar marcada cuando esa
// casilla de nieve es solo parte del camino") turned out to trace back
// to walkPaths not reliably still holding this move's route by the time
// the footprint effect below observes the position change — this
// geometric fallback needs no such timing to line up, it only needs the
// two endpoints, which `units` always has.
function hexLine(q1: number, r1: number, q2: number, r2: number): { q: number; r: number }[] {
  const x1 = q1, z1 = r1, y1 = -x1 - z1
  const x2 = q2, z2 = r2, y2 = -x2 - z2
  const n = Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2))
  const result: { q: number; r: number }[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t, z = z1 + (z2 - z1) * t
    let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z)
    const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z)
    if (dx > dy && dx > dz) rx = -ry - rz
    else if (dy > dz) ry = -rx - rz
    else rz = -rx - ry
    result.push({ q: rx, r: rz })
  }
  return result
}

const MAX_FOOTPRINTS = 600
// Evenly-spaced prints per hex crossed, not just one at its far end —
// "quiero mas de una footprint por tile, en la direccion del
// movimiento", real user request after a single-print-per-hex version
// read as too sparse.
const STEPS_PER_HEX = 3
// World units between consecutive steps within one hex — (STEPS_PER_HEX
// - 1) * STEP_SPACING must stay under a hex's own ~0.95 radius so every
// step lands inside the CURRENT (snow) tile, not the previous one.
const STEP_SPACING = 0.3

/** One mech-foot print — a single blocky, rectangular pad, not a
 * heel-and-toe pair (that read as a human shoe's curved sole, not a
 * mech's — "con la forma de un pie de mech, no de un zapato", real user
 * report with a reference image of an actual boot-sole silhouette to
 * avoid). Sharp box edges read as mechanical on sight, where the
 * previous two soft rounded blobs didn't.
 *
 * Sitting ON TOP of the ground (bottom flush at `mark.y`, same as
 * TerrainDecor.tsx's Pebbles), not recessed a little BELOW it — an
 * earlier version tried exactly that for a true "dent" look, but the
 * ground tile underneath (HexMap.tsx's Tile terrainMesh) is a SOLID
 * opaque cylinder reaching all the way down from its own top, not a thin
 * shell with empty space beneath — anything positioned even slightly
 * below that top surface is simply buried inside it, fully hidden from
 * every angle including straight down. Confirmed by temporarily swapping
 * in a giant, unmissable debug sphere at the exact same recessed
 * coordinates: it rendered fine, proving the position/pipeline itself
 * was never the problem, only being on the wrong side of the ground's
 * own solid surface. */
function FootprintMesh({ mark }: { mark: FootprintMark }) {
  return (
    <mesh position={[mark.x, mark.y + 0.015, mark.z]} rotation={[0, mark.rot, 0]}>
      <boxGeometry args={[0.16, 0.03, 0.26]} />
      <meshStandardMaterial color="#343941" roughness={0.95} />
    </mesh>
  )
}

/** A mech's compressed-snow trail, left behind wherever it's crossed a
 * 'snow' tile — "que se queden las huellas de los mechs que anden por la
 * nieve", real user request. `marks` is owned by HexMap itself (see its
 * own footprints state/effect below), not per-unit, since a trail needs
 * to persist after the mech that made it has moved on, possibly off the
 * map entirely. */
function FootprintTrail({ marks }: { marks: FootprintMark[] }) {
  return (
    <group>
      {marks.map((m) => <FootprintMesh key={m.id} mark={m} />)}
    </group>
  )
}

interface ImpactMark {
  id: number
  x: number
  y: number
  z: number
  rot: number
}

const MAX_IMPACT_MARKS = 150

/** A single missed shot's scorch mark — real user request: "los disparos
 * fallados deben golpear el suelo... y deben dejar marcas en el
 * mapa/tile que golpean". Same "sit flush on TOP of the ground" reasoning
 * as FootprintMesh above (the terrain mesh is a solid opaque cylinder,
 * anything recessed below its top surface is just buried and invisible)
 * — a dark, irregular scorch circle plus a couple of short radial
 * scuff-marks so it reads as a blast, not a dropped coin. */
function ImpactMarkMesh({ mark }: { mark: ImpactMark }) {
  return (
    <group position={[mark.x, mark.y + 0.012, mark.z]} rotation={[0, mark.rot, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.34, 16]} />
        <meshStandardMaterial color="#1a1512" roughness={1} transparent opacity={0.82} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <ringGeometry args={[0.2, 0.34, 16]} />
        <meshStandardMaterial color="#3a2a1c" roughness={1} transparent opacity={0.5} />
      </mesh>
    </group>
  )
}

function ImpactMarkTrail({ marks }: { marks: ImpactMark[] }) {
  return (
    <group>
      {marks.map((m) => <ImpactMarkMesh key={m.id} mark={m} />)}
    </group>
  )
}

// Real user request (asked repeatedly this week — "ya te he pedido esto
// 3 veces"): "estas pintando niebla por cada tile... quiero que hagas 1
// entero con la geometria de los 5 tiles conjuntos" — the whole fog
// system below builds ONE merged polygon per CONNECTED region of fogged
// hexes (via real boundary tracing, not one shape per tile glued/
// overlapped against its neighbors), which is what actually eliminates
// the seam/gap artifacts a per-tile approach kept producing regardless
// of how the edges were softened — there's nothing left to collide with
// once it's genuinely one shape. See buildFogRegions's own doc comment
// for the algorithm.
const FOG_HEIGHT = 1.7

// Matches CylinderGeometry(radius, radius, height, 6)'s own real default
// corner layout — verified directly against three.js's own source
// (thetaStart=0, vertex i at theta = i * 60°, position
// (radius*sin(theta), radius*cos(theta))), not assumed — so a boundary
// polygon built from these corners lands EXACTLY on the real terrain
// tiles' own hex outlines (Tile's own groove mesh, radius 1 — the true
// seamless spacing), with zero misalignment against what's actually
// rendered underneath.
function fogHexCorner(cx: number, cz: number, i: number): [number, number] {
  const theta = (i * Math.PI) / 3
  return [cx + Math.sin(theta), cz + Math.cos(theta)]
}

// Axial neighbor offsets, matching hexToWorld's own convention — offset
// k shares the edge between corners (k+1)%6 and (k+2)%6 (derived from
// hexToWorld's own trigonometry: neighbor k's direction always points
// exactly through the midpoint of that edge).
const FOG_HEX_NEIGHBORS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
function fogEdgeCornerIndices(neighborIndex: number): [number, number] {
  return [(neighborIndex + 1) % 6, (neighborIndex + 2) % 6]
}

function fogSignedArea(points: [number, number][]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

// Standard ray-casting point-in-polygon test.
function fogPointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false
  const [px, py] = point
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

interface FogRegion {
  shape: THREE.Shape
  /** The LOWEST ground height among this region's own tiles — a single
   * merged volume can't follow per-tile elevation without a much
   * heavier custom geometry, and erring low (fully covering every tile,
   * possibly sinking a little into a hill) reads far better than erring
   * high (visibly floating over a lower neighbor). */
  baseY: number
}

/** Traces the real outer boundary (and any holes — a visible tile fully
 * enclosed by fog) of every CONNECTED region of fogged hexes, returning
 * one polygon per region — see this section's own top comment for why.
 *
 * Standard grid-boundary-tracing algorithm, no separate flood-fill/
 * clustering pass needed: for every fogged tile, each of its 6 edges is
 * either INTERIOR (shared with another fogged tile — skip it) or a
 * BOUNDARY edge (shared with a visible tile or the map's own edge — keep
 * it, in this tile's own fixed corner-index winding). Chaining every
 * kept edge by shared endpoints traces one or more closed loops on its
 * own — disconnected fog blobs simply never produce edges that chain to
 * each other, so they fall out as separate loops for free. Loops are
 * then split into outer boundaries vs holes by signed area (fogHexCorner's
 * own winding makes a real outer boundary trace negative and a hole
 * trace positive — both are still explicitly re-oriented before handing
 * them to THREE.Shape, rather than trusting that derivation alone), and
 * each hole is assigned to whichever outer loop's area actually contains
 * it. */
function buildFogRegions(fogTiles: { q: number; r: number; groundY: number }[]): FogRegion[] {
  if (fogTiles.length === 0) return []
  const fogKeys = new Set(fogTiles.map((t) => `${t.q},${t.r}`))

  interface Edge { p1: [number, number]; p2: [number, number] }
  const edges: Edge[] = []
  for (const tile of fogTiles) {
    const [cx, cz] = hexToWorld(tile.q, tile.r)
    for (let k = 0; k < FOG_HEX_NEIGHBORS.length; k++) {
      const [dq, dr] = FOG_HEX_NEIGHBORS[k]
      if (fogKeys.has(`${tile.q + dq},${tile.r + dr}`)) continue
      const [i1, i2] = fogEdgeCornerIndices(k)
      edges.push({ p1: fogHexCorner(cx, cz, i1), p2: fogHexCorner(cx, cz, i2) })
    }
  }
  if (edges.length === 0) return []

  const keyOf = (p: [number, number]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`
  const startIndex = new Map<string, number>()
  edges.forEach((e, idx) => startIndex.set(keyOf(e.p1), idx))
  const used = new Array<boolean>(edges.length).fill(false)

  const loops: [number, number][][] = []
  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue
    const loop: [number, number][] = []
    let current = start
    // Safety cap, not an expected code path — a real closed loop on a
    // real hex grid can never exceed the total edge count; this only
    // guards against a malformed/open chain looping forever.
    for (let guard = 0; guard < edges.length + 1; guard++) {
      if (used[current]) break
      used[current] = true
      loop.push(edges[current].p1)
      const next = startIndex.get(keyOf(edges[current].p2))
      if (next === undefined || next === start) break
      current = next
    }
    if (loop.length >= 3) loops.push(loop)
  }

  const outerLoops: [number, number][][] = []
  const holeLoops: [number, number][][] = []
  for (const loop of loops) {
    if (fogSignedArea(loop) < 0) outerLoops.push(loop)
    else holeLoops.push(loop)
  }

  const regions = outerLoops.map((points) => {
    const ccw = fogSignedArea(points) < 0 ? [...points].reverse() : points
    const shape = new THREE.Shape(ccw.map(([x, z]) => new THREE.Vector2(x, z)))
    return { shape, outerPoints: ccw, baseY: Infinity }
  })

  for (const hole of holeLoops) {
    const cw = fogSignedArea(hole) > 0 ? [...hole].reverse() : hole
    const owner = regions.find((r) => fogPointInPolygon(hole[0], r.outerPoints))
    if (owner) owner.shape.holes.push(new THREE.Path(cw.map(([x, z]) => new THREE.Vector2(x, z))))
  }

  for (const tile of fogTiles) {
    const [cx, cz] = hexToWorld(tile.q, tile.r)
    const region = regions.find((r) => fogPointInPolygon([cx, cz], r.outerPoints))
    if (region) region.baseY = Math.min(region.baseY, tile.groundY)
  }

  return regions.filter((r) => Number.isFinite(r.baseY)).map((r) => ({ shape: r.shape, baseY: r.baseY }))
}

// Real user follow-up, across three rounds of real feedback: "no hay una
// iluminacion homogenea... se ven los tiles discretos de niebla" (flat
// unlit cylinder + billboard puffs) -> "bordes muy definidos... desde
// arriba el interior lo veo... no tiene animacion" (a per-tile shader
// volume, still one shape per tile under the hood) -> "estas pintando
// niebla por cada tile... y en top down hay artefactos de colision"
// (confirmed: overlapping per-tile geometry was still the root cause of
// the visible seams, no amount of shader tuning was ever going to fix
// that). This shader now runs on the SINGLE merged region geometry from
// buildFogRegions — there is no neighbor to collide with anymore, so
// this only needs height falloff + animated noise, no radial/edge
// falloff logic at all. `vCapFactor` (1 on the flat top/bottom, ~0 on
// the extruded side walls) is what actually softens the region's own
// outer silhouette now — the side walls read as noticeably thinner than
// the top face instead of an equally-solid vertical curtain, which is
// what a hard polygon boundary alone would otherwise still look like
// from any oblique angle.
const fogVertexShader = /* glsl */ `
  varying vec3 vWorldPosition;
  varying float vCapFactor;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vCapFactor = abs(normal.y);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`
const fogFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uBaseY;
  uniform float uTopY;
  uniform float uOpacity;
  varying vec3 vWorldPosition;
  varying float vCapFactor;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.55;
    for (int i = 0; i < 3; i++) {
      value += amplitude * valueNoise(p);
      p *= 2.05;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    float heightT = clamp((vWorldPosition.y - uBaseY) / max(0.0001, uTopY - uBaseY), 0.0, 1.0);
    // Dense near the ground, thinning toward the top — but with a HIGH
    // floor: TableView's own camera looks almost straight down, so it's
    // mostly looking at this volume's own top cap face, and that face
    // must stay solid enough to actually hide the terrain under it.
    float heightDensity = 1.0 - smoothstep(0.15, 1.0, heightT) * 0.28;
    // Side walls read noticeably thinner than the top/bottom caps — see
    // vCapFactor's own doc comment above.
    float capSoftness = mix(0.4, 1.0, vCapFactor);
    vec2 flow = vec2(uTime * 0.03, uTime * 0.021);
    float n = fbm(vWorldPosition.xz * 0.5 + flow) * 0.65 + fbm(vWorldPosition.xz * 1.15 - flow * 1.5) * 0.35;
    float density = heightDensity * capSoftness * (0.88 + n * 0.5);
    vec3 tint = mix(uColor * 0.72, uColor * 1.32, n);
    gl_FragColor = vec4(tint, clamp(density, 0.0, 1.0) * uOpacity);
  }
`

/** One real merged region's own body — see this section's own top
 * comment and buildFogRegions's doc comment for the "why" and the
 * boundary-tracing algorithm. `shape` already sits in real world (x, z)
 * coordinates (buildFogRegions builds it straight from hexToWorld), so
 * this only needs to extrude it upward and place it at the right
 * height — no further per-tile positioning. */
function FogRegionMesh({ shape, baseY, seed }: { shape: THREE.Shape; baseY: number; seed: number }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const geometry = useMemo(() => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: FOG_HEIGHT, bevelEnabled: false, curveSegments: 1 })
    // ExtrudeGeometry lays the shape's own local (x, y) in the XY plane
    // and extrudes along LOCAL +Z from 0 to `depth` (confirmed directly
    // against three.js's own source, not assumed, after an earlier
    // sign mistake here). rotateX(+90°) turns that into "flat footprint
    // in world (x, z), extruded along world Y" with NO mirroring on
    // either axis (+90°, not -90° — that direction previously flipped
    // Z) — the tradeoff is local Y then runs from 0 down to -depth, so
    // the mesh itself gets positioned from its TOP (baseY + FOG_HEIGHT)
    // rather than its bottom to compensate, see the mesh position below.
    geo.rotateX(Math.PI / 2)
    geo.computeVertexNormals()
    return geo
  }, [shape])
  const uniforms = useMemo(
    () => ({
      uTime: { value: seed },
      uColor: { value: new THREE.Color('#7d8589') },
      uBaseY: { value: baseY },
      uTopY: { value: baseY + FOG_HEIGHT },
      uOpacity: { value: 0.94 },
    }),
    // seed only used to desync each region's own animation phase at
    // mount — never meant to reset uTime on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseY],
  )
  useFrame((state) => {
    if (materialRef.current) materialRef.current.uniforms.uTime.value = seed + state.clock.elapsedTime
  })
  return (
    <mesh position={[0, baseY + FOG_HEIGHT, 0]} geometry={geometry}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={fogVertexShader}
        fragmentShader={fogFragmentShader}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

export function HexMap({
  map, units, losDebugHexes, needsInitiativePilotIds, activeMoverPilotId, activeAttackerPilotIds,
  moveHighlightHexes, pathPreviewHexes, targetableHexes, walkPaths, walkMovementTypes, outlineUnitIds, heatByUnitId,
  proneUnitIds, shutdownUnitIds,
  destroyedReasonByUnitId,
  teamVisibleHexes, physics, activeAttack, onAttackEffectDone, onUnitWalkDone, onUnitWalkStep,
  onUnitClick, onTileClick, onUnitDragEnd, onDraggingChange,
}: {
  map: MapData
  units: Unit[]
  /** Debug-only LoS overlay (see LosDebugOverlay above) — tiles a chosen unit currently sees, as "q,r" keys. */
  losDebugHexes?: Set<string>
  /** Pilot ids that still need to roll initiative this round (manual
   * per-pilot rolling, individual mode only) — any unit whose pilot_id
   * is in this set gets the amber ring (see UnitMarker). */
  needsInitiativePilotIds?: Set<number>
  /** Pilot id whose turn it is to move right now this movement phase
   * (rounds.ts's activeMoverPilotId) — their unit's tile gets the amber
   * wash. null/omitted highlights nothing. */
  activeMoverPilotId?: number | null
  /** Pilot ids who may act right now during the ranged/melee phases
   * (rounds.ts's activeAttackPilotIds) — same amber wash as
   * activeMoverPilotId, just a set instead of a single id since more
   * than one pilot can simultaneously still have a real target. */
  activeAttackerPilotIds?: Set<number>
  /** Hexes the current mover can reach this movement phase, as "q,r"
   * keys — see app/systems/battletech/movement.py::reachable_hexes. */
  moveHighlightHexes?: Set<string>
  /** The exact steps of the route to whichever destination was just
   * picked (a specific hex's own ReachableHex.path, as "q,r" keys) —
   * bright-white wash on top of moveHighlightHexes, shown alongside the
   * facing picker so the confirmed route reads clearly instead of only
   * the general reachable-range wash. Caller clears it the moment the
   * move is confirmed/cancelled (see each caller's own pendingFacing-
   * equivalent state). */
  pathPreviewHexes?: Set<string>
  /** Hexes holding a valid target for the attack currently being
   * declared (real weapon range / adjacency, not just "an enemy is
   * there") — danger-red wash, "q,r" keys, same technique as
   * moveHighlightHexes. */
  targetableHexes?: Set<string>
  /** The real hex-by-hex route for any unit currently mid-move this
   * movement phase, keyed by unit id (movement.py's ReachableHex.path,
   * captured by the caller at the moment it initiated the move — see
   * UnitMarker's own walkPath doc comment). Units with no entry here
   * just walk a direct line to their new q/r, same as before this
   * existed. */
  walkPaths?: Map<number, { q: number; r: number }[]>
  /** Which chain of clips each currently-walking unit actually plays
   * (real user request: proper Walk/Run/Jump animations) — keyed by unit
   * id, same population pattern as walkPaths above (straight off
   * unit_walked's own movement_type). A unit with no entry defaults to
   * 'walk' (UnitMarker's own movementType prop doc comment). */
  walkMovementTypes?: Map<number, 'walk' | 'run' | 'jump'>
  /** Unit ids to claim for the caller's own <Selection>'s <Outline>
   * effect — a real-time edge-detected silhouette outline around the
   * actual 3D model (FirstPersonView's detected enemies; real user
   * request, clarified with a reference image: the model's own
   * silhouette, not a flat shape drawn over its screen projection).
   * Harmless to set from a view with no <Selection>/<Outline> of its
   * own (see UnitMarker's own outlined doc comment) — GMView/TableView
   * never pass this. */
  outlineUnitIds?: Set<number>
  /** unit.mech_id's own mech.heat_current, keyed by UNIT id (not mech
   * id) to match how every other per-unit lookup here is keyed — drives
   * SteamPuffs (heat > 0) on the corresponding UnitMarker. Callers only
   * populate this with real values while the round is in its Heat phase
   * (real user report: steam should show ONLY during that phase, on
   * every mech carrying heat, not any phase a mech happens to be
   * hot) — outside it they pass an empty Map or all-zero values, same
   * as any caller that hasn't wired heat data through at all. */
  heatByUnitId?: Map<number, number>
  /** Unit ids whose mech is currently prone/shutdown (mechs.is_prone/
   * is_shutdown) — same per-view "caller resolves its own mechs lookup,
   * HexMap just renders" pattern as heatByUnitId above. */
  proneUnitIds?: Set<number>
  shutdownUnitIds?: Set<number>
  /** Unit ids whose mech.destroyed_reason (Fase D) is set, keyed to
   * WHICH reason — same per-view "caller resolves its own mechs lookup"
   * pattern as heatByUnitId/proneUnitIds above. See UnitMarker's own
   * destroyedReason doc comment for what each value renders as. */
  destroyedReasonByUnitId?: Map<number, 'structural' | 'pilot_killed'>
  /** Real fog of war — "q,r" keys of every hex the CALLER considers
   * currently known (TableView: the whole player team's union, via
   * app/units.py's _team_visible_hexes; FirstPersonView: just this one
   * cockpit's own facing-cone LoS, getUnitVisibleHexes). Any map tile
   * NOT in this set renders a FogTile instead of being left bare.
   * Omitted entirely (undefined, not an empty Set) means "this caller
   * has no fog concept" — GMView/MapEditorView never pass it, so the
   * GM stays omniscient exactly as before this existed. An empty Set is
   * a real, meaningful value (the team currently sees nothing at all),
   * not the same as omitting the prop. */
  teamVisibleHexes?: Set<string>
  /** Give every tile and mech a real physics collider (initiative dice
   * roll and bounce across the actual board — TableView only). Must
   * only be set true when this HexMap is rendered inside a <Physics>
   * provider — GMView's/MapEditorView's embedded maps have none, so
   * they never pass this. */
  physics?: boolean
  /** The weapon shot to animate right now (lasers/PPCs/tracers/missiles/
   * flamers between attacker and target), or null/omitted for none —
   * see ActiveAttackVfx. Callers derive this from the latest
   * attack_result broadcast plus the units array. */
  activeAttack?: ActiveAttackVfx | null
  /** Fires once activeAttack's animation has finished playing — the
   * caller should clear its activeAttack state in response (otherwise
   * the same shot's VFX just sits there finished, or never resets in
   * time for the next one to mount cleanly). */
  onAttackEffectDone?: () => void
  /** Fires once a unit's walk animation genuinely finishes (UnitMarker's
   * own onWalkDone, per the doc comment there) — real user request: the
   * movement phase's turn should hold on the mover until their mech
   * actually finishes sliding across the board, not the instant the
   * server's moved_pilot_ids updates (which can arrive well before the
   * animation catches up, especially over a longer route). Callers feed
   * this into rounds.ts's useAnimationHeldMover-style hold hook instead
   * of trusting activeMoverPilotId raw. */
  onUnitWalkDone?: (unitId: number) => void
  /** Fires each time a unit's walk animation arrives at one waypoint of
   * a real path (UnitMarker's own onWalkStep, per its doc comment) —
   * real user request: "la niebla se tiene que ir disipando con cada
   * movimiento... cada paso del mech tiene que actualizar la niebla".
   * `index` is the waypoint's 0-based position in walkPaths.get(unitId)
   * — callers look up the matching fog_steps/cockpit_fog_steps entry
   * from the same unit_walked broadcast that array came from. */
  onUnitWalkStep?: (unitId: number, index: number) => void
  /** A unit was clicked/tapped without being dragged to another hex — screen coords come straight off the native pointer event, for positioning an HTML context menu. */
  onUnitClick?: (unit: Unit, clientX: number, clientY: number) => void
  /** A tile was clicked with no drag in progress — the map's own free-standing "pick a hex" gesture (used by both attack-target and move-destination picking; the caller decides what a bare tile click means). clientX/clientY come straight off the native pointer event, same as onUnitClick/onUnitDragEnd, for anchoring a facing picker at the click point. */
  onTileClick?: (q: number, r: number, clientX: number, clientY: number) => void
  /** A unit was pointer-dragged and released on a different hex than it
   * started on — clientX/clientY (straight off the native pointer event,
   * same as onUnitClick) let the caller anchor a facing picker at the
   * drop point. */
  onUnitDragEnd?: (unit: Unit, q: number, r: number, clientX: number, clientY: number) => void
  /** Fires true when a unit-drag starts, false when it ends — so the
   * caller can disable OrbitControls' rotate while dragging (otherwise
   * the same mouse-drag gesture fights the camera for the same input). */
  onDraggingChange?: (dragging: boolean) => void
}) {
  // Memoized on map.tiles specifically — without this, these three full
  // scans over every tile rebuilt three fresh Maps (and handed Tile a
  // new `lookup` reference, defeating its own React.memo below) on EVERY
  // render, including every single pointermove event during a unit
  // drag — a real, measured contributor to "me va a tirones" on larger
  // maps, not just a style nit.
  const elevationAt = useMemo(() => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t.elevation])), [map.tiles])
  const terrainAt = useMemo(() => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t.terrain])), [map.tiles])
  const lookup = useMemo(() => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t])), [map.tiles])
  // Same resting-height formula UnitMarker computes for itself (restY),
  // generalized to an arbitrary hex so a walking mech's Y can interpolate
  // through each intermediate waypoint's own elevation instead of
  // snapping straight to the destination's height the instant unit.q/r
  // updates — real user report: walking from elevation 0 to elevation 2
  // showed the mech floating at height 2 from the very first step, while
  // its X/Z was still smoothly crossing the hexes in between. Memoized
  // (stable reference across renders unless the map's own tiles change)
  // so it can sit in unitMarkerPropsEqual as a reference check, same as
  // walkPath/physics, without defeating that memo every render.
  const heightAt = useCallback((q: number, r: number) => {
    const t = terrainAt.get(`${q},${r}`) ?? 'plains'
    const elev = elevationAt.get(`${q},${r}`) ?? 0
    return terrainSinkY(t) ?? (t === 'building' ? BUILDING_MIN_HEIGHT : 0.3 + elev * 0.22)
  }, [terrainAt, elevationAt])
  // One merged polygon per connected cluster of fogged hexes — see
  // buildFogRegions's own doc comment for why this replaced a shape-per-
  // tile approach (real, repeated user request). heightAt (not
  // groundYAt) is used here for the same reason the old per-tile fog
  // did: a fogged 'water'/'building' tile's own sink/platform height,
  // not the flat elevation-only formula.
  const fogRegions = useMemo(() => {
    if (!teamVisibleHexes) return []
    const fogTiles = map.tiles
      .filter((tile) => !teamVisibleHexes.has(`${tile.q},${tile.r}`))
      .map((tile) => ({ q: tile.q, r: tile.r, groundY: heightAt(tile.q, tile.r) }))
    return buildFogRegions(fogTiles)
  }, [teamVisibleHexes, map.tiles, heightAt])
  // A hex's own ground/platform height — matches Tile's rendering
  // exactly, including 'building's fixed platform (BUILDING_MIN_HEIGHT,
  // not the elevation formula; see its own doc comment) — used for the
  // attack-beam Y below so a shot at/from a mech on a building tile
  // still lands at that mech's actual (now non-elevation-scaled) chest
  // height, not where the old elevation math would have put it.
  const groundYAt = (q: number, r: number) =>
    terrainAt.get(`${q},${r}`) === 'building' ? BUILDING_MIN_HEIGHT : 0.3 + (elevationAt.get(`${q},${r}`) ?? 0) * 0.22
  // Real user report (GM's own map, ALL CAPS this time): "EN EL MAPA DE
  // GM SE VEN TODOS LOS MECHS DA IGUAL QUE ESTEN EN LOS O NO... en el
  // unico sitio donde esos mechs tienen que estar ocultos hasta que les
  // vean es en tableview" — the is_ghost check below is a fog-of-war
  // concept, same as the teamVisibleHexes one right after it, and must
  // be gated the SAME way: only when this caller actually passed
  // teamVisibleHexes (TableView, FirstPersonView) does hiding apply at
  // all. Omitting it (GMView/MapEditorView) keeps the GM omniscient —
  // this used to be true only for the SECOND check below, while the
  // ghost check fired unconditionally for every caller; harmless before
  // anything ever actually set is_ghost=true, a real bug the instant it
  // started mattering (units.py's own new auto-ghost-for-enemies).
  //
  // An enemy that had ever been seen once (is_ghost's own `revealed`
  // flag, which only ever flips on and never back off — see units.py's
  // own doc comment) stayed rendered forever after, regardless of
  // whether it was still actually in LoS. teamVisibleHexes is the
  // CURRENT, moment-to-moment fog (recomputed every visibility_update),
  // so on top of the one-way ghost-reveal gate, hide an enemy unit
  // whenever its own current hex isn't in it right now. Only 'enemy'
  // faction is gated — a team's own units are always visible to
  // themselves.
  const visibleUnits = units.filter((u) => {
    if (!teamVisibleHexes) return true
    if (u.is_ghost && !u.revealed) return false
    if (u.pilot_faction === 'enemy' && !teamVisibleHexes.has(`${u.q},${u.r}`)) return false
    return true
  })
  const [centerX, centerZ] = mapCenter(map.tiles)
  const needsInitiativeTiles = new Set(
    visibleUnits
      .filter((u) => u.pilot_id != null && (needsInitiativePilotIds?.has(u.pilot_id) ?? false))
      .map((u) => `${u.q},${u.r}`),
  )
  const activeMoverTiles = new Set(
    visibleUnits
      .filter((u) => u.pilot_id != null && (u.pilot_id === activeMoverPilotId || (activeAttackerPilotIds?.has(u.pilot_id) ?? false)))
      .map((u) => `${u.q},${u.r}`),
  )

  const dragRef = useRef<DragState | null>(null)
  const [hover, setHover] = useState<{ q: number; r: number } | null>(null)
  const [dragWorldPos, setDragWorldPos] = useState<[number, number] | null>(null)

  // Real user bug: clicking a mech to pick it as an attack target
  // instead opened THAT mech's own menu. Root cause — unitMarkerPropsEqual
  // (below) deliberately skips re-rendering a UnitMarker whose unit/
  // elevation/etc haven't changed, so its onPointerUp keeps calling
  // whatever `resolveAt` closure existed the LAST time that specific
  // unit's props actually changed — which can be from BEFORE the caller
  // set pickingTargetFor (GMView's onAttack), since clicking "Atacar"
  // doesn't touch any unit's own props. resolveAt below reads these refs
  // instead of the raw onUnitClick/onTileClick/onUnitDragEnd props
  // directly, so even a stale resolveAt closure calls the CURRENT
  // version — the ref *object* is stable across every render (only
  // .current mutates), so a stale closure over it still sees fresh data.
  const onUnitClickRef = useRef(onUnitClick)
  const onTileClickRef = useRef(onTileClick)
  const onUnitDragEndRef = useRef(onUnitDragEnd)
  onUnitClickRef.current = onUnitClick
  onTileClickRef.current = onTileClick
  onUnitDragEndRef.current = onUnitDragEnd

  // Snow footprint trail (FootprintTrail above). prevUnitTileRef tracks
  // each unit's last-seen "q,r" across renders so a real position CHANGE
  // (not just a re-render) can be detected; footprintSeqRef hands out
  // stable-across-renders ids for React's key prop. Both refs, not
  // state — neither needs to trigger its own re-render, only `footprints`
  // (the actual persisted marks) does.
  const prevUnitTileRef = useRef<Map<number, string>>(new Map())
  // Which foot (-1 left, 1 right) landed LAST for this unit — toggled on
  // every step so consecutive prints alternate sides down the path, a
  // real walking gait, instead of both feet landing on top of each other
  // at every single hex (real user report, with a reference image:
  // "podemos hacer pisadas en la direccion del movimiento"). A single
  // print per hex crossed still read as too sparse to that same report
  // ("quiero mas de una footprint por tile, en la direccion del
  // movimiento") — STEPS_PER_HEX interpolates a few evenly-spaced steps
  // along each hex-to-hex segment instead of only marking its far end.
  const footprintSideRef = useRef<Map<number, number>>(new Map())
  const footprintSeqRef = useRef(0)
  const [footprints, setFootprints] = useState<FootprintMark[]>([])
  // Scorch marks for missed shots — real user request: "los disparos
  // fallados deben golpear el suelo... y deben dejar marcas en el
  // mapa/tile que golpean" (see ImpactMarkTrail above and AttackEffect's
  // own onMissGround, wired in at this component's render site below).
  // Same stable-id-ref/capped-state pattern as the footprint trail.
  const impactMarkSeqRef = useRef(0)
  const [impactMarks, setImpactMarks] = useState<ImpactMark[]>([])
  const addImpactMark = (pos: [number, number, number]) => {
    // Real user report: the mark floated slightly above the ground, and
    // one landing off the edge of the map got drawn anyway (shown
    // hovering over the bare table). Both trace back to the same cause —
    // `pos`'s own Y is the ORIGINAL TARGET hex's ground height (all
    // AttackEffect has to work with), but the miss's lateral offset can
    // land it on a genuinely different hex — a neighboring one at a
    // different elevation, or no real hex at all. Re-deriving the real
    // (q, r) under the actual (x, z) landing point and using THAT hex's
    // own ground height fixes the float; a hex with no tile data at all
    // (off the map) just isn't a real place to leave a mark, so it's
    // skipped entirely instead of drawn floating over empty background.
    const { q, r } = worldToHex(pos[0], pos[2])
    const key = `${q},${r}`
    if (!terrainAt.has(key)) return
    impactMarkSeqRef.current += 1
    const y = groundYAt(q, r)
    setImpactMarks((old) => [
      ...old,
      { id: impactMarkSeqRef.current, x: pos[0], y, z: pos[2], rot: Math.random() * Math.PI * 2 },
    ].slice(-MAX_IMPACT_MARKS))
  }
  useEffect(() => {
    const prevTiles = prevUnitTileRef.current
    const sides = footprintSideRef.current
    const added: FootprintMark[] = []
    for (const u of units) {
      const key = `${u.q},${u.r}`
      const prevKey = prevTiles.get(u.id)
      if (prevKey !== undefined && prevKey !== key) {
        const [prevQStr, prevRStr] = prevKey.split(',')
        const prevQ = Number(prevQStr), prevR = Number(prevRStr)
        // walkPaths (see this component's own doc comment) is the real
        // hex-by-hex route just taken, preferred when present since a
        // real move can curve around blocked hexes a straight line
        // wouldn't; hexLine (above) reconstructs the geometric straight
        // path otherwise — covers drag-placement moves (no route data
        // at all) and, in practice, most walks: walkPaths isn't
        // reliably still holding this specific move's route by the time
        // this effect observes the resulting position change.
        const path = walkPaths?.get(u.id) ?? hexLine(prevQ, prevR, u.q, u.r)
        let [fromX, fromZ] = hexToWorld(prevQ, prevR)
        for (const hex of path) {
          const [x, z] = hexToWorld(hex.q, hex.r)
          if (terrainAt.get(`${hex.q},${hex.r}`) === 'snow') {
            const dx = x - fromX, dz = z - fromZ
            const dist = Math.hypot(dx, dz) || 1
            const angle = Math.atan2(dz, dx)
            const perpAngle = angle + Math.PI / 2
            // Unit vector back along the travel direction — steps are
            // placed walking backward from the hex's own center, not
            // interpolated across the full inter-hex distance (~1.9
            // units): that earlier version put the first step or two
            // still inside the PREVIOUS (often non-snow) tile, not this
            // one — "alguna pisada la pinta fuera de la nieve", real
            // user report. STEP_SPACING * (STEPS_PER_HEX - 1) stays
            // safely under a hex's own ~0.95 radius.
            const ux = dx / dist, uz = dz / dist
            const elev = elevationAt.get(`${hex.q},${hex.r}`) ?? 0
            // The snow's own surface height — FootprintMesh builds its
            // geometry UP from this itself, no offset needed here.
            const y = 0.3 + elev * 0.22
            for (let step = 1; step <= STEPS_PER_HEX; step++) {
              const backDist = (STEPS_PER_HEX - step) * STEP_SPACING
              const side = -(sides.get(u.id) ?? 1)
              sides.set(u.id, side)
              footprintSeqRef.current += 1
              added.push({
                id: footprintSeqRef.current,
                x: x - ux * backDist + Math.cos(perpAngle) * side * 0.09,
                y,
                z: z - uz * backDist + Math.sin(perpAngle) * side * 0.09,
                rot: angle,
              })
            }
          }
          fromX = x
          fromZ = z
        }
      }
      prevTiles.set(u.id, key)
    }
    if (added.length > 0) {
      setFootprints((old) => [...old, ...added].slice(-MAX_FOOTPRINTS))
    }
    // terrainAt/elevationAt/hexToWorld intentionally excluded — terrainAt
    // and elevationAt are rebuilt (new Map identity) every render, and
    // depending on them would rerun this on every render instead of only
    // on a real unit move; hexToWorld is a stable pure import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, walkPaths])

  const endDrag = () => {
    dragRef.current = null
    setHover(null)
    setDragWorldPos(null)
    onDraggingChange?.(false)
  }

  // Safety net for a drag released off the map entirely (no tile/unit
  // mesh under the cursor to fire its own onPointerUp resolution) — leaves
  // no lingering drag state to confuse the next interaction. Deferred one
  // tick so a real in-mesh onPointerUp (same native event, dispatched
  // synchronously first) gets to resolve — and thus null out dragRef —
  // before this fallback runs; when that happened, this is a no-op.
  useEffect(() => {
    const clearStrayDrag = () => {
      if (dragRef.current) setTimeout(endDrag, 0)
    }
    window.addEventListener('pointerup', clearStrayDrag)
    return () => window.removeEventListener('pointerup', clearStrayDrag)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resolveAt = (q: number, r: number, e: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current
    // While dragging, the unit's own mesh follows the cursor (dragPosition
    // above) and ends up the nearest/topmost hit at release, so ITS
    // onPointerUp fires — with the unit's static original q/r baked into
    // the closure, not where it was actually dropped. `hover` tracks the
    // real tile under the cursor via every Tile's onPointerMove
    // regardless of which mesh's onPointerUp ultimately catches the
    // release, so it's the one source of truth for the drop hex; the
    // passed-in q/r is only meaningful for the no-drag plain-tile-click case.
    const dropQ = drag ? (hover?.q ?? drag.startQ) : q
    const dropR = drag ? (hover?.r ?? drag.startR) : r
    endDrag()
    if (drag) {
      const moved = dropQ !== drag.startQ || dropR !== drag.startR
      // Real user request: "no podemos mover a una casilla ocupada por un
      // mech" — a drag released on a hex some OTHER unit already occupies
      // just snaps back to the start hex (treated as a plain click there,
      // same as dropping back on the origin) instead of moving there.
      const occupied = moved && units.some((u) => u.id !== drag.unit.id && u.q === dropQ && u.r === dropR)
      if (moved && !occupied) {
        onUnitDragEndRef.current?.(drag.unit, dropQ, dropR, e.nativeEvent.clientX, e.nativeEvent.clientY)
      } else {
        onUnitClickRef.current?.(drag.unit, e.nativeEvent.clientX, e.nativeEvent.clientY)
      }
    } else {
      onTileClickRef.current?.(q, r, e.nativeEvent.clientX, e.nativeEvent.clientY)
    }
  }

  return (
    <group position={[-centerX, 0, -centerZ]}>
      <FootprintTrail marks={footprints} />
      <ImpactMarkTrail marks={impactMarks} />
      {map.tiles.map((tile) => (
        <Tile
          key={`${tile.q},${tile.r}`} tile={tile} lookup={lookup}
          losHighlighted={losDebugHexes?.has(`${tile.q},${tile.r}`) ?? false}
          dragHighlighted={dragRef.current != null && hover?.q === tile.q && hover?.r === tile.r}
          needsInitiativeHighlighted={needsInitiativeTiles.has(`${tile.q},${tile.r}`)}
          activeMoverHighlighted={activeMoverTiles.has(`${tile.q},${tile.r}`)}
          moveHighlighted={moveHighlightHexes?.has(`${tile.q},${tile.r}`) ?? false}
          pathPreviewHighlighted={pathPreviewHexes?.has(`${tile.q},${tile.r}`) ?? false}
          targetableHighlighted={targetableHexes?.has(`${tile.q},${tile.r}`) ?? false}
          fogged={teamVisibleHexes ? !teamVisibleHexes.has(`${tile.q},${tile.r}`) : false}
          physics={physics}
          onPointerMove={(e) => {
            // No onUnitDragEnd means this HexMap is passive (TableView,
            // FirstPersonView) — a unit can still be clicked (dragRef is
            // still set on pointer-down for click detection below) but
            // must never visually follow the cursor. Real user report:
            // "me deja en FPV pinchar y arrastrar un mech, no debería
            // poder hacerse eso."
            if (!dragRef.current || !onUnitDragEnd) return
            setHover({ q: tile.q, r: tile.r })
            // e.point is world-space; this group is offset by
            // [-centerX,0,-centerZ], so add that back to land in the same
            // local space UnitMarker's own q/r-derived positions use.
            setDragWorldPos([e.point.x + centerX, e.point.z + centerZ])
          }}
          onPointerUp={(e) => resolveAt(tile.q, tile.r, e)}
        />
      ))}
      {fogRegions.map((region, i) => (
        <FogRegionMesh key={`fog-region-${i}`} shape={region.shape} baseY={region.baseY} seed={i * 7.13} />
      ))}
      {visibleUnits.map((unit) => (
        <UnitMarker
          key={unit.id}
          unit={unit}
          elevation={elevationAt.get(`${unit.q},${unit.r}`) ?? 0}
          terrain={terrainAt.get(`${unit.q},${unit.r}`) ?? 'plains'}
          dragPosition={dragRef.current?.unit.id === unit.id ? (dragWorldPos ?? undefined) : undefined}
          physics={physics}
          worldOffset={[centerX, centerZ]}
          walkPath={walkPaths?.get(unit.id)}
          movementType={walkMovementTypes?.get(unit.id)}
          heightAt={heightAt}
          outlined={outlineUnitIds?.has(unit.id) ?? false}
          heat={heatByUnitId?.get(unit.id)}
          prone={proneUnitIds?.has(unit.id) ?? false}
          shutdown={shutdownUnitIds?.has(unit.id) ?? false}
          destroyedReason={destroyedReasonByUnitId?.get(unit.id) ?? null}
          onWalkDone={() => onUnitWalkDone?.(unit.id)}
          onWalkStep={(index) => onUnitWalkStep?.(unit.id, index)}
          onPointerDown={() => {
            dragRef.current = { unit, startQ: unit.q, startR: unit.r }
            setHover({ q: unit.q, r: unit.r })
            onDraggingChange?.(true)
          }}
          onPointerUp={(e) => resolveAt(unit.q, unit.r, e)}
        />
      ))}
      {activeAttack && (() => {
        // Real user request: "no es muy largo hacer que las armas disparen
        // de esas zonas y los impactos se hagan en esos puntos?" — when
        // MechLab has a real weapon/hit annotation for this specific mech,
        // use its own rotated-by-facing offset instead of the generic
        // MODEL_CHEST_FRACTION guess; falls back to the old behavior per
        // side whenever that mech (or this exact weapon/location) isn't
        // annotated yet.
        const [ahx, ahz] = hexToWorld(activeAttack.attackerQ, activeAttack.attackerR)
        const [thx, thz] = hexToWorld(activeAttack.targetQ, activeAttack.targetR)
        const attackerPos: [number, number] = activeAttack.attackerOffset
          ? [ahx + activeAttack.attackerOffset.x, ahz + activeAttack.attackerOffset.z]
          : [ahx, ahz]
        const targetPos: [number, number] = activeAttack.targetOffset
          ? [thx + activeAttack.targetOffset.x, thz + activeAttack.targetOffset.z]
          : [thx, thz]
        const attackerY = groundYAt(activeAttack.attackerQ, activeAttack.attackerR)
          + (activeAttack.attackerOffset ? activeAttack.attackerOffset.y : MODEL_SCALE * MODEL_CHEST_FRACTION)
        const targetY = groundYAt(activeAttack.targetQ, activeAttack.targetR)
          + (activeAttack.targetOffset ? activeAttack.targetOffset.y : MODEL_SCALE * MODEL_CHEST_FRACTION)
        return (
        <AttackEffect
          key={activeAttack.id}
          data={{
            attackerPos,
            targetPos,
            attackerY,
            targetY,
            groundY: groundYAt(activeAttack.targetQ, activeAttack.targetR),
            weaponName: activeAttack.weaponName,
            hit: activeAttack.hit,
          }}
          onDone={() => onAttackEffectDone?.()}
          onMissGround={addImpactMark}
        />
        )
      })()}
    </group>
  )
}
