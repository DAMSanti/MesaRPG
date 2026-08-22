import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'

/** Renders nothing — exists purely to hand the parent a function that
 * converts a screen point (native clientX/clientY) to a world-space (x,
 * z) hit on the ground plane, using the actual camera/canvas r3f owns.
 * Needed for dragging a mech card from the sidebar (a plain DOM element,
 * outside the Canvas and its own per-mesh pointer events) onto the map:
 * unlike an in-canvas drag, there's no r3f mesh under the cursor to ask
 * "which hex is this" via the usual onPointerMove path, so this does the
 * camera raycast manually instead. */
export function CameraBridge({ onReady }: { onReady: (fn: (clientX: number, clientY: number) => [number, number] | null) => void }) {
  const { camera, gl } = useThree()

  useEffect(() => {
    const raycaster = new THREE.Raycaster()
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()

    onReady((clientX: number, clientY: number) => {
      const rect = gl.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      return raycaster.ray.intersectPlane(groundPlane, hit) ? [hit.x, hit.z] : null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl])

  return null
}
