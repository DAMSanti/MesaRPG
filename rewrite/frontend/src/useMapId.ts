import { useEffect, useState } from 'react'
import { createMap, listCampaigns, listMaps } from './api'

/**
 * Prefers the campaign's `active_map_id` (set from /mapeditor, ROADMAP S1).
 * Falls back to the first existing map, or creates a dev default if the
 * campaign has none yet — same dev-convenience pattern as useCampaignId.
 *
 * `liveMapId` is `activeMapId` from `useTableSocket` — when the GM projects
 * a different map while this view is already open, that WS broadcast lands
 * here and overrides the one-shot fetch immediately, instead of requiring
 * a manual reload to notice (real bug: the table never updated live).
 */
export function useMapId(campaignId: number | null, liveMapId?: number | null): number | null {
  const [mapId, setMapId] = useState<number | null>(null)

  useEffect(() => {
    if (campaignId == null) return
    let cancelled = false
    ;(async () => {
      const [campaigns, existing] = await Promise.all([listCampaigns(), listMaps(campaignId)])
      const campaign = campaigns.find((c) => c.id === campaignId)
      const active = campaign?.active_map_id
      const resolved = existing.find((m) => m.id === active) ?? existing[0]
      const map = resolved ?? (await createMap(campaignId, 'Mesa de pruebas', 12, 10))
      if (!cancelled) setMapId(map.id)
    })()
    return () => {
      cancelled = true
    }
  }, [campaignId])

  useEffect(() => {
    if (liveMapId != null) setMapId(liveMapId)
  }, [liveMapId])

  return mapId
}
