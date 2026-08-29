import { useEffect, useRef, type ReactNode } from 'react'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import {
  perfAddPhysics, perfAddSection, perfEnabled, perfEndFrame, perfEvent,
  perfSetSceneStats, type PerfGroupStat, type PerfSceneStats,
} from '../perf'

/** Drop-in replacement for useFrame that charges the callback's time to a
 * named section of the frame. Every per-frame callback in the app goes
 * through this, which is what makes the HUD's section table real measured
 * time rather than a guess.
 *
 * When profiling is off this is useFrame plus one boolean check — the
 * profiler must not be the reason the app is slow. */
export function useProfiledFrame(
  label: string,
  callback: (state: RootState, delta: number, frame?: XRFrame) => void,
  priority?: number,
) {
  useFrame((state, delta, frame) => {
    if (!perfEnabled()) {
      callback(state, delta, frame)
      return
    }
    const t0 = performance.now()
    callback(state, delta, frame)
    perfAddSection(label, performance.now() - t0)
  }, priority)
}

/** Tags a subtree so the scene sampler can attribute its draw calls and
 * triangles to a subsystem. Adds one empty group node, which costs a
 * matrix update and nothing else. */
export function PerfGroup({ name, children }: { name: string; children: ReactNode }) {
  return <group userData={{ perfGroup: name }}>{children}</group>
}

const SAMPLE_EVERY_MS = 500

function groupOf(object: THREE.Object3D): string {
  let node: THREE.Object3D | null = object
  while (node) {
    const tag = (node.userData as { perfGroup?: string }).perfGroup
    if (tag) return tag
    node = node.parent
  }
  return 'otros'
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return index.count / 3
  const position = geometry.getAttribute('position')
  return position ? position.count / 3 : 0
}

/** Mounted inside every profiled Canvas.
 *
 * Three jobs, none of which the app itself can do:
 *  - close each frame, by patching gl.render. R3F runs every priority-0
 *    useFrame subscriber and THEN renders, so the inside of gl.render is
 *    both the render-submit measurement and a reliable end-of-frame hook;
 *  - sample what the scene is asking the GPU to draw, grouped by
 *    subsystem (see PerfGroup) — the closest thing to per-system GPU cost
 *    that WebGL actually permits;
 *  - watch for the two things that stall a frame without showing up in
 *    any per-frame measurement: assets finishing their download, and the
 *    renderer compiling new shader programs. */
