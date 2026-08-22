import { useEffect, useRef, useState } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { HexTileData, MapData, Unit } from '../api'
import { Mech3D } from './Mech3D'
import { TerrainDecor } from './TerrainDecor'
import { RoadMarkings } from './RoadMarkings'
import { terrainColor, terrainRotation, terrainTexture } from '../terrain'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import { hexToWorld, mapCenter } from '../hexMath'

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

function Tile({
  tile, lookup, losHighlighted, dragHighlighted, needsInitiativeHighlighted, activeMoverHighlighted, moveHighlighted, physics,
  onPointerMove, onPointerUp,
}: {
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
  /** Give this tile a real physics collider matching its own hex/height
   * (TableView only, for the initiative dice to land and roll across
   * the actual board instead of a flat invisible floor) — must only be
   * true when HexMap is rendered inside a <Physics> provider, so GMView/
   * MapEditorView's plain (non-physics) Canvas never sets this. */
  physics?: boolean
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
}) {
  const [x, z] = hexToWorld(tile.q, tile.r)
  const height = 0.3 + tile.elevation * 0.22
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
        color={terrainColor(tile.terrain, tile.elevation, tile.q, tile.r)}
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
      {physics && (tile.terrain === 'forest' || tile.terrain === 'building') ? (
        <RigidBody type="fixed" colliders="hull">
          <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} />
        </RigidBody>
      ) : (
        <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} />
      )}
      {losHighlighted && <LosDebugOverlay height={height} color="#39ff8f" />}
      {dragHighlighted && <LosDebugOverlay height={height} color="#f5c542" y={height + 0.06} />}
      {needsInitiativeHighlighted && <LosDebugOverlay height={height} color="#ff3b3b" opacity={0.45} y={height + 0.08} />}
      {activeMoverHighlighted && <LosDebugOverlay height={height} color="#ffb020" opacity={0.5} y={height + 0.1} />}
      {moveHighlighted && <LosDebugOverlay height={height} color="#4a9eff" opacity={0.4} y={height + 0.12} />}
    </group>
  )
}

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

