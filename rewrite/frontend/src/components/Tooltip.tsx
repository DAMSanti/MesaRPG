import { useRef, useState, type ReactNode } from 'react'
import './Tooltip.css'

const SHOW_DELAY_MS = 500

/** Wraps any element and shows a small floating tooltip near the cursor
 * after a short hover delay — used by the GM sidebar's pilot/mech cards
 * to keep the card itself down to a name, moving the detail stats
 * (gunnery/piloting, heat, structure, weapons) into this instead of
 * printing them inline. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  return (
    <div
      className="tooltip-anchor"
      onMouseEnter={(e) => {
        const x = e.clientX, y = e.clientY
        clearTimer()
        timerRef.current = setTimeout(() => setPos({ x, y }), SHOW_DELAY_MS)
      }}
      onMouseMove={(e) => {
        if (pos) setPos({ x: e.clientX, y: e.clientY })
      }}
      onMouseLeave={() => {
        clearTimer()
        setPos(null)
      }}
    >
      {children}
      {pos && (
        <div className="tooltip-bubble" style={{ left: pos.x + 14, top: pos.y + 14 }}>
          {content}
        </div>
      )}
    </div>
  )
}