export function PerfProbe() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const lastSample = useRef(0)
  const renderMs = useRef(0)
  const lastPrograms = useRef(-1)
  const seenAssets = useRef<Set<string>>(new Set())

  useEffect(() => {
    const hadOwn = Object.prototype.hasOwnProperty.call(gl, 'render')
    const previous = gl.render
    const original = previous.bind(gl)
    gl.render = function profiledRender(renderScene: THREE.Object3D, camera: THREE.Camera) {
      if (!perfEnabled()) {
        original(renderScene, camera)
        return
      }
      const t0 = performance.now()
      original(renderScene, camera)
      // WebGL is asynchronous: this is the CPU cost of BUILDING and
      // submitting the frame, not the GPU's cost of drawing it. The GPU's
      // share shows up as the gap between this and the real frame period.
      //
      // Accumulated rather than treated as the end of the frame, because
      // it is called a different number of times depending on the view:
      // once normally, but several times where an EffectComposer is in
      // play (the FPV cockpit's outline pass), and a shadow-casting light
      // adds its own passes on top.
      renderMs.current += performance.now() - t0
    }
    return () => {
      if (hadOwn) gl.render = previous
      else delete (gl as Partial<THREE.WebGLRenderer>).render
    }
  }, [gl])

  // Closes the PREVIOUS frame rather than the current one. R3F runs
  // priority-0 subscribers in mount order and this component is mounted
  // first inside its Canvas, so by the time this runs again every section
  // of the last frame — and its render passes, which happen after all the
  // callbacks — has already reported in.
  useProfiledFrame('perf (medidor)', (state) => {
    const now = performance.now()
    perfEndFrame(renderMs.current, now)
    renderMs.current = 0

    const elapsed = state.clock.elapsedTime * 1000
    if (elapsed - lastSample.current < SAMPLE_EVERY_MS) return
    lastSample.current = elapsed

    const groups = new Map<string, PerfGroupStat>()
    const lights: Record<string, number> = {}
    const materials = new Set<THREE.Material>()
    let drawCalls = 0
    let triangles = 0

    scene.traverse((object) => {
      if (object instanceof THREE.Light) {
        lights[object.type] = (lights[object.type] || 0) + 1
        return
      }
      const drawable = object as THREE.Mesh | THREE.Points | THREE.Line
      if (!drawable.geometry || !object.visible) return

      const name = groupOf(object)
      let stat = groups.get(name)
      if (!stat) {
        stat = { group: name, objects: 0, draws: 0, triangles: 0, instances: 0 }
        groups.set(name, stat)
      }
      const material = drawable.material
      const materialCount = Array.isArray(material) ? material.length : 1
      if (Array.isArray(material)) material.forEach((m) => materials.add(m))
      else if (material) materials.add(material)

      const instances = object instanceof THREE.InstancedMesh ? object.count : 1
      const tris = triangleCount(drawable.geometry) * instances

      stat.objects++
      stat.draws += materialCount
      stat.triangles += tris
      stat.instances += instances
      drawCalls += materialCount
      triangles += tris
    })

    const info = gl.info
    const programs = info.programs?.length ?? 0
    // A jump here is the expensive kind of stutter: three.js bakes the
    // scene's light count into every shader's cache key, so anything that
    // changes it recompiles the lot. Worth naming when it happens.
    if (lastPrograms.current >= 0 && programs > lastPrograms.current) {
      perfEvent('shader', `+${programs - lastPrograms.current} programas compilados (${programs} total)`)
    }
    lastPrograms.current = programs

    // info.render is reset by the renderer at the start of each frame,
    // and this callback runs before the frame's own draws — so what it
    // holds right now is the PREVIOUS frame's completed totals.
    const stats: PerfSceneStats = {
      sampledAt: performance.now(),
      drawCalls,
      triangles,
      drawnCalls: info.render.calls,
      drawnTriangles: info.render.triangles,
      programs,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      materials: materials.size,
      lights,
      groups: [...groups.values()].sort((a, b) => b.triangles - a.triangles),
    }
    perfSetSceneStats(stats)

    // Asset loads, straight from the browser's own resource timeline —
    // no loader instrumentation to keep in sync with three.js's own.
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    for (const entry of entries) {
      if (seenAssets.current.has(entry.name)) continue
      if (!/\.(glb|gltf|jpe?g|png|webp|ktx2|bin)(\?|$)/i.test(entry.name)) continue
      seenAssets.current.add(entry.name)
      const short = entry.name.split('/').pop()?.split('?')[0] ?? entry.name
      perfEvent('asset', short, entry.duration, entry.transferSize || entry.encodedBodySize)
    }
  })

  return null
}

/** Times Rapier's own world.step. Must be mounted INSIDE <Physics> (it
 * needs the world), which is why it is separate from PerfProbe — a view
 * with no physics provider must not have to pay for one. */
export function PerfPhysicsProbe() {
  const { world } = useRapier()
  useEffect(() => {
    if (!world) return
    const step = world.step.bind(world)
    const patched = (...args: Parameters<typeof world.step>) => {
      if (!perfEnabled()) return step(...args)
      const t0 = performance.now()
      const result = step(...args)
      perfAddPhysics(performance.now() - t0)
      return result
    }
    // `step` lives on the prototype, so an own property shadows it and
    // deleting that own property restores the original cleanly.
    ;(world as unknown as { step: typeof patched }).step = patched
    return () => {
      delete (world as unknown as { step?: typeof patched }).step
    }
  }, [world])
  return null
}
