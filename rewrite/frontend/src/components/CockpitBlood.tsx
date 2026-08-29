import { useEffect, useMemo, useRef } from 'react'
import './CockpitBlood.css'

/** Blood on the inside of the cockpit glass, one burst per wound the pilot
 * takes.
 *
 * Real user request: "cuando un piloto de mech reciba daño, quiero que en
 * FPV se genere un splatter de sangre en el HUD, como si hubiese sangrado
 * sobre el cristal."
 *
 * Drawn to a canvas rather than assembled out of CSS gradients, because a
 * splatter's whole character is that no two are alike: a main impact blob,
 * satellites thrown off it, a scatter of fine droplets, and a few runs
 * pulled downward by gravity. A handful of CSS blobs would read as the same
 * decal stamped again and again, which is exactly what the effect is
 * supposed to avoid.
 *
 * It ACCUMULATES and never clears. Blood on glass does not tidy itself up,
 * and a pilot who has been hit four times should be looking through the
 * evidence of all four — it is a health bar you cannot ignore. Each burst
 * lands away from the centre of vision, though: this has to read as damage,
 * not become a reason to stop playing. */

/** Where a burst is allowed to land, as a fraction of the viewport. Kept
 * out of the middle so the sight line stays usable however wounded the
 * pilot is. */
const CLEAR_CENTRE = 0.26

function randomIn(min: number, max: number) {
  return min + Math.random() * (max - min)
}

/** One wound's worth of blood, in a random corner-ish region. */
function drawBurst(ctx: CanvasRenderingContext2D, width: number, height: number) {
  // Push the origin out of the centre: pick an angle, then a radius that
  // starts beyond the protected middle.
  const angle = Math.random() * Math.PI * 2
  const radius = randomIn(CLEAR_CENTRE, 0.52)
  const cx = width * (0.5 + Math.cos(angle) * radius)
  const cy = height * (0.5 + Math.sin(angle) * radius * 0.9)
  const scale = Math.min(width, height) / 900

  // Arterial red, and deliberately saturated. The layer multiplies into
  // what is behind it, so anything with green or blue left in it turns
  // brown against a bright sky — the first attempt read as mud rather than
  // blood for exactly that reason.
  const wet = () => `rgba(${Math.round(randomIn(158, 196))}, ${Math.round(randomIn(4, 14))}, ${Math.round(randomIn(6, 18))}, ${randomIn(0.72, 0.95)})`

  const blob = (x: number, y: number, r: number) => {
    // Irregular rather than round — a circle reads as a sticker — but
    // rounded, not spiky. Straight lines between widely varying radii drew
    // stars; sampling more often and easing the variation, then closing the
    // outline with curves, gives the wobbly edge a real drop has.
    const points = 20
    const radii: number[] = []
    for (let i = 0; i < points; i++) radii.push(r * randomIn(0.82, 1.18))
    ctx.beginPath()
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2
      const next = ((i + 1) / points) * Math.PI * 2
      const rr = radii[i % points]
      const nr = radii[(i + 1) % points]
      const px = x + Math.cos(a) * rr
      const py = y + Math.sin(a) * rr
      const nx = x + Math.cos(next) * nr
      const ny = y + Math.sin(next) * nr
      if (i === 0) ctx.moveTo(px, py)
      // Midpoint of the next edge as the curve's end, this vertex as its
      // control: the standard way to round a polygon without corners.
      ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2)
    }
    ctx.closePath()
    ctx.fillStyle = wet()
    ctx.fill()
  }

  // The impact itself.
  blob(cx, cy, randomIn(26, 52) * scale)

  // Satellites, thrown outward from it.
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2
    const d = randomIn(30, 150) * scale
    blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, randomIn(5, 18) * scale)
  }

  // Fine spray.
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2
    const d = randomIn(20, 260) * scale
    const r = randomIn(0.7, 3.4) * scale
    ctx.beginPath()
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, Math.PI * 2)
    ctx.fillStyle = wet()
    ctx.fill()
  }

  // Runs. Only from the heavier blobs, and only downward — this is the
  // detail that says "on glass" rather than "in the air".
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2
    const d = randomIn(0, 60) * scale
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d
    const w = randomIn(2.5, 6) * scale
    const len = randomIn(40, 190) * scale
    const grad = ctx.createLinearGradient(x, y, x, y + len)
    grad.addColorStop(0, `rgba(168, 8, 14, ${randomIn(0.7, 0.92)})`)
    grad.addColorStop(1, 'rgba(168, 8, 14, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(x - w / 2, y, w, len)
    // The bead that gathers at the end of a run.
    ctx.beginPath()
    ctx.arc(x, y + len, w * randomIn(0.6, 1.1), 0, Math.PI * 2)
    ctx.fillStyle = `rgba(168, 8, 14, ${randomIn(0.55, 0.8)})`
    ctx.fill()
  }
}

