import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { HEX_SIZE } from '../hexMath'
import { dayNightRig, DEFAULT_TIME_OF_DAY, setSceneLightLevel } from '../dayNight'
import { useProfiledFrame } from './PerfProbe'

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
  shadowMapSize = 2048,
  nightVision = false,
}: {
  hour?: number
  /** The view's own midday directional intensity. */
  sunScale?: number
  /** The view's own midday ambient intensity. */
  ambientScale?: number
  /** FirstPersonView paints a real sky of its own (SkyDome) and must not
   * have a flat colour drawn over it. */
  background?: boolean
  castShadow?: boolean
  /** Dropped hard on a phone — see deviceProfile. A shadow map is a whole
   * extra render of the scene every frame plus its own texture, and 2048²
   * of it is a quarter of the texture budget some mobile GPUs have. */
  shadowMapSize?: number
  /** Hands the scene over to NightVisionLight below — see its own doc
   * comment for why this is a replacement rather than a brightness knob. */
  nightVision?: boolean
}) {
  const rig = useMemo(() => dayNightRig(hour), [hour])

  // Published for the things that render outside three.js's lighting — see
  // sceneLightLevel. Written during render rather than in an effect so a
  // frame never draws impostors lit for the previous hour.
  //
  // The sun does most of the real lighting, so this is not the ambient
  // term alone: it tracks the shape of the day the way a lit surface
  // experiences it, which is what keeps the LOD swap between a real plant
  // and its billboard invisible.
  if (nightVision) {
    // The goggles light the board themselves — see NightVisionLight.
    setSceneLightLevel('#dfeee6', 1.15)
    return (
      <>
        {background && <color attach="background" args={['#04070a']} />}
        <NightVisionLight />
      </>
    )
  }
  setSceneLightLevel(rig.sunColor, 0.22 + (1 - rig.darkness) * 0.95)

  return (
    <>
      {background && <color attach="background" args={[rig.background]} />}
      <ambientLight color={rig.ambientColor} intensity={rig.ambientIntensity * ambientScale} />
      <directionalLight
        position={rig.sunPosition}
        color={rig.sunColor}
        intensity={rig.sunIntensity * sunScale}
        castShadow={castShadow}
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
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

/** What the GM's goggles actually see. Replaces the sun entirely.
 *
 * Real user request: "la funcion de la NV en el GMview es que el GM pueda
 * ver el tablero, los mechs, todo como si lo viera con gafas NV, se que las
 * gafas reales amplifican la luz, pero aqui los tiles y eso no son
 * emisivos, asi que necesito que lo cheatees: tenemos que ver el tablero y
 * los mechs y decoraciones con 0 iluminacion en NV."
 *
 * That is the right call, and worth being explicit about why simply turning
 * the sun up does not do it. A real intensifier multiplies the light that
 * is there; multiplying a scene whose only light source is below the
 * horizon multiplies a very small number by a large one and still leaves
 * every surface facing away from that one light in shadow. The board would
 * be brighter and just as unreadable.
 *
 * So the goggles bring their own light, and it comes from the camera. A
 * directional light pointed exactly along the view axis lights every
 * surface the GM can see, by construction — nothing visible can be facing
 * away from it — with no falloff to tune and no dark side of the board. The
 * shading that remains comes from how each surface is angled relative to
 * that axis, which is what keeps a mech reading as a mech instead of a flat
 * green sticker.
 *
 * Shadows are off for the same reason they would be wrong: a shadow is
 * light that did not arrive, and this "light" is a device on the viewer's
 * face, not a lamp in the world.
 */
function NightVisionLight() {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const targetRef = useRef<THREE.Object3D>(null)

  useProfiledFrame('iluminacion', (state) => {
    const light = lightRef.current
    const target = targetRef.current
    if (!light || !target) return
    // A directional light aims from its position at its target's, and
    // three.js needs that target to be a real object in the scene so it can
    // read its world matrix. Assigned here rather than declaratively
    // because the ref is not populated on the first render.
    light.target = target
    // Only the DIRECTION matters, so putting the light at the camera and
    // the target one unit down the view axis is the whole trick — the
    // distance between them is irrelevant.
    light.position.copy(state.camera.position)
    state.camera.getWorldDirection(target.position)
    target.position.add(state.camera.position)
    target.updateMatrixWorld()
  })

  return (
    <>
      {/* Fills in the surfaces the view-axis light rakes at a grazing angle
          — an edge-on face receives almost nothing from a directional
          light, and on a hex board those are the tile walls, which are
          exactly the elevation changes the GM needs to read.
          Deliberately ONE ambient and ONE directional, matching the
          daylight rig above: three.js bakes the number of lights into every
          shader program's cache key, so a rig with a different count would
          recompile every program in the scene the moment the sun set.
          Shadow-casting lights are counted separately and this one casts
          none, so there is still one rebuild as the goggles come on — once
          per sunset, which is a price worth paying for not painting black
          shadows into an image whose whole job is to have none. */}
      <ambientLight color="#dfeee6" intensity={1.6} />
      <directionalLight ref={lightRef} color="#ffffff" intensity={2.4} castShadow={false} />
      <object3D ref={targetRef} />
    </>
  )
}
