import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useCampaignId } from '../useCampaignId'
import { terrainColor, terrainTexture } from '../terrain'
import { TerrainDecor } from '../components/TerrainDecor'
import { TableBackground } from '../components/TableBackground'
import { RoadMarkings } from '../components/RoadMarkings'
import { NavBar } from '../components/NavBar'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import {
  BIOMES,
  createMap,
  createUnit,
  generateMap,
  getMap,
  getUnits,
  listCampaigns,
  listMaps,
  listMechs,
  setActiveMap,
  updateTile,
  type Biome,
  type Campaign,
  type HexTileData,
  type Mech,
  type MapData,
  type Unit,
} from '../api'
import './MapEditorView.css'

const SQRT3 = Math.sqrt(3)
const SQUARE_SPACING = 2

/** Grid shape follows the map's grid_type (ROADMAP.md S0) — hex for
 * Battletech, square for D&D 5e. Same (q, r) columns, different meaning. */
function worldPos(gridType: 'hex' | 'square', q: number, r: number): [number, number] {
  if (gridType === 'square') return [q * SQUARE_SPACING, r * SQUARE_SPACING]
  return [SQRT3 * (q + r / 2), 1.5 * r]
}

const PRESETS: { name: string; terrain: string; elevation: number; blocks_los: boolean; los_points: number }[] = [
  { name: 'Llanura', terrain: 'plains', elevation: 0, blocks_los: false, los_points: 0 },
  { name: 'Colina', terrain: 'hills', elevation: 2, blocks_los: false, los_points: 0 },
  // See app/mapgen.py's TERRAIN_DEFAULTS: "forest" is the heavy (2-point)
  // tier — it kept its existing key/blocks_los=false-but-2-points meaning
  // when the light/heavy split was added, rather than migrating every
  // already-painted map; light_forest is the new, additive light tier.
  { name: 'Bosque denso', terrain: 'forest', elevation: 0, blocks_los: false, los_points: 2 },
  { name: 'Bosque ligero', terrain: 'light_forest', elevation: 0, blocks_los: false, los_points: 1 },
  { name: 'Agua', terrain: 'water', elevation: 0, blocks_los: true, los_points: 0 },
  { name: 'Agua profunda', terrain: 'water_deep', elevation: -1, blocks_los: true, los_points: 0 },
  { name: 'Carretera', terrain: 'road', elevation: 0, blocks_los: false, los_points: 0 },
  { name: 'Rocoso', terrain: 'rough', elevation: 1, blocks_los: false, los_points: 0 },
  { name: 'Escombros', terrain: 'rubble', elevation: 0, blocks_los: false, los_points: 0 },
  { name: 'Peligro', terrain: 'hazards', elevation: 0, blocks_los: false, los_points: 0 },
  { name: 'Edificio', terrain: 'building', elevation: 2, blocks_los: true, los_points: 0 },
  { name: 'Pantano', terrain: 'swamp', elevation: 0, blocks_los: false, los_points: 0 },
  { name: 'Nieve', terrain: 'snow', elevation: 0, blocks_los: false, los_points: 0 },
]

const BIOME_LABELS: Record<Biome, string> = {
  grasslands: 'Llanuras',
  forest: 'Bosque',
  river: 'Río',
  city: 'Ciudad',
  ruins: 'Ruinas',
  desert: 'Desierto',
  mountains: 'Montañas',
  swamp: 'Pantano',
  lake: 'Lago',
  arctic: 'Ártico',
  volcanic: 'Volcánico',
}

function EditableTile({
  tile,
  gridType,
  selected,
  onClick,
  lookup,
}: {
  tile: HexTileData
  gridType: 'hex' | 'square'
  selected: boolean
  onClick: () => void
  lookup: Map<string, HexTileData>
}) {
  const [x, z] = worldPos(gridType, tile.q, tile.r)
  const height = 0.3 + tile.elevation * 0.22
  return (
    <group position={[x, 0, z]}>
      <mesh
        position={[0, height / 2, 0]}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        castShadow
        receiveShadow
      >
        {gridType === 'hex' ? (
          <cylinderGeometry args={[0.95, 0.95, height, 6]} />
        ) : (
          <boxGeometry args={[1.85, height, 1.85]} />
        )}
        <meshStandardMaterial
          color={terrainColor(tile.terrain, tile.elevation)}
          map={terrainTexture(tile.terrain, tile.q, tile.r)}
        />
      </mesh>
      {tile.terrain === 'road' && (
        <RoadMarkings
          q={tile.q}
          r={tile.r}
          height={height}
          lookup={lookup}
          gridType={gridType}
          worldPos={(q, r) => worldPos(gridType, q, r)}
        />
      )}
      <TerrainDecor terrain={tile.terrain} height={height} q={tile.q} r={tile.r} />
      {selected && (
        <mesh position={[0, height + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.72, 0.92, 32]} />
          <meshBasicMaterial color="#e3a765" />
        </mesh>
      )}
    </group>
  )
}

