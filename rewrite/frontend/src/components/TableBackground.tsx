import { useMemo } from 'react'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
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
export function TableBackground({ physics }: { physics?: boolean } = {}) {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/table-wood.jpg')
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(WOOD_REPEAT, WOOD_REPEAT)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])

  const plane = (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial map={texture} />
    </mesh>
  )

  if (!physics) return plane

  // Real user report: a die that rolled off a hex tile (each tile only
  // has a collider for its own footprint — HexMap.tsx's Tile) into any
  // gap — between tiles at the very board edge, or wherever a non-
  // rectangular map layout leaves the rectangular BoardWalls envelope
  // without a real tile underneath — fell straight through, since this
  // background was purely a visual plane with no collider of its own at
  // all. A thick slab well below the lowest real tile surface (tiles
  // start at y=0 and go up) catches anything that slips past them,
  // settling a little lower than the surrounding tiles rather than
  // falling forever — better than a bottomless gap, and BoardWalls
  // already stops it from also sailing off sideways.
  return (
    <RigidBody type="fixed" colliders={false}>
      <CuboidCollider args={[100, 0.25, 100]} position={[0, -0.3, 0]} />
      {plane}
    </RigidBody>
  )
}
