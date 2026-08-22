import type { DieType } from '../ws'
import { useTableSocket } from '../ws'
import { useCampaignId } from '../useCampaignId'
import './RollerView.css'

const DICE: DieType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']

export function RollerView() {
  const campaignId = useCampaignId({ allowPicker: false })
  const { connected, lastRoll, roll } = useTableSocket(campaignId)

  if (campaignId == null) {
    return (
      <div className="roller-view">
        <h1>Necesitas un enlace</h1>
        <p className="hint">Los jugadores no elegís campaña — pídele al GM el enlace de vuestra partida.</p>
      </div>
    )
  }

  return (
    <div className="roller-view">
      <header>
        <span className={`status-dot ${connected ? 'on' : 'off'}`} />
        <span>{connected ? `conectado — campaña #${campaignId}` : 'conectando…'}</span>
      </header>

      <div className="dice-grid">
        {DICE.map((die) => (
          <button key={die} onClick={() => roll(die)} disabled={!connected}>
            {die}
          </button>
        ))}
      </div>

      {lastRoll && (
        <div className="last-roll">
          Última tirada: <strong>{lastRoll.die}</strong> →{' '}
          <strong>{lastRoll.result}</strong>
        </div>
      )}
    </div>
  )
}
