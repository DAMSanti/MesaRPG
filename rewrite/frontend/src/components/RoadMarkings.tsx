import * as THREE from 'three'
import { useMemo } from 'react'
import { roadConnections } from '../terrain'

const LINE_COLOR = '#e8d296'
const HALF_WIDTH = 0.11
const OUTER_T = 0.95
// Dash noticeably longer than the gap between dashes, as asked for.
const DASH_LEN = 0.18
const GAP_LEN = 0.08

/** [start, end] distances-from-center for each dash along the line, up to
 * `OUTER_T` — computed once since it never depends on angle or position. */
const DASH_INTERVALS: [number, number][] = (() => {
  const intervals: [number, number][] = []
  let t = 0
  while (t < OUTER_T) {
    const end = Math.min(t + DASH_LEN, OUTER_T)
    intervals.push([t, end])
    t = end + GAP_LEN
  }
  return intervals
})()

/** One quad per dash, from the tile center out toward `OUTER_T` along
 * `angle`, as raw vertex positions — no object rotation involved anywhere,
 * so there's no Euler/quaternion sign convention that could point it the
 * wrong way. `angle` and the resulting positions are computed straight
 * from real world coordinates (see terrain.ts `roadConnections`), so this
 * always points exactly at the connected neighbor. */
function segmentPositions(angle: number): Float32Array {
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  const px = -dz * HALF_WIDTH
  const pz = dx * HALF_WIDTH
  const verts: number[] = []
  for (const [t0, t1] of DASH_INTERVALS) {
    const ix = dx * t0
    const iz = dz * t0
    const ox = dx * t1
    const oz = dz * t1
    verts.push(
      ix + px, 0, iz + pz,
      ix - px, 0, iz - pz,
      ox + px, 0, oz + pz,

      ix - px, 0, iz - pz,
      ox - px, 0, oz - pz,
      ox + px, 0, oz + pz,
    )
  }
  return new Float32Array(verts)
}

function LineSegment({ angle, y }: { angle: number; y: number }) {
  const positions = useMemo(() => segmentPositions(angle), [angle])
  return (
    <mesh position={[0, y, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial color={LINE_COLOR} side={THREE.DoubleSide} />
    </mesh>
  )
}

/**
 * Painted line markings for a road tile, built from its real neighbors
 * instead of a rotated pre-baked texture (see terrain.ts `roadConnections`
 * for why — a single rotatable line texture can't represent a bend/dead
 * end/crossroads). Each connection gets a dashed line running from the
 * tile's center out to its edge along the exact angle toward that
 * neighbor, so a through road reads as one dashed line spanning the tile,
 * a bend meets at the center, and a crossing radiates one dashed line per
 * direction — all from the same per-connection segment, no special case
 * needed per shape.
 */
export function RoadMarkings({
  q,
  r,
  height,
  lookup,
  gridType,
  worldPos,
}: {
  q: number
  r: number
  height: number
  lookup: Map<string, { terrain: string }>
  gridType: 'hex' | 'square'
  worldPos: (q: number, r: number) => [number, number]
}) {
  const angles = roadConnections(q, r, lookup, gridType, worldPos)
  const y = height + 0.01

  if (angles.length === 0) {
    return (
      <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.16, 12]} />
        <meshBasicMaterial color={LINE_COLOR} />
      </mesh>
    )
  }

  return (
    <group>
      {angles.map((angle, i) => (
        <LineSegment key={i} angle={angle} y={y} />
      ))}
    </group>
  )
}
