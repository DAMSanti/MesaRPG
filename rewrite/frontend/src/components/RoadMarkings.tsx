import * as THREE from 'three'
import { useMemo } from 'react'
import { roadConnections } from '../terrain'

const HALF_WIDTH = 0.11
// Per the user's own spec: imagine the segment from a tile's center to
// the midpoint of the edge it shares with a connected road tile (t=0 to
// t=1 below, in the same "world units along the connection angle"
// parameterization the old dash-array code already used and tuned by
// eye to reach the tile edge). Paint exactly ONE dash spanning the
// middle half of that segment — leaves a gap at the tile's own center
// (so a bend's two segments don't visually collide there) and a gap at
// each tile seam (so a long straight road reads as evenly-spaced
// dashes, two per through-tile, not one continuous line).
const DASH_START = 0.25
const DASH_END = 0.75

// A worn/scuffed off-white line reads as painted road marking rather
// than a stark decal — plain white or an unlit flat fill both looked
// wrong ("ahora mismo destaca mucho"): unlit MeshBasicMaterial ignored
// the scene's own lighting entirely, so the line sat at full flat
// brightness no matter how shaded the road tile itself was, while every
// other surface on the table responds to light — that mismatch, more
// than the exact color, was what made it "pop". Baked once (canvas, no
// external asset — same approach as terrain.ts's procedural patterns)
// and reused via meshStandardMaterial so it shades/shadows like
// everything else.
let lineTextureCache: THREE.Texture | null = null
function getLineTexture(): THREE.Texture {
  if (lineTextureCache) return lineTextureCache
  const w = 64
  const h = 16
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#cfc9ba'
  ctx.fillRect(0, 0, w, h)
  // Subtle worn/scuffed patches — irregular darker patches breaking up
  // the fill so it reads as faded paint on asphalt, not a clean decal.
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * w
    const y = Math.random() * h
    const r = 0.6 + Math.random() * 1.8
    ctx.fillStyle = `rgba(90,85,72,${0.08 + Math.random() * 0.16})`
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * 0.6, Math.random() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  lineTextureCache = tex
  return tex
}

/** One dash's quad, from `DASH_START` to `DASH_END` along `angle`, as raw
 * vertex positions (+ UVs so the worn-paint texture maps along its
 * length) — no object rotation involved anywhere, so there's no Euler/
 * quaternion sign convention that could point it the wrong way. `angle`
 * comes straight from real world coordinates (terrain.ts's
 * `roadConnections`), so this always points exactly at the connected
 * neighbor. */
function dashGeometry(angle: number): { positions: Float32Array; uvs: Float32Array } {
  const dx = Math.cos(angle)
  const dz = Math.sin(angle)
  const px = -dz * HALF_WIDTH
  const pz = dx * HALF_WIDTH
  const ix = dx * DASH_START, iz = dz * DASH_START
  const ox = dx * DASH_END, oz = dz * DASH_END
  const positions = new Float32Array([
    ix + px, 0, iz + pz,
    ix - px, 0, iz - pz,
    ox + px, 0, oz + pz,

    ix - px, 0, iz - pz,
    ox - px, 0, oz - pz,
    ox + px, 0, oz + pz,
  ])
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0, 1,

    1, 0,
    1, 1,
    0, 1,
  ])
  return { positions, uvs }
}

function LineSegment({ angle, y }: { angle: number; y: number }) {
  const { positions, uvs } = useMemo(() => dashGeometry(angle), [angle])
  return (
    <mesh position={[0, y, 0]} receiveShadow>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-uv" args={[uvs, 2]} />
      </bufferGeometry>
      <meshStandardMaterial map={getLineTexture()} roughness={0.9} side={THREE.DoubleSide} />
    </mesh>
  )
}

/**
 * Painted line markings for a road tile, built from its real neighbors
 * instead of a rotated pre-baked texture (see terrain.ts `roadConnections`
 * for why — a single rotatable line texture can't represent a bend/dead
 * end/crossroads). Each connection gets exactly one dash centered on the
 * middle half of the segment toward that neighbor (see DASH_START/END
 * above), so a through road reads as two dashes per tile, a bend meets
 * near the center with a gap, and a crossing radiates one dash per
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
      <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[0.16, 12]} />
        <meshStandardMaterial map={getLineTexture()} roughness={0.9} />
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
