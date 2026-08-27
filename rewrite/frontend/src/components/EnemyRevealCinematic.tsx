import { Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Mech3D, MODEL_CHEST_FRACTION, MODEL_SCALE } from './Mech3D'
import './EnemyRevealCinematic.css'

const ORBIT_DURATION_S = 6

/** Circles the camera 360° around the mech at chest height over
 * ORBIT_DURATION_S seconds, always looking at it — a real Object3D
 * ref-driven loop (this scene has no OrbitControls of its own to fight
 * with), not tied to any prop so it keeps running smoothly regardless
 * of what else re-renders around it. */
function OrbitingCamera() {
  const { camera } = useThree()
  const targetY = MODEL_SCALE * MODEL_CHEST_FRACTION
  useFrame((state) => {
    const t = (state.clock.elapsedTime % ORBIT_DURATION_S) / ORBIT_DURATION_S
    const angle = t * Math.PI * 2
    const radius = 3
    camera.position.set(Math.sin(angle) * radius, targetY + 0.35, Math.cos(angle) * radius)
    camera.lookAt(0, targetY, 0)
  })
  return null
}

/** Real user request: "cuando un enemigo entra en el LoS del equipo, en
 * el tableview se abre un modal con el chasis+modelo viendo al mech
 * moviéndose la cámara poco a poco 360º a modo de cinemática de
 * presentación" — a standalone mini-scene (its own <Canvas>, not
 * reusing HexMap's — no terrain/other units, just this one mech turning
 * in a spotlight) shown the instant a hostile enters the team's LOS
 * (TableView's own lastRevealedUnitId, gated by the campaign's
 * enemy_reveal_cinematic toggle — see GMView's own Ajustes modal).
 * Auto-closes after a delay owned by the caller (TableView — see its own
 * AUTO_CLOSE_MS, driven off the reveal id directly rather than an effect
 * in here keyed on chassis/model, which never re-armed when two reveals
 * in a row shared the same chassis/model: real user report, "hay una
 * cinematica, la ultima, que se queda eternamente ahi"); the × button
 * also closes it early. */
export function EnemyRevealCinematic({
  chassis, model, color, onClose,
}: {
  chassis: string | null
  model: string | null
  color: string
  onClose: () => void
}) {
  return (
    <div className="enemy-reveal-overlay">
      <div className="enemy-reveal-frame">
        <Canvas camera={{ fov: 32, near: 0.1, far: 50 }} shadows>
          <color attach="background" args={['#0a1210']} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[3, 5, 2]} intensity={1.7} castShadow />
          <directionalLight position={[-3, 2, -3]} intensity={0.4} color="#7fd4c8" />
          <OrbitingCamera />
          <Suspense fallback={null}>
            <Mech3D color={color} chassis={chassis} model={model} isMoving={false} />
          </Suspense>
        </Canvas>
        <div className="enemy-reveal-label">
          <span className="enemy-reveal-chassis">{chassis ?? 'Contacto desconocido'}</span>
          {model && <span className="enemy-reveal-model">{model}</span>}
        </div>
        <button
          type="button" className="enemy-reveal-close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  )
}
