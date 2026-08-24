import { useState } from 'react'
import { Modal } from './Modal'
import { verifyPilotPin } from '../api'

/** "Introduce tu PIN" gate for picking an already-existing pilot from
 * PlayerView's shared list (a real user request: "le pedirá un PIN de 4
 * dígitos para acceder a el" — protects a player's own character from
 * being picked by someone else at the table, distinct from the existing
 * owner_token/device mechanism, which only ever gated editing a pending/
 * rejected draft, not picking an approved one). Deliberately asks every
 * time (no "remember this device") — explicit user choice over the
 * lower-friction alternative. No lockout after wrong attempts — a
 * casual home-table PIN doesn't need one. */
export function PinPrompt({
  pilotId, pilotName, onSuccess, onCancel,
}: {
  pilotId: number
  pilotName: string
  onSuccess: () => void
  onCancel: () => void
}) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (pin.length !== 4) return
    setBusy(true)
    setError(null)
    try {
      const ok = await verifyPilotPin(pilotId, pin)
      if (ok) {
        onSuccess()
      } else {
        setError('PIN incorrecto.')
        setPin('')
      }
    } catch {
      setError('No se pudo comprobar el PIN — inténtalo de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`PIN de ${pilotName}`} onClose={onCancel}>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)' }}>
        Introduce tu PIN de 4 dígitos para acceder a este personaje.
      </p>
      <div className="row">
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ width: 72, fontSize: 18, letterSpacing: '0.3em', textAlign: 'center' }}
        />
        <button type="button" onClick={submit} disabled={busy || pin.length !== 4}>Entrar</button>
      </div>
      {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </Modal>
  )
}
