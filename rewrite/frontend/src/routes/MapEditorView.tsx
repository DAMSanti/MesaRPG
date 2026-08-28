import { Suspense, useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useCampaignId } from '../useCampaignId'
import { terrainColor, terrainTexture } from '../terrain'
import { TerrainDecor } from '../components/TerrainDecor'
import { BOARDGAME_MECH_SCALE, elevationToY, GROUND_BASE_HEIGHT, ELEVATION_STEP } from '../components/HexMap'
import { TableBackground } from '../components/TableBackground'
import { HEX_SIZE, hexToWorld } from '../hexMath'
import { RoadMarkings } from '../components/RoadMarkings'
import { NavBar, GM_LINKS } from '../components/NavBar'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { FACTION_COLORS, NEUTRAL_UNIT_COLOR } from '../factions'
import {
  BIOMES,
  deleteMap,
  generateMap,
  getMap,
  getUnits,
  listCampaigns,
  listMaps,
  setActiveMap,
  type Biome,
  type Campaign,
  type HexTileData,
  type MapData,
  type Unit,
} from '../api'
import './MapEditorView.css'

const SQUARE_SPACING = 2

/** Grid shape follows the map's grid_type (ROADMAP.md S0) — hex for
 * Battletech, square for D&D 5e. Same (q, r) columns, different meaning.
 * Hex case defers to hexMath.ts's own hexToWorld (real-scale, HEX_SIZE=30)
 * instead of re-deriving the formula locally — the D&D square grid has no
 * equivalent real-world scale request, so SQUARE_SPACING stays untouched. */
function worldPos(gridType: 'hex' | 'square', q: number, r: number): [number, number] {
  if (gridType === 'square') return [q * SQUARE_SPACING, r * SQUARE_SPACING]
  return hexToWorld(q, r)
}

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

// Read-only — no click/select handling. Editing terrain from here is
// gone until the promised side-menu redesign replaces it (real user
// request: "vamos a poder seguir editando mapas... pero la forma de
// hacerlo vendrá más adelante con un menú lateral, no como está ahora").
function EditableTile({
  tile,
  gridType,
  lookup,
}: {
  tile: HexTileData
  gridType: 'hex' | 'square'
  lookup: Map<string, HexTileData>
}) {
  const [x, z] = worldPos(gridType, tile.q, tile.r)
  // Same shared elevation formula HexMap.tsx's own Tile uses — see
  // elevationToY's own doc comment there.
  const height = elevationToY(tile.terrain, tile.elevation)
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        {gridType === 'hex' ? (
          <cylinderGeometry args={[HEX_SIZE * 0.98, HEX_SIZE * 0.98, height, 6]} />
        ) : (
          <boxGeometry args={[1.85, height, 1.85]} />
        )}
        <meshStandardMaterial
          color={terrainColor(tile.terrain)}
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
    </group>
  )
}