function UnitMarker({
  unit, elevation, dragPosition, physics, worldOffset, walkPath, onPointerDown, onPointerUp,
}: {
  unit: Unit
  elevation: number
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
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void
}) {
  const target = dragPosition ?? hexToWorld(unit.q, unit.r)
  const baseY = 0.3 + elevation * 0.22 + (dragPosition ? 0.5 : 0)
  // Ghosts stay red regardless of faction — before reveal, "hidden threat"
  // is the point, not who it turns out to be.
  const color = unit.is_ghost
    ? '#e35d5d'
    : unit.pilot_faction != null
      ? FACTION_COLORS[unit.pilot_faction]
      : NEUTRAL_UNIT_COLOR

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
  const [isMoving, setIsMoving] = useState(false)
  const canWalk = !dragPosition

  // The real route (ReachableHex.path from movement.py, threaded down
  // as walkPath) — a queue of world-space waypoints stepToward below
  // walks through one at a time, instead of sliding straight from the
  // old hex to the new one through anything in between. Replaced
  // wholesale whenever a genuinely new walkPath prop arrives (a fresh
  // move was just initiated); a caller with no path data (a free-form
  // drag/move) never sets one, so the queue stays empty and stepToward
  // just falls back to a direct line at `target` — the exact behavior
  // this had before walkPath existed.
  const pathQueueRef = useRef<[number, number][]>([])
  const lastWalkPathRef = useRef<{ q: number; r: number }[] | undefined>(undefined)
  useEffect(() => {
    if (walkPath && walkPath !== lastWalkPathRef.current) {
      lastWalkPathRef.current = walkPath
      pathQueueRef.current = walkPath.map((p) => hexToWorld(p.q, p.r))
    }
  }, [walkPath])

  // Turns to face the direction it's actually walking at each leg of a
  // real path, not just at the final destination — see TURN_SPEED/
  // lerpAngle above. Settles onto the unit's real commanded facing_deg
  // (facingRotationY) once there's no more route left to walk.
  const animatedRot = useRef<number>(facingRotationY)

  const stepToward = (delta: number) => {
    if (!canWalk) {
      animatedPos.current = target
      animatedRot.current = facingRotationY
      pathQueueRef.current = []
      if (isMoving) setIsMoving(false)
      return
    }
    const queue = pathQueueRef.current
    const immediateTarget = queue.length > 0 ? queue[0] : target
    const [cx, cz] = animatedPos.current
    const [tx, tz] = immediateTarget
    const dx = tx - cx
    const dz = tz - cz
    const dist = Math.hypot(dx, dz)
    const headingTarget = dist > ARRIVE_EPSILON ? Math.atan2(dx, dz) : facingRotationY
    animatedRot.current = lerpAngle(
      animatedRot.current,
      headingTarget,
      Math.min(1, TURN_SPEED * delta),
    )
    if (dist <= ARRIVE_EPSILON) {
      animatedPos.current = immediateTarget
      if (queue.length > 0) {
        pathQueueRef.current = queue.slice(1)
      } else if (isMoving) {
        setIsMoving(false)
      }
    } else {
      const step = Math.min(1, (WALK_SPEED * delta) / dist)
      animatedPos.current = [cx + dx * step, cz + dz * step]
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
    const rot = animatedRot.current
    if (physics) {
      const body = rigidBodyRef.current
      if (body) {
        // World space, not this group's local space — see worldOffset's
        // own doc comment above for why the subtraction is required here.
        const [centerX, centerZ] = worldOffset
        body.setNextKinematicTranslation({ x: x - centerX, y: baseY, z: z - centerZ })
        body.setNextKinematicRotation(quaternionFromY(rot))
      }
    } else {
      groupRef.current?.position.set(x, baseY, z)
      groupRef.current?.rotation.set(0, rot, 0)
    }
  })

  const mechOrMarker =
    unit.mech_id != null ? (
      <Mech3D color={color} chassis={unit.mech_chassis} model={unit.mech_model} isMoving={isMoving} />
    ) : (
      <mesh position={[0, 0.35, 0]} castShadow>
        <coneGeometry args={[0.35, 0.7, 4]} />
        <meshStandardMaterial color={color} />
      </mesh>
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
        position={[animatedPos.current[0], baseY, animatedPos.current[1]]}
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
      position={[animatedPos.current[0], baseY, animatedPos.current[1]]}
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
}

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

export function HexMap({
  map, units, losDebugHexes, needsInitiativePilotIds, activeMoverPilotId, moveHighlightHexes, walkPaths, physics,
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
  /** Hexes the current mover can reach this movement phase, as "q,r"
   * keys — see app/systems/battletech/movement.py::reachable_hexes. */
  moveHighlightHexes?: Set<string>
  /** The real hex-by-hex route for any unit currently mid-move this
   * movement phase, keyed by unit id (movement.py's ReachableHex.path,
   * captured by the caller at the moment it initiated the move — see
   * UnitMarker's own walkPath doc comment). Units with no entry here
   * just walk a direct line to their new q/r, same as before this
   * existed. */
  walkPaths?: Map<number, { q: number; r: number }[]>
  /** Give every tile and mech a real physics collider (initiative dice
   * roll and bounce across the actual board — TableView only). Must
   * only be set true when this HexMap is rendered inside a <Physics>
   * provider — GMView's/MapEditorView's embedded maps have none, so
   * they never pass this. */
  physics?: boolean
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
  const elevationAt = new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t.elevation]))
  const lookup = new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t]))
  const visibleUnits = units.filter((u) => !(u.is_ghost && !u.revealed))
  const [centerX, centerZ] = mapCenter(map.tiles)
  const needsInitiativeTiles = new Set(
    visibleUnits
      .filter((u) => u.pilot_id != null && (needsInitiativePilotIds?.has(u.pilot_id) ?? false))
      .map((u) => `${u.q},${u.r}`),
  )
  const activeMoverTiles = new Set(
    visibleUnits.filter((u) => u.pilot_id != null && u.pilot_id === activeMoverPilotId).map((u) => `${u.q},${u.r}`),
  )

  const dragRef = useRef<DragState | null>(null)
  const [hover, setHover] = useState<{ q: number; r: number } | null>(null)
  const [dragWorldPos, setDragWorldPos] = useState<[number, number] | null>(null)

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
        onUnitDragEnd?.(drag.unit, dropQ, dropR, e.nativeEvent.clientX, e.nativeEvent.clientY)
      } else {
        onUnitClick?.(drag.unit, e.nativeEvent.clientX, e.nativeEvent.clientY)
      }
    } else {
      onTileClick?.(q, r, e.nativeEvent.clientX, e.nativeEvent.clientY)
    }
  }

  return (
    <group position={[-centerX, 0, -centerZ]}>
      {map.tiles.map((tile) => (
        <Tile
          key={`${tile.q},${tile.r}`} tile={tile} lookup={lookup}
          losHighlighted={losDebugHexes?.has(`${tile.q},${tile.r}`) ?? false}
          dragHighlighted={dragRef.current != null && hover?.q === tile.q && hover?.r === tile.r}
          needsInitiativeHighlighted={needsInitiativeTiles.has(`${tile.q},${tile.r}`)}
          activeMoverHighlighted={activeMoverTiles.has(`${tile.q},${tile.r}`)}
          moveHighlighted={moveHighlightHexes?.has(`${tile.q},${tile.r}`) ?? false}
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
      {visibleUnits.map((unit) => (
        <UnitMarker
          key={unit.id}
          unit={unit}
          elevation={elevationAt.get(`${unit.q},${unit.r}`) ?? 0}
          dragPosition={dragRef.current?.unit.id === unit.id ? (dragWorldPos ?? undefined) : undefined}
          physics={physics}
          worldOffset={[centerX, centerZ]}
          walkPath={walkPaths?.get(unit.id)}
          onPointerDown={() => {
            dragRef.current = { unit, startQ: unit.q, startR: unit.r }
            setHover({ q: unit.q, r: unit.r })
            onDraggingChange?.(true)
          }}
          onPointerUp={(e) => resolveAt(unit.q, unit.r, e)}
        />
      ))}
    </group>
  )
}
