import type { ThreeEvent } from '@react-three/fiber'
import type { MapData, Unit } from '../api'
import { mapCenter, squareToWorld } from '../squareMath'

/** D&D 5e's own map renderer (ROADMAP.md Fase R4 — slice mínimo) —
 * deliberately NOT HexMap.tsx generalized to a second grid type.
 * HexMap.tsx carries a lot of BattleTech-specific machinery entangled
 * with its core rendering (terrain decoration, footprint trails, attack
 * VFX, physics colliders) that this slice doesn't need and shouldn't
 * risk regressing by touching that file at all. This is intentionally
 * much simpler: flat tiles, plain colored tokens, click-to-select —
 * enough to place a character and play a small skirmish, not visual
 * parity with the BattleTech table. */

const TILE_SIZE = 0.95
const TILE_GAP_COLOR = '#241a10'

function tileColor(terrain: string): string {
  // D&D v1 has no real biome/terrain generation of its own yet (out of
  // this slice's scope) — a flat checkerboard-free neutral floor per
  // elevation-agnostic tile, distinguished only by whether something
  // marked it "blocked" (a wall/obstacle painted via the same tile-patch
  // endpoint the hex editor already uses).
  return terrain === 'wall' ? '#4a4038' : '#3a4a3f'
}

export function SquareMap({
  map, units, selectedTile, onTileClick, selectedUnitId, onUnitClick,
}: {
  map: MapData
  units: Unit[]
  selectedTile?: { q: number; r: number } | null
  onTileClick?: (q: number, r: number) => void
  selectedUnitId?: number | null
  onUnitClick?: (unit: Unit) => void
}) {
  const [centerX, centerZ] = mapCenter(map.tiles)

  return (
    <group position={[-centerX, 0, -centerZ]}>
      {map.tiles.map((tile) => {
        const [x, z] = squareToWorld(tile.q, tile.r)
        const isSelected = selectedTile?.q === tile.q && selectedTile?.r === tile.r
        return (
          <group key={`${tile.q},${tile.r}`} position={[x, 0, z]}>
            <mesh position={[0, -0.02, 0]} receiveShadow>
              <boxGeometry args={[1, 0.04, 1]} />
              <meshStandardMaterial color={TILE_GAP_COLOR} roughness={0.9} />
            </mesh>
            <mesh
              position={[0, 0.13, 0]}
              receiveShadow
              onPointerUp={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation()
                onTileClick?.(tile.q, tile.r)
              }}
            >
              <boxGeometry args={[TILE_SIZE, 0.26, TILE_SIZE]} />
              <meshStandardMaterial color={tileColor(tile.terrain)} roughness={0.85} />
            </mesh>
            {isSelected && (
              <mesh position={[0, 0.27, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[0.38, 0.46, 24]} />
                <meshBasicMaterial color="#f5c542" transparent opacity={0.9} depthWrite={false} />
              </mesh>
            )}
          </group>
        )
      })}
      {units
        .filter((u) => u.dnd_character_id != null)
        .map((unit) => {
          const [x, z] = squareToWorld(unit.q, unit.r)
          const hpFraction = unit.dnd_hp_max ? (unit.dnd_hp_current ?? 0) / unit.dnd_hp_max : 1
          const color = hpFraction <= 0 ? '#3a3a3a' : hpFraction < 0.5 ? '#d1574a' : '#4a9eff'
          const isSelected = selectedUnitId === unit.id
          return (
            <group
              key={unit.id}
              position={[x, 0.26, z]}
              onPointerUp={(e: ThreeEvent<PointerEvent>) => {
                e.stopPropagation()
                onUnitClick?.(unit)
              }}
            >
              <mesh castShadow position={[0, 0.32, 0]}>
                <capsuleGeometry args={[0.22, 0.4, 4, 8]} />
                <meshStandardMaterial color={color} />
              </mesh>
              {isSelected && (
                <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[0.32, 0.4, 24]} />
                  <meshBasicMaterial color="#f5c542" transparent opacity={0.9} depthWrite={false} />
                </mesh>
              )}
            </group>
          )
        })}
    </group>
  )
}
