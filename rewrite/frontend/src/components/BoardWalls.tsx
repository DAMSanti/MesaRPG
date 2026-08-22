import { RigidBody } from '@react-three/rapier'
import type { MapData } from '../api'
import { hexToWorld } from '../hexMath'

// A die thrown in with real velocity can sail clean off the far edge of
// the board (requested directly — "quiero que haya una pared invisible
// que impida esto"). Four thin, tall, invisible fixed colliders ringing
// the map's own tile bounding box — same coordinate space HexMap's own
// [-centerX,-centerZ] group offset puts everything else in, so these
// line up with the actual rendered board regardless of its shape.
const MARGIN = 1.2
const WALL_HEIGHT = 4
const WALL_THICKNESS = 0.4

export function BoardWalls({
  map, clearLeftOf,
}: {
  map: MapData
  /** Dice throw in from off-board at this world X (TableView's
   * THROW_ORIGIN_X, same uncentered coordinate space these walls live
   * in) — the left wall must sit further out than that, or it'd block
   * the throw-in itself before the dice ever reach the board. */
  clearLeftOf?: number
}) {
  const xs = map.tiles.map((t) => hexToWorld(t.q, t.r)[0])
  const zs = map.tiles.map((t) => hexToWorld(t.q, t.r)[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minZ = Math.min(...zs), maxZ = Math.max(...zs)
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
  // Centered coordinates (HexMap's own group already offsets by
  // -centerX,-centerZ using this same bounding-box midpoint).
  let left = minX - cx - MARGIN
  if (clearLeftOf != null) left = Math.min(left, clearLeftOf - 1)
  const right = maxX - cx + MARGIN
  const back = minZ - cz - MARGIN
  const front = maxZ - cz + MARGIN
  const width = right - left
  const depth = front - back

  const wall = (position: [number, number, number], size: [number, number, number]) => (
    <RigidBody type="fixed" position={position} colliders="cuboid">
      <mesh visible={false}>
        <boxGeometry args={size} />
      </mesh>
    </RigidBody>
  )

  return (
    <>
      {wall([left, WALL_HEIGHT / 2, (back + front) / 2], [WALL_THICKNESS, WALL_HEIGHT, depth + MARGIN * 2])}
      {wall([right, WALL_HEIGHT / 2, (back + front) / 2], [WALL_THICKNESS, WALL_HEIGHT, depth + MARGIN * 2])}
      {wall([(left + right) / 2, WALL_HEIGHT / 2, back], [width + MARGIN * 2, WALL_HEIGHT, WALL_THICKNESS])}
      {wall([(left + right) / 2, WALL_HEIGHT / 2, front], [width + MARGIN * 2, WALL_HEIGHT, WALL_THICKNESS])}
    </>
  )
}
