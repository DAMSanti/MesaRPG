import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MechChassisResult } from '../api'
import { MECH_CHASSIS_ASSETS } from '../mechAssets'
import { groupChassisByWeightClass } from '../weightClass'
import './ChassisSelect.css'

/** Real user request: "en creación de mech, quiero que el desplegable de
 * chasis tenga una barra de búsqueda para poder poner un nombre" — the
 * real BattleTech chassis catalog runs into the hundreds, and hunting
 * through a plain <select>'s native popup by eye was the only way to
 * find one before this. A small combobox: typing filters the same
 * weight-class-grouped list groupChassisByWeightClass already produces
 * for the plain <select> version still used elsewhere (edit-mech forms
 * — this was scoped to mech CREATION specifically, where the request
 * was made). Shared between GMView's and PlayerView's own create flows,
 * same precedent as PilotForm. */
export function ChassisSelect({
  value, onChange, options, placeholder = 'chasis…', getOptionClassName,
}: {
  value: string
  onChange: (chassis: string) => void
  options: MechChassisResult[]
  placeholder?: string
  /** Optional extra className per option — lets a caller (e.g. MechLab)
   * layer its own meaning (review-status coloring, …) onto each row
   * without this shared combobox knowing anything about it. */
  getOptionClassName?: (chassis: string) => string | undefined
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Real user report: the menu was a plain absolutely-positioned child,
  // so Modal.css's own .modal { overflow: auto } (needed there for
  // MechRecordSheet's wide content — see its own comment) clipped it
  // the instant it grew taller than the modal's remaining space.
  // Portaled straight onto <body> and positioned in viewport (fixed)
  // coordinates instead, same fix any dropdown-inside-a-clipped-
  // container needs — it no longer has ANY clipping ancestor to fight.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const updateMenuPos = () => {
    const rect = inputRef.current?.getBoundingClientRect()
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }

  // The modal's own body can scroll (that's the overflow-y this whole
  // fix works around), and the window can resize, either of which would
  // otherwise leave the portaled menu hovering over the wrong spot.
  useEffect(() => {
    if (!open) return
    updateMenuPos()
    window.addEventListener('scroll', updateMenuPos, true)
    window.addEventListener('resize', updateMenuPos)
    return () => {
      window.removeEventListener('scroll', updateMenuPos, true)
      window.removeEventListener('resize', updateMenuPos)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => o.chassis.toLowerCase().includes(q)) : options
  }, [options, query])
  const grouped = useMemo(() => groupChassisByWeightClass(filtered), [filtered])

  const select = (chassis: string) => {
    onChange(chassis)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <div className="chassis-select">
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={open ? query : value}
        onFocus={() => { setQuery(''); setOpen(true) }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('')
            setOpen(false)
            inputRef.current?.blur()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const first = grouped[0]?.entries[0]
            if (first) select(first.chassis)
          }
        }}
        onBlur={() => {
          // A click on an option fires its own onMouseDown (below)
          // BEFORE this blur — closing synchronously here would unmount
          // the option list before that click ever registers, so this
          // waits one beat instead of closing immediately.
          setTimeout(() => setOpen(false), 120)
        }}
      />
      {open && menuPos && createPortal(
        <div
          className="chassis-select-menu"
          style={{ top: menuPos.top, left: menuPos.left, width: Math.max(180, menuPos.width) }}
        >
          {grouped.length === 0 && <div className="chassis-select-empty">sin resultados</div>}
          {grouped.map(({ weightClass, entries }) => (
            <div key={weightClass} className="chassis-select-group">
              <div className="chassis-select-group-label">{weightClass}</div>
              {entries.map(({ chassis: c }) => (
                <div
                  key={c}
                  className={`chassis-select-option${c === value ? ' selected' : ''}${getOptionClassName?.(c) ? ` ${getOptionClassName(c)}` : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); select(c) }}
                >
                  {MECH_CHASSIS_ASSETS[c] ? `🛠️ ${c}` : c}
                </div>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
