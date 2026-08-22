import { useEffect } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

/**
 * Reads `?campaign=<id>` from the URL.
 *
 * `allowPicker` (default true) controls what happens when it's absent:
 * - true (GM-operated views: `/`, `/gm`, `/mapeditor`): redirect to
 *   `/hub` (bare `/`) or `/campaigns?next=...` (a specific GM route) so
 *   the GM can pick or create one.
 * - false (player-facing views: `/player`, `/roll`): players never
 *   choose a campaign themselves — they only ever open a link the GM
 *   already shared with `?campaign=` baked in. No redirect; the caller
 *   is expected to show "ask your GM for the link" instead.
 */
export function useCampaignId(options?: { allowPicker?: boolean }): number | null {
  const allowPicker = options?.allowPicker ?? true
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const fromUrl = params.get('campaign')

  useEffect(() => {
    if (fromUrl || !allowPicker) return
    const target =
      location.pathname === '/'
        ? '/hub'
        : `/campaigns?next=${encodeURIComponent(location.pathname)}`
    navigate(target, { replace: true })
  }, [fromUrl, allowPicker, navigate, location.pathname])

  return fromUrl ? Number(fromUrl) : null
}
