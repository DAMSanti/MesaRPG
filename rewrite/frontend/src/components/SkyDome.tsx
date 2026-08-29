import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { HEX_SIZE } from '../hexMath'
import { dayNightRig, DEFAULT_TIME_OF_DAY } from '../dayNight'
import { getGlowTexture } from './AttackEffects'
import { useProfiledFrame } from './PerfProbe'

/** The cockpit's sky, following the board's own clock.
 *
 * Real user request: "el slider de hora de dia deberia mover tambien el sol
 * del FPV y cambiar el cielo a noche cuando corresponda de forma
 * coherente."
 *
 * The photographed sky stays — it is what makes daylight look like
 * daylight, and no gradient was going to replace it — but it is now dimmed
 * by scene.backgroundIntensity as the sun goes down, so at night it reads
 * as a dark sky rather than as a bright afternoon someone forgot to turn
 * off. What the photo cannot do is have a sun in the right place, so the
 * sun, the moon and the stars are drawn on top of it and follow the same
 * rig every other light in the scene reads.
 *
 * Everything here rides ON the camera: the group is moved to the camera's
 * own position every frame, so the sun sits at a fixed direction rather
 * than at a fixed point. A sun placed at a real distance would slide
 * across the sky as the mech walked — and it cannot simply be placed
 * further away instead, because this view's camera has three.js's default
 * 2000-unit far plane and a hex is 30 units, so "far enough not to
 * parallax" is well past where it would stop being drawn at all.
 */

/** Radius the sky objects sit at. Only the direction matters (the group
 * tracks the camera), so this just needs to clear the terrain and stay
 * inside the far plane. */
const SKY_RADIUS = 40 * HEX_SIZE
const SUN_SIZE = 5 * HEX_SIZE
const STAR_COUNT = 700

export function SkyDome({ hour = DEFAULT_TIME_OF_DAY }: { hour?: number }) {
  const scene = useThree((state) => state.scene)
  const groupRef = useRef<THREE.Group>(null)
  const sunRef = useRef<THREE.Mesh>(null)
  const starsRef = useRef<THREE.Points>(null)

  const rig = useMemo(() => dayNightRig(hour), [hour])

  const texture = useMemo(() => {
    const t = new THREE.TextureLoader().load('/textures/sky.jpg')
    t.mapping = THREE.EquirectangularReflectionMapping
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])

  // Stars on the upper half of a sphere, drawn once and then only faded.
  // Rejection-free: sampling z in [0, 1] instead of [-1, 1] gives a
  // uniform upper hemisphere directly.
  const starGeometry = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      const y = Math.random()
      const radius = Math.sqrt(1 - y * y)
      const theta = Math.random() * Math.PI * 2
      positions[i * 3] = Math.cos(theta) * radius * SKY_RADIUS
      positions[i * 3 + 1] = y * SKY_RADIUS
      positions[i * 3 + 2] = Math.sin(theta) * radius * SKY_RADIUS
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geometry
  }, [])

  // The direction the sun is in, as a unit vector — the rig gives a
  // position in world units, which is the same thing once normalised.
  const sunDirection = useMemo(() => {
    const [x, y, z] = rig.sunPosition
    return new THREE.Vector3(x, y, z).normalize()
  }, [rig])

  useProfiledFrame('cielo', (state) => {
    // Riding the camera is what stops the sky from parallaxing — see the
    // component's own doc comment.
    groupRef.current?.position.copy(state.camera.position)

    // Dimming the photo is what turns day into night here. Not taken all
    // the way to zero: a completely black sky reads as a rendering fault,
    // and a trace of the real horizon is what keeps the board sitting
    // under something.
    scene.background = texture
    scene.backgroundIntensity = 0.04 + (1 - rig.darkness) * 0.96

    if (sunRef.current) {
      sunRef.current.position.copy(sunDirection).multiplyScalar(SKY_RADIUS)
      sunRef.current.quaternion.copy(state.camera.quaternion)
      const material = sunRef.current.material as THREE.MeshBasicMaterial
      // Below the horizon this is the moon: smaller, colder, and dimmer
      // than the sun ever is.
      const isMoon = rig.darkness >= 1
      material.color.set(isMoon ? '#cfe0ff' : rig.sunColor)
      material.opacity = isMoon ? 0.85 : 1
      sunRef.current.scale.setScalar(isMoon ? 0.45 : 1)
    }

    if (starsRef.current) {
      const material = starsRef.current.material as THREE.PointsMaterial
      // Squared so they stay out of the way through most of dusk and then
      // come out quickly, rather than hanging faintly in a bright sky.
      material.opacity = rig.darkness ** 2
      starsRef.current.visible = material.opacity > 0.01
    }
  })

  return (
    <group ref={groupRef}>
      <mesh ref={sunRef}>
        <planeGeometry args={[SUN_SIZE, SUN_SIZE]} />
        <meshBasicMaterial
          map={getGlowTexture()}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <points ref={starsRef} geometry={starGeometry}>
        <pointsMaterial
          color="#dce8ff"
          size={0.22 * HEX_SIZE}
          sizeAttenuation
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  )
}
