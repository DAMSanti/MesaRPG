import * as THREE from 'three'
import { hashTile, buildingKind, terrainTexture } from '../terrain'

// Fallen-leaf litter (forest) / grass tufts (plains) — thin, cheap,
// scattered by a per-decal hash so they land at a different spot/angle
// each time without needing per-tile state. Deliberately sparse (most
// calls return nothing) per the "sin mucha densidad, desperdigado" ask —
// a light dusting of personality, not a lawn's worth of geometry.
function LeafLitter({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'leaf-litter')
  if (seed % 100 >= 45) return null
  const count = 1 + (seed % 2)
  const colors = ['#a8702f', '#c78a35', '#8a5a26', '#b5893a']
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `leaf-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = 0.12 + ((s >>> 8) % 100) / 100 * 0.6
        const size = 0.05 + ((s >>> 16) % 100) / 100 * 0.05
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, 0.015, Math.sin(angle) * dist]}
            rotation={[-Math.PI / 2, 0, (s % 628) / 100]}
          >
            <planeGeometry args={[size, size * 0.7]} />
            <meshStandardMaterial color={colors[s % colors.length]} side={THREE.DoubleSide} />
          </mesh>
        )
      })}
    </group>
  )
}

function GrassTufts({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'grass-tuft')
  if (seed % 100 >= 30) return null
  const count = 1 + (seed % 3)
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `tuft-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = 0.1 + ((s >>> 8) % 100) / 100 * 0.65
        const bladeScale = 0.7 + ((s >>> 16) % 100) / 100 * 0.5
        const px = Math.cos(angle) * dist
        const pz = Math.sin(angle) * dist
        return (
          <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale}>
            {[-1, 0, 1].map((lean) => (
              <mesh key={lean} position={[lean * 0.015, 0.055, 0]} rotation={[0, 0, lean * 0.35]} castShadow>
                <coneGeometry args={[0.01, 0.11, 3]} />
                <meshStandardMaterial color={lean === 0 ? '#4d7a3d' : '#3f6b34'} />
              </mesh>
            ))}
          </group>
        )
      })}
    </group>
  )
}

/** Cheap procedural "models" for terrain worth a 3D shape beyond flat
 * colour/texture — forest gets a tree (+ scattered fallen leaves),
 * plains gets scattered grass tufts, building gets a rooftop block.
 * Everything else reads fine from the texture alone; a mesh for those
 * would be decoration without a mechanism. Shape/size/tint vary per tile
 * via a coordinate hash (deterministic — same tile always looks the same,
 * unlike Math.random which would reshuffle on every re-render) so a
 * cluster of trees or buildings doesn't look like one model copy-pasted. */
export function TerrainDecor({ terrain, height, q, r }: { terrain: string; height: number; q: number; r: number }) {
  if (terrain === 'forest') {
    const seed = hashTile(q, r, 'forest-decor')
    const kind = seed % 3
    const scale = 0.85 + ((seed >>> 3) % 100) / 100 * 0.4
    return (
      <>
        <group position={[0, height, 0]} scale={scale}>
          <mesh position={[0, 0.18, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.08, 0.36, 5]} />
            <meshStandardMaterial color="#3a2a1c" />
          </mesh>
          {kind === 0 && (
            <mesh position={[0, 0.5, 0]} castShadow>
              <coneGeometry args={[0.32, 0.6, 6]} />
              <meshStandardMaterial color="#234a30" />
            </mesh>
          )}
          {kind === 1 && (
            <mesh position={[0, 0.5, 0]} castShadow>
              <sphereGeometry args={[0.3, 7, 6]} />
              <meshStandardMaterial color="#2b5536" />
            </mesh>
          )}
          {kind === 2 && (
            <group position={[0, 0.38, 0]}>
              <mesh castShadow>
                <coneGeometry args={[0.3, 0.36, 6]} />
                <meshStandardMaterial color="#1f4028" />
              </mesh>
              <mesh position={[0, 0.28, 0]} castShadow>
                <coneGeometry args={[0.22, 0.3, 6]} />
                <meshStandardMaterial color="#2a5533" />
              </mesh>
            </group>
          )}
        </group>
        <group position={[0, height, 0]}>
          <LeafLitter q={q} r={r} />
        </group>
      </>
    )
  }
  if (terrain === 'plains') {
    return (
      <group position={[0, height, 0]}>
        <GrassTufts q={q} r={r} />
      </group>
    )
  }
  if (terrain === 'building') {
    const kind = buildingKind(q, r)
    const seed = hashTile(q, r, 'building-decor')
    const jitter = (shift: number, spread: number) => ((seed >>> shift) % 100) / 100 * spread
    // The rooftop texture (skylights, AC units, panel grid, or the
    // collapsed/scorched look for ruins) is what actually reads as "a
    // textured building" — it was being drawn on the flat tile underneath
    // and then completely hidden by an opaque, untextured box sitting on
    // top of it. Applying it as the box's own material fixes that.
    const roofMap = terrainTexture('building', q, r)

    if (kind === 0) {
      // clean single tower
      const h = 0.55 + jitter(4, 0.5)
      const fp = 0.75 + jitter(8, 0.25)
      return (
        <mesh position={[0, height + h / 2, 0]} castShadow>
          <boxGeometry args={[fp, h, fp]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
      )
    }
    if (kind === 1) {
      // stepped tower — a smaller plain rooftop-equipment housing on top
      // of the main, fully textured block
      const h1 = 0.4 + jitter(4, 0.3)
      const h2 = 0.25 + jitter(10, 0.25)
      return (
        <group>
          <mesh position={[0, height + h1 / 2, 0]} castShadow>
            <boxGeometry args={[0.85, h1, 0.85]} />
            <meshStandardMaterial map={roofMap} />
          </mesh>
          <mesh position={[0, height + h1 + h2 / 2, 0]} castShadow>
            <boxGeometry args={[0.45, h2, 0.45]} />
            <meshStandardMaterial color="#4d5458" />
          </mesh>
        </group>
      )
    }
    if (kind === 2) {
      // wide low warehouse
      const h = 0.32 + jitter(4, 0.2)
      return (
        <mesh position={[0, height + h / 2, 0]} castShadow>
          <boxGeometry args={[0.95, h, 0.95]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
      )
    }
    // kind 3/4: ruined — an uneven, broken silhouette instead of a clean
    // box, textured with the collapsed/scorched roof (drawBuildingRuined).
    // The small debris chunks stay plain-coloured — they're rubble, not
    // building, so the building texture wouldn't belong on them.
    const mainH = kind === 4 ? 0.12 + jitter(4, 0.15) : 0.3 + jitter(4, 0.3)
    return (
      <group>
        <mesh position={[0, height + mainH / 2, 0]} rotation={[0, jitter(0, 0.3), 0]} castShadow>
          <boxGeometry args={[0.7, mainH, 0.7]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
        <mesh position={[0.3, height + 0.08, 0.2]} rotation={[0.15, 0.4, 0.1]} castShadow>
          <boxGeometry args={[0.3, 0.16, 0.3]} />
          <meshStandardMaterial color="#4a4038" />
        </mesh>
        <mesh position={[-0.25, height + 0.06, -0.25]} rotation={[-0.1, 0.8, 0.2]} castShadow>
          <boxGeometry args={[0.25, 0.12, 0.25]} />
          <meshStandardMaterial color="#443a34" />
        </mesh>
      </group>
    )
  }
  return null
}
