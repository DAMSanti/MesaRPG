import { useEffect, useRef, useState } from 'react'
import type { DieType } from '../ws'
import { useTableSocket } from '../ws'
import { useCampaignId } from '../useCampaignId'
import './RollerView.css'

const DICE: DieType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']

/** Real user request: the old always-expanded 6-button grid "ahora ocupa
 * mucho" — collapsed to a single compact control showing whichever die
 * is currently selected; clicking it opens a dropdown of the other
 * five, picking one rolls it immediately (same one-click-rolls behavior
 * the grid always had) and closes the dropdown, and clicking outside
 * (or Escape) closes it without changing anything — "se cierra cuando
 * se selecciona una o se cancela". */
function DiePicker({ selected, onPick, disabled }: { selected: DieType; onPick: (die: DieType) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="die-picker" ref={rootRef}>
      <button
        type="button"
        className="die-picker-toggle"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {selected}
        <span className="die-picker-caret">▾</span>
      </button>
      {open && (
        <ul className="die-picker-menu">
          {DICE.map((die) => (
            <li key={die}>
              <button
                type="button"
                className={`die-picker-option${die === selected ? ' selected' : ''}`}
                onClick={() => {
                  setOpen(false)
                  onPick(die)
                }}
              >
                {die}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RollerView() {
  const campaignId = useCampaignId({ allowPicker: false })
  const { connected, lastRoll, roll } = useTableSocket(campaignId)
  const [selectedDie, setSelectedDie] = useState<DieType>('d6')

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

      <DiePicker
        selected={selectedDie}
        disabled={!connected}
        onPick={(die) => {
          setSelectedDie(die)
          roll(die)
        }}
      />

      {lastRoll && (
        <div className="last-roll">
          Última tirada: <strong>{lastRoll.die}</strong> →{' '}
          <strong>{lastRoll.result}</strong>
        </div>
      )}
    </div>
  )
}
