import { FACTIONS, FACTION_LABELS, type Faction } from '../factions'

interface Props {
  name: string
  onName: (v: string) => void
  callsign: string
  onCallsign: (v: string) => void
  gunnery: number
  onGunnery: (v: number) => void
  piloting: number
  onPiloting: (v: number) => void
  faction?: Faction
  onFaction?: (v: Faction) => void
  showFaction?: boolean
  color?: string
  onColor?: (v: string) => void
  /** 4-digit PIN, shown only when both are given — PlayerView's own
   * "Crear mi ficha" passes these so a player sets a PIN for their new
   * character; GMView's pilot form omits them (the GM never needs one,
   * has full access regardless). */
  pin?: string
  onPin?: (v: string) => void
  onSubmit: () => void
  submitLabel: string
  submitDisabled?: boolean
  hideSubmit?: boolean
}

/** Name/callsign/Gunnery/Piloting(/faction/color) — shared between the
 * GM's pilot form and the player's own direct-fill sheet (ROADMAP.md
 * Fase R3). Players never pick a faction (always 'player'), so
 * `showFaction` defaults off. `color` is the pilot's dice color for the
 * manual initiative-roll flow — optional so callers that don't manage
 * it (none currently) can omit the swatch entirely. */
export function PilotForm({
  name, onName, callsign, onCallsign, gunnery, onGunnery, piloting, onPiloting,
  faction, onFaction, showFaction = false, color, onColor, pin, onPin,
  onSubmit, submitLabel, submitDisabled, hideSubmit = false,
}: Props) {
  return (
    <div className="row">
      <input placeholder="nombre" value={name} onChange={(e) => onName(e.target.value)} />
      <input placeholder="callsign" value={callsign} onChange={(e) => onCallsign(e.target.value)} />
      <label>gunnery <input type="number" value={gunnery} onChange={(e) => onGunnery(Number(e.target.value))} style={{ width: 48 }} /></label>
      <label>piloting <input type="number" value={piloting} onChange={(e) => onPiloting(Number(e.target.value))} style={{ width: 48 }} /></label>
      {pin !== undefined && onPin && (
        <label>
          PIN (4 dígitos)
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => onPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            style={{ width: 56 }}
          />
        </label>
      )}
      {showFaction && faction && onFaction && (
        <select value={faction} onChange={(e) => onFaction(e.target.value as Faction)}>
          {FACTIONS.map((f) => <option key={f} value={f}>{FACTION_LABELS[f]}</option>)}
        </select>
      )}
      {color !== undefined && onColor && (
        <label className="pilot-color-picker" title="Color de dados">
          <input type="color" value={color} onChange={(e) => onColor(e.target.value)} />
        </label>
      )}
      {!hideSubmit && (
        <button type="button" onClick={onSubmit} disabled={submitDisabled ?? !name}>{submitLabel}</button>
      )}
    </div>
  )
}
