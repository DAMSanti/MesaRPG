import { useRef } from 'react'
import * as THREE from 'three'
import { useProfiledFrame } from './PerfProbe'

/** A fixed pool of transient point lights, mounted once with the board and
 * never unmounted. Weapons and dice both draw from it.
 *
 * WHY a pool instead of each effect mounting its own light, measured on a
 * real board (campaign 65, GPU-rendered, via a WebGL context patched to
 * count shader compiles):
 *
 *   scene:            1408 materials, 1278 meshes, 130 instanced meshes
 *   at rest:          46 shader programs
 *   +1 point light:   89 programs   (+43 new, 86 shader compiles)
 *   +5 point lights: 261 programs  (+215 new, 430 shader compiles)
 *
 * three.js bakes the scene's light COUNT into every material's shader
 * program cache key, so changing the count invalidates every program in
 * the scene and compiles a fresh set. A five-missile volley used to mount
 * ten point lights and unmount them again — one riding each missile, one
 * more per impact flash — all staggered, so the count churned through
 * roughly ten distinct values inside a second, compiling hundreds of
 * programs. That is what the user saw as "cuando tiramos misiles los FPS
 * se mueren", and it is why the fix has to be about the COUNT, not about
 * making the lights cheaper.
 *
 * The same bug had a second home: every glass die mounts its own light
 * too, and a table where four pilots roll initiative in their own time
 * mounts and unmounts eight of them at staggered moments. Same churn, same
 * recompiles, so dice come through here as well (see acquireLight).
 *
 * These lights are always in the scene, sitting at intensity 0 when
 * nothing is firing, so the count never changes and the programs compile
 * exactly once. The price is seven point lights' worth of per-fragment
 * maths that the board pays even in peace — a constant, predictable cost
 * traded against a large and repeated stall.
 *
 * Effects don't acquire or release anything. They write to the ROLE they
 * need, every frame, for as long as they want it lit; the pool applies
 * whatever it finds and then zeroes it. A light therefore goes out on its
 * own the moment its effect stops writing or unmounts, with no cleanup to
 * forget. Two effects wanting the same role in one frame is fine: the
 * last writer wins, which for (say) five missiles hitting the same tile
 * is exactly the one flash you'd want anyway. */
export const LIGHT_MUZZLE = 0
export const LIGHT_TRAVEL = 1
export const LIGHT_IMPACT = 2
const ROLE_SLOTS = 3

/** Slots handed out one at a time instead of being addressed by role.
 *
 * Dice need these: several glass dice can be in the air at once, each
 * wanting its own internal sparkle, and unlike a weapon's muzzle there is
 * no fixed number of them known in advance. Four is a deliberate ceiling —
 * every slot is a point light the whole board pays for in per-fragment
 * maths forever, so a fifth die simply goes unlit rather than making the
 * other 1.278 meshes on the board slower. */
const ACQUIRED_SLOTS = 4
const TOTAL_SLOTS = ROLE_SLOTS + ACQUIRED_SLOTS

interface Slot {
  x: number
  y: number
  z: number
  color: THREE.Color
  intensity: number
  distance: number
}

const slots: Slot[] = Array.from({ length: TOTAL_SLOTS }, () => ({
  x: 0, y: 0, z: 0, color: new THREE.Color('#ffffff'), intensity: 0, distance: 1,
}))

const taken = new Array<boolean>(ACQUIRED_SLOTS).fill(false)

/** Claim a slot for as long as a component lives. Returns -1 when they are
 * all spoken for, which callers must treat as "no light" rather than as an
 * error — running unlit is the correct degradation here. */
export function acquireLight(): number {
  for (let i = 0; i < ACQUIRED_SLOTS; i++) {
    if (!taken[i]) {
      taken[i] = true
      return ROLE_SLOTS + i
    }
  }
  return -1
}

export function releaseLight(slot: number) {
  const i = slot - ROLE_SLOTS
  if (i < 0 || i >= ACQUIRED_SLOTS) return
  taken[i] = false
  slots[slot].intensity = 0
}

/** Light one role for THIS frame. Call it every frame the light should be
 * on — see this file's own doc comment on why there is no release. */
export function setPoolLight(
  role: number, x: number, y: number, z: number,
  color: THREE.Color, intensity: number, distance: number,
) {
  const slot = slots[role]
  if (!slot) return
  slot.x = x
  slot.y = y
  slot.z = z
  slot.color.copy(color)
  slot.intensity = intensity
  slot.distance = distance
}

/** Mounted once, inside the board's own Canvas. Everything it drives is a
 * plain uniform (position, colour, intensity, distance), none of which
 * touches a shader's cache key — only the number of lights does, and that
 * is exactly what this never changes. */
export function LightPool() {
  const lights = useRef<(THREE.PointLight | null)[]>([])
  useProfiledFrame('luces', () => {
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const light = lights.current[i]
      const slot = slots[i]
      if (!light) continue
      light.position.set(slot.x, slot.y, slot.z)
      light.color.copy(slot.color)
      light.intensity = slot.intensity
      light.distance = slot.distance
      // Consumed: an effect that is still running writes it again before
      // the next frame, and one that has stopped leaves it dark.
      slot.intensity = 0
    }
  })
  return (
    <>
      {Array.from({ length: TOTAL_SLOTS }, (_, i) => (
        <pointLight
          key={i}
          ref={(l) => { lights.current[i] = l }}
          intensity={0}
          // Never three.js's own "0 = infinite" default, same reasoning as
          // DynamicLight's own `distance` prop: a finite range keeps the
          // renderer from weighing these against every object on the board.
          distance={1}
          decay={2}
          castShadow={false}
        />
      ))}
    </>
  )
}
