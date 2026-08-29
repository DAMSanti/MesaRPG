import { useCallback, useEffect, useRef, useState } from 'react'
import {
  perfEnabled, perfEvents, perfHistory, perfSceneStats, perfSnapshot, setPerfEnabled,
  type PerfSnapshot, type PerfSceneStats,
} from '../perf'
import { renderPolicyLabel } from './RenderPolicy'
import './PerfHud.css'

/** The on-screen profiler, mounted next to the board in TableView, GMView
 * and the FPV cockpit.
 *
 * Reads at 4Hz rather than every frame: the numbers underneath are
 * gathered per frame (see perf.ts), but a panel that re-rendered React 60
 * times a second would be measuring itself as much as the app. */
const REFRESH_MS = 250
const GRAPH_FRAMES = 240
const GRAPH_H = 64

const STORAGE_KEY = 'mesarpg.perfHud'

function useToggle(): [boolean, (on: boolean) => void] {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    if (new URLSearchParams(window.location.search).get('perf') === '1') return true
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  })
  const set = useCallback((on: boolean) => {
    setOpen(on)
    setPerfEnabled(on)
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
    } catch {
      // A blocked localStorage is no reason to lose the panel.
    }
  }, [])
  useEffect(() => {
    setPerfEnabled(open)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault()
        set(!perfEnabled())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      setPerfEnabled(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return [open, set]
}

function ms(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

function bytes(value?: number): string {
  if (!value) return '—'
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`
  return `${Math.round(value / 1024)}KB`
}

function thousands(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

function FrameGraph({ snapshot }: { snapshot: PerfSnapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Caller-owned buffers, refilled in place each tick — see perfHistory.
  const buffers = useRef({
    period: new Float32Array(GRAPH_FRAMES),
    logic: new Float32Array(GRAPH_FRAMES),
    render: new Float32Array(GRAPH_FRAMES),
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { period, logic, render } = buffers.current
    const count = perfHistory(GRAPH_FRAMES, period, logic, render)
    const width = canvas.width
    const height = canvas.height

    ctx.clearRect(0, 0, width, height)
    // Scale to whatever is actually happening, but never zoom in past the
    // 60fps budget — a graph that rescales to make 8ms frames look tall
    // reads as a problem where there is none.
    let peak = 33.4
    for (let i = 0; i < count; i++) peak = Math.max(peak, period[i])
    peak = Math.min(peak, 200)
    const y = (value: number) => height - Math.min(height, (value / peak) * height)

    for (const [budget, color] of [[16.7, '#2f6f4f'], [33.4, '#6b552a']] as const) {
      if (budget > peak) continue
      ctx.strokeStyle = color
      ctx.beginPath()
      ctx.moveTo(0, y(budget) + 0.5)
      ctx.lineTo(width, y(budget) + 0.5)
      ctx.stroke()
    }

    const barWidth = width / GRAPH_FRAMES
    for (let i = 0; i < count; i++) {
      const x = i * barWidth
      const logicMs = logic[i]
      const renderMs = render[i]
      const total = period[i]
      // Stacked bottom-up: what the CPU did, then the unexplained rest —
      // GPU time and vsync idle, which WebGL will not itemise.
      ctx.fillStyle = total > 33.4 ? '#d4574b' : '#3d4a5c'
      ctx.fillRect(x, y(total), Math.max(1, barWidth), y(0) - y(total))
      ctx.fillStyle = '#7a6ad8'
      ctx.fillRect(x, y(logicMs + renderMs), Math.max(1, barWidth), y(0) - y(logicMs + renderMs))
      ctx.fillStyle = '#4e9ad6'
      ctx.fillRect(x, y(logicMs), Math.max(1, barWidth), y(0) - y(logicMs))
    }
  }, [snapshot])

  return (
    <div className="perf-graph">
      <canvas ref={canvasRef} width={320} height={GRAPH_H} />
      <div className="perf-graph-key">
        <span><i style={{ background: '#4e9ad6' }} />lógica</span>
        <span><i style={{ background: '#7a6ad8' }} />render (CPU)</span>
        <span><i style={{ background: '#3d4a5c' }} />GPU/espera</span>
      </div>
    </div>
  )
}

function SceneTable({ scene }: { scene: PerfSceneStats }) {
  const total = scene.triangles || 1
  return (
    <>
      <div className="perf-section-title">
        Gráficos — qué se dibuja
        <span className="perf-hint">{scene.drawnCalls} draws · {thousands(scene.drawnTriangles)} tris/frame</span>
      </div>
      <table className="perf-table">
        <tbody>
          {scene.groups.map((group) => (
            <tr key={group.group}>
              <td className="perf-label">{group.group}</td>
              <td className="perf-num">{thousands(group.triangles)}</td>
              <td className="perf-num perf-dim">{group.draws}d</td>
              <td className="perf-num perf-dim">{group.instances > group.objects ? `${thousands(group.instances)}i` : ''}</td>
              <td className="perf-bar-cell">
                <span className="perf-bar" style={{ width: `${Math.min(100, (group.triangles / total) * 100)}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="perf-meta perf-dim">
        en escena: {scene.drawCalls} objetos · {thousands(scene.triangles)} tris
        {scene.drawnCalls > scene.drawCalls ? ' (dibujado más de una vez: pases de sombra)' : ''}
      </div>
      <div className="perf-meta">
        luces: {Object.entries(scene.lights).map(([type, n]) => `${type.replace('Light', '')}×${n}`).join(' ') || 'ninguna'}
        {' · '}programas: {scene.programs}
        {' · '}materiales: {scene.materials}
        {' · '}texturas: {scene.textures}
        {' · '}geometrías: {scene.geometries}
      </div>
    </>
  )
}

export function PerfHud() {
  const [open, setOpen] = useToggle()
  const [expanded, setExpanded] = useState(true)
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null)
  const [scene, setScene] = useState<PerfSceneStats | null>(null)

  useEffect(() => {
    if (!open) return
    const tick = () => {
      setSnapshot(perfSnapshot(performance.now()))
      setScene(perfSceneStats())
    }
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [open])

  if (!open) {
    return (
      <button type="button" className="perf-hud-open" onClick={() => setOpen(true)} title="Medidor de rendimiento (F8)">
        fps
      </button>
    )
  }

  const short = snapshot?.short
  const long = snapshot?.long
  const verdict = snapshot?.verdict

  return (
    <div className="perf-hud">
      <div className="perf-head">
        <span className={`perf-fps perf-fps-${verdict?.kind ?? 'idle'}`}>
          {short && short.frames > 0 ? short.fps.toFixed(0) : '—'}
          <em>fps</em>
        </span>
        <div className="perf-head-nums">
          <div>
            <b>{short ? ms(short.avgMs) : '—'}</b> ms/frame
            <span className="perf-dim"> · 10s {long ? ms(long.avgMs) : '—'}</span>
          </div>
          <div className="perf-dim">
            p95 {short ? ms(short.p95Ms) : '—'} · peor {short ? ms(short.maxMs) : '—'}
            {short && short.slow33 > 0 ? ` · ${short.slow33} frames >33ms` : ''}
          </div>
          {/* A view deliberately running slow should say so, or it reads as
              a bug — see RenderPolicy. */}
          <div className="perf-dim">bucle: {renderPolicyLabel()}</div>
        </div>
        <div className="perf-head-actions">
          <button type="button" onClick={() => setExpanded((v) => !v)}>{expanded ? '−' : '+'}</button>
          <button type="button" onClick={() => setOpen(false)}>×</button>
        </div>
      </div>

      {verdict && (
        <div className={`perf-verdict perf-verdict-${verdict.kind}`}>
          {verdict.kind === 'ok' && 'Todo bien'}
          {verdict.kind === 'cpu' && 'Cuello de botella: CPU'}
          {verdict.kind === 'gpu' && 'Cuello de botella: GPU'}
          {verdict.kind === 'physics' && 'Cuello de botella: física'}
          {verdict.kind === 'idle' && 'Midiendo…'}
          <span> — {verdict.detail}</span>
        </div>
      )}

      {snapshot && <FrameGraph snapshot={snapshot} />}

      {expanded && snapshot && (
        <>
          <div className="perf-section-title">
            CPU por sección
            <span className="perf-hint">media 1s</span>
          </div>
          <table className="perf-table">
            <tbody>
              <tr className="perf-row-strong">
                <td className="perf-label">render (envío)</td>
                <td className="perf-num">{ms(short?.renderMs ?? 0)}</td>
                <td className="perf-num perf-dim">{short && short.avgMs > 0 ? `${((short.renderMs / short.avgMs) * 100).toFixed(0)}%` : ''}</td>
                <td className="perf-bar-cell">
                  <span className="perf-bar perf-bar-render" style={{ width: `${Math.min(100, ((short?.renderMs ?? 0) / (short?.avgMs || 1)) * 100)}%` }} />
                </td>
              </tr>
              {(short?.physicsMs ?? 0) > 0.01 && (
                <tr className="perf-row-strong">
                  <td className="perf-label">física (Rapier)</td>
                  <td className="perf-num">{ms(short?.physicsMs ?? 0)}</td>
                  <td className="perf-num perf-dim">{short && short.avgMs > 0 ? `${((short.physicsMs / short.avgMs) * 100).toFixed(0)}%` : ''}</td>
                  <td className="perf-bar-cell">
                    <span className="perf-bar perf-bar-physics" style={{ width: `${Math.min(100, ((short?.physicsMs ?? 0) / (short?.avgMs || 1)) * 100)}%` }} />
                  </td>
                </tr>
              )}
              {snapshot.sections.map((section) => (
                <tr key={section.label}>
                  <td className="perf-label">{section.label}</td>
                  <td className="perf-num">{ms(section.avgMs)}</td>
                  <td className="perf-num perf-dim">{(section.share * 100).toFixed(0)}%</td>
                  <td className="perf-bar-cell">
                    <span className="perf-bar" style={{ width: `${Math.min(100, section.share * 100)}%` }} />
                  </td>
                </tr>
              ))}
              <tr className="perf-row-gap">
                <td className="perf-label">GPU / espera (sin medir)</td>
                <td className="perf-num">{ms(short?.gapMs ?? 0)}</td>
                <td className="perf-num perf-dim">{short && short.avgMs > 0 ? `${((short.gapMs / short.avgMs) * 100).toFixed(0)}%` : ''}</td>
                <td className="perf-bar-cell">
                  <span className="perf-bar perf-bar-gap" style={{ width: `${Math.min(100, ((short?.gapMs ?? 0) / (short?.avgMs || 1)) * 100)}%` }} />
                </td>
              </tr>
            </tbody>
          </table>

          {snapshot.worst && snapshot.worst.periodMs > 25 && (
            <>
              <div className="perf-section-title">
                Peor frame del último segundo
                <span className="perf-hint">{ms(snapshot.worst.periodMs)} ms</span>
              </div>
              <div className="perf-meta">
                render {ms(snapshot.worst.renderMs)}
                {snapshot.worst.physicsMs > 0.01 ? ` · física ${ms(snapshot.worst.physicsMs)}` : ''}
                {snapshot.worst.sections.slice(0, 4).map((s) => ` · ${s.label} ${ms(s.ms)}`).join('')}
              </div>
            </>
          )}

          {scene && <SceneTable scene={scene} />}

          <div className="perf-section-title">Cargas y compilaciones</div>
          <div className="perf-events">
            {perfEvents().length === 0 && <div className="perf-dim">nada todavía</div>}
            {[...perfEvents()].slice(-8).reverse().map((event, i) => (
              <div key={`${event.t}-${i}`} className={`perf-event perf-event-${event.kind}`}>
                <span className="perf-event-text">{event.text}</span>
                <span className="perf-dim">
                  {event.ms !== undefined ? `${ms(event.ms)}ms` : ''}
                  {event.bytes ? ` · ${bytes(event.bytes)}` : ''}
                </span>
              </div>
            ))}
          </div>

          <div className="perf-foot">
            F8 abre y cierra · «render (envío)» es CPU armando el frame, no lo que tarda la GPU en pintarlo
          </div>
        </>
      )}
    </div>
  )
}
