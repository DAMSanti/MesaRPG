import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import { Select } from '@react-three/postprocessing'
import * as THREE from 'three'
import type {
  AttackResult, HexTileData, MapData, Unit,
} from '../api'
import { Mech3D } from './Mech3D'
import { TerrainDecor, terrainSinkY } from './TerrainDecor'
import { RoadMarkings } from './RoadMarkings'
import { terrainColor, terrainRotation, terrainTexture } from '../terrain'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import { hexToWorld, mapCenter } from '../hexMath'
import { MODEL_CHEST_FRACTION, MODEL_SCALE } from './Mech3D'
import { AttackEffect, getGlowTexture } from './AttackEffects'

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
export function useAttackVfxQueue(lastAttack: AttackResult | null | undefined, units: Unit[]) {
  const seq = useRef(0)
  const queueRef = useRef<ActiveAttackVfx[]>([])
  const activeRef = useRef<ActiveAttackVfx | null>(null)
  const [activeAttack, setActiveAttackState] = useState<ActiveAttackVfx | null>(null)

  const setActive = (vfx: ActiveAttackVfx | null) => {
    activeRef.current = vfx
    setActiveAttackState(vfx)
  }

  useEffect(() => {
    if (!lastAttack || lastAttack.attacker_unit_id == null || lastAttack.target_unit_id == null) return
    const attackerUnit = units.find((u) => u.id === lastAttack.attacker_unit_id)
    const targetUnit = units.find((u) => u.id === lastAttack.target_unit_id)
    if (!attackerUnit || !targetUnit) return
    seq.current += 1
    const vfx: ActiveAttackVfx = {
      id: `${seq.current}`,
      attackerQ: attackerUnit.q,
      attackerR: attackerUnit.r,
      targetQ: targetUnit.q,
      targetR: targetUnit.r,
      weaponName: lastAttack.weapon_name ?? '',
      hit: lastAttack.hit,
    }
    if (activeRef.current === null) {
      setActive(vfx)
    } else {
      queueRef.current.push(vfx)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttack])

  const onAttackEffectDone = () => {
    setActive(queueRef.current.shift() ?? null)
  }

  return { activeAttack, onAttackEffectDone }
}

// World units per second a unit visually walks between hexes at — hex
// center-to-center spacing is √3 (hexMath.ts's hexToWorld), so this is
// roughly one hex every ~0.5s, brisk enough not to stall the table but
// slow enough to actually read as a mech stepping rather than a blur.
const WALK_SPEED = 3.5
// Below this distance (world units) a move is considered "arrived" —
// small enough to be visually indistinguishable from exact, avoids the
// interpolation asymptotically crawling the last fraction of a unit
// forever.
const ARRIVE_EPSILON = 0.01
// Radians/sec the mech's model turns at while walking a real path — a
// mech pivots to face each leg of its route before advancing along it,
// not just at the destination, so a dogleg path visibly reads as a turn
// then a step rather than a diagonal slide.
const TURN_SPEED = Math.PI * 2.2

/** Shortest-path interpolation between two angles (radians), so turning
 * from e.g. 350° to 10° goes the short way through 0° instead of the
 * long way around through 180°. */
function lerpAngle(from: number, to: number, t: number): number {
  const twoPi = Math.PI * 2
  let diff = ((to - from + Math.PI) % twoPi + twoPi) % twoPi - Math.PI
  return from + diff * t
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
  pathPreviewHighlighted, targetableHighlighted, physics,
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
      {tile.terrain === 'road' && (
        <RoadMarkings q={tile.q} r={tile.r} height={height} lookup={lookup} gridType="hex" worldPos={hexToWorld} />
      )}
      {/* forest/light_forest/building all dropped from the hull-collider
          set — a hull used to wrap a cheap procedural decoration (a few
          dozen primitives), fine to compute; TerrainDecor's trees and
          buildings (standing AND ruined, since ruins now reuse the same
          real models with a scorch tint rather than a cheap procedural
          debris box) are real .glb models, tens of thousands to a few
          hundred thousand triangles each, and Rapier computing a hull
          from that per tile instance was a real cost on top of the
          geometry's own render cost, for something dice essentially
          never land under anyway. The flat ground plane above still
          gets a (cheap, hex-shaped) collider for every tile regardless,
          so dice still land on the table correctly either way. */}
      <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} />
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

/** A handful of soft puffs drifting straight up off a mech's chest and
 * fading out, looping continuously — real user request: "los mechs en
 * esta fase desprenderán vapor en todas las vistas de mapa" for any
 * mech at/above the Heat Scale's first real threshold (5 — see
 * movement.py's _HEAT_MP_PENALTY_BRACKETS, the first bracket that
 * isn't 0). More heat = more puffs, capped so it never gets busy enough
 * to obscure the model. Reuses AttackEffects' baked glow texture but
 * with plain alpha blending (not additive) so overlapping puffs read as
 * smoke/vapor instead of brightening toward white-hot like a muzzle
 * flash. */
function SteamPuffs({ heat }: { heat: number }) {
  const count = Math.min(5, 2 + Math.floor(heat / 10))
  const particles = useMemo(
    () => Array.from({ length: count }, () => ({
      seed: Math.random() * 10,
      xOff: (Math.random() - 0.5) * 0.3,
      zOff: (Math.random() - 0.5) * 0.3,
      size: 0.35 + Math.random() * 0.25,
    })),
    [count],
  )
  return (
    <>
      {particles.map((p, i) => <SteamPuff key={i} {...p} />)}
    </>
  )
}

function SteamPuff({ seed, xOff, zOff, size }: { seed: number; xOff: number; zOff: number; size: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const cycleSeconds = 2.2
  useFrame((state) => {
    const t = ((state.clock.elapsedTime + seed) % cycleSeconds) / cycleSeconds
    if (!ref.current) return
    ref.current.position.set(xOff, MODEL_SCALE * MODEL_CHEST_FRACTION + t * 0.9, zOff)
    ref.current.quaternion.copy(state.camera.quaternion)
    const mat = ref.current.material as THREE.MeshBasicMaterial
    mat.opacity = 0.45 * Math.sin(t * Math.PI)
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
    && prev.heightAt === next.heightAt
    && prev.outlined === next.outlined
    && prev.heat === next.heat
    && prev.prone === next.prone
    && prev.shutdown === next.shutdown
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
   * gyro. Darkens the model's faction tint instead of a separate icon —
   * same "keep it simple" scope as `prone` above. */
  shutdown?: boolean
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
}

const UnitMarker = memo(function UnitMarker({
  unit, elevation, terrain, dragPosition, physics, worldOffset, walkPath, heightAt, outlined, heat, prone, shutdown,
  onPointerDown, onPointerUp,
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
  // Ghosts stay red regardless of faction — before reveal, "hidden threat"
  // is the point, not who it turns out to be.
  const baseColor = unit.is_ghost
    ? '#e35d5d'
    : unit.pilot_faction != null
      ? FACTION_COLORS[unit.pilot_faction]
      : NEUTRAL_UNIT_COLOR
  // Shutdown darkens the faction tint instead of a separate icon —
  // "powered down" reads as "dim", same visual shorthand a real cockpit
  // status light uses.
  const color = shutdown ? new THREE.Color(baseColor).multiplyScalar(0.35).getStyle() : baseColor

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
  useEffect(() => {
    if (walkPath && walkPath !== lastWalkPathRef.current) {
      lastWalkPathRef.current = walkPath
      pathQueueRef.current = walkPath.map((p) => {
        const [x, z] = hexToWorld(p.q, p.r)
        return { x, z, y: heightAt(p.q, p.r) }
      })
    }
  }, [walkPath, heightAt])

  // Turns to face the direction it's actually walking at each leg of a
  // real path, not just at the final destination — see TURN_SPEED/
  // lerpAngle above. Settles onto the unit's real commanded facing_deg
  // (facingRotationY) once there's no more route left to walk.
  const animatedRot = useRef<number>(facingRotationY)

  const stepToward = (delta: number) => {
    if (!canWalk) {
      animatedPos.current = target
      animatedY.current = baseY
      animatedRot.current = facingRotationY
      pathQueueRef.current = []
      if (isMoving) setIsMoving(false)
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
        pathQueueRef.current = queue.slice(1)
      } else if (isMoving) {
        setIsMoving(false)
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
          // Prone tilts the whole model over onto its side instead of
          // standing it upright — pivots around the feet (Mech3D's own
          // local origin), so it swings down onto the tile rather than
          // sinking through it.
          <group rotation={prone ? [0, 0, Math.PI * 0.42] : [0, 0, 0]}>
            <Mech3D color={color} chassis={unit.mech_chassis} model={unit.mech_model} isMoving={isMoving && !prone} />
          </group>
        ) : (
          <mesh position={[0, 0.35, 0]} castShadow>
            <coneGeometry args={[0.35, 0.7, 4]} />
            <meshStandardMaterial color={color} />
          </mesh>
        )}
      </Select>
      {unit.mech_id != null && heat != null && heat >= 5 && <SteamPuffs heat={heat} />}
    </>
  )

  if (physics) {
    // Owns its own world-space transform via the kinematic API above —
    // deliberately NOT nested inside the pointer-handling group below
    // (TableView, the only physics caller, never wires up
    // onUnitClick/onUnitDragEnd — the shared board is passive).
    return (
      <RigidBody
        ref={rigidBodyRef}
        type="kinematicPosition"
        colliders="hull"
        position={[animatedPos.current[0], animatedY.current, animatedPos.current[1]]}
        rotation={[0, facingRotationY, 0]}
      >
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

/** Baked once and reused for every fog puff — several overlapping soft
 * radial blobs at fixed offsets instead of one perfect circle (like
 * AttackEffects' getGlowTexture), so the silhouette reads as an
 * irregular cloud rather than a glowing disc. */
let cloudTextureCache: THREE.Texture | null = null
function getCloudTexture(): THREE.Texture {
  if (cloudTextureCache) return cloudTextureCache
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const blobs = [
    { x: 0.5, y: 0.5, r: 0.42 },
    { x: 0.3, y: 0.42, r: 0.28 },
    { x: 0.7, y: 0.4, r: 0.3 },
    { x: 0.42, y: 0.66, r: 0.3 },
    { x: 0.64, y: 0.62, r: 0.26 },
  ]
  for (const b of blobs) {
    const cx = b.x * size, cy = b.y * size, r = b.r * size
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    // Wider, gentler falloff than a typical glow sprite (getGlowTexture's
    // own 0.4 stop) — real user request: neighboring tiles' puffs should
    // visually merge into one continuous bank, not read as separate
    // touching-but-distinct blobs. A big soft "skirt" reaching most of
    // the way to full-transparent at the very edge is what lets two
    // overlapping puffs blend smoothly instead of showing two ring-like
    // edges next to each other.
    grad.addColorStop(0, 'rgba(255,255,255,0.9)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.6)')
    grad.addColorStop(0.75, 'rgba(255,255,255,0.22)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const tex = new THREE.CanvasTexture(canvas)
  cloudTextureCache = tex
  return tex
}

const _fogScratchVec = new THREE.Vector3()

/** One drifting billboard puff — always faces the camera, so the exact
 * same puff reads as a flat cloud patch from TableView's near-vertical
 * top-down camera and as a wall of mist from FirstPersonView's
 * eye-level one, with no view-specific code needed. Gentle looping
 * drift (position only, never fades out) — unlike SteamPuff/
 * FlameParticle, this isn't a one-shot effect, it's a standing fog
 * bank that just breathes slightly so it doesn't read as a static
 * decal.
 *
 * Opacity fades out at close range (real user report: FPV's low eye-
 * level camera standing right next to a fogged neighboring tile turned
 * the ENTIRE screen white — a puff barely a meter from the lens still
 * subtends most of the frame even at a modest size). TableView's
 * camera sits many units up regardless of tile, so it never trips this
 * — only a puff genuinely close to whichever camera is rendering it
 * gets dimmed, distant/unexplored terrain stays properly opaque. */
function FogPuff({
  dx, dz, y, size, baseOpacity, speed, seed,
}: { dx: number; dz: number; y: number; size: number; baseOpacity: number; speed: number; seed: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const matRef = useRef<THREE.MeshBasicMaterial>(null)
  useFrame((state) => {
    if (!ref.current) return
    const t = state.clock.elapsedTime * speed + seed
    ref.current.position.set(dx + Math.sin(t) * 0.1, y + Math.sin(t * 0.7) * 0.06, dz + Math.cos(t) * 0.1)
    ref.current.quaternion.copy(state.camera.quaternion)
    if (matRef.current) {
      ref.current.getWorldPosition(_fogScratchVec)
      const dist = state.camera.position.distanceTo(_fogScratchVec)
      const fade = THREE.MathUtils.clamp((dist - 0.6) / 2.4, 0.12, 1)
      matRef.current.opacity = baseOpacity * fade
    }
  })
  return (
    <mesh ref={ref}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial ref={matRef} map={getCloudTexture()} color="#dfe7e8" transparent opacity={baseOpacity} depthWrite={false} />
    </mesh>
  )
}

/** Real user request: "niebla de guerra real en el table view. Debe
 * mostrar literalmente niebla como nubes en las casillas que el equipo
 * jugador no ve" — one of these per hex HexMap's own fog computation
 * (see teamVisibleHexes prop below) decides is currently unknown.
 *
 * Three randomly-jittered puffs per tile (real user follow-up: "me
 * gustaria que los puffs de niebla se juntasen entre si y no fuesen
 * independientes unos de otros") — sized well past hex spacing so a
 * fogged tile's own puffs reach deep into every fogged neighbor,
 * combined with getCloudTexture's own wide soft falloff so the overlap
 * blends into one continuous mass instead of showing each tile's own
 * distinct disc silhouette. Randomized (not fixed) offsets/sizes per
 * tile via useMemo (seeded once at mount, stable across re-renders —
 * same pattern SteamPuffs already uses) keep it from reading as a
 * uniform grid of identical clouds. FogPuff's own close-camera opacity
 * fade is what keeps this from blowing out FirstPersonView's close-up
 * eye-level view despite the larger size here. */
function FogTile({ x, z, seed }: { x: number; z: number; seed: number }) {
  const puffs = useMemo(
    () => Array.from({ length: 3 }, (_, i) => ({
      dx: (Math.random() - 0.5) * 0.7,
      dz: (Math.random() - 0.5) * 0.7,
      y: 0.35 + i * 0.35 + Math.random() * 0.15,
      size: 2.1 + Math.random() * 0.5,
      baseOpacity: 0.48 + Math.random() * 0.14,
      speed: 0.08 + Math.random() * 0.08,
      seed: seed + i * 4.1 + Math.random(),
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed],
  )
  return (
    <group position={[x, 0, z]}>
      {puffs.map((p, i) => <FogPuff key={i} {...p} />)}
    </group>
  )
}

export function HexMap({
  map, units, losDebugHexes, needsInitiativePilotIds, activeMoverPilotId, activeAttackerPilotIds,
  moveHighlightHexes, pathPreviewHexes, targetableHexes, walkPaths, outlineUnitIds, heatByUnitId, proneUnitIds, shutdownUnitIds,
  teamVisibleHexes, physics, activeAttack, onAttackEffectDone,
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
   * SteamPuffs (heat >= 5) on the corresponding UnitMarker. Omitted
   * entirely (not just per-unit-missing) by any caller that hasn't
   * wired heat data through yet; a unit with no entry just renders no
   * steam, same as heat 0. */
  heatByUnitId?: Map<number, number>
  /** Unit ids whose mech is currently prone/shutdown (mechs.is_prone/
   * is_shutdown) — same per-view "caller resolves its own mechs lookup,
   * HexMap just renders" pattern as heatByUnitId above. */
  proneUnitIds?: Set<number>
  shutdownUnitIds?: Set<number>
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
  // A hex's own ground/platform height — matches Tile's rendering
  // exactly, including 'building's fixed platform (BUILDING_MIN_HEIGHT,
  // not the elevation formula; see its own doc comment) — used for the
  // attack-beam Y below so a shot at/from a mech on a building tile
  // still lands at that mech's actual (now non-elevation-scaled) chest
  // height, not where the old elevation math would have put it.
  const groundYAt = (q: number, r: number) =>
    terrainAt.get(`${q},${r}`) === 'building' ? BUILDING_MIN_HEIGHT : 0.3 + (elevationAt.get(`${q},${r}`) ?? 0) * 0.22
  const visibleUnits = units.filter((u) => !(u.is_ghost && !u.revealed))
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
      if (dropQ !== drag.startQ || dropR !== drag.startR) {
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
          physics={physics}
          onPointerMove={(e) => {
            if (!dragRef.current) return
            setHover({ q: tile.q, r: tile.r })
            // e.point is world-space; this group is offset by
            // [-centerX,0,-centerZ], so add that back to land in the same
            // local space UnitMarker's own q/r-derived positions use.
            setDragWorldPos([e.point.x + centerX, e.point.z + centerZ])
          }}
          onPointerUp={(e) => resolveAt(tile.q, tile.r, e)}
        />
      ))}
      {teamVisibleHexes && map.tiles
        .filter((tile) => !teamVisibleHexes.has(`${tile.q},${tile.r}`))
        .map((tile) => {
          const [x, z] = hexToWorld(tile.q, tile.r)
          return <FogTile key={`fog-${tile.q},${tile.r}`} x={x} z={z} seed={tile.q * 7.13 + tile.r * 3.7} />
        })}
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
          heightAt={heightAt}
          outlined={outlineUnitIds?.has(unit.id) ?? false}
          heat={heatByUnitId?.get(unit.id)}
          prone={proneUnitIds?.has(unit.id) ?? false}
          shutdown={shutdownUnitIds?.has(unit.id) ?? false}
          onPointerDown={() => {
            dragRef.current = { unit, startQ: unit.q, startR: unit.r }
            setHover({ q: unit.q, r: unit.r })
            onDraggingChange?.(true)
          }}
          onPointerUp={(e) => resolveAt(unit.q, unit.r, e)}
        />
      ))}
      {activeAttack && (
        <AttackEffect
          key={activeAttack.id}
          data={{
            attackerPos: hexToWorld(activeAttack.attackerQ, activeAttack.attackerR),
            targetPos: hexToWorld(activeAttack.targetQ, activeAttack.targetR),
            attackerY: groundYAt(activeAttack.attackerQ, activeAttack.attackerR) + MODEL_SCALE * MODEL_CHEST_FRACTION,
            targetY: groundYAt(activeAttack.targetQ, activeAttack.targetR) + MODEL_SCALE * MODEL_CHEST_FRACTION,
            weaponName: activeAttack.weaponName,
            hit: activeAttack.hit,
          }}
          onDone={() => onAttackEffectDone?.()}
        />
      )}
    </group>
  )
}
