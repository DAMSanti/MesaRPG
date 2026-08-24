import { useEffect, useState } from 'react'
import { getMap, getUnits, type MapData, type Unit } from './api'

// Extracted from TableView.tsx so GMView's embedded map can reuse the same
// fetch-and-refetch-on-token pattern (e.g. refetch when `visibility`
// changes, since POST /api/units/{id}/move already broadcasts
// visibility_update on every move — no dedicated "unit moved" WS message
// needed for either view to stay live).
export function useMapState(mapId: number | null, refetchToken: unknown) {
  const [map, setMap] = useState<MapData | null>(null)
  const [units, setUnits] = useState<Unit[]>([])

  // Tiles only ever change from MapEditorView (a separate route) — this
  // embedded map is read-only for terrain, so there's no reason to
  // refetch it on every refetchToken tick (visibility_update fires on
  // every unit placed/moved/attacked). Refetching it anyway used to
  // recreate `map` — and every <Tile> under it — each time, which
  // visibly flickered the whole board on something as small as placing
  // one mech (real user report). Only `units` needs to track
  // refetchToken; `map` is fetched once per mapId.
  useEffect(() => {
    if (mapId == null) return
    let cancelled = false
    getMap(mapId).then((m) => {
      if (!cancelled) setMap(m)
    })
    return () => {
      cancelled = true
    }
  }, [mapId])

  useEffect(() => {
    if (mapId == null) return
    let cancelled = false
    getUnits(mapId).then((u) => {
      if (!cancelled) setUnits(u)
    })
    return () => {
      cancelled = true
    }
  }, [mapId, refetchToken])

  // Exposed so a caller can patch a unit's position optimistically right
  // when a drag/move completes, instead of the marker snapping back to
  // its last-fetched q/r and sitting there until the server round-trip +
  // WS-triggered refetch above catches up (visible ~1s stutter otherwise).
  return { map, units, setUnits }
}
