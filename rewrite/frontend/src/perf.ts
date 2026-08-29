/** Frame profiler core — framework-free, so the R3F side (PerfProbe.tsx)
 * and the DOM overlay (PerfHud.tsx) both talk to the same numbers.
 *
 * Real user request: "medidores de rendimiento... cuanto tarda en cargar
 * cada frame, y la media corrida segregado por secciones, graficos y
 * dentro de graficos, carga de mechs, dados, arboles, hierba, iluminacion
 * etc etc... simulaciones, motor... Tengo que ver quienes son los
 * culpables en cada momento de que vaya como va."
 *
 * WHAT IS ACTUALLY MEASURABLE, because a profiler that quietly invents
 * numbers is worse than none:
 *
 *  - CPU per subsystem: real. Every useFrame callback in the app is
 *    wrapped (useProfiledFrame), so the time each one costs is measured
 *    directly and attributed to a named section.
 *  - Render submit: real. The time inside gl.render() — building the
 *    render lists, uploading uniforms, issuing draw calls. This is CPU
 *    time, NOT how long the GPU takes to draw; WebGL returns as soon as
 *    the commands are queued.
 *  - Physics: real, timed around Rapier's own world.step.
 *  - GPU per subsystem: NOT measurable. WebGL exposes no per-object
 *    timing, and the one extension that could time a whole frame
 *    (EXT_disjoint_timer_query_webgl2) is disabled in most browsers. So
 *    instead of faking a per-system GPU cost, the HUD reports what the
 *    GPU is being ASKED to do — draw calls, triangles and instances,
 *    grouped by subsystem — plus the unexplained gap between the frame's
 *    CPU work and its real duration, which is where GPU time hides.
 *
 * Everything is preallocated: a profiler that allocates per frame shows
 * up in its own measurements.
 */

const MAX_LABELS = 24
/** ~15s of history at 60fps, enough for the 10s rolling average the user
 * asked for plus room for the frame graph. */
const RING = 900

/** Fixed slots at the end of every frame's row, alongside the labels. */
const SLOT_PERIOD = MAX_LABELS
const SLOT_RENDER = MAX_LABELS + 1
const SLOT_PHYSICS = MAX_LABELS + 2
const STRIDE = MAX_LABELS + 3

const labels: string[] = []
const labelIndex = new Map<string, number>()

const ring = new Float32Array(RING * STRIDE)
const ringTime = new Float64Array(RING)
const current = new Float32Array(STRIDE)
let head = -1
let filled = 0
let lastFrameEnd = 0

let enabled = false

export function perfEnabled(): boolean {
  return enabled
}

export function setPerfEnabled(on: boolean) {
  enabled = on
  if (!on) {
    head = -1
    filled = 0
    lastFrameEnd = 0
    current.fill(0)
  }
}

function slotFor(label: string): number {
  const known = labelIndex.get(label)
  if (known !== undefined) return known
  if (labels.length >= MAX_LABELS) return -1
  const index = labels.length
  labels.push(label)
  labelIndex.set(label, index)
  return index
}

/** Add measured milliseconds to a named section of the frame in progress. */
export function perfAddSection(label: string, ms: number) {
  if (!enabled) return
  const slot = slotFor(label)
  if (slot < 0) return
  current[slot] += ms
}

export function perfAddPhysics(ms: number) {
  if (!enabled) return
  current[SLOT_PHYSICS] += ms
}

/** Called from inside the patched gl.render, which R3F runs after every
 * priority-0 useFrame subscriber — so by this point every section of the
 * frame has already reported in. */
export function perfEndFrame(renderMs: number, now: number) {
  if (!enabled) return
  current[SLOT_RENDER] = renderMs
  // The very first frame has no previous one to measure against.
  current[SLOT_PERIOD] = lastFrameEnd > 0 ? now - lastFrameEnd : 0
  lastFrameEnd = now

  head = (head + 1) % RING
  ring.set(current, head * STRIDE)
  ringTime[head] = now
  if (filled < RING) filled++
  current.fill(0)
}

export interface PerfSection {
  label: string
  avgMs: number
  maxMs: number
  share: number
}

export interface PerfWindow {
  frames: number
  fps: number
  avgMs: number
  maxMs: number
  p95Ms: number
  cpuMs: number
  renderMs: number
  physicsMs: number
  logicMs: number
  gapMs: number
  slow33: number
  slow100: number
}

