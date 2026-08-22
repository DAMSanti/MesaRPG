import { useMemo } from 'react'
import * as THREE from 'three'

// A real CC0 photo texture (ambientCG's Wood095 — see
// public/textures/CREDITS.md), not a procedural canvas texture like
// terrain.ts/Die.tsx use elsewhere — the user specifically asked for a
// real wood photo here. Plain THREE.TextureLoader instead of r3f's
// useLoader/useTexture (which suspend) — nothing else in this codebase
// sets up a Suspense boundary around its Canvas, and the plain loader
// just starts blank and repaints once the image arrives, same as a
// normal <img>.
const WOOD_REPEAT = 14

/** The physical gaming-table surface the hex board sits on — a large
 * wood-textured plane behind the map, visible in the gaps between/
 * around tiles under the fixed top-down camera (TableView, GMView).
 * Not part of HexMap itself: HexMap's own contents sit inside a
 * recentering group (see hexMath.ts's mapCenter), but this backdrop
 * should stay fixed and just cover the whole visible floor regardless
 * of where the map itself is centered. */
export function TableBackground() {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/table-wood.jpg')
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(WOOD_REPEAT, WOOD_REPEAT)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial map={texture} />
    </mesh>
  )
}
