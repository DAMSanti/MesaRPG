import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { resolveDieStyle, type DieMarkingKind, type DieTextureSet } from '../dieStyles'
import { GROUND_BASE_HEIGHT, HEX_SIZE } from '../hexMath'
import { DynamicLight } from './DynamicLight'

// Real user request: "los dados deben tener los lados y los vertices
// ligeramente redondeados" — a real d6's edges/corners are never
// knife-sharp. RoundedBoxGeometry still extends THREE.BoxGeometry (same
// 6-group/materialIndex layout, [+x,-x,+y,-y,+z,-z]), so the existing
// per-face pip/texture materials array below still applies exactly the
// same way — the rounded bevel itself samples from whichever face's
// material it's nearest to, no separate edge material needed, which is
// also the other half of that request ("deben tener el mismo
// color/textura que el dado en si"). Modest radius/segment count —
// "ligeramente", not a soap-bar look.
// Real user report: "desde que hemos hecho esto del tamaño real no veo
// los dados" — this file was DELIBERATELY left alone during the scale
// normalization (dice were treated as a stylized tabletop-prop
// abstraction, never meant to represent real-world size). That reasoning
// missed one thing: the TableView camera itself moved HEX_SIZE times
// farther back to frame the now-real-scale board, so a die that stayed
// at its old absolute size shrank to the same fraction on screen — not
// a rendering bug, just correct perspective math applied to a size that
// never moved. Scaling by HEX_SIZE restores the exact same on-screen
// presence the dice always had, same as scaling the camera position did
// for everything else.
const DIE_SIZE = 0.9 * HEX_SIZE
const DIE_CORNER_RADIUS = 0.07 * HEX_SIZE

// Real user request: "quiero texturizar los dados de verdad... dados
// metalicos con textura... mapa metalico, roughness y glossiness,
// normales, ambient occlusion, mascara de oxido" — real scanned PBR
// texture sets (see public/textures/CREDITS.md for source/license),
// downscaled to 512px, one set per 'metallic' DieTextureSet. 'chrome' is
// clean polished steel; 'rust' is the SAME kind of map set but scanned
// off genuinely oxidized metal — its own color/roughness photograph
// already IS the "mascara de oxido" ask, real weathering baked in by the
// original photogrammetry rather than a hand-painted mask layer added on
// top of a clean material.
const DIE_TEXTURE_URLS: Record<DieTextureSet, { map: string; normalMap: string; roughnessMap: string; metalnessMap: string }> = {
  chrome: {
    map: '/textures/dice/dice-chrome-color.jpg',
    normalMap: '/textures/dice/dice-chrome-normal.jpg',
    roughnessMap: '/textures/dice/dice-chrome-roughness.jpg',
    metalnessMap: '/textures/dice/dice-chrome-metalness.jpg',
  },
  rust: {
    map: '/textures/dice/dice-rust-color.jpg',
    normalMap: '/textures/dice/dice-rust-normal.jpg',
    roughnessMap: '/textures/dice/dice-rust-roughness.jpg',
    metalnessMap: '/textures/dice/dice-rust-metalness.jpg',
  },
}

// Pip layout per face value, on a 3x3 grid (-1, 0, 1 in each axis).
const PIP_LAYOUTS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
}

// Shared by the plain per-face texture path AND the atlas path below (a
// 'glass' die's own single material needs all 6 faces at this same cell
// size to tile evenly into buildFaceAtlasTexture's grid).
const FACE_TEXTURE_SIZE = 256

