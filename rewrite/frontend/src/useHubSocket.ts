import { useEffect, useState } from 'react'
import { getTableSession } from './api'

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8124/ws'
const RECONNECT_DELAY_MS = 2000

interface ActiveCampaignChanged {
  type: 'active_campaign_changed'
  campaign_id: number | null
}

/**
 * Devices sitting on /hub connect here (no campaign chosen yet) to learn
 * live when the GM picks a campaign elsewhere — see
 * rewrite/backend/app/table_session.py and ws.py's HubManager.
 *
 * Phones sitting on /hub waiting for the GM can have their screen lock
 * or the tab go to background for a while before anything happens —
 * mobile browsers routinely suspend WebSockets in that state, and a
 * plain "connect once" hook then silently stops listening forever with
 * no visible sign anything's wrong. Two defenses against that: (1)
 * reconnect automatically whenever the socket closes, for as long as
 * the component stays mounted; (2) re-fetch the current state whenever
 * the tab becomes visible again, so even a socket that's still quietly
 * dead catches up the moment someone actually looks at the phone.
 */
export function useHubSocket() {
  const [activeCampaignId, setActiveCampaignId] = useState<number | null>(null)

  useEffect(() => {
    let current = true
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const refetch = () => {
      getTableSession().then((s) => {
        if (current) setActiveCampaignId(s.active_campaign_id)
      })
    }

    const connect = () => {
      if (!current) return
      ws = new WebSocket(`${WS_BASE}/hub`)
      ws.onmessage = (event) => {
        if (!current) return
        const message = JSON.parse(event.data)
        if (message.type === 'active_campaign_changed') {
          setActiveCampaignId((message as ActiveCampaignChanged).campaign_id)
        }
      }
      ws.onclose = () => {
        if (!current) return
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      refetch()
      if (ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) connect()
    }

    refetch()
    connect()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      current = false
      document.removeEventListener('visibilitychange', onVisible)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  return { activeCampaignId }
}