/** Real user request: "el splatter de sangre debe desaparecer con el
 * tiempo."
 *
 * Done by repeatedly erasing a little of the canvas rather than by fading
 * the element, because the two behave differently in the case that
 * matters: fading the whole layer would take a fresh wound down with the
 * old ones, and the fade would have to be restarted from full every time
 * the pilot is hit, which reads as the old blood coming BACK. Erasing
 * multiplies what is already there, so each splatter decays from the
 * moment it lands and a new one arrives at full strength over whatever is
 * left of the last.
 *
 * The decay is geometric (each tick keeps 1 - PER_TICK of what remains),
 * so these two numbers mean: effectively gone about a minute after the
 * last hit. */
const BLOOD_FADE_TICK_MS = 900
const BLOOD_FADE_PER_TICK = 0.075
/** Ticks to run before wiping the last invisible residue and stopping. A
 * geometric fade never quite reaches zero, and a timer that runs forever
 * for the sake of alpha nobody can see is a timer that runs forever. */
const BLOOD_FADE_TICKS = 60

export function CockpitBlood({ hits }: { hits: number }) {
  // ?blood=N paints N wounds regardless of the pilot's real state. Looking
  // at this effect otherwise means getting a pilot shot first, which is a
  // poor way to iterate on how it looks.
  const forced = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('blood')
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : null
  }, [])
  const wounds = forced ?? hits

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const flashRef = useRef<HTMLDivElement>(null)
  // What has already been painted. Starts at the pilot's CURRENT wounds so
  // reopening the cockpit mid-fight does not replay every hit at once as a
  // sudden faceful of blood.
  const paintedRef = useRef<number | null>(null)
  const fadeTimerRef = useRef<number | null>(null)
  const fadeTicksRef = useRef(0)

  // Stopped on unmount — leaving the cockpit while the blood is still
  // drying would otherwise leave an interval running against a canvas
  // that no longer exists.
  useEffect(() => () => {
    if (fadeTimerRef.current !== null) window.clearInterval(fadeTimerRef.current)
    fadeTimerRef.current = null
  }, [])

  useEffect(() => {
    // Restarts the clock rather than the fade: whatever is on the glass
    // keeps whatever strength it has left, it just gets the full window
    // again before the layer is wiped and the timer stops.
    const keepFading = () => {
      fadeTicksRef.current = BLOOD_FADE_TICKS
      if (fadeTimerRef.current !== null) return
      fadeTimerRef.current = window.setInterval(() => {
        const target = canvasRef.current
        const targetCtx = target?.getContext('2d')
        if (!target || !targetCtx) return
        targetCtx.save()
        // Erases a fraction of what is there instead of painting over it,
        // which is what makes this work on a transparent layer.
        targetCtx.globalCompositeOperation = 'destination-out'
        targetCtx.fillStyle = `rgba(0, 0, 0, ${BLOOD_FADE_PER_TICK})`
        targetCtx.fillRect(0, 0, target.width, target.height)
        targetCtx.restore()
        fadeTicksRef.current -= 1
        if (fadeTicksRef.current > 0) return
        targetCtx.clearRect(0, 0, target.width, target.height)
        if (fadeTimerRef.current !== null) window.clearInterval(fadeTimerRef.current)
        fadeTimerRef.current = null
      }, BLOOD_FADE_TICK_MS)
    }

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Sized once, in device pixels, and never resized: a canvas resize
    // clears it, which would wipe the blood every time the window moved.
    if (canvas.width === 0) {
      canvas.width = Math.round(window.innerWidth * window.devicePixelRatio)
      canvas.height = Math.round(window.innerHeight * window.devicePixelRatio)
    }

    if (paintedRef.current === null) {
      // First mount: catch up silently to whatever the pilot already has.
      for (let i = 0; i < wounds; i++) drawBurst(ctx, canvas.width, canvas.height)
      paintedRef.current = wounds
      if (wounds > 0) keepFading()
      return
    }
    if (wounds <= paintedRef.current) {
      paintedRef.current = wounds
      return
    }

    for (let i = paintedRef.current; i < wounds; i++) drawBurst(ctx, canvas.width, canvas.height)
    paintedRef.current = wounds
    keepFading()

    // A new wound also throws a red pulse across the whole screen — the
    // splatter alone is easy to miss when it lands out at the edge, which
    // is exactly where it is put on purpose.
    const flash = flashRef.current
    if (flash) {
      flash.classList.remove('hit')
      // Forces the animation to restart on a second wound in quick
      // succession; without it the class is already there and nothing runs.
      void flash.offsetWidth
      flash.classList.add('hit')
    }
  }, [wounds])

  return (
    <>
      <canvas ref={canvasRef} className="fp-blood" aria-hidden />
      <div ref={flashRef} className="fp-blood-flash" aria-hidden />
    </>
  )
}
