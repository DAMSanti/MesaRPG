import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/** Real user request: "quiero iluminación dinámica... cuando los mechs
 * disparen un láser producirán un destello rojo que iluminará lo que
 * tenga alrededor... no solo serán las armas, serán también las
 * farolas, luces en edificios, luces en los mechs, y cuando haya más
 * juegos, antorchas en D&D" — one shared primitive underneath every one
 * of those, game-system-agnostic (lives outside HexMap.tsx on purpose,
 * so SquareMap's own D&D torches can use it too without any BattleTech
 * dependency).
 *
 * Two distinct use patterns share this same component:
 * - PERSISTENT (streetlight, building window, mech running light,
 *   torch): just mount it with a fixed `intensity` and leave it — an
 *   optional `flicker` gives torches/damaged lights/neon a believable
 *   waver without any caller-side animation code.
 * - TRANSIENT (muzzle flash, explosion, missile propulsion glow): the
 *   caller drives `intensity` itself over time — same "ref driven by the
 *   caller" convention AttackEffects.tsx's own GlowSprite already
 *   established (see its doc comment) — by grabbing this component's
 *   underlying THREE.PointLight via `lightRef` and setting
 *   `lightRef.current.intensity` inside its own useFrame/fade logic,
 *   instead of re-deriving a whole separate light component per effect. */
export function DynamicLight({
  lightRef, position, color, intensity, distance, decay = 2, castShadow = false, flicker,
}: {
  /** Grab the underlying THREE.PointLight to drive `intensity` (or
   * anything else) from the caller's own useFrame — see this file's own
   * TRANSIENT doc comment above. Optional: a purely persistent light
   * (streetlight, building window) never needs one. */
  lightRef?: React.RefObject<THREE.PointLight | null>
  position: [number, number, number]
  color: string
  /** Base intensity — for a TRANSIENT light this is the PEAK the caller
   * fades up/down from via lightRef, not a value this component itself
   * changes (flicker aside). */
  intensity: number
  /** World units the light's influence reaches — kept finite (never
   * three.js's own "0 = infinite" default) so a map with many persistent
   * lights (streetlights down a city block) doesn't force the renderer
   * to consider every single one for every single object on the board. */
  distance: number
  decay?: number
  /** Shadow-casting lights are real render-pass cost each — default off.
   * Safe to enable for a single transient combat flash (real BattleTech
   * turn order: "dos mechs NUNCA pueden disparar a la vez, ni un mech
   * dispara 2 armas a la vez" — confirmed by the user, so at most one
   * combat light is ever live at once) but NOT for persistent world
   * lights (streetlights/building windows can add up to dozens on one
   * map) unless a specific one is worth the cost. */
  castShadow?: boolean
  /** Real flame/electrical waver — torches, damaged/overheated lights,
   * neon signs. Two summed sine waves at slightly different speeds/
   * phases (seeded per-instance so a row of torches doesn't flicker in
   * obvious unison) reads as organic, unlike one clean sine's too-regular
   * pulse. `amount` is the fraction of `intensity` the flicker swings by
   * (0.15 = wavers between 85% and 115%), `speed` a rough Hz. */
  flicker?: { amount: number; speed: number }
}) {
  const ownRef = useRef<THREE.PointLight>(null)
  const seed = useRef(Math.random() * 1000)
  useFrame((state) => {
    if (!flicker) return
    const light = lightRef?.current ?? ownRef.current
    if (!light) return
    const t = state.clock.elapsedTime
    const n = Math.sin(t * flicker.speed + seed.current) * 0.6
      + Math.sin(t * flicker.speed * 2.7 + seed.current * 1.3) * 0.4
    light.intensity = intensity * (1 + n * flicker.amount)
  })
  return (
    <pointLight
      ref={(l) => { ownRef.current = l; if (lightRef) lightRef.current = l }}
      position={position}
      color={color}
      intensity={intensity}
      distance={distance}
      decay={decay}
      castShadow={castShadow}
    />
  )
}