function UnitDot({ unit, gridType, elevation }: { unit: Unit; gridType: 'hex' | 'square'; elevation: number }) {
  const [x, z] = worldPos(gridType, unit.q, unit.r)
  const y = 0.3 + elevation * 0.22 + 0.35
  const color = unit.is_ghost
    ? '#e35d5d'
    : unit.pilot_faction != null
      ? FACTION_COLORS[unit.pilot_faction]
      : NEUTRAL_UNIT_COLOR
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[0.28, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={unit.is_ghost ? '#e35d5d' : '#000000'}
        emissiveIntensity={unit.is_ghost ? 0.4 : 0}
      />
    </mesh>
  )
}

export function MapEditorView() {
  const campaignId = useCampaignId()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [mapsList, setMapsList] = useState<MapData[]>([])
  const [map, setMap] = useState<MapData | null>(null)
  const [units, setUnits] = useState<Unit[]>([])
  const [mechsList, setMechsList] = useState<Mech[]>([])
  const [selected, setSelected] = useState<{ q: number; r: number } | null>(null)
  const [newName, setNewName] = useState('')
  const [newWidth, setNewWidth] = useState(12)
  const [newHeight, setNewHeight] = useState(10)
  const [mode, setMode] = useState<'terrain' | 'units'>('terrain')
  const [placeMechId, setPlaceMechId] = useState<number | ''>('')
  const [placeGhost, setPlaceGhost] = useState(false)
  const [genName, setGenName] = useState('')
  const [genWidth, setGenWidth] = useState(12)
  const [genHeight, setGenHeight] = useState(10)
  const [genBiome, setGenBiome] = useState<Biome>('grasslands')
  const [generating, setGenerating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = async () => {
    if (campaignId == null) return
    try {
      const campaigns = await listCampaigns()
      const c = campaigns.find((x) => x.id === campaignId) ?? null
      setCampaign(c)
      const ms = await listMaps(campaignId)
      setMapsList(ms)
      setMechsList(await listMechs(campaignId))
      const activeId = c?.active_map_id ?? ms[0]?.id
      if (activeId) {
        setMap(await getMap(activeId))
        setUnits(await getUnits(activeId))
      } else {
        setMap(null)
        setUnits([])
      }
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId])

  const create = async () => {
    if (!campaignId || !newName) return
    try {
      await createMap(campaignId, newName, newWidth, newHeight)
      setNewName('')
      setSelected(null)
      refetch()
    } catch {
      setError('No se pudo crear el mapa.')
    }
  }

  /** Load a map into the editor to view/paint it — does NOT change what
   * players see on the shared table. That's `projectCurrentMap` below,
   * a deliberately separate, explicitly-named action (ROADMAP S5). */
  const openMap = async (id: number) => {
    setSelected(null)
    setMap(await getMap(id))
    setUnits(await getUnits(id))
  }

  const projectCurrentMap = async () => {
    if (!campaignId || !map) return
    await setActiveMap(campaignId, map.id)
    refetch()
  }

  const applyPreset = async (preset: { terrain: string; elevation: number; blocks_los: boolean; los_points: number }) => {
    if (!map || !selected) return
    const updated = await updateTile(map.id, selected.q, selected.r, preset)
    setMap(updated)
  }

  const generate = async () => {
    if (!campaignId || !genName || generating) return
    setGenerating(true)
    try {
      const m = await generateMap(campaignId, genName, genWidth, genHeight, genBiome)
      setGenName('')
      setSelected(null)
      await refetch()
      await openMap(m.id)
    } catch {
      setError('No se pudo generar el mapa. Revisa el ancho/alto (mínimo 1).')
    } finally {
      setGenerating(false)
    }
  }

  const placeUnit = async () => {
    if (!map || !selected || placeMechId === '') return
    const mech = mechsList.find((m) => m.id === placeMechId)
    await createUnit(map.id, {
      q: selected.q,
      r: selected.r,
      mech_id: placeMechId,
      pilot_id: mech?.pilot_id ?? undefined,
      is_ghost: placeGhost,
    })
    setUnits(await getUnits(map.id))
    setSelected(null)
  }

  if (campaignId == null) return <div className="map-editor">preparando campaña…</div>

  const elevationAt = new Map((map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t.elevation]))

  return (
    <div className="map-editor">
      <NavBar campaignId={campaignId} current="/mapeditor" />
      <header>
        <h1>Editor de mapas — campaña #{campaignId}</h1>
      </header>
      {loading && <p className="loading">Cargando…</p>}
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="row">
        <input placeholder="nombre del mapa" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <label>
          ancho <input type="number" min={1} value={newWidth} onChange={(e) => setNewWidth(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <label>
          alto <input type="number" min={1} value={newHeight} onChange={(e) => setNewHeight(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <button onClick={create} disabled={!newName}>Crear y usar</button>
      </div>

      <div className="row generate-row">
        <input placeholder="nombre del mapa generado" value={genName} onChange={(e) => setGenName(e.target.value)} />
        <select value={genBiome} onChange={(e) => setGenBiome(e.target.value as Biome)}>
          {BIOMES.map((b) => <option key={b} value={b}>{BIOME_LABELS[b]}</option>)}
        </select>
        <label>
          ancho <input type="number" min={1} value={genWidth} onChange={(e) => setGenWidth(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <label>
          alto <input type="number" min={1} value={genHeight} onChange={(e) => setGenHeight(Number(e.target.value))} style={{ width: 48 }} />
        </label>
        <button onClick={generate} disabled={!genName || generating}>
          {generating ? 'Generando…' : '🎲 Generar mapa aleatorio'}
        </button>
      </div>

      <ul className="map-list">
        {mapsList.map((m) => (
          <li key={m.id}>
            <button
              className={map?.id === m.id ? 'active' : ''}
              onClick={() => openMap(m.id)}
            >
              {m.name} <span className="grid-type-tag">{m.grid_type === 'hex' ? 'hex' : 'cuadrada'}</span> {campaign?.active_map_id === m.id ? '(proyectado)' : ''}
            </button>
          </li>
        ))}
      </ul>

      {map && (
        <>
          <div className="row project-row">
            <span className="editing-label">Editando: <strong>{map.name}</strong></span>
            <button
              className="project-button"
              onClick={projectCurrentMap}
              disabled={campaign?.active_map_id === map.id}
            >
              {campaign?.active_map_id === map.id ? '✓ Proyectado en pantalla' : '📽 Proyectar en pantalla'}
            </button>
          </div>

          <div className="row mode-row">
            <button className={mode === 'terrain' ? 'active' : ''} onClick={() => { setMode('terrain'); setSelected(null) }}>
              🗺️ Editar terreno
            </button>
            <button className={mode === 'units' ? 'active' : ''} onClick={() => { setMode('units'); setSelected(null) }}>
              🎯 Colocar fichas
            </button>
          </div>

          <div className="canvas-wrap">
            <Canvas3D map={map} units={units} elevationAt={elevationAt} selected={selected} onSelect={setSelected} />
          </div>

          {mode === 'terrain' ? (
            <div className="presets">
              {selected ? (
                <>
                  <span className="selected-label">Casilla ({selected.q}, {selected.r})</span>
                  {PRESETS.map((p) => (
                    <button key={p.name} onClick={() => applyPreset(p)}>{p.name}</button>
                  ))}
                </>
              ) : (
                <span className="hint">Toca una casilla del mapa para editarla.</span>
              )}
            </div>
          ) : (
            <div className="presets">
              {selected ? (
                <>
                  <span className="selected-label">Casilla ({selected.q}, {selected.r})</span>
                  <select value={placeMechId} onChange={(e) => setPlaceMechId(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">elegir mech…</option>
                    {mechsList.map((m) => <option key={m.id} value={m.id}>{m.chassis} {m.model ?? ''} (#{m.id})</option>)}
                  </select>
                  <label className="ghost-toggle">
                    <input type="checkbox" checked={placeGhost} onChange={(e) => setPlaceGhost(e.target.checked)} />
                    fantasma (oculto hasta LoS)
                  </label>
                  <button onClick={placeUnit} disabled={placeMechId === ''}>Colocar aquí</button>
                </>
              ) : (
                <span className="hint">Toca una casilla para colocar una ficha ahí. Rojo = fantasma del GM sin revelar; una vez visible, el color es el de la facción del piloto (turquesa jugador, rojo enemigo, ámbar NPC).</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Split out so the R3F Canvas (and its WebGL context) only mounts once a map exists.
function Canvas3D({
  map,
  units,
  elevationAt,
  selected,
  onSelect,
}: {
  map: MapData
  units: Unit[]
  elevationAt: Map<string, number>
  selected: { q: number; r: number } | null
  onSelect: (t: { q: number; r: number }) => void
}) {
  const lookup = new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t]))
  // Same fixed-camera-looks-at-origin setup as HexMap.tsx (table view) — a
  // width x height map isn't centered on (0,0) by construction, so the
  // whole group needs shifting or it renders tucked in a corner.
  const xs = map.tiles.map((t) => worldPos(map.grid_type, t.q, t.r)[0])
  const zs = map.tiles.map((t) => worldPos(map.grid_type, t.q, t.r)[1])
  const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  const centerZ = zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0
  return (
    <Canvas shadows camera={{ position: [0, 16, 0.01], fov: 40 }}>
      <color attach="background" args={['#0f1a18']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 8, 3]} intensity={1.2} castShadow />
      <TableBackground />
      <group position={[-centerX, 0, -centerZ]}>
        {map.tiles.map((t) => (
          <EditableTile
            key={`${t.q},${t.r}`}
            tile={t}
            gridType={map.grid_type}
            selected={selected?.q === t.q && selected?.r === t.r}
            onClick={() => onSelect({ q: t.q, r: t.r })}
            lookup={lookup}
          />
        ))}
        {units.map((u) => (
          <UnitDot key={u.id} unit={u} gridType={map.grid_type} elevation={elevationAt.get(`${u.q},${u.r}`) ?? 0} />
        ))}
      </group>
      <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} />
    </Canvas>
  )
}
