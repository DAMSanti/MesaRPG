import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/** Decides how often a board actually renders, from whether anyone is
 * looking at it.
 *
 * Real user setup: two FPV cockpits, a GM view and a TableView open at
 * once, dropping every one of them to 12 fps. Measured, that is not a
 * coincidence — one view costs 21,1 ms of GPU-limited frame time, and four
 * come to 84 ms ≈ 11,8 fps. Each view is its own WebGL context with its
 * own copy of every texture and buffer, rendering the whole board
 * independently; nothing is shared between them, so four views really is
 * four times the work.
 *
 * The browser does not save us here. Chrome throttles requestAnimationFrame
 * for a hidden TAB, but four windows visible on two monitors are all
 * "visible" and all run flat out, however few of them anyone is looking at.
 *
 * Three states, because "not focused" and "not visible" are different
 * things and collapsing them would break the real use case — a TableView
 * projected on a table that players are watching while the GM works in
 * another window:
 *
 *   focused, or the only window     full rate
 *   visible but not focused         THROTTLED_HZ
 *   hidden or minimised             nothing at all
 *
 * ONLY document.hidden stops a board. An earlier attempt also stopped one
 * whose canvas had scrolled out of the page, watched with an
 * IntersectionObserver, and that turned out to be a fine way to wedge a
 * board somebody was looking at: the observer reports isIntersecting false
 * for an element that has no size yet, fires once, and then never fires
 * again, because the intersection never CHANGES. A view that is merely
 * scrolled away is not worth that risk. If the document is visible, this
 * keeps rendering. */

/** Frames per second for a board that is visible but that nobody is
 * working in — the user's own call after watching it: "lo que este sin
 * foco deja que llegue a 30fps si puede."
 *
 * A ceiling, not a target: it allows a frame every 33ms and the board
 * renders it if it can. Half of 60 is also the kindest number to pick,
 * since a projected table showing a mech walk at 30fps still reads as
 * smooth while costing half the GPU. */
const THROTTLED_HZ = 30

export type RenderReason = 'focused' | 'unfocused' | 'hidden'

export interface RenderPolicy {
  /** Renders per second this board is allowed. `null` means no limit, `0`
   * means none at all. */
  maxHz: number | null
  reason: RenderReason
}

const REASON_LABEL: Record<RenderReason, string> = {
  focused: 'a pleno ritmo',
  unfocused: `${THROTTLED_HZ} fps (sin foco)`,
  hidden: 'parado (pestaña oculta)',
}

let currentPolicy: RenderPolicy = { maxHz: null, reason: 'focused' }

/** What the profiler HUD reports, so a deliberately slow view never looks
 * like a bug. */
export function renderPolicyLabel(): string {
  return REASON_LABEL[currentPolicy.reason]
}

/** Watches the page and says how this board should be running. Call it
 * outside the Canvas; hand the result to <FrameGate>. */
export function useRenderPolicy(): RenderPolicy {
  const [policy, setPolicy] = useState<RenderPolicy>(() => ({ maxHz: null, reason: 'focused' }))

  useEffect(() => {
    // An escape hatch for when this feature itself is the suspect:
    // ?render=always pins the view to full rate.
    const forced = new URLSearchParams(window.location.search).get('render') === 'always'

    const resolve = (): RenderPolicy => {
      if (forced) return { maxHz: null, reason: 'focused' }
      if (document.hidden) return { maxHz: 0, reason: 'hidden' }
      // hasFocus() is false for every window but one, which is exactly the
      // question being asked. It is also false while focus sits in the
      // devtools, and running at half rate reading the console is fine.
      if (!document.hasFocus()) return { maxHz: THROTTLED_HZ, reason: 'unfocused' }
      return { maxHz: null, reason: 'focused' }
    }

    const apply = () => {
      const next = resolve()
      currentPolicy = next
      setPolicy((prev) => (prev.maxHz === next.maxHz && prev.reason === next.reason ? prev : next))
    }

    apply()
    window.addEventListener('focus', apply)
    window.addEventListener('blur', apply)
    document.addEventListener('visibilitychange', apply)
    return () => {
      window.removeEventListener('focus', apply)
      window.removeEventListener('blur', apply)
      document.removeEventListener('visibilitychange', apply)
      currentPolicy = { maxHz: null, reason: 'focused' }
    }
  }, [])

  return policy
}

/** Enforces the policy, by intercepting the renderer itself.
 *
 * The obvious implementation is R3F's own `frameloop="demand"`, and it was
 * the first attempt. It does not hold: under `demand` a board renders
 * whenever ANYTHING calls invalidate(), and inside a board carrying
 * physics something does, every frame. Measured — GM view, with no
 * <Physics>, obeyed perfectly; TableView ignored the setting completely
 * and kept running at full rate even with the tab reported hidden, while
 * its own HUD correctly said "parado". The gate has to sit somewhere
 * nothing else can reach around, and that is gl.render.
 *
 * (`frameloop="never"` is worse still: R3F special-cases it by writing the
 * timestamp handed to advance() straight into the world clock, which is in
 * SECONDS while every timestamp to hand is in milliseconds. That ran the
 * wind a thousand times too fast in the background and left the clock
 * unusable on the way back — a real user report, both halves at once.)
 *
 * The decision is made ONCE per frame, in a frame callback, rather than
 * per gl.render call. It has to be: the FPV cockpit renders through an
 * EffectComposer, which calls the renderer several times for one frame,
 * and a time-based gate would let the scene through and block the outline
 * — or the reverse — and draw a broken frame.
 *
 * The app's own per-frame logic still runs while a board is gated. That is
 * on purpose: it is 0,6 ms of a 20 ms frame, and letting it run keeps
 * animation, physics and the world clock honest, so a throttled board
 * stays correct instead of lurching when it comes back. What gets skipped
 * is the expensive part — building and submitting the frame, and
 * everything the GPU then does with it. */
export function FrameGate({ policy }: { policy: RenderPolicy }) {
  const gl = useThree((state) => state.gl)
  const allow = useRef(true)
  const last = useRef(0)
  const maxHz = policy.maxHz

  useFrame(() => {
    if (maxHz === null) {
      allow.current = true
      return
    }
    if (maxHz <= 0) {
      allow.current = false
      return
    }
    const now = performance.now()
    allow.current = now - last.current >= 1000 / maxHz
    if (allow.current) last.current = now
  })

  useEffect(() => {
    if (maxHz === null) return
    const hadOwn = Object.prototype.hasOwnProperty.call(gl, 'render')
    const previous = gl.render
    const original = previous.bind(gl)
    gl.render = function gatedRender(scene: THREE.Object3D, camera: THREE.Camera) {
      if (!allow.current) return
      original(scene, camera)
    }
    return () => {
      if (hadOwn) gl.render = previous
      else delete (gl as Partial<THREE.WebGLRenderer>).render
    }
  }, [gl, maxHz])

  return null
}
