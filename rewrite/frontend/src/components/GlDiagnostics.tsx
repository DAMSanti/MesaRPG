import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import { deviceProfile } from '../deviceProfile'
import './GlDiagnostics.css'

/** Makes the canvas say what went wrong, on the device where it went wrong.
 *
 * Real user report: three views failing three different ways on a phone —
 * "en GMview aparece un cuadro blanco", "en tableview carga un segundo y
 * rapidamente se vuelve blanco", "en FPV aparece el hud, pero con ruido
 * estatico de fondo, nunca carga el mapa" — none of which says WHY. A
 * white canvas is the same picture whether the GPU dropped the context,
 * a shader failed to compile, or an asset never arrived, and those have
 * nothing in common as fixes.
 *
 * So rather than guessing from a desktop, this puts the answer on the
 * phone's own screen. It catches the three things that actually produce a
 * blank canvas — a React error thrown inside the tree, a lost WebGL
 * context, and a failure to get a context at all — and shows the message
 * along with what the device said about itself.
 *
 * Deliberately not hidden behind a debug flag. A blank screen with no
 * explanation is worse than a blank screen with one, for anybody.
 */
export function GlDiagnostics({ children }: { children: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [fault, setFault] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // The canvas does not exist yet on the first effect run (R3F creates it
    // as it mounts), and it can be replaced, so the listeners go on the
    // container and rely on the events bubbling... which they do not.
    // Hence polling for the canvas once, briefly, instead.
    let canvas: HTMLCanvasElement | null = null
    const onLost = (event: Event) => {
      // Preventing the default is what allows a restore to be attempted at
      // all; without it the context is gone for good.
      event.preventDefault()
      setFault(
        'El navegador ha perdido el contexto WebGL. Suele significar que el '
        + 'dispositivo se ha quedado sin memoria de GPU.',
      )
    }
    const onRestored = () => setFault(null)

    const attach = () => {
      canvas = host.querySelector('canvas')
      if (!canvas) return false
      canvas.addEventListener('webglcontextlost', onLost as EventListener)
      canvas.addEventListener('webglcontextrestored', onRestored)
      return true
    }

    if (!attach()) {
      const timer = window.setInterval(() => { if (attach()) window.clearInterval(timer) }, 200)
      // Stops looking after a few seconds: by then either the canvas
      // exists or something else has already gone wrong.
      window.setTimeout(() => window.clearInterval(timer), 5000)
    }

    return () => {
      canvas?.removeEventListener('webglcontextlost', onLost as EventListener)
      canvas?.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [])

  return (
    <div className="gl-diagnostics-host" ref={hostRef}>
      <GlErrorBoundary onError={setFault}>{children}</GlErrorBoundary>
      {fault && <GlFaultReport message={fault} />}
    </div>
  )
}

function GlFaultReport({ message }: { message: string }) {
  const profile = deviceProfile()
  const nav = navigator as Navigator & { deviceMemory?: number }
  return (
    <div className="gl-diagnostics-report" role="alert">
      <strong>El mapa 3D no ha podido dibujarse</strong>
      <p>{message}</p>
      <dl>
        <div><dt>Calidad</dt><dd>{profile.reason}</dd></div>
        <div><dt>Resolución</dt><dd>{`hasta ${profile.dpr[1]}x de ${window.devicePixelRatio}x`}</dd></div>
        <div><dt>Sombras</dt><dd>{profile.shadows ? 'sí' : 'no'}</dd></div>
        <div><dt>Memoria</dt><dd>{nav.deviceMemory != null ? `${nav.deviceMemory} GB` : 'no declarada'}</dd></div>
        <div><dt>Núcleos</dt><dd>{nav.hardwareConcurrency ?? 'no declarados'}</dd></div>
        <div><dt>GPU</dt><dd>{describeRenderer()}</dd></div>
      </dl>
      <p className="gl-diagnostics-hint">
        Puedes forzar la calidad añadiendo <code>?calidad=baja</code> o <code>?calidad=alta</code> a la URL.
      </p>
    </div>
  )
}

/** What the driver calls itself. Its own context, thrown away immediately:
 * asking the live renderer would mean holding a reference to a context that
 * may be exactly the thing that just died. */
function describeRenderer(): string {
  try {
    const probe = document.createElement('canvas').getContext('webgl2')
      ?? document.createElement('canvas').getContext('webgl')
    if (!probe) return 'sin contexto WebGL'
    const info = probe.getExtension('WEBGL_debug_renderer_info')
    const name = info
      ? String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : 'no revelada'
    const maxTexture = probe.getParameter(probe.MAX_TEXTURE_SIZE)
    return `${name} (texturas hasta ${maxTexture}px)`
  } catch {
    return 'no consultable'
  }
}

class GlErrorBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    this.props.onError(error.message || String(error))
  }

  render() {
    // Rendering nothing rather than a placeholder: the report above is
    // already showing, and re-mounting a tree that just threw would only
    // throw again.
    return this.state.failed ? null : this.props.children
  }
}