function createFaceCanvas(
  pips: number, faceColor: string, marking: DieMarkingKind = 'pips',
  /** Real user request: "quiero texturizar los dados de verdad" — a
   * metallic style's face is the real scanned photo (see
   * DIE_TEXTURE_SETS) drawn as this canvas's own background instead of a
   * flat fill, so the pips/numbers painted on top sit on genuine texture
   * rather than a solid color standing in for one. Cropped to a centered
   * square first (the source photos are already square, but this stays
   * correct if that ever isn't true) so it isn't stretched. */
  background?: CanvasImageSource | null,
): HTMLCanvasElement {
  const size = FACE_TEXTURE_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  if (background) {
    ctx.drawImage(background, 0, 0, size, size)
    // A dark inking pass under the pips/numbers only, not the whole
    // face — real photo texture stays visible everywhere else, but a
    // pip drawn directly onto bare metal/rust photo is nearly
    // unreadable at this resolution without SOME contrast boost.
    ctx.fillStyle = 'rgba(10, 10, 10, 0.35)'
    ctx.fillRect(0, 0, size, size)
  } else {
    ctx.fillStyle = faceColor
    ctx.fillRect(0, 0, size, size)
  }
  // Real user request: "no deben tener lineas en los lados" — the old
  // per-face border rect read as a visible seam/frame on every face,
  // especially once RoundedBoxGeometry's rounded edges made the actual
  // face boundary itself soft — a real die's faces are just flat inset
  // markings, no painted border.

  ctx.fillStyle = background ? '#eef1ef' : '#1c2422'
  if (marking === 'numbers') {
    // A numbered die style (real user request: "con numeros") — same
    // face-background/border as the pip style, just the big numeral
    // drawn centered instead of the dot pattern below.
    ctx.font = `bold ${size * 0.56}px 'Cascadia Mono', Consolas, ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(pips), size / 2, size / 2 + size * 0.02)
  } else {
    const radius = size * 0.09
    const step = size * 0.27
    const center = size / 2
    for (const [gx, gy] of PIP_LAYOUTS[pips]) {
      ctx.beginPath()
      ctx.arc(center + gx * step, center + gy * step, radius, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  return canvas
}

function createFaceTexture(
  pips: number, faceColor: string, marking: DieMarkingKind = 'pips',
  background?: CanvasImageSource | null,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(createFaceCanvas(pips, faceColor, marking, background))
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Real user request: "vetas de otro color/textura intravenado" — a
 * marbled canvas (soft radial base glow + several blurred, randomly
 * curved translucent streaks in a second accent color) standing in for
 * a real pearl/opal's internal veining, used as createFaceTexture's own
 * `background` param so the pips get painted directly on top of it —
 * paired with dieStyles.ts's own transmission/attenuationColor pair
 * (the actual "reads as subsurface scattering" half of this). Generated
 * once per die (materials useMemo), reused for all 6 faces — real
 * pearls don't look dramatically different side to side either. */
function createPearlVeinTexture(baseColorHex: string, veinColorHex: string): HTMLCanvasElement {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  const base = new THREE.Color(baseColorHex)
  const grad = ctx.createRadialGradient(size * 0.4, size * 0.35, size * 0.04, size * 0.5, size * 0.5, size * 0.75)
  grad.addColorStop(0, `#${base.clone().offsetHSL(0, 0, 0.08).getHexString()}`)
  grad.addColorStop(1, `#${base.clone().offsetHSL(0, 0, -0.05).getHexString()}`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)

  ctx.strokeStyle = veinColorHex
  ctx.lineCap = 'round'
  ctx.filter = 'blur(3px)'
  for (let i = 0; i < 5; i++) {
    ctx.globalAlpha = 0.22 + Math.random() * 0.25
    ctx.lineWidth = 4 + Math.random() * 10
    let x = Math.random() * size
    let y = Math.random() * size
    ctx.beginPath()
    ctx.moveTo(x, y)
    const segments = 3 + Math.floor(Math.random() * 2)
    for (let s = 0; s < segments; s++) {
      const cx1 = x + (Math.random() - 0.5) * size * 0.6
      const cy1 = y + (Math.random() - 0.5) * size * 0.6
      const nx = Math.random() * size
      const ny = Math.random() * size
      ctx.quadraticCurveTo(cx1, cy1, nx, ny)
      x = nx
      y = ny
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  return canvas
}

// BoxGeometry material order is [+x, -x, +y, -y, +z, -z].
// Opposite faces of a real d6 sum to 7: this ordering keeps that true.
const FACE_PIPS = [1, 6, 2, 5, 3, 4]

// Real user demand, after an opacity-only "translucent" fallback was
// rejected outright ("una puta mierda... o solucionas lo del
// transmision"): MeshPhysicalMaterial's `transmission` (true refraction)
// is a real, working three.js feature — the actual bug (confirmed via
// three.js's own documented limitation) is that it doesn't reliably
// render on a mesh whose `material` is an ARRAY, which every OTHER style
// here needs (one material per face, so each face shows its own real
// pip/number). Rather than fake translucency again, a 'glass' die instead
// gets ONE material for the whole mesh, with all 6 faces' numbers baked
// into a single shared atlas texture — this sidesteps the real limitation
// instead of working around the symptom. 3x2 grid, matching FACE_PIPS'
// own 6-entry order 1:1 (cell i holds FACE_PIPS[i]'s face).
const ATLAS_COLS = 3
const ATLAS_ROWS = 2

function buildFaceAtlasTexture(faceCanvases: HTMLCanvasElement[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_TEXTURE_SIZE * ATLAS_COLS
  canvas.height = FACE_TEXTURE_SIZE * ATLAS_ROWS
  const ctx = canvas.getContext('2d')!
  faceCanvases.forEach((faceCanvas, i) => {
    const col = i % ATLAS_COLS
    const row = Math.floor(i / ATLAS_COLS)
    ctx.drawImage(faceCanvas, col * FACE_TEXTURE_SIZE, row * FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Remaps each of a (non-indexed — RoundedBoxGeometry's own toNonIndexed()
 * internals, confirmed by reading its source) geometry's 6 per-face
 * `groups` (materialIndex 0..5, the same [+x,-x,+y,-y,+z,-z] order
 * FACE_PIPS/buildFaceAtlasTexture both use) from their own local [0,1] UV
 * range into that face's cell of the atlas built above. Since the
 * geometry is non-indexed, `group.start`/`group.count` address the uv
 * attribute's entries directly (one vertex per index slot already — no
 * separate index buffer to resolve through). The v-axis flip
 * (ATLAS_ROWS-1-row) matches CanvasTexture's default flipY sampling, so
 * the remapped UVs land on the exact cell each face's image was actually
 * drawn into by buildFaceAtlasTexture, not its vertical mirror.
 * Mutates a geometry the caller already owns exclusively — see Die's own
 * per-die `geometry` useMemo, which only ever calls this on a fresh
 * clone, never the shared base RoundedBoxGeometry. */
function remapUvsToAtlas(geometry: THREE.BufferGeometry) {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
  for (const group of geometry.groups) {
    const materialIndex = group.materialIndex ?? 0
    const col = materialIndex % ATLAS_COLS
    const row = Math.floor(materialIndex / ATLAS_COLS)
    for (let i = group.start; i < group.start + group.count; i++) {
      const u0 = uv.getX(i)
      const v0 = uv.getY(i)
      uv.setXY(i, (col + u0) / ATLAS_COLS, (ATLAS_ROWS - 1 - row + v0) / ATLAS_ROWS)
    }
  }
  uv.needsUpdate = true
}

// Local (pre-rotation) outward normal of the face carrying each pip
// value — matches FACE_PIPS/BoxGeometry's own [+x,-x,+y,-y,+z,-z] order.
// Used to read back which face physics actually landed face-up (see
// valueFromRotation below) — the die is the real source of the result
// now, not the other way around ("vamos a hacer que los dados sean el
// valor real").
const FACE_LOCAL_NORMALS: [number, THREE.Vector3][] = [
  [1, new THREE.Vector3(1, 0, 0)],
  [6, new THREE.Vector3(-1, 0, 0)],
  [2, new THREE.Vector3(0, 1, 0)],
  [5, new THREE.Vector3(0, -1, 0)],
  [3, new THREE.Vector3(0, 0, 1)],
  [4, new THREE.Vector3(0, 0, -1)],
]

const WORLD_UP = new THREE.Vector3(0, 1, 0)

/** Given the die's actual resting rotation, finds which face is
 * pointing up — whichever local face normal, once rotated, is closest
 * to world-up. */
function valueFromRotation(quat: THREE.Quaternion): number {
  let best = 1
  let bestDot = -Infinity
  for (const [value, normal] of FACE_LOCAL_NORMALS) {
    const dot = normal.clone().applyQuaternion(quat).dot(WORLD_UP)
    if (dot > bestDot) {
      bestDot = dot
      best = value
    }
  }
  return best
}

// Real user request: "dados traslucidos que generen causticas sobre la
// grid cuando les de la luz" — true real-time caustics (actually tracing
// refracted light) are expensive enough that even AAA games fake them;
// the standard trick (confirmed the right call for this app too) is an
// animated light-pattern texture projected as a soft decal under the
// glass object, which is exactly what DieCausticsProjector below does.
// Built once and cached, same pattern as AttackEffects.tsx's
// getGlowTexture / HexMap.tsx's getCloudTexture — several overlapping
// soft-edged distorted rings (light focused/defocused by an uneven
// surface, the actual visual signature of a caustic pattern) rather than
// plain circular blobs, which would just read as a glow, not refracted
// light.
let causticsTextureCache: THREE.Texture | null = null
function getCausticsTexture(): THREE.Texture {
  if (causticsTextureCache) return causticsTextureCache
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const rings = [
    { x: 0.5, y: 0.5, r: 0.4, w: 0.1 },
    { x: 0.32, y: 0.4, r: 0.22, w: 0.07 },
    { x: 0.68, y: 0.36, r: 0.26, w: 0.08 },
    { x: 0.42, y: 0.66, r: 0.2, w: 0.06 },
    { x: 0.66, y: 0.62, r: 0.24, w: 0.07 },
    { x: 0.5, y: 0.28, r: 0.14, w: 0.05 },
  ]
  for (const ring of rings) {
    const cx = ring.x * size, cy = ring.y * size, r = ring.r * size, w = ring.w * size
    const grad = ctx.createRadialGradient(cx, cy, Math.max(0, r - w), cx, cy, r + w)
    grad.addColorStop(0, 'rgba(255,255,255,0)')
    grad.addColorStop(0.5, 'rgba(255,255,255,0.8)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(cx, cy, r + w, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  causticsTextureCache = texture
  return texture
}

const CAUSTICS_SIZE = 1.3 * HEX_SIZE
// How high above the ground a die can be and still show a (fading)
// caustic pattern — real light-through-glass caustics only sharpen once
// something is close to the surface catching them, so this fades out
// while the die is still tumbling through the air, not just at rest.
const CAUSTICS_FADE_HEIGHT = 0.6 * HEX_SIZE

/** Follows `bodyRef`'s own live X/Z every frame (a plain sibling of the
 * RigidBody, not a child of it — a caustic pattern lives flat on the
 * table regardless of how the die itself is tumbling/rotating) and fades
 * in as the die gets close to the ground. Only ever rendered for a
 * 'glass' style die (see Die's own return) — real user request, see this
 * file's own getCausticsTexture doc comment for the "why a projected
 * texture, not real refraction" reasoning. */
function DieCausticsProjector({ bodyRef, color }: { bodyRef: RefObject<RapierRigidBody | null>; color: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const materialRef = useRef<THREE.MeshBasicMaterial>(null)
  const texture = useMemo(() => getCausticsTexture(), [])

  useFrame((_, delta) => {
    const body = bodyRef.current
    const group = groupRef.current
    const mat = materialRef.current
    if (!body || !group || !mat) return
    const t = body.translation()
    // 0.46 tracks DIE_SIZE's own half-height (was 0.45 against the old
    // 0.9 — a hair over so the projector sits just under the die's own
    // center, not exactly at it) — scaled the same HEX_SIZE way DIE_SIZE
    // itself was. The ground-level offset uses GROUND_BASE_HEIGHT (was a
    // stale bare 0.3 — the same duplicated-old-value bug fixed everywhere
    // else in the rescale, just missed here since this file was
    // otherwise left alone).
    group.position.set(t.x, t.y - 0.46 * HEX_SIZE, t.z)
    const heightAboveGround = Math.max(0, t.y - GROUND_BASE_HEIGHT)
    mat.opacity = 0.5 * Math.max(0, 1 - heightAboveGround / CAUSTICS_FADE_HEIGHT)
    // Slow independent drift on each axis so the pattern visibly
    // shimmers instead of sitting static — real caustics never hold
    // still, the refracting surface is never perfectly stationary either.
    texture.offset.x = (texture.offset.x + delta * 0.05) % 1
    texture.offset.y = (texture.offset.y + delta * 0.035) % 1
  })

  return (
    <group ref={groupRef}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CAUSTICS_SIZE, CAUSTICS_SIZE]} />
        <meshBasicMaterial
          ref={materialRef} map={texture} color={color} transparent opacity={0}
          blending={THREE.AdditiveBlending} depthWrite={false}
        />
      </mesh>
    </group>
  )
}

interface DieProps {
  /** Changing this key is what triggers a fresh roll (see TableView). */
  rollId: number
  spawn: [number, number, number]
  /** Face background color — defaults to the plain white/grey TableView
   * has always used. The manual initiative-roll flow (GMView/PlayerView)
   * passes each pilot's own color instead. Pips stay dark regardless;
   * every color in src/pilotColors.ts's palette is light enough to keep
   * them readable. Ignored once `style` is set — a picked style's own
   * fixed color wins. */
  color?: string
  /** A DIE_STYLES id (see ../dieStyles.ts) — real user request: every
   * player/GM can pick a distinct look (material + pip-vs-number
   * marking), exclusive across the table. Coexists with `color` rather
   * than replacing it: unset (null/undefined) keeps today's exact
   * legacy look (plain box, pips, `color`), so a pilot who never
   * touches this feature sees zero change. */
  style?: string | null
  /** Initial linear velocity, e.g. a real toss thrown in from off the
   * board instead of a straight drop from above — see TableView's
   * InitiativeDice. Defaults to a small random pop-and-tumble in place
   * (the original generic-dice-tray behavior). */
  throwVelocity?: [number, number, number]
  /** Fires once, the first time this die's physics body actually comes
   * to rest, with whichever face real physics landed face-up. This is
   * the real result now; nothing corrects it afterward. */
  onSettled?: (value: number) => void
  /** Set true to start shrinking/fading the die out — see TableView's
   * InitiativeDice, which flips this 5s after both dice have settled.
   * Purely visual, driven every frame from the outside rather than an
   * internal timer, so multiple dice vanish in lockstep. */
  vanishing?: boolean
  /** Fires once the vanish animation finishes (scale/opacity reach 0) —
   * the caller's cue to actually unmount this Die. */
  onVanished?: () => void
}

// How long the shrink-and-fade takes once `vanishing` flips true.
const VANISH_DURATION_MS = 550

// @react-three/rapier's RigidBody has no onSleep/onWake callback prop in
// this version — the underlying rapier body does expose isSleeping(),
// so this polls it every frame instead. Rapier only actually puts a
// body to sleep once its velocity stays under a threshold for several
// consecutive frames — resting on hex terrain (angled tile edges,
// height steps between neighboring tiles) can leave a die gently
// rocking indefinitely and never technically qualify, so there's also a
// flat timeout backstop: read whatever face is up and settle anyway if
// real sleep hasn't happened by then, so a roll can never hang forever
// waiting for perfect physical stillness.
const SETTLE_TIMEOUT_MS = 3500

export function Die({ spawn, color = '#eef1ef', style, throwVelocity, onSettled, vanishing, onVanished }: DieProps) {
  const bodyRef = useRef<RapierRigidBody>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const settledRef = useRef(false)
  const mountTimeRef = useRef(Date.now())
  const vanishStartRef = useRef<number | null>(null)
  const vanishedRef = useRef(false)
  // Real user report: a settled die would still sometimes visibly
  // "teleport" to a fixed spot mid-table, even after locking its
  // translation/rotation directly on the rapier body (settleNow below) —
  // a locked DYNAMIC body can still apparently get relocated by contact
  // resolution against a KINEMATIC one (HexMap's UnitMarker re-asserts
  // its own position via setNextKinematicTranslation every single frame,
  // moving or not — see its own doc comment). Switching the body's TYPE
  // to "fixed" once it settles is the actual bulletproof guarantee — a
  // fixed body is immovable by the solver, period, not just "locked".
  // Driven through this state (not an imperative rapier call) so
  // @react-three/rapier's own reactive `type` prop handling — confirmed
  // in its source to call the real setBodyType on change — does the work,
  // rather than fighting the wrapper's own prop-driven state tracking.
  const [settled, setSettled] = useState(false)

  const roundedGeometry = useMemo(
    () => new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 4, DIE_CORNER_RADIUS),
    [],
  )

  // Always loaded (drei's useTexture cache is global/keyed by URL, so
  // every OTHER die sharing a style pays for this exactly once) rather
  // than conditionally per style — hooks can't be called conditionally,
  // and this is the only way to have the real image data ready by the
  // time the `materials` useMemo below runs synchronously.
  const chromeTextures = useTexture(DIE_TEXTURE_URLS.chrome)
  const rustTextures = useTexture(DIE_TEXTURE_URLS.rust)

  const look = useMemo(() => resolveDieStyle(style, color), [style, color])

  // MeshPhysicalMaterial rather than MeshStandardMaterial — a strict
  // superset (same roughness/metalness/map), so the no-style path (both
  // iridescence/sheen left at 0) renders pixel-identical to before,
  // while a 'metallic'/'pearl'/'glass' style can lean on the extra
  // properties with no second material-construction code path to
  // maintain. 'metallic' now uses a real scanned PBR set (see
  // DIE_TEXTURE_URLS/dieStyles.ts's own doc comments) — normal/
  // roughness/metalness maps applied directly (real surface detail +
  // varying glossiness + oxidation, not a flat metalness scalar), and
  // the per-face color texture draws that same photo as its background
  // instead of a flat fill (createFaceTexture's own `background` param).
  // 'glass' needs its own UV-remapped clone (see remapUvsToAtlas's own
  // doc comment) — every other style keeps the plain shared geometry
  // untouched, so switching a die's own style at runtime never leaves it
  // stuck with stale atlas UVs.
  const geometry = useMemo(() => {
    if (!look.transmission) return roundedGeometry
    const atlasGeometry = roundedGeometry.clone()
    remapUvsToAtlas(atlasGeometry)
    return atlasGeometry
  }, [roundedGeometry, look.transmission])

  const materials = useMemo(() => {
    // 'glass': a real refractive material CANNOT be one of a
    // per-face array (see dieStyles.ts's own doc comment on this style) —
    // a single MeshPhysicalMaterial reading the atlas texture built from
    // all 6 faces' own numbers, paired with the atlas-remapped geometry
    // above, instead of joining the per-face branch below.
    if (look.transmission) {
      const atlasTexture = buildFaceAtlasTexture(FACE_PIPS.map((pips) => createFaceCanvas(pips, look.color, look.marking)))
      return new THREE.MeshPhysicalMaterial({
        map: atlasTexture,
        roughness: look.roughness,
        metalness: look.metalness,
        envMapIntensity: look.envMapIntensity ?? 1,
        ior: look.ior ?? 1.5,
        transmission: look.transmission,
        thickness: look.thickness ?? 0.5,
        attenuationColor: look.attenuationColorHex ? new THREE.Color(look.attenuationColorHex) : undefined,
        attenuationDistance: look.attenuationDistance ?? Infinity,
        transparent: true,
      })
    }
    const textureSet = look.textureSet ? (look.textureSet === 'chrome' ? chromeTextures : rustTextures) : null
    if (textureSet) {
      // Normal/roughness/metalness are DATA, not color — must never be
      // sRGB-decoded (that would wash out/skew their actual values). The
      // shared cached texture objects only need this set once, but
      // setting it again here is harmless (same object every time).
      textureSet.normalMap.colorSpace = THREE.NoColorSpace
      textureSet.roughnessMap.colorSpace = THREE.NoColorSpace
      textureSet.metalnessMap.colorSpace = THREE.NoColorSpace
    }
    // Real user request: "vetas de otro color/textura intravenado" — a
    // pearl style gets its own procedural marbled-vein canvas (synchronous,
    // unlike the metal photos which need a real loaded Image) as
    // createFaceTexture's background, same slot the metal texture uses.
    // Reused below as the emissiveMap too — its own brighter vein
    // streaks are what make THOSE areas glow more than the plain base
    // tint around them, real user request: "subsurface scattering para
    // los dados perlados... con vetas de otro color/textura intravenado".
    const veinCanvas = look.veinColorHex ? createPearlVeinTexture(look.color, look.veinColorHex) : null
    // One shared texture (not per-face like `map`) — the glow doesn't
    // need its own pip cut into it, just the vein pattern underneath.
    const veinEmissiveTexture = veinCanvas ? new THREE.CanvasTexture(veinCanvas) : null
    if (veinEmissiveTexture) veinEmissiveTexture.colorSpace = THREE.SRGBColorSpace
    return FACE_PIPS.map(
      (pips) =>
        new THREE.MeshPhysicalMaterial({
          map: createFaceTexture(
            pips, look.color, look.marking,
            veinCanvas ?? (textureSet?.map.image as CanvasImageSource | undefined) ?? null,
          ),
          normalMap: textureSet?.normalMap,
          roughnessMap: textureSet?.roughnessMap,
          metalnessMap: textureSet?.metalnessMap,
          roughness: look.roughness,
          metalness: look.metalness,
          iridescence: look.iridescence ?? 0,
          iridescenceIOR: look.iridescence ? 1.3 : 1,
          sheen: look.sheen ?? 0,
          sheenColor: look.sheenColorHex ? new THREE.Color(look.sheenColorHex) : undefined,
          clearcoat: look.clearcoat ?? 0,
          clearcoatRoughness: look.clearcoatRoughness ?? 0,
          // Real user follow-up: "los dados de jade se ven muy
          // oscuros" — a metal's real reflection leans on the scene's
          // environment map far more than plain diffuse shading does,
          // so a style that actually uses one gets a real boost here
          // (dieStyles.ts's own per-material values) instead of the
          // THREE default of 1.
          envMapIntensity: look.envMapIntensity ?? 1,
          ior: look.ior ?? 1.5,
          // 'pearl' only reaches this branch with opacity < 1 — a real
          // pearl is mostly opaque, so this plus its own emissive glow
          // (dieStyles.ts's own glowColorHex/glowIntensity) is what reads
          // as "light gathering in the veins" (see dieStyles.ts's own doc
          // comment). 'glass' no longer goes through this per-face array
          // branch at all — see the `look.transmission` branch above.
          opacity: look.opacity ?? 1,
          emissive: look.glowColorHex ? new THREE.Color(look.glowColorHex) : undefined,
          emissiveIntensity: look.glowIntensity ?? 0,
          emissiveMap: veinEmissiveTexture ?? undefined,
          transparent: true,
        }),
    )
  }, [look, chromeTextures, rustTextures])

  const settleNow = () => {
    if (settledRef.current) return
    settledRef.current = true
    const body = bodyRef.current
    if (!body) return
    setSettled(true)
    if (!onSettled) return
    const r = body.rotation()
    onSettled(valueFromRotation(new THREE.Quaternion(r.x, r.y, r.z, r.w)))
  }

  // Polls isSleeping() every frame rather than relying on an event (this
  // version of @react-three/rapier's RigidBody has no onSleep/onWake
  // callback prop). The elapsed-time fallback lives in the same poll
  // (not a separate setTimeout) so it can't be silently cancelled by an
  // unrelated remount clearing a timer early.
  useFrame(() => {
    if (!settledRef.current && onSettled) {
      const asleep = bodyRef.current?.isSleeping()
      const elapsed = Date.now() - mountTimeRef.current
      if (asleep || elapsed > SETTLE_TIMEOUT_MS) settleNow()
    }

    if (!vanishing || vanishedRef.current) return
    if (vanishStartRef.current == null) {
      vanishStartRef.current = Date.now()
    }
    const t = Math.min(1, (Date.now() - vanishStartRef.current) / VANISH_DURATION_MS)
    const scale = 1 - t
    meshRef.current?.scale.setScalar(scale)
    // `materials` is a single material for 'glass' (real transmission
    // needs the whole mesh on one material, see the useMemo above) but an
    // array of 6 for every other style — normalize before looping.
    for (const m of Array.isArray(materials) ? materials : [materials]) m.opacity = scale
    if (t >= 1) {
      vanishedRef.current = true
      onVanished?.()
    }
  })

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    if (throwVelocity) {
      // A real toss: set velocity directly (not an impulse) so it flies
      // in at a consistent, controllable speed regardless of the die's
      // mass, plus spin so it visibly tumbles as it crosses the board.
      body.setLinvel({ x: throwVelocity[0], y: throwVelocity[1], z: throwVelocity[2] }, true)
      body.setAngvel(
        { x: (Math.random() - 0.5) * 18, y: (Math.random() - 0.5) * 18, z: (Math.random() - 0.5) * 18 },
        true,
      )
    } else {
      // Random-ish pop-and-tumble in place — the original generic dice
      // tray behavior, cosmetic only.
      body.applyImpulse(
        { x: (Math.random() - 0.5) * 3, y: 1.5, z: (Math.random() - 0.5) * 3 },
        true,
      )
      body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 4,
          y: (Math.random() - 0.5) * 4,
          z: (Math.random() - 0.5) * 4,
        },
        true,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <RigidBody
        ref={bodyRef}
        position={spawn}
        type={settled ? 'fixed' : undefined}
        colliders="cuboid"
        restitution={0.3}
        friction={0.6}
      >
        <mesh ref={meshRef} castShadow material={materials} geometry={geometry}>
          {/* Real user request: "los dados de cristal quiero que tengan
              una pequeña luz que no castee sombras en el centro" — a
              child of the die's own mesh, not a separate tracked object,
              so it rides along with every tumble/bounce for free (same
              transform Rapier already drives via `meshRef`). Non-shadow-
              casting (DynamicLight's own default) — a shadow-casting
              light bouncing/spinning with the die would be a much
              stranger effect than the subtle internal sparkle asked
              for, on top of the real render cost of a shadow map that
              has to keep re-rendering every frame the die moves. */}
          {/* Real user report: "no se ve la luz" — three.js's default
              lighting is physically-correct (candela units, real
              inverse-square falloff), so a point light's actual
              contribution at distance d is roughly intensity/d². At the
              die's own surface (d≈DIE_SIZE/2≈13-14 units), intensity=2
              works out to ~0.01 — completely imperceptible next to the
              scene's own ambient/directional light. 600 puts a
              genuinely visible ~3 contribution at that same distance. */}
          {look.transmission ? (
            <DynamicLight position={[0, 0, 0]} color={look.color} intensity={600} distance={DIE_SIZE * 4} />
          ) : null}
        </mesh>
      </RigidBody>
      {/* A sibling of the RigidBody, not a child of it — a caustic
          pattern lives flat on the table regardless of how the die
          itself tumbles, see DieCausticsProjector's own doc comment.
          Genuinely translucent styles only (glass, real transmission) —
          not pearl (opacity 0.95, barely translucent by design, see
          resolveDieStyle's own doc comment on why it leans on the
          emissive glow instead of seeing-through) or the fully-opaque
          standard/metal styles. */}
      {((look.opacity ?? 1) < 0.9 || (look.transmission ?? 0) > 0) && (
        <DieCausticsProjector bodyRef={bodyRef} color={look.color} />
      )}
    </>
  )
}
