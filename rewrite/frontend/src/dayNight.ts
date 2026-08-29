import * as THREE from 'three'
import { HEX_SIZE } from './hexMath'

/** The board's own sky: one number, 0–24, turned into a lighting rig.
 *
 * Real user request: "slider en GM para cambiar la hora del dia/noche."
 *
 * Kept as a pure function of the hour rather than as a set of presets, so
 * dragging the slider sweeps continuously instead of snapping between
 * "day" and "night" — the interesting hours are the ones in between, and a
 * preset list has no way to sit at them. Every view feeds the same hour
 * through this, which is what makes the GM's slider mean something to a
 * player in the cockpit.
 *
 * What it does NOT do is change how bright each view is relative to the
 * others: the cockpit has always been lit harder than the tabletop views
 * (a pilot sits inside the mech, not above the board), so each view keeps
 * its own multiplier and this only decides the shape of the day.
 */

/** When the sun crosses the horizon. A 14-hour day, per explicit request —
 * see dayNightRig. */
export const SUNRISE_HOUR = 7
export const SUNSET_HOUR = 21

/** Midday, and what a board with no stored hour uses. */
export const DEFAULT_TIME_OF_DAY = (SUNRISE_HOUR + SUNSET_HOUR) / 2

/** Where the sun sits at its highest, in world units. Scaled to the board
 * so the shadow camera (which is sized in HEX_SIZE too) keeps containing
 * it as the map grows. */
const SUN_DISTANCE = 24 * HEX_SIZE

export interface DayNightRig {
  /** Sun/moon direction, ready for a directionalLight position. */
  sunPosition: [number, number, number]
  sunColor: string
  /** Multiplier on whatever intensity a view already used at midday. */
  sunIntensity: number
  ambientColor: string
  /** Same, for the view's own ambient. */
  ambientIntensity: number
  /** What the camera sees past the edge of the board. */
  background: string
  /** 0 at solar noon, 1 in the dead of night — for anything that wants to
   * react to darkness without redoing this maths. */
  darkness: number
}

/** Sun colours through the day: deep night, first light, low sun, midday.
 * Interpolated, never picked — see the note above on presets. */
const NIGHT_SUN = new THREE.Color('#4a5c8a')
const DAWN_SUN = new THREE.Color('#ff9d5c')
const DAY_SUN = new THREE.Color('#fff4e0')

const NIGHT_AMBIENT = new THREE.Color('#2b3550')
const DAY_AMBIENT = new THREE.Color('#cfe0ff')

const NIGHT_SKY = new THREE.Color('#070b16')
const DAWN_SKY = new THREE.Color('#3d2b3a')
const DAY_SKY = new THREE.Color('#0f1a18')

const _mix = new THREE.Color()

function mix(a: THREE.Color, b: THREE.Color, t: number): string {
  return `#${_mix.copy(a).lerp(b, THREE.MathUtils.clamp(t, 0, 1)).getHexString()}`
}

export function dayNightRig(hour: number): DayNightRig {
  // Wrapped rather than clamped: 25:00 is 01:00, and a slider that can be
  // dragged past midnight should keep going rather than stick.
  const h = ((hour % 24) + 24) % 24

  // Sunrise at 7, sunset at 21 — deliberately not a real solar model. This
  // is a game board, and an hour on the slider should mean the same amount
  // of change wherever you are on it.
  //
  // Real user request: "quiero que se haga de dia a las 7 y de noche a las
  // 9, ahora hay pocas horas de luz." The first version ran 06:00–18:00,
  // which put the board in darkness for half the slider — most of the
  // range was unusable for actually looking at a battle.
  const dayAngle = ((h - SUNRISE_HOUR) / (SUNSET_HOUR - SUNRISE_HOUR)) * Math.PI
  const elevation = Math.sin(dayAngle)
  const sunPosition: [number, number, number] = [
    Math.cos(dayAngle) * SUN_DISTANCE * 0.6,
    // Never allowed underground: below the horizon this becomes the moon,
    // and a light source under the terrain lights nothing but the underside
    // of the board.
    Math.max(0.12, elevation) * SUN_DISTANCE,
    SUN_DISTANCE * 0.35,
  ]

  // How high the sun is, as 0..1 — the one number every colour below reads.
  const height = Math.max(0, elevation)
  const darkness = 1 - height

  // Below the horizon it is night, and the light that remains is moonlight:
  // dim, blue, and coming from roughly where the sun would have been.
  if (elevation <= 0) {
    return {
      sunPosition,
      sunColor: `#${NIGHT_SUN.getHexString()}`,
      sunIntensity: 0.18,
      ambientColor: `#${NIGHT_AMBIENT.getHexString()}`,
      ambientIntensity: 0.35,
      background: `#${NIGHT_SKY.getHexString()}`,
      darkness: 1,
    }
  }

  // The first fifth of the sun's climb is dawn/dusk — long, orange and
  // low-contrast. After that it settles into ordinary daylight.
  const goldenHour = THREE.MathUtils.clamp(height / 0.2, 0, 1)
  const sunColor = height < 0.2
    ? mix(NIGHT_SUN, DAWN_SUN, goldenHour)
    : mix(DAWN_SUN, DAY_SUN, (height - 0.2) / 0.8)
  const background = height < 0.2
    ? mix(NIGHT_SKY, DAWN_SKY, goldenHour)
    : mix(DAWN_SKY, DAY_SKY, (height - 0.2) / 0.8)

  return {
    sunPosition,
    sunColor,
    // Never quite reaching the full midday value until the sun is actually
    // overhead, so noon still reads as the brightest moment of the day.
    sunIntensity: 0.18 + height * 0.92,
    ambientColor: mix(NIGHT_AMBIENT, DAY_AMBIENT, height),
    ambientIntensity: 0.35 + height * 0.65,
    background,
    darkness,
  }
}

/** How lit the board is right now, as a colour multiplier.
 *
 * Written by SceneLighting (the one thing that decides the lighting) and
 * read by anything that renders WITHOUT taking part in three.js's lighting
 * — today that is GroundVegetation's distant-tree impostors, which are
 * baked billboards no light can reach. They looked correct for as long as
 * the board had a single lighting condition; the moment a day/night cycle
 * existed they were the only thing still at full noon brightness in the
 * dark, which reads as a forest of glowing shrubs.
 *
 * A module value rather than a prop or a scene lookup, for two reasons that
 * both matter here: the impostor batches are rebuilt per region, so a prop
 * would rebuild geometry every time the slider moved a colour; and reading
 * it back off the scene means a full scene.traverse() per batch per frame,
 * which on this board is exactly the kind of cost the LOD work existed to
 * remove. */
const sceneLight = new THREE.Color(1, 1, 1)

export function setSceneLightLevel(color: THREE.ColorRepresentation, level: number): void {
  sceneLight.set(color).multiplyScalar(level)
}

export function sceneLightLevel(): THREE.Color {
  return sceneLight
}

/** "13:30" from 13.5 — for the slider's own readout. */
export function formatTimeOfDay(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const hours = Math.floor(h)
  const minutes = Math.round((h - hours) * 60)
  // Rounding 13.999 up must not produce "13:60".
  const carried = minutes === 60
  return `${String(carried ? (hours + 1) % 24 : hours).padStart(2, '0')}:${String(carried ? 0 : minutes).padStart(2, '0')}`
}