export interface PerfWorstFrame {
  periodMs: number
  renderMs: number
  physicsMs: number
  sections: { label: string; ms: number }[]
}

export interface PerfSnapshot {
  short: PerfWindow
  long: PerfWindow
  lastMs: number
  sections: PerfSection[]
  worst: PerfWorstFrame | null
  verdict: { kind: 'ok' | 'gpu' | 'cpu' | 'physics' | 'idle'; detail: string }
}

function ringIndex(offsetFromHead: number): number {
  return (head - offsetFromHead + RING * 2) % RING
}

function summarize(windowMs: number, now: number): { win: PerfWindow; firstOffset: number; count: number } {
  const win: PerfWindow = {
    frames: 0, fps: 0, avgMs: 0, maxMs: 0, p95Ms: 0,
    cpuMs: 0, renderMs: 0, physicsMs: 0, logicMs: 0, gapMs: 0,
    slow33: 0, slow100: 0,
  }
  if (filled === 0) return { win, firstOffset: 0, count: 0 }

  const periods: number[] = []
  let count = 0
  for (let offset = 0; offset < filled; offset++) {
    const i = ringIndex(offset)
    if (now - ringTime[i] > windowMs) break
    const base = i * STRIDE
    const period = ring[base + SLOT_PERIOD]
    // A zero period is the very first recorded frame, which has nothing
    // to measure against; counting it would drag every average down.
    if (period <= 0) continue
    count++
    periods.push(period)
    win.avgMs += period
    win.maxMs = Math.max(win.maxMs, period)
    win.renderMs += ring[base + SLOT_RENDER]
    win.physicsMs += ring[base + SLOT_PHYSICS]
    for (let s = 0; s < labels.length; s++) win.logicMs += ring[base + s]
    if (period > 33.4) win.slow33++
    if (period > 100) win.slow100++
  }
  if (count === 0) return { win, firstOffset: 0, count: 0 }

  win.frames = count
  win.avgMs /= count
  win.renderMs /= count
  win.physicsMs /= count
  win.logicMs /= count
  win.cpuMs = win.logicMs + win.renderMs + win.physicsMs
  win.gapMs = Math.max(0, win.avgMs - win.cpuMs)
  win.fps = win.avgMs > 0 ? 1000 / win.avgMs : 0
  periods.sort((a, b) => a - b)
  win.p95Ms = periods[Math.min(periods.length - 1, Math.floor(periods.length * 0.95))]
  return { win, firstOffset: 0, count }
}

function verdictFor(win: PerfWindow, sections: PerfSection[]): PerfSnapshot['verdict'] {
  if (win.frames === 0) return { kind: 'idle', detail: 'sin datos todavía' }
  // Anything at or above ~55fps is doing fine; naming a "culprit" there
  // would just be pointing at whichever number happens to be biggest.
  if (win.avgMs <= 18) return { kind: 'ok', detail: `${win.fps.toFixed(0)} fps, holgado` }
  const top = sections[0]
  if (win.physicsMs > win.avgMs * 0.3) {
    return { kind: 'physics', detail: `física ${win.physicsMs.toFixed(1)}ms de ${win.avgMs.toFixed(1)}ms` }
  }
  // Render submit is checked BEFORE the named sections, because it is not
  // one of them and it is usually the biggest single number on the panel.
  // Naming the largest useFrame instead — when that useFrame costs 0.2ms
  // and gl.render costs 65 — points at the wrong culprit entirely.
  if (win.renderMs > win.avgMs * 0.4) {
    return {
      kind: 'cpu',
      detail: `render (envío) ${win.renderMs.toFixed(1)}ms — mira el número de dibujos`,
    }
  }
  if (win.cpuMs > win.avgMs * 0.6) {
    return {
      kind: 'cpu',
      detail: top ? `CPU: ${top.label} ${top.avgMs.toFixed(1)}ms` : `CPU ${win.cpuMs.toFixed(1)}ms`,
    }
  }
  // CPU is idle but frames are still long: the GPU (or vsync) is the wall.
  return {
    kind: 'gpu',
    detail: `GPU/espera ${win.gapMs.toFixed(1)}ms de ${win.avgMs.toFixed(1)}ms — mira triángulos y draws`,
  }
}

