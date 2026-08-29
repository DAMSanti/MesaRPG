/** What this device can actually be asked to draw.
 *
 * Real user report: "intento entrar desde el movil y me carga todo menos el
 * mapa... en GMview aparece un cuadro blanco, en tableview carga un segundo
 * y rapidamente se vuelve blanco... el rendimiento en movil es una ruina."
 *
 * A canvas that draws for a second and then turns white is a lost WebGL
 * context, and the usual cause on a phone is simply asking for more than
 * the device has. This board asks for a lot: every view preloads 38.7 MB of
 * vegetation .glb (two "hero" trees alone are 28 MB of that), renders at
 * whatever devicePixelRatio the phone reports — 3 on a lot of handsets,
 * which is nine times the pixels of a 1x buffer for the same picture — and
 * carries 2048² shadow maps, a post-processing pass and a floating-point
 * environment map on top.
 *
 * Detection deliberately avoids sniffing the user agent, which lies and
 * goes stale. It asks about the things that actually matter: how much
 * memory the device admits to, how many cores it has, and whether the
 * pointer is a finger. Any one of those being modest is enough — a desktop
 * with a touchscreen still reports a fine pointer for its mouse, and the
 * worst case of being wrong here is a slightly softer picture on a machine
 * that could have handled more.
 */

export interface DeviceProfile {
  /** Real capability, not a preference — see `dpr`. */
  constrained: boolean
  /** [min, max] for R3F's own dpr. Left uncapped by the views until now,
   * which on a 3x phone meant a full-screen canvas nine times the area of
   * the same picture at 1x, for a difference nobody can see at arm's
   * length. This is the single biggest lever on a phone. */
  dpr: [number, number]
  /** Shadow maps cost memory and a whole extra render of the scene per
   * frame. */
  shadows: boolean
  shadowMapSize: number
  /** The post-processing outline pass and the floating-point environment
   * map for the dice. Both allocate render targets some mobile GPUs will
   * not give out, and both are decoration. */
  heavyEffects: boolean
  /** The two unoptimised "hero" trees — 28 MB of the 38.7 MB every view
   * preloads. The board still has four other tree species, all of them
   * around 1 MB, so dropping these costs variety and nothing else. */
  heroVegetation: boolean
  /** Multiplier on how many plants a tile grows.
   *
   * Measured on the phone, not guessed: with everything else already
   * dialled back, the GM view still ran at 1.4 fps with the GPU at 94% of
   * the frame and 18.5M triangles going through it. Vegetation was 95% of
   * that geometry — 5.84M triangles of scattered plants, 1.65M of grass
   * carpet and 1.37M of trees. Nothing else on the board comes close, and
   * no amount of shaving draw calls helps when the problem is how many
   * triangles exist. */
  vegetationDensity: number
  /** Ceiling on the grass carpet's own instanced cards. */
  carpetCards: number
  /** Scales the distance at which a real tree becomes a billboard — bring
   * it in and far more of the board is impostors, which is one draw call
   * per region instead of thousands of triangles. */
  lodDistanceScale: number
  /** Why it decided what it decided, for the on-screen diagnostics. */
  reason: string
}

const DESKTOP: DeviceProfile = {
  constrained: false,
  // Capped at 2 even here: past that the cost is quadratic and the gain is
  // invisible, and a 4x external display should not quietly quadruple the
  // work every frame.
  dpr: [1, 2],
  shadows: true,
  shadowMapSize: 2048,
  heavyEffects: true,
  heroVegetation: true,
  vegetationDensity: 1,
  carpetCards: 900000,
  lodDistanceScale: 1,
  reason: 'escritorio',
}

const CONSTRAINED: DeviceProfile = {
  constrained: true,
  dpr: [1, 1.5],
  shadows: false,
  shadowMapSize: 512,
  heavyEffects: false,
  heroVegetation: false,
  // Measured, then measured again. A first pass at a quarter density took
  // the phone from 1.4 to 3.8 fps and the GPU from 550 ms to 139 ms a
  // frame -- the right direction and nowhere near far enough, with
  // vegetation still 3.2M of the 3.69M triangles in the scene. These
  // numbers are what the second pass needed: a tenth of the plants, and a
  // LOD distance short enough (about a hex and a half) that nearly
  // everything past the mech you are looking at is a billboard, which is
  // one draw call per region instead of thousands of triangles.
  //
  // Aggressive on purpose. A thinner meadow is a cosmetic loss; a board
  // that runs at 4 fps is not a screen anyone can use.
  vegetationDensity: 0.1,
  carpetCards: 60000,
  lodDistanceScale: 0.15,
  reason: 'dispositivo limitado',
}

let cached: DeviceProfile | null = null

export function deviceProfile(): DeviceProfile {
  if (cached) return cached
  if (typeof window === 'undefined') {
    cached = DESKTOP
    return cached
  }

  const nav = navigator as Navigator & { deviceMemory?: number }
  const memory = nav.deviceMemory
  const cores = nav.hardwareConcurrency
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false

  const reasons: string[] = []
  if (coarse) reasons.push('puntero táctil')
  if (memory != null && memory <= 4) reasons.push(`${memory} GB de RAM`)
  if (cores != null && cores <= 4) reasons.push(`${cores} núcleos`)

  cached = reasons.length > 0
    ? { ...CONSTRAINED, reason: reasons.join(', ') }
    : DESKTOP
  return cached
}

/** Forces a profile — the `?calidad=alta` / `?calidad=baja` escape hatch.
 *
 * Detection is a guess, and a guess that cannot be overridden is a trap:
 * this is what lets a phone that copes fine ask for the full picture, and
 * (more usefully) what lets a desktop reproduce the mobile path without a
 * phone in hand. */
export function applyQualityOverride(search: string): void {
  const value = new URLSearchParams(search).get('calidad')
  if (value === 'alta') cached = { ...DESKTOP, reason: 'forzado a alta' }
  else if (value === 'baja') cached = { ...CONSTRAINED, reason: 'forzado a baja' }
}
