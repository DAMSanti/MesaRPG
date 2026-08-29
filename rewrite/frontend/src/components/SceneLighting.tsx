import { useMemo } from 'react'
import { HEX_SIZE } from '../hexMath'
import { dayNightRig, DEFAULT_TIME_OF_DAY } from '../dayNight'

/** The board's sun, ambient and sky, driven by the time of day.
 *
 * One component for GMView, TableView and FirstPersonView, which until now
 * each carried their own copy of the same rig (right down to the same
 * shadow-acne comment pasted three times). They were never meant to differ
 * except in overall brightness, and keeping three copies is how a fix for
 * one of them quietly fails to reach the other two.
 *
 * `sunScale`/`ambientScale` preserve exactly that one real difference: the
 * cockpit is lit harder than the tabletop views, because a pilot sits
 * inside the mech rather than above the board. Passing the numbers each
 * view already used keeps them looking as they do today at midday, and
 * lets the time of day move all three together. */
export function SceneLighting({
  hour = DEFAULT_TIME_OF_DAY,
  sunScale = 1.4,
  ambientScale = 0.6,
  background = true,
  castShadow = true,
  nightVision = false,
}: {
  hour?: number
  /** The view's own midday directional intensity. */
  sunScale?: number
  /** The view's own midday ambient intensity. */
  ambientScale?: number
  /** FirstPersonView paints a real sky of its own (SkyBackground) and must
   * not have a flat colour drawn over it. */
  background?: boolean
  castShadow?: boolean
  /** Lifts the board to something legible at night, for the view wearing
   * goggles (see NightVision). No amount of green tinting rescues an image
   * that is genuinely black, so the light has to come first — the tint is
   * only what makes it read as an intensified image rather than as someone
   * having turned the sun back on. */
  nightVision?: boolean
}) {
  const rig = useMemo(() => dayNightRig(hour), [hour])
  // Roughly the gain of a real intensifier tube: enough to make out shape
  // and movement, nowhere near daylight. Scaled by how dark it actually is
  // so that turning the goggles on never makes the board BRIGHTER than the
  // moment before they came on — at the switchover point the gain is still
  // near 1 and it fades in as the night deepens.
  const gain = nightVision ? 1 + rig.darkness * 3.2 : 1

  return (
    <>
      {background && <color attach="background" args={[rig.background]} />}
      <ambientLight color={rig.ambientColor} intensity={rig.ambientIntensity * ambientScale * gain} />
      <directionalLight
        position={rig.sunPosition}
        color={rig.sunColor}
        intensity={rig.sunIntensity * sunScale * gain}
        castShadow={castShadow}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-30 * HEX_SIZE} shadow-camera-right={30 * HEX_SIZE}
        shadow-camera-top={30 * HEX_SIZE} shadow-camera-bottom={-30 * HEX_SIZE}
        shadow-camera-far={60 * HEX_SIZE}
        // Real user report: dark speckled blotches across whole tile faces,
        // worse when zoomed out — classic shadow-map self-shadowing acne
        // (three.js's own shadow.bias/normalBias both default to 0), and
        // this terrain mesh's own per-vertex noise/ramp displacement
        // (terrainReliefAt) gives it exactly the kind of constantly-varying
        // normal that triggers it; a flat plane rarely shows this at all.
        // Worse at a distance because more of the shadow map's fixed 2048²
        // resolution covers the visible area at once, making its own
        // discretization error more visible per screen pixel. normalBias
        // (which offsets the shadow-map LOOKUP along the surface normal,
        // not along the light direction) is the standard fix for acne on
        // non-flat receivers, scaled to this scene's real HEX_SIZE=30m
        // units like every other small offset in this codebase.
        shadow-normalBias={HEX_SIZE * 0.02}
      />
    </>
  )
}