export function perfSnapshot(now: number): PerfSnapshot {
  const { win: short } = summarize(1000, now)
  const { win: long } = summarize(10000, now)

  // Per-section averages over the short window, so the table reacts at
  // roughly the speed the user perceives a stutter.
  const sums = new Float64Array(MAX_LABELS)
  const maxes = new Float64Array(MAX_LABELS)
  let counted = 0
  let worstOffset = -1
  let worstPeriod = 0
  for (let offset = 0; offset < filled; offset++) {
    const i = ringIndex(offset)
    if (now - ringTime[i] > 1000) break
    const base = i * STRIDE
    const period = ring[base + SLOT_PERIOD]
    if (period <= 0) continue
    counted++
    for (let s = 0; s < labels.length; s++) {
      const v = ring[base + s]
      sums[s] += v
      if (v > maxes[s]) maxes[s] = v
    }
    if (period > worstPeriod) {
      worstPeriod = period
      worstOffset = i
    }
  }

  const sections: PerfSection[] = []
  for (let s = 0; s < labels.length; s++) {
    if (counted === 0) break
    const avg = sums[s] / counted
    if (avg < 0.001 && maxes[s] < 0.05) continue
    sections.push({
      label: labels[s],
      avgMs: avg,
      maxMs: maxes[s],
      share: short.avgMs > 0 ? avg / short.avgMs : 0,
    })
  }
  sections.sort((a, b) => b.avgMs - a.avgMs)

  let worst: PerfWorstFrame | null = null
  if (worstOffset >= 0) {
    const base = worstOffset * STRIDE
    const parts: { label: string; ms: number }[] = []
    for (let s = 0; s < labels.length; s++) {
      if (ring[base + s] > 0.01) parts.push({ label: labels[s], ms: ring[base + s] })
    }
    parts.sort((a, b) => b.ms - a.ms)
    worst = {
      periodMs: ring[base + SLOT_PERIOD],
      renderMs: ring[base + SLOT_RENDER],
      physicsMs: ring[base + SLOT_PHYSICS],
      sections: parts,
    }
  }

  const lastMs = head >= 0 ? ring[head * STRIDE + SLOT_PERIOD] : 0
  return { short, long, lastMs, sections, worst, verdict: verdictFor(short, sections) }
}

/** The last `count` frames, newest last, for the frame graph. Written into
 * caller-owned arrays so drawing the graph allocates nothing either. */
export function perfHistory(
  count: number, period: Float32Array, logic: Float32Array, render: Float32Array,
): number {
  const n = Math.min(count, filled)
  for (let k = 0; k < n; k++) {
    const i = ringIndex(n - 1 - k)
    const base = i * STRIDE
    period[k] = ring[base + SLOT_PERIOD]
    render[k] = ring[base + SLOT_RENDER]
    let logicMs = ring[base + SLOT_PHYSICS]
    for (let s = 0; s < labels.length; s++) logicMs += ring[base + s]
    logic[k] = logicMs
  }
  return n
}

// ---------------------------------------------------------------- scene

/** What the GPU is being ASKED to draw, grouped by subsystem. Sampled a
 * few times a second (a full scene walk every frame would be its own
 * performance problem), not per frame. */
export interface PerfGroupStat {
  group: string
  objects: number
  draws: number
  triangles: number
  instances: number
}

export interface PerfSceneStats {
  sampledAt: number
  /** What the scene CONTAINS, from walking the graph. */
  drawCalls: number
  triangles: number
  /** What the renderer actually DREW last frame, from renderer.info —
   * after frustum culling, and including every extra shadow-map pass. The
   * honest per-frame GPU load, where the two above are what it was asked
   * to consider. */
  drawnCalls: number
  drawnTriangles: number
  programs: number
  geometries: number
  textures: number
  materials: number
  lights: Record<string, number>
  groups: PerfGroupStat[]
}

let sceneStats: PerfSceneStats | null = null

export function perfSetSceneStats(stats: PerfSceneStats) {
  sceneStats = stats
}

export function perfSceneStats(): PerfSceneStats | null {
  return sceneStats
}

// ---------------------------------------------------------------- events

export interface PerfEvent {
  t: number
  kind: 'asset' | 'shader' | 'note'
  text: string
  ms?: number
  bytes?: number
}

const events: PerfEvent[] = []
const MAX_EVENTS = 60

export function perfEvent(kind: PerfEvent['kind'], text: string, ms?: number, bytes?: number) {
  events.push({ t: performance.now(), kind, text, ms, bytes })
  if (events.length > MAX_EVENTS) events.shift()
}

export function perfEvents(): readonly PerfEvent[] {
  return events
}
