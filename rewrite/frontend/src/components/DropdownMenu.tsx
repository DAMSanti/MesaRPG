import { useEffect, type ReactNode } from 'react'
import './DropdownMenu.css'

/** Small fixed-position menu opened at a click point — the shared chrome
 * behind both UnitContextMenu (map units) and the sidebar's pilot/mech
 * card menus, so every "click something → small menu at the cursor" in
 * the GM view looks and behaves the same. */
export function DropdownMenu({
  x, y, title, onClose, children,
}: {
  x: number
  y: number
  title?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="dropdown-menu-backdrop" onClick={onClose} />
      <div className="dropdown-menu" style={{ left: x, top: y }}>
        {title && <div className="dropdown-menu-title">{title}</div>}
        {children}
      </div>
    </>
  )
}
