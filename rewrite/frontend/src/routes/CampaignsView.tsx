import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { activateTableSession, createCampaign, listCampaigns, listSystems, type Campaign, type GameSystem } from '../api'
import './CampaignsView.css'

export function CampaignsView() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [systems, setSystems] = useState<Record<string, GameSystem>>({})
  const [name, setName] = useState('')
  const [system, setSystem] = useState('battletech')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = () =>
    listCampaigns()
      .then(setCampaigns)
      .catch(() => setError('No se pudo conectar con el servidor.'))
      .finally(() => setLoading(false))

  useEffect(() => {
    refetch()
    listSystems().then(setSystems).catch(() => {})
  }, [])

  const create = async () => {
    if (!name) return
    try {
      const c = await createCampaign(name, system)
      setName('')
      await refetch()
      choose(c.id)
    } catch {
      setError('No se pudo crear la campaña.')
    }
  }

  const choose = async (id: number) => {
    // Best-effort: activating the table session is what lets other
    // devices on /hub light up live, but a GM navigating locally
    // shouldn't be blocked if that call fails.
    await activateTableSession(id).catch(() => {})
    navigate(next ? `${next}?campaign=${id}` : `/hub?campaign=${id}`)
  }

  return (
    <div className="campaigns-view">
      <h1>Campañas</h1>
      <p className="sub">Elige una campaña o crea una nueva. El GM entra por aquí; desde el panel de GM se puede pasar a la mesa o compartir el enlace de jugador.</p>
      {loading && <p className="loading">Cargando…</p>}
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

      <div className="row">
        <input placeholder="nombre de la nueva campaña" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={system} onChange={(e) => setSystem(e.target.value)}>
          {Object.entries(systems).map(([id, s]) => (
            <option key={id} value={id}>{s.name} ({s.grid_type === 'hex' ? 'grid hexagonal' : 'grid cuadrada'})</option>
          ))}
        </select>
        <button onClick={create} disabled={!name}>Crear campaña</button>
      </div>

      <ul className="campaign-list">
        {campaigns.map((c) => (
          <li key={c.id}>
            <button className="campaign-card" onClick={() => choose(c.id)}>
              <span className="campaign-name">{c.name}</span>
              <span className="campaign-meta">
                {systems[c.system]?.name ?? c.system} · {c.pilot_count} piloto{c.pilot_count === 1 ? '' : 's'} · {c.mech_count} mech{c.mech_count === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
        {campaigns.length === 0 && <p className="hint">Todavía no hay campañas — crea la primera arriba.</p>}
      </ul>
    </div>
  )
}
