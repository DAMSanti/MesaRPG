import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { deactivateTableSession, listCampaigns, type Campaign } from '../api'
import { useHubSocket } from '../useHubSocket'
import './HubView.css'

/**
 * The true front door — loads with no campaign required. Only "GM" is
 * clickable until a campaign is chosen there. Once the GM picks/creates
 * one (anywhere — their own device), "Pantalla" and "Jugador" unlock
 * live here over /ws/hub (see useHubSocket) — no link-sharing needed. A
 * `?campaign=` in this device's own URL still works as a manual
 * override/deep-link, but it's no longer the only way in.
 */
export function HubView() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const campaignParam = params.get('campaign')
  const { activeCampaignId } = useHubSocket()
  const campaignId = campaignParam ? Number(campaignParam) : activeCampaignId
  const [campaign, setCampaign] = useState<Campaign | null>(null)

  useEffect(() => {
    if (campaignId == null) return
    listCampaigns().then((all) => setCampaign(all.find((c) => c.id === campaignId) ?? null))
  }, [campaignId])

  const active = campaignId != null

  const endSession = async () => {
    await deactivateTableSession().catch(() => {})
    // Drop this device's own ?campaign= too, in case it had one (e.g. the
    // GM's own tab) — otherwise it'd keep overriding the now-cleared live
    // state (see campaignId derivation above).
    navigate('/hub')
  }

  return (
    <div className="hub-view">
      <h1>{active ? (campaign?.name ?? `Campaña #${campaignId}`) : 'MesaRPG'}</h1>
      <p className="sub">{active ? '¿Cómo entras?' : 'Empieza por GM para elegir o crear una campaña.'}</p>

      <div className="hub-options">
        <a className="hub-card" href={active ? `/gm?campaign=${campaignId}` : '/campaigns?next=/hub'}>
          <span className="hub-icon">🎛️</span>
          <span className="hub-label">GM</span>
          <span className="hub-desc">Crear pilotos/mechs, editor de mapas, atacar, deshacer.</span>
        </a>

        {active ? (
          <a className="hub-card" href={`/?campaign=${campaignId}`}>
            <span className="hub-icon">🖥️</span>
            <span className="hub-label">Pantalla</span>
            <span className="hub-desc">Vista de mesa compartida — proyector o pantalla central.</span>
          </a>
        ) : (
          <div className="hub-card disabled" aria-disabled="true">
            <span className="hub-icon">🖥️</span>
            <span className="hub-label">Pantalla</span>
            <span className="hub-desc">El GM elige antes una campaña.</span>
          </div>
        )}

        {active ? (
          <a className="hub-card" href={`/player?campaign=${campaignId}`}>
            <span className="hub-icon">🧑‍🚀</span>
            <span className="hub-label">Jugador</span>
            <span className="hub-desc">Unirte con tu ficha, ver el mapa según tu LoS, atacar, tirar dados.</span>
          </a>
        ) : (
          <div className="hub-card disabled" aria-disabled="true">
            <span className="hub-icon">🧑‍🚀</span>
            <span className="hub-label">Jugador</span>
            <span className="hub-desc">Los jugadores no eligen campaña — usa el enlace que te pase el GM.</span>
          </div>
        )}
      </div>

      {active && (
        <div className="hub-session-actions">
          <a className="switch-campaign" href="/campaigns?next=/hub">otra campaña</a>
          <button className="end-session" onClick={endSession}>Terminar sesión</button>
        </div>
      )}
    </div>
  )
}
