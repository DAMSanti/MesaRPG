import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { DIE_STYLES, type DieStyle } from '../dieStyles'
import './DieStylePicker.css'

/** Real user request: the old always-expanded grid of all 10 styles
 * "ocupa mucho" — collapsed to a compact toggle showing whichever style
 * is currently selected (swatch + name), that expands an inline list of
 * the rest on click. Picking one (or clicking a locked one is a no-op)
 * closes it immediately; clicking the toggle again or pressing Escape
 * closes it without changing anything — "se cierra cuando se selecciona
 * una o se cancela". Kept as an inline expanding list rather than a
 * floating absolute dropdown on purpose: both call sites (GMView's/
 * PlayerView's "Ajustes" modal) scroll their own body
 * (Modal.css's overflow-y/x: auto), which would clip a floating
 * dropdown reaching past the modal's edge.
 *
 * Shared between GMView's and PlayerView's own settings modal, since
 * it's the same control/behavior in both: yours (check), free
 * (clickable), or someone else's (locked, shows who). Swatch preview is
 * CSS-only, not a mini 3D <Canvas> per style — ten WebGL contexts inside
 * a settings modal, possibly open at once on several screens at the
 * same table, is real cost for little payoff over a flat color + a
 * Unicode die-face glyph. */
export function DieStylePicker({
  styles = DIE_STYLES, heldBy, currentStyleId, onPick, disabled,
}: {
  styles?: DieStyle[]
  heldBy: Map<string, string>
  currentStyleId: string | null
  onPick: (styleId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = styles.find((s) => s.id === currentStyleId) ?? null

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
    <div className="die-style-picker" ref={rootRef}>
      <button
        type="button"
        className="die-style-toggle"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {current ? (
          <>
            <span className={`die-style-swatch-color material-${current.material}`} style={{ '--die-style-color': current.color } as CSSProperties}>
              <span className="die-style-marking">{current.marking === 'numbers' ? '6' : '⚅'}</span>
            </span>
            <span className="die-style-toggle-name">{current.name}</span>
          </>
        ) : (
          <span className="die-style-toggle-name die-style-toggle-placeholder">Elegir estilo de dado…</span>
        )}
        <span className="die-style-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <ul className="die-style-menu">
          {styles.map((s) => {
            const holder = heldBy.get(s.id)
            const isMine = s.id === currentStyleId
            const isTaken = holder != null && !isMine
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`die-style-option${isMine ? ' mine' : ''}${isTaken ? ' taken' : ''}`}
                  disabled={isTaken || disabled}
                  onClick={() => {
                    setOpen(false)
                    onPick(s.id)
                  }}
                  title={isTaken ? `En uso por ${holder}` : s.name}
                >
                  <span className={`die-style-swatch-color material-${s.material}`} style={{ '--die-style-color': s.color } as CSSProperties}>
                    <span className="die-style-marking">{s.marking === 'numbers' ? '6' : '⚅'}</span>
                  </span>
                  <span className="die-style-option-label">
                    <span className="die-style-name">{s.name}</span>
                    {isTaken && <span className="die-style-status">{holder}</span>}
                  </span>
                  {isMine && <span className="die-style-check">✓</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
