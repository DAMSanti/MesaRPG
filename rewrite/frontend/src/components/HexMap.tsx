import {
  memo, Suspense, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import {type ThreeEvent} from '@react-three/fiber'
import { CuboidCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier'
import { Select } from '@react-three/postprocessing'
import * as THREE from 'three'
import type {
  AttackResult, HexTileData, MapData, Mech, MechAnnotation, Unit,
} from '../api'
import { addBoardMark, deleteBoardMark, listBoardMarks } from '../api'
import { useMechAnnotationsCache } from '../mechAnnotations'
import { Mech3D } from './Mech3D'
import { TerrainDecor, terrainSinkY } from './TerrainDecor'
import { RoadMarkings } from './RoadMarkings'
import { GroundVegetation, LOD_DISTANCE, LOD_MIN_TILES, VEGETATION_REGION_SPAN } from './GroundVegetation'
import { GroundClutter } from './GroundClutter'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { computeRiverFlow } from '../riverFlow'
import { setWaterDisturbers } from '../waterDisturbance'
import { hashTile, terrainColor, terrainTexture } from '../terrain'
import { grassShadeAt, isGrassTerrain, GRASS_SHADE, GRASS_SHADE_STRENGTH } from '../grassPatches'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import {
  BUILDING_MIN_HEIGHT, ELEVATION_STEP, elevationToY, GROUND_BASE_HEIGHT, HEX_SIZE,
  hexToWorld, mapCenter, WALK_SPEED, worldToHex,
} from '../hexMath'
import { jumpFlight, type JumpPhase } from '../jumpFlight'
import { DEAD_MECH_CHAR_COLOR, MODEL_CHEST_FRACTION, MODEL_SCALE, type SeveredLimbInfo } from './Mech3D'
import { resolveMechModelUrl } from '../mechAssets'
import { AttackEffect, getGlowTexture, ImpactFlash } from './AttackEffects'
import { LightPool } from './LightPool'
import {
  buildBlendedHexGeometry, buildDrapedHexCap, buildEdgeBlendPatch, buildHexGrooveRing, makeHexHeightAt,
} from '../hexTileGeometry'
import { getStampVersion, RELIEF_SKIP_TERRAINS, stampDeformation } from '../terrainRelief'
import { TILE_RAMP_FRACTION, tileHeightInputs } from '../tileHeightField'
import { useProfiledFrame } from './PerfProbe'
import {
  adoptSavedLimb, clearDroppedLimbs, dropLimb, droppedLimbList, droppedLimbVersion, undropLimb,
} from '../droppedLimbs'
import { FallenLimb } from './FallenLimb'

// useMechAnnotationsCache moved to ../mechAnnotations — Mech3D needs it
// too (to read a limb's real membership out of the same saved data), and
// this file already imports Mech3D, so leaving it here would close an
// import cycle. Re-exported so the views keep their existing import.
export { useMechAnnotationsCache }

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

// GROUND_BASE_HEIGHT/ELEVATION_STEP/BUILDING_MIN_HEIGHT/elevationToY now
// live in hexMath.ts (imported above, re-exported here for every existing
// consumer that imports them from this file) — TerrainDecor.tsx's own
// GROUND_FLUSH_TOP needs the exact same ground-level constant to keep
// water/swamp surfaces flush with the real terrain mesh, but
// TerrainDecor.tsx can't import from HERE (this file already imports
// TerrainDecor, and Three/Vite don't tolerate the cycle) — hexMath.ts has
// no such constraint either way.
export { GROUND_BASE_HEIGHT, ELEVATION_STEP, BUILDING_MIN_HEIGHT, elevationToY }

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

// Below this distance (world units) a move is considered "arrived" —
// small enough to be visually indistinguishable from exact, avoids the
// interpolation asymptotically crawling the last fraction of a unit
// forever. Scales with HEX_SIZE so it stays the same tiny FRACTION of a
// hex it always was, not a fixed sub-meter distance that's now way too
// strict against the 30m-wide grid.
export const ARRIVE_EPSILON = 0.01 * HEX_SIZE
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
    && prev.riverFlow === next.riverFlow
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
  /** Current direction per water tile for the whole board — see
   * riverFlow.ts. Passed down rather than derived here because whether a
   * tile is a river or a pond depends on the shape of ALL the water. */
  riverFlow: Map<string, [number, number]>
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
  tile, lookup, riverFlow, losHighlighted, dragHighlighted, needsInitiativeHighlighted, activeMoverHighlighted, moveHighlighted,
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
  const height = elevationToY(tile.terrain, tile.elevation)
  // Terrain cylinders are drawn at 0.98 of the true hex spacing (radius
  // 1.0), leaving a small gap at every seam — harmless against a flat
  // background color, but a visible sliver of raw wood table once
  // TableBackground gave that gap something to show through. This sits
  // just under every tile at the FULL 1.0 radius, so neighboring tiles'
  // own undersized tops leave only a thin ring of it showing — a
  // continuous grid of grooves across the whole board, like the tiles
  // are inset into it, instead of an empty seam. Real user request: "el
  // espacio entre tiles debe ser mucho mas pequeño... menos de la mitad
  // que ahora, un 40% o asi" — was 0.95 (5% gap), 0.98 leaves a 2% gap,
  // ~40% of the old one. That inset (and the corner taper that keeps
  // three-way junctions from blobbing) now lives in hexTileGeometry as
  // CAP_EDGE_INSET, instead of a bare multiplier repeated at every call
  // site here.
  // Real user request: "vamos a eliminar los saltos entre hexes... no
  // suavices demasiado... se tiene que notar que son hexes de diferentes
  // alturas aunque sus fronteras coincidan en altura" — each of this
  // tile's 6 edges ramps toward whatever REAL neighbor sits there (a
  // flush terrain — water/mud/building — or the map's own edge opts a
  // side out, same flat vertical wall it always had), computed once in
  // plain JS by buildBlendedHexGeometry (see its own doc comment for the
  // cross-tile coherence reasoning). Never rotated: unlike the old flat
  // cylinder, this mesh's own vertex positions now encode WHICH
  // real-world edge ramps toward which real neighbor, and rotating the
  // whole mesh would silently point each ramp at the wrong neighbor.
  // Texture variety costs nothing here anymore either way — the UVs are
  // world-space (hexTileGeometry's worldTextureUV), so every tile shows
  // a different crop with the mesh sitting still.
  // One shared derivation of this tile's real surface inputs — see
  // tileHeightField.ts. It used to be duplicated here in full, which is
  // exactly how the riverbed's own band ended up being fixed in one copy
  // and not the other.
  const {
    meshOwnHeight, neighborHeights, neighborBands, bandLow, bandHigh,
  } = useMemo(() => tileHeightInputs(tile, lookup), [tile, lookup])
  // Real user request: "quiero que JUSTO donde pisa el mech queden
  // huellas, quiero crateres" — a footprint/crater lands at any moment
  // during play (terrainRelief.ts's stampDeformation, called from this
  // component's own footprint/impact-mark logic below), long after this
  // tile's own geometry already built — this cheap per-frame poll is
  // what notices "something stamped me" and forces a rebuild (same
  // pattern an earlier, reverted shader attempt already used for texture
  // arrival, just driving a rebuilt geometry instead of a swapped
  // uniform this time).
  const [stampVersion, setStampVersion] = useState(0)
  const stampVersionRef = useRef(0)
  useProfiledFrame('terreno', () => {
    const v = getStampVersion(tile.q, tile.r)
    if (v !== stampVersionRef.current) {
      stampVersionRef.current = v
      setStampVersion(v)
    }
  })
  // Real user report (with screenshot): huellas/cráteres weren't
  // showing at all, and zooming out revealed dark faceted "artefactos"
  // scattered across the terrain instead. Root cause: this tile's own
  // wedge mesh subdivides at a FIXED, coarse density (10 → outer-edge
  // vertex spacing ≈ radius/10 ≈ 2.9 world units) tuned for the smooth
  // large-scale elevation ramp/relief, not for a small stamp (a
  // footprint's real halfWidth/halfDepth, or even a weapon crater's
  // radius 3) — a stamp that size sits BELOW that vertex spacing, so
  // baking it can land on zero nearby vertices (stamp invisible) or one
  // lone vertex pulled down with flat neighbors on every side (a sharp
  // single-point spike/facet under lighting — exactly the dark
  // speckling reported, worse at a distance where the facet's small
  // triangles alias). Only tiles that actually HAVE a stamp
  // (stampVersion > 0, same signal already driving the rebuild above)
  // pay for finer subdivision — the vast majority of tiles, never
  // stamped, keep the cheap coarse mesh exactly as before.
  const STAMP_DETAIL_SUBDIVISIONS = 32
  const BASE_SUBDIVISIONS = 10
  const subdivisions = stampVersion > 0 ? STAMP_DETAIL_SUBDIVISIONS : BASE_SUBDIVISIONS
  // Only terrain that actually grows grass gets the shading — see
  // grassPatches.ts. Everything else passes nothing and bakes plain white.
  const groundTint = useMemo(() => (isGrassTerrain(tile.terrain)
    ? (wx: number, wz: number): [number, number, number] => {
      const d = grassShadeAt(tile.terrain, wx, wz) * GRASS_SHADE_STRENGTH
      return [1 + (GRASS_SHADE.r - 1) * d, 1 + (GRASS_SHADE.g - 1) * d, 1 + (GRASS_SHADE.b - 1) * d]
    }
    : undefined), [tile.terrain])
  const blendedGeometry = useMemo(
    () => buildBlendedHexGeometry(HEX_SIZE, meshOwnHeight, neighborHeights, neighborBands, subdivisions, TILE_RAMP_FRACTION, x, z, bandLow, bandHigh, groundTint),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meshOwnHeight, JSON.stringify(neighborHeights), x, z, bandLow, bandHigh, stampVersion, groundTint],
  )
  // Real user correction: a first fix just raised LosDebugOverlay's own
  // flat disc higher, clearing the terrain's bumps but reading as
  // "floating over the hex's highest point" instead — "quiero que el
  // overlay se ajuste al terreno... que parezca que lo cubre como una
  // sabana". A real draped cap instead: the SAME heightAt this tile's
  // own base mesh already uses (so it's guaranteed to sit flush against
  // whatever that surface actually does — ramped, noisy, stamped), built
  // only when at least one highlight is actually active on this tile
  // (most tiles never are, so this doesn't cost anything map-wide).
  // Shared by every highlight type currently active on this one tile —
  // each gets its own small Y stacking offset applied via its own
  // <mesh>'s position, not baked into the geometry, so one build serves
  // all of them.
  const anyHighlighted = losHighlighted || dragHighlighted || needsInitiativeHighlighted
    || activeMoverHighlighted || moveHighlighted || pathPreviewHighlighted || targetableHighlighted
  const HIGHLIGHT_CAP_SUBDIVISIONS = 6
  const HIGHLIGHT_CAP_LIFT = HEX_SIZE * 0.02
  const drapedHighlightCap = useMemo(() => {
    if (!anyHighlighted) return null
    const { heightAt, capBoundary } = makeHexHeightAt(HEX_SIZE, meshOwnHeight, neighborHeights, neighborBands, TILE_RAMP_FRACTION, x, z, bandLow, bandHigh)
    return buildDrapedHexCap(heightAt, capBoundary, HIGHLIGHT_CAP_SUBDIVISIONS, HIGHLIGHT_CAP_LIFT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyHighlighted, meshOwnHeight, JSON.stringify(neighborHeights), x, z, bandLow, bandHigh, stampVersion])
  // The groove ring and the texture-blend strips used to be built and
  // drawn right here, per tile: 120 draw calls for one flat brown colour
  // plus 284 for the strips, together more than a third of everything the
  // board drew. They are the same geometry now, built by the same
  // functions, but collected into merged per-region batches — see
  // TerrainSkin below.
  const terrainMesh = (
    <mesh
      position={[0, 0, 0]}
      geometry={blendedGeometry}
      userData={{ perfGroup: 'terreno' }}
      receiveShadow
      // Real user report: a diagonal shadow streak crossing several
      // hexes, present since the very first wall-geometry attempt and
      // still there with this one — the tile's own wall/ramp geometry
      // casting a shadow onto ITSELF/its neighbors, not anything wrong
      // with the directional light. Terrain never needs to shadow other
      // terrain for the elevation/ramp to read correctly (mechs/trees
      // still cast real shadows onto it via receiveShadow above) — only
      // this self-shadowing was ever the problem, so this is the whole
      // fix, not a workaround for a symptom.
      castShadow={false}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => {
        e.stopPropagation()
        onPointerUp?.(e)
      }}
    >
      <meshStandardMaterial
        color={terrainColor(tile.terrain)}
        map={terrainTexture(tile.terrain, tile.q, tile.r)}
        // Carries the grass-density shading baked into the geometry above.
        // Always on, because every tile bakes the attribute (white where
        // there is no tint) — see buildBlendedHexGeometry's own note on why
        // a sometimes-present attribute is worse than a constant one.
        vertexColors
        side={THREE.DoubleSide}
      />
    </mesh>
  )
  // The long note that used to sit here — why these strips are ordinary
  // transparent meshes rather than a shader, why MeshLambert rather than
  // MeshStandard (Standard silently drops vertex alpha when combined with
  // a map in this three.js version) and rather than MeshBasic (an unlit
  // strip fading over lit ground reads as a glowing halo, a real user
  // report) — now lives on blendMaterialFor, which builds the merged
  // strips' shared material.
  return (
    <group position={[x, 0, z]}>
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
      {!fogged && <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} physics={physics} riverFlow={riverFlow} />}
      {drapedHighlightCap && (
        <>
          {losHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#39ff8f" />}
          {dragHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#f5c542" yOffset={0.03 * HEX_SIZE} />}
          {needsInitiativeHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#ff3b3b" opacity={0.45} yOffset={0.04 * HEX_SIZE} />}
          {activeMoverHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#ffb020" opacity={0.5} yOffset={0.05 * HEX_SIZE} />}
          {/* Real user request: from FirstPersonView's near-ground eye-level
              camera, the old +0.12 gap read as visibly floating above the
              hex — a small perspective effect a top-down camera never
              revealed. Halving the whole stack (still staggered, just
              tighter) keeps every highlight type distinguishable without
              the floating look, in both this and GMView's own top-down use. */}
          {moveHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#4a9eff" opacity={0.4} yOffset={0.06 * HEX_SIZE} />}
          {pathPreviewHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#ffffff" opacity={0.55} yOffset={0.065 * HEX_SIZE} />}
          {targetableHighlighted && <LosDebugOverlay geometry={drapedHighlightCap} color="#e35d5d" opacity={0.45} yOffset={0.07 * HEX_SIZE} />}
        </>
      )}
    </group>
  )
}, tilePropsEqual)

// Debug-only stand-in for VISION.md §4.2's real per-player vision-cone
// fog (still unbuilt) — a translucent hex over every tile a chosen unit
// currently has LoS to, so "does this mech see anything" is at least
// answerable by eye today instead of invisible until the real feature
// lands. See useUnitLosDebug in TableView.tsx.
//
// Real user report: "cuando hago zoom out a veces las tiles se rompen y
// muestran cosas que 'estan debajo' como overlay amarillos" — this used
// to be a flat cylinder at a fixed Y with a small clearance above the
// tile's own flat `elevationToY` height; the terrain mesh itself stopped
// being flat earlier this session (buildBlendedHexGeometry's own
// within-hex noise/ramp), so its own bumps could poke above that thin
// clearance and fail the disc's depth test right there — a real
// mid-surface dropout, worse at a distance. First fix just raised the
// disc's own clearance — real user correction: "no quiero que
// simplemente eleves un overlay plano... quiero que el overlay se
// ajuste al terreno... que parezca que lo cubre como una sabana". Now a
// real draped cap (`geometry`, built by Tile's own drapedHighlightCap
// using the EXACT SAME heightAt that tile's own base mesh already uses)
// instead of a flat disc — it follows the real bumpy/ramped surface
// directly, so there's no clearance to get wrong in the first place.
// `yOffset` is only the SMALL relative stacking amount between several
// simultaneously-active highlight types on the same tile (all sharing
// the one draped geometry, each its own thin parallel sheet just above
// the last), not a clearance against the terrain.
function LosDebugOverlay({
  geometry, color, yOffset = 0, opacity = 0.32,
}: { geometry: THREE.BufferGeometry; color: string; yOffset?: number; opacity?: number }) {
  return (
    <mesh geometry={geometry} position={[0, yOffset, 0]}>
      <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} side={THREE.DoubleSide} />
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
  useProfiledFrame('vapor', (state) => {
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
      // MECH-factor scaled (tuned by eye against the mech, same family as
      // FOG_HEIGHT above) — both the burst's travel distance (speed, a
      // world-units/sec multiplier on dir) and the sprite size need to
      // stay proportionate to the now-10-world-unit-tall mech.
      speed: (0.6 + Math.random() * 0.8) * (MODEL_SCALE / 1.65),
      size: (0.3 + Math.random() * 0.35) * (MODEL_SCALE / 1.65),
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
  useProfiledFrame('explosiones', (state) => {
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
/** Compares two severed-location sets by CONTENTS.
 *
 * Real user report: "cuando 'pierde extremidades'... no se actualiza ni el
 * FPV, ni el GMView ni el TableView, si les refresco se ve sin
 * extremidades... nunca veo las extremidades en el mapa, ni las veo caer."
 *
 * unitMarkerPropsEqual did not look at severedLocations at all, so a mech
 * that had just lost an arm compared equal to the same mech with the arm
 * still on: the marker never re-rendered, Mech3D never saw the new set,
 * and — because the fall is reported from that same effect — no limb was
 * ever handed to the board to drop. A reload looked like it worked only
 * because a fresh mount has no memoised render to skip.
 *
 * By contents and not by identity: the views rebuild these sets from
 * scratch on every poll, so comparing references would re-render every
 * mech on the board several times a second, which is the exact cost this
 * comparator exists to avoid. */
function sameSeveredLocations(prev?: ReadonlySet<string>, next?: ReadonlySet<string>) {
  if (prev === next) return true
  const prevSize = prev?.size ?? 0
  if (prevSize !== (next?.size ?? 0)) return false
  if (prevSize === 0) return true
  for (const location of prev!) if (!next!.has(location)) return false
  return true
}

function unitMarkerPropsEqual(prev: Readonly<UnitMarkerProps>, next: Readonly<UnitMarkerProps>) {
  return sameSeveredLocations(prev.severedLocations, next.severedLocations)
    && prev.unit === next.unit
    && prev.elevation === next.elevation
    && prev.terrain === next.terrain
    && prev.physics === next.physics
    && prev.walkPath === next.walkPath
    && prev.movementType === next.movementType
    && prev.heightAt === next.heightAt
    && prev.outlined === next.outlined
    && prev.heat === next.heat
    && prev.boardgameScale === next.boardgameScale
    && prev.prone === next.prone
    && prev.shutdown === next.shutdown
    && prev.destroyedReason === next.destroyedReason
    && prev.worldOffset[0] === next.worldOffset[0] && prev.worldOffset[1] === next.worldOffset[1]
    && (prev.dragPosition === next.dragPosition
      || (prev.dragPosition != null && next.dragPosition != null
        && prev.dragPosition[0] === next.dragPosition[0] && prev.dragPosition[1] === next.dragPosition[1]))
}

// Real user request: "en GMview y en tableview los mechs deben ocupar
// toda la hex, solo ahi, por el tema de jugar al juego de tablero" — the
// realistic 10m-mech-on-a-30m-hex proportions (the whole point of the
// scale normalization above) read as "too small to click/read" on the
// tabletop views, so those two get a purely-visual boardgame-token scale
// instead, same convention real BattleTech miniatures use (a mini that
// visibly overflows its own hex). Rather than pick a new number by eye,
// this reproduces the OLD (pre-normalization) implicit ratio — mech
// height was 1.65 world units against a hex of circumradius 1, i.e.
// 1.65x the hex — on the NEW grid: (1.65 * HEX_SIZE) world units of mech
// height, expressed as a multiplier on the real MODEL_SCALE. FirstPersonView's
// own <HexMap> instance deliberately does NOT set this (real scale only
// there — "solo ahi" was explicit).
export const BOARDGAME_MECH_SCALE = (1.65 * HEX_SIZE) / MODEL_SCALE

type UnitMarkerProps = {
  unit: Unit
  elevation: number
  /** The terrain of the tile this unit is currently standing on — only
   * consulted to sink a unit's resting height into water/mud (terrainSinkY),
   * so a mech visibly wades/sinks instead of standing on an invisible
   * floor at the dry-land elevation height while the surface covers its
   * ankles. */
  terrain: string
  /** Full q,r→terrain lookup for the whole map — unlike `terrain` above
   * (just THIS unit's own current/destination hex), this unit's own
   * real-time footprint stamping (stepToward's queue-arrival branch)
   * needs to gate EVERY intermediate hex a multi-hex walk actually
   * crosses, not just the final one. */
  terrainAt: Map<string, string>
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
  /** Location codes whose structure has reached 0 — see Mech3D's own prop. */
  severedLocations?: Set<string>
  /** Forwarded straight to Mech3D — see its own prop. */
  onLimbSevered?: (info: SeveredLimbInfo) => void
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
  /** BOARDGAME_MECH_SCALE's own opt-in — GMView/TableView pass true,
   * FirstPersonView leaves this unset (real scale). See that constant's
   * doc comment for why. */
  boardgameScale?: boolean
  /** Forwarded straight to Mech3D's own `onFootstep` (see its doc
   * comment) — real per-bone footfall, only fires for a chassis actually
   * rigged with PieD/PieI (the Jenner today). The parent (this
   * component's own default export) uses this to stamp a real oriented
   * footprint AND to remember that this unit has real foot tracking, so
   * its own geometric-approximation fallback loop (below) can skip it.
   * Same unitMarkerPropsEqual exclusion as onWalkDone/onWalkStep above. */
  onFootstep?: (worldPos: [number, number, number], footHalfWidth: number, footHalfDepth: number, rotationY: number) => void
}

const UnitMarker = memo(function UnitMarker({
  unit, elevation, terrain, terrainAt, dragPosition, physics, worldOffset, walkPath, movementType, heightAt, outlined, heat,
  prone, shutdown, destroyedReason, severedLocations, onLimbSevered, boardgameScale,
  onPointerDown, onPointerUp, onWalkDone, onWalkStep, onFootstep,
}: UnitMarkerProps) {
  const target = dragPosition ?? hexToWorld(unit.q, unit.r)
  // 'building' matches Tile's own fixed platform height (BUILDING_MIN_
  // HEIGHT), not the elevation formula every other terrain uses here —
  // a mech standing on a building tile needs to rest on the SAME
  // surface height that tile actually renders at, or it visibly floats
  // above (a real elevation-2 building tile's platform sits at
  // GROUND_BASE_HEIGHT, not GROUND_BASE_HEIGHT + 2*ELEVATION_STEP).
  const restY = terrainSinkY(terrain) ?? elevationToY(terrain, elevation)
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

  // Real user report: drop a dragged mech and it visibly WALKED back to
  // its original hex first, only THEN starting the real commanded move —
  // backwards from "drag y drop... el mech snapea rapidamente a su
  // posicion original y comienza el movimiento". Root cause: while
  // dragging, `canWalk` is false and stepToward snaps `animatedPos`
  // straight to the cursor every frame (no easing) — correct. The
  // instant the drag ends, `dragPosition` clears, `canWalk` flips back
  // to true, and `target` immediately resolves to `hexToWorld(unit.q,
  // unit.r)` — the unit's real, server-confirmed hex, which at that
  // exact moment is STILL THE OLD ONE (the move command's own walkPath
  // hasn't arrived yet, that's an async round-trip). With no queued
  // path yet, stepToward's normal "direct line to target" branch takes
  // over and EASES from wherever the cursor dropped it toward that old
  // hex — a real, visible walk-back, before the destination's real
  // walkPath ever shows up to redirect it. Declared BEFORE the walkPath
  // effect below (both fire in the same commit when a drag-drop
  // immediately triggers a move) so animatedPos is already reset by the
  // time that effect reads it for its own initial-heading check.
  const prevDragPositionRef = useRef(dragPosition)
  useEffect(() => {
    if (prevDragPositionRef.current && !dragPosition) {
      animatedPos.current = target
      animatedY.current = baseY
      animatedRot.current = facingRotationY
    }
    prevDragPositionRef.current = dragPosition
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragPosition])

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
  // Real footprints, synced to this unit's own VISUAL arrival at each
  // real waypoint (stepToward's own queue-arrival branch below) instead
  // of a separate prop-watching effect — see that branch's own doc
  // comment for the real bug this replaced. legStartRef is the world
  // position the CURRENT leg started from (reset below whenever a fresh
  // walkPath arrives, and updated to each waypoint just reached so the
  // NEXT leg's own start is correct); footprintSideRef alternates which
  // side of the travel direction each print lands on, a real walking
  // gait instead of both feet landing on the centerline.
  const legStartRef = useRef<[number, number]>(animatedPos.current)
  const footprintSideRef = useRef(1)
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
      // Fresh route — the first leg's own footprint trail starts from
      // wherever the mech is RIGHT NOW, not wherever the previous,
      // unrelated move's last leg happened to end.
      legStartRef.current = animatedPos.current
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
        // Real user report, blunt: the OLD footprint system (a separate
        // useEffect reacting to the units/walkPaths PROPS) fired the
        // instant the server confirmed a move — which happens
        // immediately, long before this component's own SLOW visual
        // walk animation actually finishes sliding across the board —
        // "pinta las huellas por tiles que aun no ha pasado... segunda
        // vez que le mando andar, no pinta nada" (footprints appeared on
        // tiles the animation hadn't visually reached yet, or sometimes
        // not at all — a data-driven effect racing an unrelated,
        // independently-timed animation is exactly this kind of
        // unreliable). Stamping HERE instead — the exact frame the
        // visual walk itself arrives at a real waypoint, the same
        // instant onWalkStep already fires for fog — ties footprints
        // directly to what's actually on screen, with no separate
        // timing to race against.
        const arrivedHex = worldToHex(immediateTarget.x, immediateTarget.z)
        if (canWalk && FOOTPRINT_TERRAINS.has(terrainAt.get(`${arrivedHex.q},${arrivedHex.r}`) ?? '')) {
          const [legFromX, legFromZ] = legStartRef.current
          const legDx = immediateTarget.x - legFromX
          const legDz = immediateTarget.z - legFromZ
          const legDist = Math.hypot(legDx, legDz) || 1
          const travelAngle = Math.atan2(legDz, legDx)
          const perpAngle = travelAngle + Math.PI / 2
          const ux = legDx / legDist, uz = legDz / legDist
          for (let step = 1; step <= STEPS_PER_HEX; step++) {
            const backDist = (STEPS_PER_HEX - step) * STEP_SPACING
            const side = -footprintSideRef.current
            footprintSideRef.current = side
            stampDeformation(
              immediateTarget.x - ux * backDist + Math.cos(perpAngle) * side * 0.09 * HEX_SIZE,
              immediateTarget.z - uz * backDist + Math.sin(perpAngle) * side * 0.09 * HEX_SIZE,
              1.2, FOOTPRINT_DEPTH,
            )
          }
        }
        legStartRef.current = [immediateTarget.x, immediateTarget.z]
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
  useProfiledFrame('unidades (movim.)', (_state, delta) => {
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
  // BOARDGAME_MECH_SCALE's own doc comment — real scale (1) everywhere
  // except GMView/TableView, which opt in via boardgameScale. Wrapping
  // the whole visual subtree (model + explosion VFX + steam puffs, whose
  // own vent-point offsets are already MODEL_SCALE-relative) in one group
  // scale keeps every part of it proportionate to the model, instead of
  // rescaling each piece's constants independently.
  const mechScale = boardgameScale ? BOARDGAME_MECH_SCALE : 1
  const mechOrMarker = (
    <group scale={mechScale}>
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
              severedLocations={severedLocations}
              onLimbSevered={onLimbSevered}
              emissive={glowEmissive} emissiveIntensity={glowEmissiveIntensity}
              tintStrength={tintStrength}
              onLoaded={() => forceMeshRegistered((n) => n + 1)}
              onFootstep={onFootstep}
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
    </group>
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
          <CuboidCollider
            args={[0.374 * MODEL_SCALE * mechScale, 0.5 * MODEL_SCALE * mechScale, 0.310 * MODEL_SCALE * mechScale]}
            position={[0, 0.5 * MODEL_SCALE * mechScale, 0]}
          />
        ) : (
          <CuboidCollider args={[0.35 * mechScale, 0.35 * mechScale, 0.35 * mechScale]} position={[0, 0.35 * mechScale, 0]} />
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

// Evenly-spaced prints per hex crossed, not just one at its far end —
// "quiero mas de una footprint por tile, en la direccion del
// movimiento", real user request after a single-print-per-hex version
// read as too sparse.
const STEPS_PER_HEX = 3
// World units (meters, now — see hexMath.ts's own HEX_SIZE) between
// consecutive steps within one hex — (STEPS_PER_HEX - 1) * STEP_SPACING
// must stay under a hex's own ~0.95*HEX_SIZE radius so every step lands
// inside the CURRENT (snow) tile, not the previous one. Scaled by the
// same HEX_SIZE factor as the grid itself (not a real per-step stride
// length — this is "a few evenly-spaced marks across whatever hex was
// just crossed," always exactly STEPS_PER_HEX of them regardless of the
// hex's real size, same as before the rescale).
const STEP_SPACING = 0.3 * HEX_SIZE
// Real user request: "quiero las huellas en todos los terrenos blandos,
// llanura, colina, bosque, bosque denso, nieve" — was 'snow'-only.
// Deliberately excludes water/water_deep/swamp (already flush/no relief
// — see RELIEF_SKIP_TERRAINS), road/rough/rubble (hard surfaces, no
// "blando" reading), and building (a flat platform, same reasoning).
const FOOTPRINT_TERRAINS = new Set(['plains', 'hills', 'forest', 'light_forest', 'snow'])
// Real user report (with screenshot): footprints weren't reading as
// visible dents at all — 0.25 was shallow enough to get lost against the
// terrain's own ambient relief noise (amplitude ~3.6, see
// terrainRelief.ts's RELIEF_AMPLITUDE). Module-level (not component-
// local) since UnitMarker's own real-time footprint stamping needs it
// too, not just the outer component's real-bone-tracked path.
const FOOTPRINT_DEPTH = 0.45

// Real user request: "cuando dos tiles adyacentes tienen texturas
// diferentes, la transicion es brusca... quiero que se blendeen las
// texturas de tiles diferentes en el borde... no habra blend entre
// otras casillas y las casillas de agua... vamos con eso de momento" —
// see Tile's own blendStrips useMemo for the full reasoning. Width is a
// fraction of the hex's own apothem, deliberately narrow — a wide blend
// would read as "this whole edge is a third texture," not a border
// transition. Reuses RELIEF_SKIP_TERRAINS as the exclusion set (every
// terrain in it already has its own fixed/flush surface treatment
// elsewhere, not just water). LIFT is now much smaller than the first
// attempt needed — that attempt was ALSO fighting the scene-wide
// near:far depth-precision bug (see GMView.tsx's own fix), not just
// this strip's own z-fighting.

/** Shape of the groove ring between tiles. DROP is how far under the tile's
 * own surface its visible top sits — what makes the seam read as a groove
 * the tiles are inset into rather than as a flat join. SKIRT is how far its
 * outer wall carries on down, so the gap looks like a slot with depth
 * instead of a ribbon floating in one. SEGMENTS only has to be enough to
 * follow the ground's own curvature along an edge. */
const GROOVE_SEGMENTS = 8
const GROOVE_DROP = 0.35
const GROOVE_SKIRT = 1.2

const TEXTURE_BLEND_SKIP_TERRAINS = RELIEF_SKIP_TERRAINS
// Real user follow-up on that first version: "quiero que los cambios de
// textura no se aprecien tan bruscos... no tiene por que ser justo en la
// frontera entre tiles, puedes hacer degradados de diferentes formas en
// diferentes sitios." The old 0.12 was a hairline ribbon that just drew
// the hex outline in the neighbor's texture; this is the widest the
// transition may reach (~48% of the apothem, so two facing borders can
// never meet in the middle of a tile), and buildEdgeBlendPatch's own
// noise mask is what decides where inside that band the real boundary
// actually lands — typically far short of it, in ragged patches.
const TEXTURE_BLEND_MAX_WIDTH = HEX_SIZE * 0.55
// Per-border share of that maximum, picked from a hash below: some
// borders fade over the full band, others stay tight and abrupt.
const TEXTURE_BLEND_MIN_WIDTH_FACTOR = 0.5
// Enough to resolve buildEdgeBlendPatch's own FINE_WAVELENGTH (which is
// tuned against this density in the other direction — the two numbers
// have to be changed together or the mask aliases into speckle).
const TEXTURE_BLEND_SEGMENTS_ALONG = 16
const TEXTURE_BLEND_SEGMENTS_IN = 8
// Much smaller than the first version's HEX_SIZE * 0.04: that lift was
// invisible on a hairline ribbon, but a band this wide floating ~1.2
// world units over the ground would read as a hovering decal from any
// low camera (FirstPersonView's especially). polygonOffset on the
// material carries most of the z-fighting defense; this is just the
// belt-and-braces gap that a real user report showed was needed.
const TEXTURE_BLEND_LIFT = HEX_SIZE * 0.012

/** Per-BORDER (not per-tile) random parameters for a texture blend: how
 * wide that particular transition is allowed to be, and where in the
 * shared noise field its pattern is sampled from. Keyed on the two tile
 * coordinates in a canonical order, so the tile on each side of a border
 * independently computes the IDENTICAL values — that agreement is what
 * lets both halves of one transition line up into a single continuous
 * pattern instead of two unrelated ones meeting at the edge. */
function blendBorderParams(
  q: number, r: number, nq: number, nr: number,
): { width: number; noiseOffsetX: number; noiseOffsetZ: number; flipped: boolean } {
  const first = q < nq || (q === nq && r < nr)
  const [aq, ar, bq, br] = first ? [q, r, nq, nr] : [nq, nr, q, r]
  const h = hashTile(aq * 1024 + bq, ar * 1024 + br, 'texture-blend-border')
  const t = (h % 1000) / 1000
  return {
    width: TEXTURE_BLEND_MAX_WIDTH * (TEXTURE_BLEND_MIN_WIDTH_FACTOR + (1 - TEXTURE_BLEND_MIN_WIDTH_FACTOR) * t),
    // Arbitrary large-ish strides through the noise field — big enough
    // that two different borders never sample overlapping neighborhoods
    // of it and end up with visually twinned patterns.
    noiseOffsetX: ((h >>> 10) % 977) * 6.13,
    noiseOffsetZ: ((h >>> 20) % 983) * 7.41,
    // Which half of this border we are. The two tiles derive it from the
    // SAME canonical ordering, so exactly one of them gets `true` — see
    // buildEdgeBlendPatch's own doc comment for why that is the whole
    // reason the two halves compose into one crossfade.
    flipped: !first,
  }
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
// MECH-factor scaled (tuned by eye against the mech, not the hex grid —
// this was always "about knee-to-chest height on a mech standing in it,"
// never tied to hex spacing), against MODEL_SCALE's own old value (1.65)
// so this tracks correctly if MODEL_SCALE is ever retuned again.
const FOG_HEIGHT = 1.7 * (MODEL_SCALE / 1.65)
// Real user request: "en FPV deberia ser mas sutil... debe tener mas
// altura, que no se vea donde termina por arriba" — a completely
// separate, MUCH taller volume for that view (see FogRegionMesh's own
// `subtle` prop), so there's real height for the fragment shader's own
// upward fade to fade all the way to invisible well before any real
// top edge could ever be seen from inside/beside it.
const FOG_HEIGHT_SUBTLE = FOG_HEIGHT * 4.2

// Real user follow-up: "es como un bloque gris geometrico... quiero que
// sea como una nube densa, o humo blanco, que tenga corriente y
// movimiento/turbulencia" — a single flat noise-modulated alpha on one
// rigid extruded polygon (the previous version) always reads as "a solid
// shape with a texture on it," because the shape's own silhouette never
// moves and there's no sense of depth/parallax. Three real, independently
// time-phased/offset copies of the SAME region geometry (see
// FogRegionMesh below) fixes both at once: each layer's own noise flow
// runs at a different speed/direction so they visibly drift past each
// other (the "corriente" — real relative motion, not just one static
// pattern scrolling), and stacking partial-opacity layers naturally
// varies local density the way real layered fog/smoke does, instead of
// one uniform slab. yOffset is in world units (a small vertical stagger,
// like sedimentary bands); flowAngle is radians; opacity is this layer's
// OWN multiplier on top of the caller's overall uOpacity.
// yOffset values are MECH-factor scaled (small vertical stagger tuned by
// eye against the mech, same family as FOG_HEIGHT above) so the layers
// stay proportionately "thin sedimentary bands" at the new scale instead
// of collapsing to a barely-there fraction of the now-much-taller volume.
const FOG_YOFFSET_SCALE = MODEL_SCALE / 1.65
const FOG_LAYERS = [
  { yOffset: 0, flowAngle: 0.6, flowSpeed: 1, noiseScale: 1, opacity: 1 },
  { yOffset: 0.22 * FOG_YOFFSET_SCALE, flowAngle: 2.4, flowSpeed: 0.62, noiseScale: 1.7, opacity: 0.65 },
  { yOffset: 0.42 * FOG_YOFFSET_SCALE, flowAngle: 4.4, flowSpeed: 1.35, noiseScale: 0.55, opacity: 0.5 },
] as const

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
  return [cx + HEX_SIZE * Math.sin(theta), cz + HEX_SIZE * Math.cos(theta)]
}

// Axial neighbor offsets, matching hexToWorld's own convention — offset
// k shares the edge between corners (k+1)%6 and (k+2)%6 (derived from
// hexToWorld's own trigonometry: neighbor k's direction always points
// exactly through the midpoint of that edge).
const FOG_HEX_NEIGHBORS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]

/** How many hexes across one merged terrain-skin batch covers.
 *
 * The tension: bigger regions mean fewer draw calls, but a footprint or a
 * crater rebuilds a whole region (every geometry in it is a function of
 * its tile's own stamp version), and a region that spans the map would
 * rebuild the map on every step a mech takes. Four is a compromise picked
 * against the real board: ~16 tiles per batch takes 120 grooves and 284
 * strips down to roughly a dozen batches each, while a footstep rebuilds
 * a sixteenth of the board rather than all of it. */
const TERRAIN_BATCH_SPAN = 4

/** Materials for the merged strips, shared across every batch that needs
 * the same one. Sharing matters twice over: fewer materials is fewer
 * shader-program binds per frame (the thing that makes each draw call cost
 * ~21µs on this board), and it is what lets two regions with the same
 * neighbouring terrain be two draws instead of two draws AND two
 * materials. */
const blendMaterialCache = new Map<string, THREE.MeshLambertMaterial>()

function blendMaterialFor(terrain: string, q: number, r: number): THREE.MeshLambertMaterial {
  const texture = terrainTexture(terrain, q, r)
  const color = terrainColor(terrain)
  const key = `${texture?.uuid ?? 'none'}|${color}`
  let material = blendMaterialCache.get(key)
  if (!material) {
    // Every setting here is the per-tile material this replaces, verbatim
    // — see the long note that used to sit on it: MeshLambert rather than
    // Standard because Standard drops vertex alpha when combined with a
    // map in this three.js version, and rather than Basic because an
    // unlit strip fading over lit ground reads as a glowing halo.
    material = new THREE.MeshLambertMaterial({
      map: texture,
      color,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    })
    blendMaterialCache.set(key, material)
  }
  return material
}

const grooveMaterial = new THREE.MeshStandardMaterial({
  color: '#241a10', roughness: 0.9, side: THREE.DoubleSide,
})

interface SkinBatch {
  key: string
  geometry: THREE.BufferGeometry
  material: THREE.Material
  groove: boolean
}

/** Builds one region's merged geometry: every groove ring in it as one
 * mesh, and its blend strips as one mesh per neighbouring material.
 *
 * The per-tile builders are called exactly as Tile called them, and their
 * output is tile-LOCAL (Tile placed it with a positioned group), so each
 * geometry is translated into world space before merging. */
function buildSkinBatches(
  tiles: HexTileData[], lookup: Map<string, HexTileData>, keyPrefix: string,
): SkinBatch[] {
  const grooves: THREE.BufferGeometry[] = []
  const strips = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>()

  for (const tile of tiles) {
    const [x, z] = hexToWorld(tile.q, tile.r)
    const {
      meshOwnHeight, neighborHeights, neighborBands, bandLow, bandHigh,
    } = tileHeightInputs(tile, lookup)
    const { heightAt, capBoundary } = makeHexHeightAt(
      HEX_SIZE, meshOwnHeight, neighborHeights, neighborBands, TILE_RAMP_FRACTION, x, z, bandLow, bandHigh,
    )

    const groove = buildHexGrooveRing(HEX_SIZE, heightAt, capBoundary, GROOVE_SEGMENTS, GROOVE_DROP, GROOVE_SKIRT)
    groove.translate(x, 0, z)
    grooves.push(groove)

    if (TEXTURE_BLEND_SKIP_TERRAINS.has(tile.terrain)) continue
    const ownTexture = terrainTexture(tile.terrain, tile.q, tile.r)
    const ownColor = terrainColor(tile.terrain)
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = FOG_HEX_NEIGHBORS[k]
      const neighborQ = tile.q + dq
      const neighborR = tile.r + dr
      const neighborTerrain = lookup.get(`${neighborQ},${neighborR}`)?.terrain ?? null
      if (!neighborTerrain) continue
      if (TEXTURE_BLEND_SKIP_TERRAINS.has(neighborTerrain)) continue
      // Two tiles render different pixels if EITHER half of
      // (texture, colour) differs — forest and light_forest share one
      // photo and differ only by their canopy-shadow multiply.
      if (terrainTexture(neighborTerrain, neighborQ, neighborR) === ownTexture
        && terrainColor(neighborTerrain) === ownColor) continue
      const { width, noiseOffsetX, noiseOffsetZ, flipped } = blendBorderParams(tile.q, tile.r, neighborQ, neighborR)
      const geometry = buildEdgeBlendPatch(
        HEX_SIZE, heightAt, capBoundary, k, width,
        TEXTURE_BLEND_SEGMENTS_ALONG, TEXTURE_BLEND_SEGMENTS_IN, TEXTURE_BLEND_LIFT,
        x, z, noiseOffsetX, noiseOffsetZ, flipped,
      )
      geometry.translate(x, 0, z)
      const material = blendMaterialFor(neighborTerrain, neighborQ, neighborR)
      let bucket = strips.get(material.uuid)
      if (!bucket) { bucket = { material, parts: [] }; strips.set(material.uuid, bucket) }
      bucket.parts.push(geometry)
    }
  }

  const out: SkinBatch[] = []
  const mergedGroove = grooves.length > 0 ? mergeGeometries(grooves, false) : null
  // mergeGeometries copies everything it is given, so the per-tile pieces
  // are rubbish the moment the merge is done.
  grooves.forEach((g) => g.dispose())
  if (mergedGroove) {
    out.push({ key: `${keyPrefix}:groove`, geometry: mergedGroove, material: grooveMaterial, groove: true })
  }
  for (const [id, bucket] of strips) {
    const merged = mergeGeometries(bucket.parts, false)
    bucket.parts.forEach((g) => g.dispose())
    if (merged) out.push({ key: `${keyPrefix}:strip:${id}`, geometry: merged, material: bucket.material, groove: false })
  }
  return out
}

/** One region's worth of merged grooves and blend strips.
 *
 * It watches its own tiles' stamp versions the same way Tile watches its
 * own: a footprint or a crater changes the ground those rings and strips
 * sit on, so the batch has to be rebuilt. Only this region's, though —
 * that is the whole reason the board is cut into regions at all. */
const TerrainSkinRegion = memo(function TerrainSkinRegion({
  tiles, lookup, regionKey,
}: { tiles: HexTileData[]; lookup: Map<string, HexTileData>; regionKey: string }) {
  const regionSignature = useMemo(
    () => tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|'),
    [tiles],
  )
  const [stamps, setStamps] = useState('')
  const stampsRef = useRef('')
  useProfiledFrame('terreno', () => {
    let key = ''
    for (const tile of tiles) key += `${getStampVersion(tile.q, tile.r)},`
    if (key !== stampsRef.current) {
      stampsRef.current = key
      setStamps(key)
    }
  })

  const batches = useMemo(
    () => buildSkinBatches(tiles, lookup, regionKey),
    // Content, not identity — see HexMap's own tilesSignature. Rebuilding a
    // region's merged grooves and blend strips is expensive enough that
    // doing it on every poll was most of the cockpit's load time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionSignature, regionKey, stamps],
  )

  useEffect(() => () => {
    // Materials are shared and cached board-wide; the merged geometry is
    // this batch's own and nothing else will free it.
    batches.forEach((b) => b.geometry.dispose())
  }, [batches])

  return (
    <>
      {batches.map((b) => (
        <mesh
          key={b.key}
          geometry={b.geometry}
          material={b.material}
          userData={{ perfGroup: b.groove ? 'terreno' : 'terreno (blend)' }}
          receiveShadow={b.groove}
          castShadow={false}
        />
      ))}
    </>
  )
})

/** The board's grooves and texture-blend strips, merged by region.
 *
 * These carry no pointer handlers and no colliders — they are pure
 * surface dressing — which is exactly why they can be merged without
 * touching how a tile is picked, dragged onto, or collided with. The
 * terrain mesh itself still draws per tile for that reason. */
function TerrainSkin({ tiles, lookup }: { tiles: HexTileData[]; lookup: Map<string, HexTileData> }) {
  const regions = useMemo(() => {
    const out = new Map<string, HexTileData[]>()
    for (const tile of tiles) {
      const key = `${Math.floor(tile.q / TERRAIN_BATCH_SPAN)},${Math.floor(tile.r / TERRAIN_BATCH_SPAN)}`
      const bucket = out.get(key)
      if (bucket) bucket.push(tile)
      else out.set(key, [tile])
    }
    return [...out.entries()].map(([key, regionTiles]) => ({ key, tiles: regionTiles }))
    // Keyed on content, not on the array identity a session refetch
    // replaces — same reasoning as GroundVegetation's own tilesKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|')])

  return (
    <>
      {regions.map((region) => (
        <TerrainSkinRegion key={region.key} regionKey={region.key} tiles={region.tiles} lookup={lookup} />
      ))}
    </>
  )
}
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
  /** Height difference between the lowest and highest ground the region
   * covers, added on top of the fog's own thickness so the volume reaches
   * over the high ground instead of ending below it. */
  span: number
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
    return { shape, outerPoints: ccw, baseY: Infinity, topY: -Infinity }
  })

  for (const hole of holeLoops) {
    const cw = fogSignedArea(hole) > 0 ? [...hole].reverse() : hole
    const owner = regions.find((r) => fogPointInPolygon(hole[0], r.outerPoints))
    if (owner) owner.shape.holes.push(new THREE.Path(cw.map(([x, z]) => new THREE.Vector2(x, z))))
  }

  for (const tile of fogTiles) {
    const [cx, cz] = hexToWorld(tile.q, tile.r)
    const region = regions.find((r) => fogPointInPolygon([cx, cz], r.outerPoints))
    if (region) {
      region.baseY = Math.min(region.baseY, tile.groundY)
      // The HIGHEST ground in the region matters as much as the lowest. A
      // region spanning two elevation levels has 12 world units between its
      // floor and its ceiling, and a fixed-height volume raised from the
      // floor simply ends below the high ground, which then stands out of
      // the fog untouched. Real user report: "a veces el terreno elevado la
      // clipea."
      region.topY = Math.max(region.topY, tile.groundY)
    }
  }

  return regions
    .filter((r) => Number.isFinite(r.baseY))
    .map((r) => ({ shape: r.shape, baseY: r.baseY, span: Math.max(0, r.topY - r.baseY) }))
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
// Shared between both shader stages (three.js just concatenates whatever
// GLSL text it's given — no separate "shader library" mechanism here) so
// the vertex stage's own turbulence displacement and the fragment stage's
// own density noise stay the exact same noise function, not two
// independently-drifting approximations of "similar-looking" noise.
const fogNoiseGLSL = /* glsl */ `
  float fogHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float fogValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = fogHash(i);
    float b = fogHash(i + vec2(1.0, 0.0));
    float c = fogHash(i + vec2(0.0, 1.0));
    float d = fogHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float fogFbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.55;
    for (int i = 0; i < 4; i++) {
      if (i >= octaves) break;
      value += amplitude * fogValueNoise(p);
      p *= 2.05;
      amplitude *= 0.5;
    }
    return value;
  }
`

// Real user report: "es como un bloque gris geometrico... quiero que sea
// como una nube densa, o humo blanco, que tenga corriente y
// movimiento/turbulencia" — the previous version only ever animated
// ALPHA on a perfectly rigid extruded polygon, so the shape's own outer
// edge never moved and read as "a solid block with a texture," no matter
// how the density noise was tuned. This displaces the actual vertex
// positions (mostly near the top — see the `lift` falloff below, which
// keeps the base flush with the ground so it doesn't visibly detach from
// the terrain) with the SAME noise function the fragment shader uses for
// density, so the silhouette itself billows instead of just its opacity.
const fogVertexShader = /* glsl */ `
  ${fogNoiseGLSL}
  uniform float uTime;
  uniform float uBaseY;
  uniform float uTopY;
  uniform float uNoiseScale;
  uniform vec2 uFlowDir;
  // Real user report: FPV's own volume (tall, viewed up close/from the
  // side instead of TableView's steep top-down angle) billowing by the
  // SAME absolute amount as the blocking variant pushed it clean outside
  // its own hex and over/around whatever — a mech — happened to be
  // standing in the next one, reading as a chunky blob wrapping the
  // model instead of mist. Per-variant multiplier (FOG_VARIANTS' own
  // displaceScale) so blocking (TableView, confirmed to already look
  // right) stays exactly as it was.
  uniform float uDisplaceScale;
  varying vec3 vWorldPosition;
  varying float vCapFactor;
  // The shape's own plane, which after this geometry's rotateX(+90deg) is
  // the mesh's XZ: a shape point (sx, sy) extruded to depth d lands at
  // (sx, -d, sy). Passed on so the fragment stage can look itself up in
  // the region's distance map — see buildFogEdgeMap.
  varying vec2 vShapeXZ;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    float heightT = clamp((worldPos.y - uBaseY) / max(0.0001, uTopY - uBaseY), 0.0, 1.0);
    // Stays grounded at the base (lift ~0), billows more with height —
    // real smoke drifts/spreads as it rises, it doesn't sway uniformly
    // top to bottom.
    float lift = smoothstep(0.0, 0.7, heightT) * uDisplaceScale;
    vec2 flow = uFlowDir * uTime;
    float wx = fogFbm(worldPos.xz * (0.35 * uNoiseScale) + flow, 2) - 0.5;
    float wz = fogFbm(worldPos.xz * (0.35 * uNoiseScale) - flow, 2) - 0.5;
    worldPos.x += wx * lift * 0.9;
    worldPos.z += wz * lift * 0.9;
    worldPos.y += (fogValueNoise(worldPos.xz * (0.4 * uNoiseScale) + flow * 0.6) - 0.5) * lift * 0.35;
    vWorldPosition = worldPos.xyz;
    vCapFactor = abs(normal.y);
    vShapeXZ = position.xz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`
const fogFragmentShader = /* glsl */ `
  ${fogNoiseGLSL}
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uBaseY;
  uniform float uTopY;
  uniform float uOpacity;
  uniform float uNoiseScale;
  uniform vec2 uFlowDir;
  // Real user request: FPV's own volume must fade out long before its
  // real (very tall — see FOG_HEIGHT_SUBTLE) top, so nobody ever
  // perceives a "lid"; TableView's needs to stay dense almost all the
  // way up instead, since its camera looks nearly straight down through
  // the top face. Same falloff shape, different knobs per caller.
  uniform float uFadeStart;
  uniform float uFadeAmount;
  /** How hard the noise pushes the soft edge in and out. */
  uniform float uEdgeNoise;
  /** Fraction of the fog left standing at the boundary itself. */
  uniform float uEdgeFloor;
  /** Distance to the region's own outline, rasterised — see buildFogEdgeMap.
   * Red channel: 0 on the boundary, 1 once the variant's own edgeFade
   * distance inside it. */
  uniform sampler2D uEdgeMap;
  /** The rectangle that map covers, as (minX, minZ, width, height), in the
   * same shape coordinates vShapeXZ carries. */
  uniform vec4 uEdgeRect;
  varying vec3 vWorldPosition;
  varying float vCapFactor;
  varying vec2 vShapeXZ;

  void main() {
    float heightT = clamp((vWorldPosition.y - uBaseY) / max(0.0001, uTopY - uBaseY), 0.0, 1.0);
    float heightDensity = 1.0 - smoothstep(uFadeStart, 1.0, heightT) * uFadeAmount;
    // Side walls read noticeably thinner than the top/bottom caps — see
    // vCapFactor's own doc comment above.
    float capSoftness = mix(0.4, 1.0, vCapFactor);
    vec2 flow = uFlowDir * uTime;
    float n = fogFbm(vWorldPosition.xz * (0.5 * uNoiseScale) + flow, 3) * 0.65
      + fogFbm(vWorldPosition.xz * (1.15 * uNoiseScale) - flow * 1.5, 3) * 0.35;
    // A third, finer/faster pass on top — wispy detail a single fbm call
    // at one scale never produces, real smoke reads as several sizes of
    // curl at once.
    float wisp = fogFbm(vWorldPosition.xz * (2.4 * uNoiseScale) + flow * 2.2, 2);
    // Real user request: "los extremos de la niebla, quiero que le metas
    // ruido gausiano o algo de eso para que quede difuminado."
    //
    // A fog region is an extruded polygon, so without this its silhouette
    // is exactly that: a wall of mist stopping dead along a straight hex
    // edge. Fading it out towards the boundary is the first half. The
    // second is that a clean fade still reads as a manufactured gradient,
    // with the polygon's own straight edges legible inside it — so the
    // fade's threshold is perturbed by the same fbm that already drives
    // the fog's body. Cheap, and coherent with the swirl instead of
    // fighting it: the boundary wanders in and out, and what you see is
    // mist thinning irregularly rather than a shape being cross-faded.
    //
    // Two octaves at different scales: the coarse one moves the whole edge
    // around, the fine one frays it.
    float edgeCoarse = fogFbm(vWorldPosition.xz * (0.55 * uNoiseScale) - flow * 0.8, 2) - 0.5;
    float edgeFine = fogFbm(vWorldPosition.xz * (1.9 * uNoiseScale) + flow * 1.4, 2) - 0.5;
    float edgeNoise = edgeCoarse * 0.72 + edgeFine * 0.28;
    vec2 edgeUv = (vShapeXZ - uEdgeRect.xy) / uEdgeRect.zw;
    float edgeDist = texture2D(uEdgeMap, edgeUv).r;
    // uEdgeFloor is how much of the fog SURVIVES at the very boundary.
    // Zero dissolves the edge completely, which is right for the thick
    // top-down variant. The cockpit's veil is already only a tenth
    // opaque, and from inside your own visible area what you actually
    // look at IS the region's boundary — dissolving that left nothing at
    // all to see (real user report: "en FPV no se ve la niebla"). A floor
    // keeps the veil and only takes the hard line off it.
    float edgeFade = mix(
      uEdgeFloor, 1.0,
      smoothstep(0.0, 1.0, clamp(edgeDist + edgeNoise * uEdgeNoise, 0.0, 1.0))
    );
    float density = heightDensity * capSoftness * edgeFade * (0.72 + n * 0.55 + wisp * 0.18);
    vec3 tint = mix(uColor * 0.86, min(uColor * 1.18, vec3(1.0)), n * 0.7 + wisp * 0.3);
    gl_FragColor = vec4(tint, clamp(density, 0.0, 1.0) * uOpacity);
  }
`

// Real user request: "en tableview [debe] bloquear la vision, pero en FPV
// deberia ser mas sutil" — two named looks, not a free numeric knob per
// caller (nobody else needs a third variant yet, and a named pair is
// harder to accidentally get wrong than remembering the right opacity/
// fade numbers at every call site).
// Real user report on the first version of `subtle`: "se ve un poco
// cutre... parece cualquier cosa" (a chunky, hard-edged blob wrapping a
// nearby mech instead of mist) — two real bugs, both fixed by the fields
// below rather than the layering/turbulence approach itself (which the
// SAME shader already proved out fine in `blocking`, confirmed live):
// (1) `displaceScale` — the vertex billow (fogVertexShader's own
// uDisplaceScale) was strong enough, on FPV's much taller volume, to push
// a fog column clean outside its own hex into a neighboring one, wrapping
// whatever was standing there. Way down for `subtle`, untouched for
// `blocking` (that one's confirmed to already look right — real user
// quote: "me gusta MUCHO la de tableview"). (2) `opacity` — three stacked
// layers compose via real alpha-over-alpha (1-(1-a)(1-b)(1-c)), so the
// old subtle.opacity=0.4 combined with FOG_LAYERS' own per-layer
// multipliers (1, 0.65, 0.5) actually stacked to ~65% combined opacity,
// nowhere near "sutil" — dropped low enough that the SAME stacking nets
// out to a genuinely faint veil instead.
const FOG_VARIANTS = {
  // edgeFade / edgeFloor: how wide the soft boundary is, and how much fog
  // survives at the boundary itself. They differ per variant because the
  // two are looked at from completely different places. The thick top-down
  // fog is seen from above, so its boundary is an outline on the ground and
  // can dissolve to nothing. The cockpit's veil is seen edge-on from inside
  // your own visible area, so its boundary is the whole thing you look at —
  // dissolve that and there is nothing left, which is exactly what happened.
  blocking: {
    height: FOG_HEIGHT, color: '#e3e8e8', opacity: 0.95, fadeStart: 0.15, fadeAmount: 0.28,
    displaceScale: 1, edgeFade: HEX_SIZE * 0.34, edgeFloor: 0,
  },
  subtle: {
    height: FOG_HEIGHT_SUBTLE, color: '#eef2f2', opacity: 0.15, fadeStart: 0.04, fadeAmount: 0.94,
    displaceScale: 0.3, edgeFade: HEX_SIZE * 0.16, edgeFloor: 0.55,
  },
} as const

/** How far the noise may shift that edge, as a fraction of the fade band.
 * At 0.55 the boundary wanders over half the band's width, which is what
 * turns a clean gradient into something that looks torn. */
const FOG_EDGE_NOISE = 0.55

/** Shortest distance from a point to a line segment, in 2D. */
function distanceToSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  // A degenerate segment is just its own endpoint.
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
    : 0
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/** The region's distance-to-outline, rasterised into a small texture.
 *
 * A per-VERTEX distance field was the obvious approach, and it silently
 * produced nothing: ExtrudeGeometry triangulates a shape from the contour's
 * own points and adds no interior vertices at all, so EVERY vertex of a fog
 * region sits exactly ON its boundary. The attribute came out zero
 * everywhere, the fade multiplied the whole volume by zero, and the fog
 * disappeared — which is how this was found, from the outside, as "la
 * niebla ha desaparecido".
 *
 * A texture does not care where the vertices are. Its resolution comes from
 * the fade band rather than from the region's size, so the gradient always
 * gets about three texels to cross however big the region is, and bilinear
 * filtering carries the rest. */
function buildFogEdgeMap(shape: THREE.Shape, fade: number): {
  texture: THREE.DataTexture
  rect: THREE.Vector4
} {
  const contours: THREE.Vector2[][] = [shape.getPoints(1)]
  for (const hole of shape.holes) contours.push(hole.getPoints(1))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const points of contours) {
    for (const point of points) {
      if (point.x < minX) minX = point.x
      if (point.x > maxX) maxX = point.x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
  }
  const width = Math.max(1e-3, maxX - minX)
  const height = Math.max(1e-3, maxY - minY)

  // Roughly three texels across the fade band, capped so an enormous
  // region cannot turn this into a real cost.
  const target = fade / 3
  const cols = Math.max(8, Math.min(160, Math.ceil(width / target)))
  const rows = Math.max(8, Math.min(160, Math.ceil(height / target)))

  // Flattened, with each segment's own bounding box alongside it. A CPU
  // profile of a cockpit load put distanceToSegment at 1,4 seconds: this
  // is texels x segments, and a merged fog region has hundreds of segments.
  // The box lets a texel skip any segment that cannot possibly beat the
  // best distance it has already found, which is nearly all of them.
  const segments: number[] = []
  for (const points of contours) {
    for (let k = 0; k < points.length; k++) {
      const a = points[k]
      const b = points[(k + 1) % points.length]
      segments.push(
        a.x, a.y, b.x, b.y,
        Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y),
      )
    }
  }

  const data = new Uint8Array(cols * rows * 4)
  for (let j = 0; j < rows; j++) {
    // Texel CENTRES, so a sampled value stands for the position it is at.
    const y = minY + ((j + 0.5) / rows) * height
    for (let i = 0; i < cols; i++) {
      const x = minX + ((i + 0.5) / cols) * width
      // Anything past the fade band reads as "fully inside" regardless, so
      // the search can stop caring beyond it.
      let best = fade
      for (let o = 0; o < segments.length; o += 8) {
        // Distance to the segment's own box is a lower bound on the
        // distance to the segment.
        const dx = x < segments[o + 4] ? segments[o + 4] - x : (x > segments[o + 6] ? x - segments[o + 6] : 0)
        const dy = y < segments[o + 5] ? segments[o + 5] - y : (y > segments[o + 7] ? y - segments[o + 7] : 0)
        if (dx * dx + dy * dy >= best * best) continue
        const d = distanceToSegment(x, y, segments[o], segments[o + 1], segments[o + 2], segments[o + 3])
        if (d < best) best = d
      }
      const o = (j * cols + i) * 4
      data[o] = Math.round(Math.min(1, best / fade) * 255)
      data[o + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  // Clamped, not wrapped: a fragment landing a hair outside the rectangle
  // should read the nearest edge, never the far side's.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true

  return { texture, rect: new THREE.Vector4(minX, minY, width, height) }
}

/** One real merged region's own body — see this section's own top
 * comment and buildFogRegions's doc comment for the "why" and the
 * boundary-tracing algorithm. `shape` already sits in real world (x, z)
 * coordinates (buildFogRegions builds it straight from hexToWorld), so
 * this only needs to extrude it upward and place it at the right
 * height — no further per-tile positioning.
 *
 * Renders FOG_LAYERS.length stacked copies (real user request: "que
 * tenga corriente y movimiento/turbulencia... no como un bloque gris
 * geometrico" — see FOG_LAYERS' own doc comment for why one static layer
 * never reads as real depth/motion no matter how its own noise is
 * tuned), all sharing the SAME extruded geometry (only its per-layer
 * uniforms/Y-offset differ), so this is still exactly one real mesh
 * object's worth of triangles per layer, not a heavier per-tile scheme. */
function FogRegionMesh({
  shape, baseY, span, seed, subtle,
}: {
  shape: THREE.Shape
  baseY: number
  /** How far the ground climbs between the lowest and highest tile the
   * region covers, added on top of the fog's own thickness so the volume
   * reaches over the high ground instead of ending below it. */
  span: number
  seed: number
  /** false (default): TableView/GMView's own opaque, vision-blocking
   * look. true: FirstPersonView's taller, fainter look — see
   * FOG_VARIANTS above for the actual numbers. */
  subtle?: boolean
}) {
  const variant = FOG_VARIANTS[subtle ? 'subtle' : 'blocking']
  // Its own thickness PLUS whatever the ground climbs across the region.
  const height = variant.height + span
  const materialRefs = useRef<(THREE.ShaderMaterial | null)[]>([])
  const geometry = useMemo(() => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 })
    // ExtrudeGeometry lays the shape's own local (x, y) in the XY plane
    // and extrudes along LOCAL +Z from 0 to `depth` (confirmed directly
    // against three.js's own source, not assumed, after an earlier
    // sign mistake here). rotateX(+90°) turns that into "flat footprint
    // in world (x, z), extruded along world Y" with NO mirroring on
    // either axis (+90°, not -90° — that direction previously flipped
    // Z) — the tradeoff is local Y then runs from 0 down to -depth, so
    // the mesh itself gets positioned from its TOP (baseY + height)
    // rather than its bottom to compensate, see each layer's own mesh
    // position below.
    geo.rotateX(Math.PI / 2)
    geo.computeVertexNormals()
    return geo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, height])
  const color = useMemo(() => new THREE.Color(variant.color), [variant.color])
  const edgeMap = useMemo(() => buildFogEdgeMap(shape, variant.edgeFade), [shape, variant.edgeFade])
  useEffect(() => () => edgeMap.texture.dispose(), [edgeMap])
  useProfiledFrame('niebla', (state) => {
    for (const mat of materialRefs.current) {
      if (mat) mat.uniforms.uTime.value = seed + state.clock.elapsedTime
    }
  })
  return (
    <>
      {FOG_LAYERS.map((layer, i) => {
        const layerBaseY = baseY + layer.yOffset
        const layerTopY = layerBaseY + height
        // The shader samples noise at worldPos.xz * uNoiseScale (real world
        // units, now HEX_SIZE times bigger for the same relative position
        // within a hex) — without dividing back down here, the noise
        // pattern completes many full cycles across a single hex instead
        // of one smooth swirl, reading as flat/staticky instead of turbulent
        // cloud (real user report: no visible turbulence after the rescale).
        // flowDir gets the same correction so the animated drift still
        // moves through noise-space at the same relative rate.
        //
        // The constant is the fog's speed in METRES PER SECOND, which is
        // worth writing down because it is not obvious from the shader. The
        // fragment stage samples noise at `worldPos.xz * (0.5 * uNoiseScale)
        // + uFlowDir * uTime`, so a feature holds still when
        // `worldPos * scale + flow * t` is constant, and its world velocity
        // is therefore `|uFlowDir| / scale`.
        //
        // Two bugs lived in that division, and both are fixed below.
        //
        // The first was aiming at the wrong target. An earlier pass raised
        // this from 0.05 (ten centimetres a second) to 1.5, reasoning that
        // roughly 3 metres a second is a real breeze — which it is, and a
        // BattleTech hex really is 30 metres across, so the units were
        // honest. But you look at this board from far enough away to see
        // ten hexes at once, and at 3 m/s a wisp takes seventeen seconds to
        // cross one of them. Physically right, visually a still image: the
        // user watched it and concluded the fog "no se habia movido nunca".
        // What matters here is how much of a HEX goes past per second, so
        // that is what the constant now says.
        //
        // The second was that `scale` above is per layer, so each layer's
        // noise SIZE was silently setting its SPEED: the third layer drifted
        // 6,7x faster than the second purely because its features are
        // smaller. Folding the sample scale in here makes FOG_DRIFT_SPEED an
        // honest world speed and leaves each layer's own flowSpeed as the
        // only thing deciding its pace.
        const FOG_DRIFT_SPEED = 0.45 * HEX_SIZE
        // Matches the fragment stage's own first (and visually dominant)
        // sample, `vWorldPosition.xz * (0.5 * uNoiseScale)`.
        const sampleScale = (0.5 * layer.noiseScale) / HEX_SIZE
        const drift = FOG_DRIFT_SPEED * layer.flowSpeed * sampleScale
        const flowDir = [
          Math.cos(layer.flowAngle) * drift,
          Math.sin(layer.flowAngle) * drift,
        ]
        return (
          <mesh key={i} position={[0, layerTopY, 0]} geometry={geometry} userData={{ perfGroup: 'niebla' }}>
            <shaderMaterial
              ref={(el) => { materialRefs.current[i] = el }}
              vertexShader={fogVertexShader}
              fragmentShader={fogFragmentShader}
              uniforms={{
                uTime: { value: seed + i * 91.7 },
                uColor: { value: color },
                uBaseY: { value: layerBaseY },
                uTopY: { value: layerTopY },
                uOpacity: { value: variant.opacity * layer.opacity },
                uNoiseScale: { value: layer.noiseScale / HEX_SIZE },
                uFlowDir: { value: flowDir },
                uFadeStart: { value: variant.fadeStart },
                uFadeAmount: { value: variant.fadeAmount },
                // variant.displaceScale is a dimensionless 0.3-1 ratio —
                // the actual vertex-shader displacement it drives (`lift`)
                // was tuned in absolute world units against the OLD ~1.73-
                // wide hex, so it needs the same HEX_SIZE scale-up as the
                // hex grid itself (this displacement's whole job is
                // staying proportionate to — and clamped under — one
                // hex's own radius, see FOG_VARIANTS' own doc comment).
                uDisplaceScale: { value: variant.displaceScale * HEX_SIZE },
                uEdgeNoise: { value: FOG_EDGE_NOISE },
                uEdgeFloor: { value: variant.edgeFloor },
                uEdgeMap: { value: edgeMap.texture },
                uEdgeRect: { value: edgeMap.rect },
              }}
              transparent
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )
      })}
    </>
  )
}

export function HexMap({
  map, units, losDebugHexes, needsInitiativePilotIds, activeMoverPilotId, activeAttackerPilotIds,
  moveHighlightHexes, pathPreviewHexes, targetableHexes, walkPaths, walkMovementTypes, outlineUnitIds, heatByUnitId,
  proneUnitIds, shutdownUnitIds,
  destroyedReasonByUnitId,
  severedLocationsByUnitId,
  teamVisibleHexes, fogSubtle, physics, cullRegions, activeAttack, onAttackEffectDone, onAttackImpact, onUnitWalkDone, onUnitWalkStep,
  onUnitClick, onTileClick, onUnitDragEnd, onDraggingChange, boardgameScale,
}: {
  map: MapData
  units: Unit[]
  /** Cut the vegetation into cullable regions instead of one batch per
   * species across the whole board.
   *
   * NO VIEW SETS THIS TODAY, and the measurements are why. Regions trade
   * draw calls for culling, and after the decor was instanced and the
   * terrain skin merged, nothing on this board is GPU-bound any more —
   * draw calls are the wall in every view, so the trade is the wrong way
   * round everywhere. Measured in the cockpit, the one place it was
   * supposed to pay:
   *
   *   with regions     43 fps, 23,2 ms, 521 + 120 vegetation draws
   *   without          60 fps, 16,7 ms,  96 +  32
   *
   * with GPU time sitting at 2,0 ms of that 23,2 either way.
   *
   * The dial is kept, and deliberately, for two reasons. The balance can
   * shift back — cut draw calls far enough and the GPU becomes the limit
   * again. And regions are the natural unit for level of detail: you
   * cannot swap distant trees for their impostor cards while every tree on
   * the board is one batch. Paired with LOD the arithmetic even inverts,
   * because a far region collapses to a single impostor draw instead of
   * one per species — which is the point at which turning this back on
   * should pay for itself rather than cost. See VEGETATION_REGION_SPAN. */
  cullRegions?: boolean
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
  /** Per unit, the location codes whose structure has reached 0. Models
   * built with separate limb meshes stop drawing those; the rest ignore it.
   * Built by the view, same shape as every other per-unit map here. */
  severedLocationsByUnitId?: Map<number, Set<string>>
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
  /** Real user request: "en tableview [debe] bloquear la vision, pero en
   * FPV deberia ser mas sutil... debe tener mas altura, que no se vea
   * donde termina por arriba" — false/omitted (GMView/TableView) keeps
   * the opaque, vision-blocking look; true (FirstPersonView) switches
   * every fog region in THIS instance to the taller, fainter look (see
   * FOG_VARIANTS in this file). */
  fogSubtle?: boolean
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
  /** Fires when a shot's animation actually REACHES its target, which is
   * not when the server resolved it — see AttackEffect's own onImpact. */
  onAttackImpact?: (attack: ActiveAttackVfx) => void
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
  /** BOARDGAME_MECH_SCALE's own opt-in for every unit on this map — real
   * user request: "en GMview y en tableview los mechs deben ocupar toda
   * la hex, solo ahi". GMView/TableView pass true; FirstPersonView leaves
   * this unset so its own cockpit stays at real 10m-mech/30m-hex scale. */
  boardgameScale?: boolean
}) {
  // Memoized on map.tiles specifically — without this, these three full
  // scans over every tile rebuilt three fresh Maps (and handed Tile a
  // new `lookup` reference, defeating its own React.memo below) on EVERY
  // render, including every single pointermove event during a unit
  // drag — a real, measured contributor to "me va a tirones" on larger
  // maps, not just a style nit.
  const elevationAt = useMemo(() => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t.elevation])), [map.tiles])
  const terrainAt = useMemo(() => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t.terrain])), [map.tiles])
  // Keyed on the tiles' CONTENT, not on the array holding them. Every
  // session poll hands this component a brand new array describing the very
  // same board, and a lookup rebuilt from that is a new Map — which then
  // invalidated every memo downstream that depends on it. Measured in the
  // cockpit: a 420ms rebuild of the merged terrain repeating every two or
  // three seconds for the whole load, 33s of blocked main thread against GM
  // view's 7,6s. Same trick, and same reason, as GroundVegetation's own
  // tilesKey.
  const tilesSignature = useMemo(
    () => map.tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|'),
    [map.tiles],
  )
  const lookup = useMemo(
    () => new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tilesSignature],
  )
  // Which way the water runs, worked out from the shape of the whole board
  // at once — a tile cannot tell on its own whether it is a river or a pond.
  // See riverFlow.ts.
  // A view asks for the level of detail; the BOARD decides whether it can
  // pay for it. Regions multiply draw calls and LOD wins them back only on
  // what it can hide, so below LOD_MIN_TILES the split costs more than the
  // hiding saves — measured, not assumed.
  // ?lod=1 forces it on regardless of board size, so the two can be
  // compared on a board this one's size instead of only in theory.
  const lodForced = useMemo(
    () => new URLSearchParams(window.location.search).get('lod') === '1',
    [],
  )
  const lodWorthwhile = (cullRegions ?? false) && (lodForced || map.tiles.length >= LOD_MIN_TILES)
  const vegetationRegionSpan = lodWorthwhile ? VEGETATION_REGION_SPAN : null
  const riverFlow = useMemo(() => computeRiverFlow(map.tiles).direction, [map.tiles])
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
    return terrainSinkY(t) ?? elevationToY(t, elev)
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
    elevationToY(terrainAt.get(`${q},${r}`) ?? 'plains', elevationAt.get(`${q},${r}`) ?? 0)
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
  // Units standing in water, handed to the water surface so it can throw
  // rings off them ("el agua debe interactuar y colisionar con un mech
  // hundido"). Deliberately NOT a prop: this changes while a unit walks, and
  // as a prop it would re-render every water tile on the board every frame —
  // see waterDisturbance.ts.
  useEffect(() => {
    const wading = units
      .map((u) => ({ u, terrain: terrainAt.get(`${u.q},${u.r}`) }))
      .filter(({ terrain }) => terrain === 'water' || terrain === 'water_deep')
      .map(({ u, terrain }) => {
        const [wx, wz] = hexToWorld(u.q, u.r)
        // In SCENE space, not board space. Everything the tiles draw lives
        // inside <group position={[-centerX, 0, -centerZ]}>, so the shader's
        // own world position is offset by the board centre — registering raw
        // q/r-derived coordinates put every ripple a whole board-width away
        // from the mech making it, which is why nothing appeared to react.
        const [cx, cz] = mapCenter(map.tiles)
        // Deeper water means more of the mech is in it, so it pushes more
        // of it around.
        return { x: wx - cx, z: wz - cz, strength: terrain === 'water_deep' ? 1 : 0.62 }
      })
    setWaterDisturbers(wading)
  }, [units, terrainAt, map.tiles])

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

  // Real bone-tracked footstep (chassis rigged with PieD/PieI, the
  // Jenner today — see Mech3D.tsx's own onFootstep doc comment). Real
  // user report, blunt: this alone wasn't reliable enough yet (several
  // rounds of real, measured bugs — see Mech3D.tsx's own onFootstep/
  // WALK_CYCLE_TIME_SCALE doc comments), so UnitMarker's own real-time,
  // path-interpolation-driven footprint stamping (stepToward's queue-
  // arrival branch, NOT animation-timing-dependent) now ALWAYS runs too,
  // guaranteeing a footprint on every hex crossed regardless of whether
  // this real path also fires. realFootstepUnitIds is tracked here only
  // as a future hook (currently unread) for re-suppressing that
  // deterministic fallback once real bone tracking is solid enough to
  // trust alone.
  const realFootstepUnitIds = useRef<Set<number>>(new Set())
  // Real per-chassis foot (Mech3D.tsx's getFootShape) can be genuinely
  // tiny — smaller than even the finer stamped-tile mesh can shape
  // cleanly — so real footsteps get floored to a legible minimum half-
  // size; the shape stays whatever aspect ratio the real foot has (a
  // clamped-up ellipse, not a circle), just never smaller than what the
  // terrain can actually render as a distinct mark. FOOTPRINT_DEPTH
  // itself is module-level now (UnitMarker's own footprint stamping,
  // below, needs it too).
  const MIN_FOOTPRINT_HALF_SIZE = 1
  const handleUnitFootstep = (
    unitId: number,
    worldPos: [number, number, number],
    footHalfWidth: number,
    footHalfDepth: number,
    rotationY: number,
  ) => {
    realFootstepUnitIds.current.add(unitId)
    const { q, r } = worldToHex(worldPos[0], worldPos[2])
    const key = `${q},${r}`
    if (!FOOTPRINT_TERRAINS.has(terrainAt.get(key) ?? '')) return
    stampDeformation(
      worldPos[0], worldPos[2],
      Math.max(footHalfWidth, MIN_FOOTPRINT_HALF_SIZE), FOOTPRINT_DEPTH,
      Math.max(footHalfDepth, MIN_FOOTPRINT_HALF_SIZE), rotationY,
    )
  }
  // Scorch marks for missed shots — real user request: "los disparos
  // fallados deben golpear el suelo... y deben dejar marcas en el
  // mapa/tile que golpean" (AttackEffect's own onMissGround, wired in at
  // this component's render site below). Real user request: "quiero
  // crateres de las armas... 3D, no decals" —
  // stampDeformation (terrainRelief.ts) leaves a real gouge in the
  // ground mesh itself instead of a flat scorch decal (the old
  // ImpactMark/ImpactMarkMesh system this replaced). Radius/depth tuned
  // by eye against the now-real-meters scale (HEX_SIZE=30/tile,
  // MODEL_SCALE=10-tall mech) — a real weapon impact reads as a
  // noticeably bigger, deeper gouge than a mech's own footprint below.
  const IMPACT_CRATER_RADIUS = 3
  const IMPACT_CRATER_DEPTH = 1.2
  // Mirrors droppedLimbs' own version counter, purely to re-render when a
  // limb is added — see recordDroppedLimb.
  const [limbVersion, setLimbVersion] = useState(droppedLimbVersion())
  const fallenLimbs = useMemo(() => droppedLimbList(), [limbVersion])

  // Whatever this board was already carrying. Wreckage from a previous
  // session, or from a limb that came off on somebody else's screen —
  // adoptSavedLimb puts those straight on the ground rather than replaying
  // the fall, which would rain arms every time anyone opened the map.
  useEffect(() => {
    if (map.id == null) return
    let cancelled = false
    // A different board's wreckage would simply be wrong.
    clearDroppedLimbs()
    setLimbVersion(droppedLimbVersion())
    listBoardMarks(map.id, 'limb')
      .then((marks) => {
        if (cancelled) return
        for (const mark of marks) {
          const data = mark.data as {
            unitId?: number
            location?: string
            dropY?: number
            facing?: number
            modelUrl?: string
          }
          if (!data.location || !data.modelUrl) continue
          adoptSavedLimb({
            key: `${data.unitId ?? mark.id}:${data.location}`,
            x: mark.x,
            z: mark.z,
            dropY: data.dropY ?? 0,
            facing: data.facing ?? 0,
            modelUrl: data.modelUrl,
            location: data.location,
            markId: mark.id,
          })
        }
        setLimbVersion(droppedLimbVersion())
      })
      // A board with no scenery is a board; failing to fetch it is not
      // worth interrupting a game over.
      .catch(() => {})
    return () => { cancelled = true }
  }, [map.id])

  // Which server-side mark each dropped limb is stored as. A ref rather
  // than state: nothing renders from it, it only exists so a limb that is
  // put back can be deleted from the board for good. Filled in when the
  // POST returns (see recordDroppedLimb) and when saved wreckage is
  // adopted on load.
  const markIdsRef = useRef<Map<string, number>>(new Map())

  // A limb that comes BACK — the GM restoring structure, an undone action,
  // the debug menu — has to stop being wreckage.
  //
  // Real user report: "le he restaurado los miembros, y si le doy a perder
  // miembros, simplemente desaparecen del modelo, no se despegan, no
  // caen." dropLimb ignores a key it already holds (which is what stops a
  // render-driven effect from raining copies of one arm), so the stale
  // record made the SECOND amputation look like a duplicate: nothing new
  // fell, and the piece from the first one just sat where it already was.
  //
  // Driven off severedLocationsByUnitId rather than off an event, because
  // "this limb is attached again" is a state, and the views recompute that
  // state anyway — there is no restore event to listen for.
  useEffect(() => {
    if (!severedLocationsByUnitId) return
    for (const limb of droppedLimbList()) {
      const [unitIdText, location] = limb.key.split(':')
      const unitId = Number(unitIdText)
      // Only ever prunes a limb belonging to a unit this view actually
      // knows about: a unit that has simply left the board keeps its
      // wreckage, which is the whole point of the board owning it.
      const severed = severedLocationsByUnitId.get(unitId)
      if (!severed || severed.has(location)) continue
      undropLimb(limb.key)
      const markId = limb.markId ?? markIdsRef.current.get(limb.key)
      markIdsRef.current.delete(limb.key)
      if (markId != null && map.id != null) deleteBoardMark(map.id, markId).catch(() => {})
    }
    setLimbVersion(droppedLimbVersion())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severedLocationsByUnitId, map.id])

  // A limb that has just come off, on its way to the ground. The board
  // owns this rather than the unit does, because wreckage belongs to the
  // place it fell: the mech walks on, the arm stays.
  const recordDroppedLimb = (unitId: number, info: SeveredLimbInfo) => {
    // Mech3D reports true world coordinates; everything inside this map's
    // own group is offset by [-centerX, 0, -centerZ], so the board-space
    // position is the world one with the centre added back.
    const x = info.worldX + centerX
    const z = info.worldZ + centerZ
    const isNew = dropLimb({
      key: `${unitId}:${info.location}`,
      x,
      z,
      dropY: info.worldY,
      facing: info.facing,
      modelUrl: info.modelUrl,
      location: info.location,
      // The already-baked piece, in the pose and at the scale it was
      // actually being drawn at. Lives only in the module store — the POST
      // below deliberately does not carry it (see droppedLimbs.ts).
      piece: info.piece,
    })
    // Fire and forget, and only for a limb nobody had recorded yet. A limb
    // the player just watched fall off is a limb that has fallen off:
    // holding it back until a POST returns would trade a cosmetic
    // inconsistency for a visible stutter in the middle of a fight.
    if (isNew && map.id != null) {
      addBoardMark(map.id, 'limb', x, z, {
        unitId,
        location: info.location,
        dropY: info.worldY,
        facing: info.facing,
        modelUrl: info.modelUrl,
      })
        // Recorded on the way back so this piece can be taken off the board
        // again if its mech ever gets the limb back — see undropLimb.
        .then((mark) => { markIdsRef.current.set(`${unitId}:${info.location}`, mark.id) })
        .catch(() => {})
    }
    // The store is module-level, so it cannot re-render anything by
    // itself; mirroring its version into state is what puts the new limb
    // on screen.
    setLimbVersion(droppedLimbVersion())
  }

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
    if (RELIEF_SKIP_TERRAINS.has(terrainAt.get(key) ?? '')) return
    stampDeformation(pos[0], pos[2], IMPACT_CRATER_RADIUS, IMPACT_CRATER_DEPTH)
  }

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
      {map.tiles.map((tile) => (
        <Tile
          key={`${tile.q},${tile.r}`} tile={tile} lookup={lookup} riverFlow={riverFlow}
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
      {/* One batched pass for the whole board rather than per-tile decor —
          see GroundVegetation's own doc comment for why instancing is the
          only affordable way to put real plants on 30m hexes. */}
      {/* No fog gating on purpose. Real user request: "la hierba/rocas debe
          cargar incluso fuera de LoS" — and gating it was actively harmful,
          because the visible set changes on every step and every turn, and
          each change rebuilt the whole board's vegetation. Grass and ground
          props are short enough that the fog volume covers them anyway. */}
      {/* Grooves and blend strips for the whole board, merged by region
          — 404 draw calls down to a couple of dozen, see TerrainSkin. */}
      {/* Blown-off limbs, lying where they landed. Rendered by the BOARD
          and not by the unit that lost them, so they stay put when it
          moves — see droppedLimbs.ts. */}
      {fallenLimbs.map((limb) => {
        const hex = worldToHex(limb.x, limb.z)
        return (
          <FallenLimb
            key={limb.key} limb={limb} groundY={groundYAt(hex.q, hex.r)}
            mechScale={boardgameScale ? BOARDGAME_MECH_SCALE : 1}
          />
        )
      })}
      <TerrainSkin tiles={map.tiles} lookup={lookup} />
      <GroundVegetation
        tiles={map.tiles} lookup={lookup}
        regionSpan={vegetationRegionSpan}
        lodDistance={lodWorthwhile ? LOD_DISTANCE : null}
      />
      {/* Leaf litter, pebbles and grass tufts, batched for the whole board
          instead of scattered as loose meshes per tile — 733 draw calls
          down to 7, see GroundClutter.tsx. */}
      <GroundClutter tiles={map.tiles} lookup={lookup} regionSpan={vegetationRegionSpan} />
      {fogRegions.map((region, i) => (
        <FogRegionMesh
          key={`fog-region-${i}`} shape={region.shape} baseY={region.baseY}
          span={region.span} seed={i * 7.13} subtle={fogSubtle}
        />
      ))}
      {visibleUnits.map((unit) => (
        <UnitMarker
          key={unit.id}
          unit={unit}
          elevation={elevationAt.get(`${unit.q},${unit.r}`) ?? 0}
          terrain={terrainAt.get(`${unit.q},${unit.r}`) ?? 'plains'}
          terrainAt={terrainAt}
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
          severedLocations={severedLocationsByUnitId?.get(unit.id)}
          onLimbSevered={(info) => recordDroppedLimb(unit.id, info)}
          boardgameScale={boardgameScale}
          onWalkDone={() => onUnitWalkDone?.(unit.id)}
          onWalkStep={(index) => onUnitWalkStep?.(unit.id, index)}
          onFootstep={(worldPos, footHalfWidth, footHalfDepth, rotationY) =>
            handleUnitFootstep(unit.id, worldPos, footHalfWidth, footHalfDepth, rotationY)}
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
          onImpact={() => onAttackImpact?.(activeAttack)}
          groundYAt={(x, z) => {
            const hex = worldToHex(x, z)
            return groundYAt(hex.q, hex.r)
          }}
          onMissGround={addImpactMark}
        />
        )
      })()}
      {/* Mounted once with the board and never unmounted, because what
          costs frames is not a light's brightness but the scene's light
          COUNT changing — see LightPool.tsx for the measurements that
          traced the missile-volley frame drop to exactly that. */}
      <LightPool />
    </group>
  )
}
