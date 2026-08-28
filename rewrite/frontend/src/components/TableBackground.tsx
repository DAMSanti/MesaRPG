import { useMemo } from 'react'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import { HEX_SIZE } from '../hexMath'

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
export function TableBackground({ physics, hexScale }: { physics?: boolean; hexScale?: boolean } = {}) {
  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/table-wood.jpg')
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(WOOD_REPEAT, WOOD_REPEAT)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])

  // 200 was a comfortable oversized margin against the OLD radius-1 hex
  // grid (~115 hex-widths across, far more than any real map needs) —
  // ×HEX_SIZE (hexMath.ts) keeps that same proportional margin now that
  // a hex is 30 world units across, so the backdrop still fully covers
  // the map instead of the (now much bigger) board hanging off its edge.
  // Gated behind hexScale (GMView/TableView's Battletech board only) — the
  // D&D square grid (TableViewDnd, and MapEditorView's editor when it's
  // showing a square map) never rescaled its own coordinates, so scaling
  // this same backdrop for it would stretch WOOD_REPEAT's fixed tile
  // count across a plane 30x too big, blurring the wood texture out to
  // one giant smear under the (comparatively tiny) square board.
  const scale = hexScale ? HEX_SIZE : 1
  const plane = (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
      <planeGeometry args={[200 * scale, 200 * scale]} />
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
      <CuboidCollider args={[100 * scale, 0.25, 100 * scale]} position={[0, -0.3, 0]} />
      {plane}
    </RigidBody>
  )
}
