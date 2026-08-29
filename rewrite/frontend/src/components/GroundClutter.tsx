import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { HexTileData } from '../api'
import { HEX_SIZE, hexToWorld } from '../hexMath'
import { hashTile, plainsGroundVariant } from '../terrain'
import { vegetationRegion } from './GroundVegetation'
import { MODEL_SCALE } from './Mech3D'
import { makeTileHeightSampler } from '../tileHeightField'
import { getLeafTexture, LEAF_SHAPES, type LeafShape } from './TerrainDecor'

/** Leaf litter, pebbles and grass tufts for the whole board, in seven
 * instanced draws.
 *
 * These used to be per-tile `<mesh>` scatter inside TerrainDecor: a plains
 * tile drew up to five tufts of five cone blades each, plus loose pebbles,
 * and a forest tile a couple of leaf quads — every one of them its own
 * mesh, its own geometry and its own material. Measured on the real board
 * (campaign 65) that was the single worst thing on it:
 *
 *   decoración   733 draw calls   4.900 triangles   ≈ 7 triangles per draw
 *
 * versus the grass carpet's 411.400 instances in 2 draws. With `gl.render`
 * eating 93% of a 71ms frame at 2.683 draw calls, those 733 were roughly a
 * quarter of the whole problem, bought for two thousandths of the
 * triangles. Nothing here changes what the board looks like — the
 * placement hashes below are copied from the originals so every leaf and
 * pebble lands exactly where it landed before.
 *
 * Colour variety survives instancing through `setColorAt`: three.js
 * multiplies each instance's own colour into the shared material, so one
 * material still gives a palette.
 *
 * One thing genuinely improves. The old scatter sat at the tile's single
 * flat `height`, so on a ramped or bumpy tile the pebbles at the edges
 * floated or sank; these sample the tile's real surface, the same way the
 * grass and plants already do. */

// Same MECH-factor as TerrainDecor's own — these sizes were tuned by eye
// against the mech, not the hex grid.
const MECH_FACTOR = MODEL_SCALE / 1.65

const LEAF_COLORS = ['#a8702f', '#c78a35', '#8a5a26', '#b5893a', '#d9a441', '#7a4a1f']
const PEBBLE_COLORS = ['#8b8378', '#6f6a62', '#a39a8a', '#5f5b54']
/** Per grass-tuft species, in the same order the original `species` index
 * picked them: 0 bushy clump, 1 tall dry pair, 2 fine three-blade tuft. */
const BLADE_PALETTES = [
  ['#5c8a3f', '#4a7332', '#6b9748'],
  ['#a89a4e', '#8f8240', '#b8ab63'],
  ['#4d7a3d', '#3f6b34', '#5a8a44'],
]

/** Unit-sized on purpose: every per-instance size difference rides in the
 * instance matrix instead of in its own geometry, which is the whole point
 * of batching these. */
let sharedGeometries: {
  leaf: THREE.PlaneGeometry
  pebble: THREE.IcosahedronGeometry
  blades: THREE.ConeGeometry[]
} | null = null

function geometries() {
  if (!sharedGeometries) {
    sharedGeometries = {
      leaf: new THREE.PlaneGeometry(1, 1),
      pebble: new THREE.IcosahedronGeometry(1, 0),
      // Radii and heights straight from the originals; the group scale
      // that used to wrap them is folded into each instance matrix.
      blades: [
        new THREE.ConeGeometry(0.012, 0.09, 3),
        new THREE.ConeGeometry(0.007, 0.18, 3),
        new THREE.ConeGeometry(0.01, 0.11, 3),
      ],
    }
  }
  return sharedGeometries
}

interface Bucket {
  key: string
  geometry: THREE.BufferGeometry
  material: THREE.Material
  matrices: THREE.Matrix4[]
  colors: THREE.Color[]
  castShadow: boolean
}

function bucketFor(
  out: Map<string, Bucket>,
  key: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  castShadow: boolean,
): Bucket {
  let bucket = out.get(key)
  if (!bucket) {
    bucket = { key, geometry, material, matrices: [], colors: [], castShadow }
    out.set(key, bucket)
  }
  return bucket
}