function UnitDot({ unit, gridType, elevation }: { unit: Unit; gridType: 'hex' | 'square'; elevation: number }) {
  const [x, z] = worldPos(gridType, unit.q, unit.r)
  // Small float-above-the-platform clearance, kept proportional to how
  // much GROUND_BASE_HEIGHT itself grew (was 0.35 against an old base of
  // ~0.3) so this read-only marker still visibly hovers above the tile
  // surface instead of clipping into it.
  const y = GROUND_BASE_HEIGHT + elevation * ELEVATION_STEP + GROUND_BASE_HEIGHT * (0.35 / 0.3)
  const color = unit.is_ghost
    ? '#e35d5d'
    : unit.pilot_faction != null
      ? FACTION_COLORS[unit.pilot_faction]
      : NEUTRAL_UNIT_COLOR
  // BOARDGAME_MECH_SCALE's own doc comment (HexMap.tsx) — same "board
  // game token" convenience this read-only overview wants too, only for
  // the hex (Battletech) grid; the D&D square grid never rescaled.
  const dotScale = gridType === 'hex' ? BOARDGAME_MECH_SCALE : 1
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[0.28 * dotScale, 16, 16]} />
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
  const [genName, setGenName] = useState('')
  const [genWidth, setGenWidth] = useState(12)
  const [genHeight, setGenHeight] = useState(10)
  const [genBiome, setGenBiome] = useState<Biome>('grasslands')
  const [generating, setGenerating] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
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

  /** Load a map into the editor to view it — does NOT change what
   * players see on the shared table. That's `projectCurrentMap` below,
   * a deliberately separate, explicitly-named action (ROADMAP S5). */
  const openMap = async (id: number) => {
    setMap(await getMap(id))
    setUnits(await getUnits(id))
  }

  const projectCurrentMap = async () => {
    if (!campaignId || !map) return
    await setActiveMap(campaignId, map.id)
    refetch()
  }

  const generate = async () => {
    if (!campaignId || !genName || generating) return
    setGenerating(true)
    try {
      const m = await generateMap(campaignId, genName, genWidth, genHeight, genBiome)
      setGenName('')
      await refetch()
      await openMap(m.id)
    } catch {
      setError('No se pudo generar el mapa. Revisa el ancho/alto (mínimo 1).')
    } finally {
      setGenerating(false)
    }
  }

  const confirmDelete = async () => {
    if (confirmDeleteId == null) return
    try {
      await deleteMap(confirmDeleteId)
      setConfirmDeleteId(null)
      await refetch()
    } catch {
      setError('No se pudo borrar el mapa.')
    }
  }

  if (campaignId == null) return <div className="map-editor">preparando campaña…</div>

  const elevationAt = new Map((map?.tiles ?? []).map((t) => [`${t.q},${t.r}`, t.elevation]))

  return (
    <div className="map-editor">
      <NavBar campaignId={campaignId} campaignName={campaign?.name} current="/mapeditor" links={GM_LINKS} />
      <header>
        <h1>Editor de mapas — {campaign?.name ?? `campaña #${campaignId}`}</h1>
      </header>
      {loading && <p className="loading">Cargando…</p>}
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

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
            <button className="delete-map-button" title="Borrar mapa" onClick={() => setConfirmDeleteId(m.id)}>🗑️</button>
          </li>
        ))}
      </ul>

      {confirmDeleteId != null && (
        <ConfirmDialog
          title="Borrar mapa"
          message={`¿Seguro que quieres borrar "${mapsList.find((m) => m.id === confirmDeleteId)?.name}"? Esto también borra las fichas colocadas en él. No se puede deshacer.`}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {map && (
        <>
          <div className="row project-row">
            <span className="editing-label">Viendo: <strong>{map.name}</strong></span>
            <button
              className="project-button"
              onClick={projectCurrentMap}
              disabled={campaign?.active_map_id === map.id}
            >
              {campaign?.active_map_id === map.id ? '✓ Proyectado en pantalla' : '📽 Proyectar en pantalla'}
            </button>
          </div>

          <div className="canvas-wrap">
            <Canvas3D map={map} units={units} elevationAt={elevationAt} />
          </div>
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
}: {
  map: MapData
  units: Unit[]
  elevationAt: Map<string, number>
}) {
  const lookup = new Map(map.tiles.map((t) => [`${t.q},${t.r}`, t]))
  // Same fixed-camera-looks-at-origin setup as HexMap.tsx (table view) — a
  // width x height map isn't centered on (0,0) by construction, so the
  // whole group needs shifting or it renders tucked in a corner.
  const xs = map.tiles.map((t) => worldPos(map.grid_type, t.q, t.r)[0])
  const zs = map.tiles.map((t) => worldPos(map.grid_type, t.q, t.r)[1])
  const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0
  const centerZ = zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0
  // Only the hex (Battletech) grid got the real-scale rescale — the D&D
  // square grid (SQUARE_SPACING) has its own untouched, much smaller
  // scale, so this camera/shadow setup can't use one fixed multiplier
  // for both grid_types.
  const camScale = map.grid_type === 'hex' ? HEX_SIZE : 1
  return (
    // near/far explicit and scaled alongside position — see GMView.tsx's
    // own identical comment (same fix, same real user report: "se glichea
    // el agua cuando hago zoom").
    <Canvas shadows camera={{ position: [0, 16 * camScale, 0.01], fov: 40, near: 0.1 * camScale, far: 2000 * camScale }}>
      <color attach="background" args={['#0f1a18']} />
      <ambientLight intensity={0.7} />
      <directionalLight
        position={[4, 8, 3]} intensity={1.2} castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30 * camScale} shadow-camera-right={30 * camScale}
        shadow-camera-top={30 * camScale} shadow-camera-bottom={-30 * camScale}
        shadow-camera-far={60 * camScale}
      />
      <TableBackground hexScale={map.grid_type === 'hex'} />
      {/* TerrainDecor's forest tiles load a real .glb tree model via
          useGLTF, which suspends — every other TerrainDecor consumer
          (HexMap.tsx's own callers: TableView/GMView/FirstPersonView)
          already wraps it for exactly this reason; this one didn't
          need it before RealTree existed. */}
      <Suspense fallback={null}>
        <group position={[-centerX, 0, -centerZ]}>
          {map.tiles.map((t) => (
            <EditableTile
              key={`${t.q},${t.r}`}
              tile={t}
              gridType={map.grid_type}
              lookup={lookup}
            />
          ))}
          {units.map((u) => (
            <UnitDot key={u.id} unit={u} gridType={map.grid_type} elevation={elevationAt.get(`${u.q},${u.r}`) ?? 0} />
          ))}
        </group>
      </Suspense>
      {/* dampingFactor explicit — see TableView.tsx's own comment on
          this same fix (drei defaults enableDamping true but leaves
          three.js's very low 0.05 dampingFactor, which read as an
          endless slow spin after releasing a drag). */}
      <OrbitControls enablePan minPolarAngle={0} maxPolarAngle={0} dampingFactor={0.2} />
    </Canvas>
  )
}
