import { Suspense, useEffect, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import type { PointLight } from 'three'
import { Mech3D } from './Mech3D'
import './KillReplay.css'

/**
 * Not a true instant-replay (no position history is recorded/rewound) —
 * a live cinematic reaction shot triggered by the kill event, rendered
 * as a picture-in-picture inset while the main view stays top-down.
 * Real replay (scrub back through recorded state) is future work.
 */
function OrbitCam() {
  useFrame((state) => {
    const t = state.clock.elapsedTime
    const radius = 3.2
    state.camera.position.set(Math.sin(t * 0.6) * radius, 1.8, Math.cos(t * 0.6) * radius)
    state.camera.lookAt(0, 0.4, 0)
  })
  return null
}

function Wreck() {
  const light = useRef<PointLight>(null)
  useFrame((state) => {
    if (light.current) {
      light.current.intensity = 3 + Math.sin(state.clock.elapsedTime * 8) * 2
    }
  })
  return (
    <group rotation={[0, 0.6, 1.15]} position={[0, 0.3, 0]}>
      <Mech3D color="#3a1a12" emissive="#e35d2a" emissiveIntensity={1.4} />
      <pointLight ref={light} color="#ff6a2a" intensity={4} distance={5} />
    </group>
  )
}

export function KillReplay({ label, onDone }: { label: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000)
    return () => clearTimeout(t)
  }, [onDone])

  return (
    <div className="kill-replay">
      <div className="kill-replay-badge">REPRODUCCIÓN — {label}</div>
      <Canvas camera={{ fov: 45 }}>
        <color attach="background" args={['#050807']} />
        <ambientLight intensity={0.3} />
        <OrbitCam />
        <Suspense fallback={null}>
          <Wreck />
        </Suspense>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow>
          <circleGeometry args={[3, 32]} />
          <meshStandardMaterial color="#12211f" />
        </mesh>
      </Canvas>
    </div>
  )
}