export function GroundClutter({ tiles, lookup, regionSpan }: {
  tiles: HexTileData[]
  lookup: Map<string, HexTileData>
  /** See GroundVegetation's own prop — same dial, same reasoning. */
  regionSpan: number | null
}) {
  // Keyed on the tiles' CONTENT rather than the array holding them: a
  // session refetch hands down a new array describing the same board, and
  // rebuilding every batch for that was a real user-visible flicker in the
  // first-person view (see GroundVegetation's own note).
  const tilesKey = useMemo(
    () => tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|'),
    [tiles],
  )

  const materials = useMemo(() => {
    const leaf = new Map<LeafShape, THREE.Material>()
    for (const shape of LEAF_SHAPES) {
      leaf.set(shape, new THREE.MeshStandardMaterial({
        map: getLeafTexture(shape),
        transparent: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
      }))
    }
    return {
      leaf,
      pebble: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
      // All three blade species differ only in geometry, so they share one
      // material and their colours ride per instance.
      blade: new THREE.MeshStandardMaterial({}),
    }
  }, [])

  useEffect(() => () => {
    materials.leaf.forEach((m) => m.dispose())
    materials.pebble.dispose()
    materials.blade.dispose()
  }, [materials])

  const buckets = useMemo(() => {
    const geo = geometries()
    const out = new Map<string, Bucket>()
    const group = new THREE.Object3D()
    const blade = new THREE.Object3D()
    const composed = new THREE.Matrix4()

    for (const tile of tiles) {
      const { q, r, terrain } = tile
      const forest = terrain === 'forest' || terrain === 'light_forest'
      const plains = terrain === 'plains'
      if (!forest && !plains) continue

      const [wx, wz] = hexToWorld(q, r)
      // Same cullable regions the plants use, for the same reason.
      const region = vegetationRegion(q, r, regionSpan)
      const surfaceAt = makeTileHeightSampler(tile, lookup)

      if (forest) {
        // --- leaf litter
        const seed = hashTile(q, r, 'leaf-litter')
        if (seed % 100 < 45) {
          const count = 1 + (seed % 2)
          for (let i = 0; i < count; i++) {
            const s = hashTile(q, r, `leaf-${i}`)
            const angle = (s % 360) * (Math.PI / 180)
            const dist = (0.12 + ((s >>> 8) % 100) / 100 * 0.6) * HEX_SIZE
            const size = (0.08 + ((s >>> 16) % 100) / 100 * 0.07) * MECH_FACTOR
            const shape = LEAF_SHAPES[s % LEAF_SHAPES.length]
            const x = Math.cos(angle) * dist
            const z = Math.sin(angle) * dist
            group.position.set(wx + x, surfaceAt(x, z) + 0.015 * MECH_FACTOR, wz + z)
            group.rotation.set(-Math.PI / 2, 0, (s % 628) / 100)
            group.scale.set(size, size, 1)
            group.updateMatrix()
            const bucket = bucketFor(
              out, `${region}:leaf:${shape}`, geo.leaf, materials.leaf.get(shape)!, false,
            )
            bucket.matrices.push(group.matrix.clone())
            bucket.colors.push(new THREE.Color(LEAF_COLORS[s % LEAF_COLORS.length]))
          }
        }
        continue
      }

      // --- pebbles
      const pebbleSeed = hashTile(q, r, 'pebbles')
      if (pebbleSeed % 100 < 35) {
        const count = 1 + (pebbleSeed % 3)
        for (let i = 0; i < count; i++) {
          const s = hashTile(q, r, `pebble-${i}`)
          const angle = (s % 360) * (Math.PI / 180)
          const dist = (0.08 + ((s >>> 8) % 100) / 100 * 0.7) * HEX_SIZE
          const size = (0.02 + ((s >>> 16) % 100) / 100 * 0.035) * MECH_FACTOR
          const flat = 0.55 + ((s >>> 20) % 100) / 100 * 0.3
          const x = Math.cos(angle) * dist
          const z = Math.sin(angle) * dist
          group.position.set(wx + x, surfaceAt(x, z) + size * flat * 0.5, wz + z)
          group.rotation.set((s % 628) / 100, ((s >>> 4) % 628) / 100, ((s >>> 9) % 628) / 100)
          // The original squashed a `size`-radius icosahedron by [1,flat,1];
          // with a unit geometry that becomes the scale outright.
          group.scale.set(size, size * flat, size)
          group.updateMatrix()
          const bucket = bucketFor(out, `${region}:pebble`, geo.pebble, materials.pebble, true)
          bucket.matrices.push(group.matrix.clone())
          bucket.colors.push(new THREE.Color(PEBBLE_COLORS[s % PEBBLE_COLORS.length]))
        }
      }

      // --- grass tufts
      const sparse = plainsGroundVariant(q, r) === 'dirt'
      const tuftSeed = hashTile(q, r, 'grass-tuft')
      if (tuftSeed % 100 >= (sparse ? 45 : 92)) continue
      const tuftCount = (sparse ? 1 : 2) + (tuftSeed % 4)
      for (let i = 0; i < tuftCount; i++) {
        const s = hashTile(q, r, `tuft-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = (0.08 + ((s >>> 8) % 100) / 100 * 0.7) * HEX_SIZE
        const bladeScale = (0.7 + ((s >>> 16) % 100) / 100 * 0.5) * MECH_FACTOR
        const x = Math.cos(angle) * dist
        const z = Math.sin(angle) * dist
        const species = (s >>> 24) % 3
        const speciesScale = species === 0 ? 0.85 : (species === 1 ? 1.15 : 1)
        const palette = BLADE_PALETTES[species]

        // The tuft's own group transform, exactly as the JSX built it.
        group.position.set(wx + x, surfaceAt(x, z), wz + z)
        group.rotation.set(0, (s % 628) / 100, 0)
        group.scale.setScalar(bladeScale * speciesScale)
        group.updateMatrix()

        // Each blade's local transform, then flattened into world space:
        // an instanced mesh has no parent group to inherit one from.
        const bucket = bucketFor(out, `${region}:blade:${species}`, geo.blades[species], materials.blade, true)
        if (species === 0) {
          const blades = 5
          for (let b = 0; b < blades; b++) {
            const bAng = (b / blades) * Math.PI * 2
            blade.position.set(Math.cos(bAng) * 0.02, 0.045, Math.sin(bAng) * 0.02)
            blade.rotation.set(Math.sin(bAng) * 0.3, 0, Math.cos(bAng) * 0.3)
            blade.scale.setScalar(1)
            blade.updateMatrix()
            composed.multiplyMatrices(group.matrix, blade.matrix)
            bucket.matrices.push(composed.clone())
            bucket.colors.push(new THREE.Color(palette[b % palette.length]))
          }
        } else if (species === 1) {
          for (const lean of [-1, 1]) {
            blade.position.set(lean * 0.012, 0.09, 0)
            blade.rotation.set(0, 0, lean * 0.22)
            blade.scale.setScalar(1)
            blade.updateMatrix()
            composed.multiplyMatrices(group.matrix, blade.matrix)
            bucket.matrices.push(composed.clone())
            bucket.colors.push(new THREE.Color(palette[lean === -1 ? 0 : 1]))
          }
        } else {
          for (const lean of [-1, 0, 1]) {
            blade.position.set(lean * 0.015, 0.055, 0)
            blade.rotation.set(0, 0, lean * 0.35)
            blade.scale.setScalar(1)
            blade.updateMatrix()
            composed.multiplyMatrices(group.matrix, blade.matrix)
            bucket.matrices.push(composed.clone())
            bucket.colors.push(new THREE.Color(palette[lean === 0 ? 0 : 1]))
          }
        }
      }
    }

    return [...out.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, materials, regionSpan])

  return (
    <>
      {buckets.map((bucket) => <ClutterBatch key={bucket.key} bucket={bucket} />)}
    </>
  )
}

function ClutterBatch({ bucket }: { bucket: Bucket }) {
  const ref = useRef<THREE.InstancedMesh>(null)

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    bucket.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    bucket.colors.forEach((c, i) => mesh.setColorAt(i, c))
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    // Bounds over the instances just written — what lets the frustum test
    // below cull a region the camera is not looking at.
    mesh.computeBoundingSphere()
  }, [bucket])

  if (bucket.matrices.length === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[bucket.geometry, bucket.material, bucket.matrices.length]}
      userData={{ perfGroup: 'decoración' }}
      receiveShadow
      castShadow={bucket.castShadow}
    />
  )
}
