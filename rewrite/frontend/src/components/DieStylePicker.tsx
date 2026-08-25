import type { CSSProperties } from 'react'
import { DIE_STYLES, type DieStyle } from '../dieStyles'
import './DieStylePicker.css'

/** Grid of every die style (real user request: pick one, exclusive
 * across the whole table) — shared between GMView's "Ajustes" modal and
 * PlayerView's own, since it's the same control/behavior in both:
 * yours (check), free (clickable), or someone else's (locked, shows who).
 * Swatch preview is CSS-only, not a mini 3D <Canvas> per style — ten
 * WebGL contexts inside a settings modal, possibly open at once on
 * several screens at the same table, is real cost for little payoff
 * over a flat color + a Unicode die-face glyph. */
export function DieStylePicker({
  styles = DIE_STYLES, heldBy, currentStyleId, onPick, disabled,
}: {
  styles?: DieStyle[]
  heldBy: Map<string, string>
  currentStyleId: string | null
  onPick: (styleId: string) => void
  disabled?: boolean
}) {
  return (
    <div className="die-style-grid">
      {styles.map((s) => {
        const holder = heldBy.get(s.id)
        const isMine = s.id === currentStyleId
        const isTaken = holder != null && !isMine
        return (
          <button
            key={s.id}
            type="button"
            className={`die-style-swatch material-${s.material}${isMine ? ' mine' : ''}${isTaken ? ' taken' : ''}`}
            style={{ '--die-style-color': s.color } as CSSProperties}
            onClick={() => onPick(s.id)}
            disabled={isTaken || disabled}
            title={isTaken ? `En uso por ${holder}` : s.name}
          >
            <span className="die-style-swatch-color">
              <span className="die-style-marking">{s.marking === 'numbers' ? '6' : '⚅'}</span>
              {isMine && <span className="die-style-check">✓</span>}
            </span>
            <span className="die-style-label">
              <span className="die-style-name">{s.name}</span>
              {isTaken && <span className="die-style-status">{holder}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
