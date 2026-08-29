import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Html } from '@react-three/drei'
import { HEX_SIZE, hexToWorld } from '../hexMath'
import { useProfiledFrame } from './PerfProbe'

/** The GM's tile highlights, drawn outside the canvas so night vision
 * cannot recolour them.
 *
 * Real user request: "SOLO quiero que se vea sin el brillo verde el
 * overlay... el hex debajo del mech que le toca actuar", then, once that
 * one worked: "tiene que marcar de la misma manera iniciativas, ataques,
 * ataques a melee, movimiento..."
 *
 * The green is a CSS filter over the whole canvas, and a filter has no way
 * to tell the board from the marks drawn on it — the image is already one
 * thing by the time it applies. So under night vision the marks are drawn
 * a second time as DOM, which drei's <Html> portals NEXT TO the canvas
 * rather than into it, and which the filter therefore never touches.
 *
 * One SVG for every hex rather than one element per hex: a movement range
 * is routinely twenty or thirty tiles, and drei's Html creates its own
 * React root per instance — thirty roots updating every frame would cost
 * more than the board underneath them. This is a single root, a single
 * SVG, and the per-frame work is writing a `points` string per hex
 * straight onto the DOM node, with no React render in the loop.
 *
 * The polygons come from the tiles' REAL corners, projected. A hexagon
 * drawn flat at the tile's screen position would drift out of register
 * with the board as soon as the camera was tilted off straight-down, and
 * the GM's camera can be orbited. */

/** Same corner convention the tile geometry itself uses (see
 * hexTileGeometry): corner i at theta = i * 60°, at (R sin θ, R cos θ). */
const CORNERS = Array.from({ length: 6 }, (_, i) => {
  const theta = (i * Math.PI) / 3
  return [Math.sin(theta) * HEX_SIZE, Math.cos(theta) * HEX_SIZE] as const
})

export interface HighlightedHex {
  q: number
  r: number
  color: string
  opacity: number
}

export function UnfilteredHighlights({
  hexes, centerX, centerZ, groundYAt,
}: {
  hexes: HighlightedHex[]
  centerX: number
  centerZ: number
  groundYAt: (q: number, r: number) => number
}) {
  const polygonRefs = useRef<(SVGPolygonElement | null)[]>([])
  const svgRef = useRef<SVGSVGElement>(null)

  // Keyed on contents, not identity: the caller rebuilds this list on every
  // render and only its contents decide what to draw.
  const key = hexes.map((h) => `${h.q},${h.r},${h.color}`).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => hexes, [key])

  const scratch = useMemo(() => new THREE.Vector3(), [])

  useProfiledFrame('overlays', (state) => {
    const svg = svgRef.current
    if (!svg) return
    const { camera, size } = state
    svg.setAttribute('width', String(size.width))
    svg.setAttribute('height', String(size.height))

    for (let i = 0; i < stable.length; i++) {
      const node = polygonRefs.current[i]
      if (!node) continue
      const { q, r } = stable[i]
      const [wx, wz] = hexToWorld(q, r)
      // The map group these tiles live in is offset by the board's own
      // centre, so the highlight has to be too or it lands a whole map
      // away from the tile it belongs to.
      const baseX = wx - centerX
      const baseZ = wz - centerZ
      const y = groundYAt(q, r)

      let points = ''
      for (const [cx, cz] of CORNERS) {
        scratch.set(baseX + cx, y, baseZ + cz)
        scratch.project(camera)
        const px = (scratch.x * 0.5 + 0.5) * size.width
        const py = (-scratch.y * 0.5 + 0.5) * size.height
        points += `${px.toFixed(1)},${py.toFixed(1)} `
      }
      node.setAttribute('points', points)
    }
  })

  if (stable.length === 0) return null

  return (
    <Html
      // Pinned to the top-left of the canvas instead of tracking a point in
      // the scene: the SVG inside is in screen coordinates already, so it
      // must not be moved by the camera on top of that.
      calculatePosition={() => [0, 0]}
      style={{ pointerEvents: 'none', position: 'absolute', top: 0, left: 0 }}
      zIndexRange={[3, 3]}
    >
      <svg ref={svgRef} className="unfiltered-highlights" aria-hidden>
        {stable.map((hex, i) => (
          <polygon
            key={`${hex.q},${hex.r},${hex.color}`}
            ref={(node) => { polygonRefs.current[i] = node }}
            fill={hex.color}
            fillOpacity={hex.opacity}
            stroke={hex.color}
            strokeOpacity={Math.min(1, hex.opacity + 0.35)}
            strokeWidth={2}
          />
        ))}
      </svg>
    </Html>
  )
}
