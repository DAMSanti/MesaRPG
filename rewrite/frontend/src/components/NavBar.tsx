import './NavBar.css'

export type NavPath = '/' | '/gm' | '/mapeditor' | '/player'
export type NavLink = { path: NavPath; label: string; icon: string }

export const LINKS: readonly NavLink[] = [
  { path: '/', label: 'Mesa', icon: '🖥️' },
  { path: '/gm', label: 'GM', icon: '🎛️' },
  { path: '/mapeditor', label: 'Mapas', icon: '🗺️' },
  { path: '/player', label: 'Jugador', icon: '🧑‍🚀' },
] as const

// GM/staff "session" nav — just this page and the map editor, not the
// shared-table/player-facing views a GM mid-session doesn't need to jump
// to from either of these two screens. Shared between GMView and
// MapEditorView (identical set, requested directly: "que el menú
// superior [del editor de mapas] quede como el de GM") rather than two
// separately-maintained copies that could drift.
export const GM_LINKS: readonly NavLink[] = [
  { path: '/gm', label: 'GM', icon: '🎛️' },
  { path: '/mapeditor', label: 'Creación de Mapas', icon: '🗺️' },
] as const

/**
 * Persistent nav between mesa/GM/editor/jugador (ROADMAP.md S4) — GM/staff
 * facing only. Players never see this: they only ever open the link the GM
 * already shared with `?campaign=` baked in, never pick a role or campaign
 * themselves (see PlayerView/RollerView).
 *
 * `links` defaults to the full set above — pass a shorter/relabeled list
 * to trim it for one view (e.g. GMView hides Mesa/Jugador) without
 * affecting any other consumer.
 */
export function NavBar({
  campaignId,
  campaignName,
  current,
  variant = 'bar',
  links = LINKS,
  children,
}: {
  campaignId: number
  /** Real user request: this link showed the literal word "campaña"
   * regardless of which one was open — should show the actual campaign's
   * name instead. Optional so a caller that hasn't loaded the campaign
   * yet (or never fetches it at all) still gets the old generic label. */
  campaignName?: string
  current: NavPath
  variant?: 'bar' | 'overlay'
  links?: readonly NavLink[]
  /** Extra controls rendered right after the nav links, before the
   * "↺ campaña" link — e.g. GMView's settings gear. Optional so every
   * other caller (MapEditorView, the overlay variant) is unaffected. */
  children?: React.ReactNode
}) {
  return (
    <nav className={`nav-bar ${variant}`}>
      {links.map((l) => (
        <a
          key={l.path}
          href={`${l.path}?campaign=${campaignId}`}
          className={current === l.path ? 'active' : ''}
        >
          <span className="nav-icon">{l.icon}</span>
          <span className="nav-label">{l.label}</span>
        </a>
      ))}
      {children}
      <a className="nav-campaign" href="/campaigns?next=/hub">↺ {campaignName ?? 'campaña'}</a>
    </nav>
  )
}
