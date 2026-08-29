import { useEffect, useMemo, useRef, useState } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { HEX_SIZE } from '../hexMath'
import { MODEL_SCALE } from './Mech3D'
import { LIGHT_IMPACT, LIGHT_MUZZLE, LIGHT_TRAVEL, setPoolLight } from './LightPool'
import { useProfiledFrame } from './PerfProbe'

// Real user request: "cuando los mechs disparen un láser... producirán
// un destello rojo que iluminará lo que tenga alrededor, sobretodo a
// oscuras" — real point lights, not just emissive
// sprites that only light themselves. Distance kept generous (a few hex
// widths) so a flash in the dark actually reaches the mechs standing
// around it, not just its own few-meter footprint. castShadow stays off
// even for these — confirmed with the user that BattleTech's own turn
// order means at most one shot's VFX is ever live at a time, so cost
// isn't the concern; a shadow-casting muzzle flash just didn't read as
// better than a plain one for something this brief.
//
// The lights themselves come from LightPool.tsx's fixed pool rather
// than being mounted per effect: mounting one changes the scene's light
// COUNT, which recompiles every shader in the scene. See that file for
// the measurements — it is the whole reason a missile volley used to
// flatten the frame rate.
const ATTACK_LIGHT_DISTANCE = HEX_SIZE * 4
// Real user report (on Die.tsx's own glass-die light, same root cause
// here): three.js's default lighting is physically-correct (candela
// units, real inverse-square falloff) — a plain intensity of 4-6 works
// out to a barely-there contribution of ~0.01 at even a modest 20-unit
// distance, invisible next to the scene's own ambient/directional
// light. This multiplier bumps every intensity below into the hundreds/
// low-thousands range so each flash is actually visible at mech-scale
// distances, without hand-tuning every call site's raw number.
const ATTACK_LIGHT_INTENSITY_SCALE = 250

// MECH-factor multiplier — this file's beam/tracer/missile/glow sizes were
// all originally tuned by eye against the mech (MODEL_SCALE), not the hex
// grid, same family as HexMap.tsx's own FOG_HEIGHT.
const MECH_FACTOR = MODEL_SCALE / 1.65

/** Which visual treatment a weapon gets, classified from its own catalog
 * name (app/weapons.py's WEAPON_CATALOG) — kept as simple substring
 * matching here rather than a new backend field, since this is purely
 * cosmetic and the catalog's naming is already consistent enough to
 * bucket reliably (every energy weapon says "Laser" or "PPC", every
 * missile rack says "SRM"/"LRM"/"MRM"/"ATM"/"MML"/"Rocket Launcher",
 * every autocannon/Gauss variant reads fine as a fast ballistic tracer,
 * the safe default for anything this doesn't otherwise recognize). */
export type AttackEffectCategory =
  | 'beam' | 'pulse' | 'ppc' | 'tracer'
  | 'missileArc' | 'missileDirect' | 'rocket'
  | 'mg' | 'flame'

export function weaponEffectCategory(weaponName: string): AttackEffectCategory {
  const n = weaponName.toLowerCase()
  if (n.includes('flamer')) return 'flame'
  if (n.includes('machine gun')) return 'mg'
  if (n.includes('ppc')) return 'ppc'
  // Pulse lasers before plain ones: every pulse weapon also says "laser",
  // and the pulse IS the difference the name is pointing at -- a burst of
  // short shots rather than one held beam.
  if (n.includes('pulse') && n.includes('laser')) return 'pulse'
  if (n.includes('laser')) return 'beam'
  // Three different missiles, because they are three different weapons
  // once you watch them fly (real user spec, picking the models himself
  // out of the pack):
  //   LRM  — indirect fire. "Salva que sube y cae sobre el blanco, siempre
  //          se ven volar un buen rato."
  //   SRM/MRM/ATM/MML — "Trayectoria plana y rápida a corta distancia."
  //   Rocket Launcher — an unguided one-shot swarm, wider and messier.
  if (n.includes('rocket launcher')) return 'rocket'
  if (n.includes('lrm')) return 'missileArc'
  if (
    n.includes('srm') || n.includes('mrm') || n.includes('atm') || n.includes('mml')
  ) return 'missileDirect'
  return 'tracer'
}

// Per-category color — standard BattleTech convention where one exists
// (IS lasers ruby red, PPCs electric blue), a warm muzzle-flash tone for
// the rest rather than trying to fake a literal tracer color.
const CATEGORY_COLOR: Record<AttackEffectCategory, string> = {
  beam: '#ff3b3b',
  pulse: '#ff3b3b',
  ppc: '#3bb2ff',
  tracer: '#ffb020',
  missileArc: '#ff8a3b',
  missileDirect: '#ff8a3b',
  rocket: '#ff7a2f',
  mg: '#ffd23b',
  flame: '#ff6a1f',
}

/** Laser timing, in milliseconds.
 *
 * Real user spec: "en el canon se generara una esfera de energia que cuando
 * llegue a un tamano, disparara un laser, algo mas lento que ahora. En el
 * caso de continuo, durara un segundo y poco el laser sobre el objetivo, en
 * caso de laser de pulsos, hara 4 o 5 repeticiones de todo, esfera creciendo
 * y pum! laser."
 *
 * So a laser is two phases, not one snap: a charge that visibly builds at the
 * muzzle, then the beam. The pulse variant is the SAME two phases repeated,
 * each one much shorter -- which is what a pulse laser physically is, and why
 * it gets the same component with different numbers rather than an animation
 * of its own. */
const LASER_CHARGE_MS = 430
const LASER_BEAM_MS = 1150
const LASER_FADE_MS = 260
const PULSE_COUNT = 5
// A pulse cycle is short, but not as short as it physically "should" be:
// at 200ms the five shots blurred into one flicker and the charge-and-fire
// shape stopped being readable at all (real user report: "el pulse laser es
// muy rapido"). At 320ms each pulse is legibly its own little swell and
// release, which is the point of giving pulse lasers their own treatment.
const PULSE_CHARGE_MS = 150
const PULSE_BEAM_MS = 170

// Total lifetime (travel + impact + fade) before AttackEffect unmounts
// itself for a category with NO real travel distance (beam/pulse snap
// in instantly regardless of range — that's how BT lore treats a laser —
// flame is a short jet, not a projectile). tracer/missile/mg/ppc
// instead travel at a fixed real-world SPEED (see CATEGORY_SPEED below)
// so a long shot visibly takes proportionally longer to cross the board
// instead of covering the whole distance in the same fixed instant —
// this table's entries for those three categories are unused fallbacks
// only (kept in case a distance can't be computed).
const CATEGORY_DURATION_MS: Record<AttackEffectCategory, number> = {
  beam: LASER_CHARGE_MS + LASER_BEAM_MS + LASER_FADE_MS,
  pulse: PULSE_COUNT * (PULSE_CHARGE_MS + PULSE_BEAM_MS) + LASER_FADE_MS,
  // Unused fallback now that the PPC bolt travels at a real speed (see
  // CATEGORY_SPEED) — kept only for the case where a distance can't be
  // computed, same as the tracer/missile/mg entries below.
  ppc: 480,
  tracer: 900,
  missileArc: 1600,
  missileDirect: 1600,
  rocket: 1600,
  mg: 900,
  flame: 420,
}

interface MissileKind {
  url: string
  /** World units nose to tail. */
  length: number
  /** Peak lob height as a FRACTION OF THE SHOT'S OWN DISTANCE. Fixed world
   * units were the old bug here: 0.5 units of arc on a board where a mech
   * is ten units tall and a hex is thirty across is not an arc at all, so
   * every missile flew flat no matter the weapon. */
  arcFraction: number
  /** World units per second. */
  speed: number
  /** How far across the salvo spreads, in world units. */
  spread: number
  /** Cap on how many bodies fly at once, however big the rack is. */
  maxCount: number
}

const MISSILE_KINDS: Record<'arc' | 'direct' | 'rocket', MissileKind> = {
  // LRM — Object_34, the AGM-114 Hellfire body. Slow and high: this is the
  // one the user wants to see "volar un buen rato".
  arc: {
    url: '/models/missile-arc.glb',
    length: 0.42 * MECH_FACTOR,
    arcFraction: 0.26,
    speed: 2.5 * HEX_SIZE,
    spread: 1.1 * MECH_FACTOR,
    maxCount: 8,
  },
  // SRM/MRM/ATM/MML — Object_26. Flat and fast, over before you track it.
  direct: {
    url: '/models/missile-direct.glb',
    length: 0.5 * MECH_FACTOR,
    arcFraction: 0.035,
    speed: 6 * HEX_SIZE,
    spread: 0.7 * MECH_FACTOR,
    maxCount: 6,
  },
  // Rocket Launcher — Object_32. Unguided, so the widest spread of the
  // three and the loosest formation.
  rocket: {
    url: '/models/missile-rocket.glb',
    length: 0.38 * MECH_FACTOR,
    arcFraction: 0.09,
    speed: 5 * HEX_SIZE,
    spread: 1.6 * MECH_FACTOR,
    maxCount: 8,
  },
}

// World units/second — hex center-to-center spacing is √3 * HEX_SIZE (see
// hexMath.ts), so missile ≈ 0.4s/hex (a slow, clearly-trackable lob) and
// tracer/mg ≈ 0.15s/hex (fast but still visible, unlike the near-instant
// speed a short fixed duration implied for a many-hex shot before —
// that's what made a missile look like it vanished after "a few tiles"
// instead of visibly flying the whole way to the target). Values scale
// ×HEX_SIZE (not divided, unlike jumpFlight.ts's own per-world-unit
// rate) since these ARE the world-units/sec speed directly, and a hex
// now spans HEX_SIZE times more world units for the same real distance.
const CATEGORY_SPEED: Partial<Record<AttackEffectCategory, number>> = {
  tracer: 11 * HEX_SIZE,
  // One speed per missile type, and they are deliberately far apart: an
  // LRM salvo is meant to be watched arcing over, a short-range missile is
  // meant to be there before you've followed it.
  missileArc: MISSILE_KINDS.arc.speed,
  missileDirect: MISSILE_KINDS.direct.speed,
  rocket: MISSILE_KINDS.rocket.speed,
  // The PPC is the one energy weapon here that actually TRAVELS: what it
  // fires is a bolt of charged particles, so it has to be seen crossing
  // the board or it is just a blue laser. Slowed further on watching it
  // ("tienen que ser algo mas lentos en el travel time, sobretodo el
  // PPC") — 0,43s per hex now, slow enough to follow the bolt and read
  // the arc crackling around it rather than catch a streak.
  ppc: 4 * HEX_SIZE,
  mg: 13 * HEX_SIZE,
}
const MIN_TRAVEL_MS = 350
// Raised alongside the slower speeds above: at 2,5 hex/s a long LRM lob
// wants more than three seconds, and clamping it there put the salvo back
// at the pace it was just slowed down from.
const MAX_TRAVEL_MS = 4500
// How long the impact flash/fade lingers after a traveling projectile
// actually reaches its (real-hit or miss-offset) endpoint.
const IMPACT_TAIL_MS = 300

/** Cheap radial-gradient "glow" sprite, generated once and reused for
 * every muzzle flash / impact flash / missile head in the whole app —
 * same "bake a canvas texture instead of shipping an asset" approach
 * terrain.ts already uses for ground textures, just a soft round glow
 * instead of a tileable pattern. */
let glowTextureCache: THREE.Texture | null = null
export function getGlowTexture(): THREE.Texture {
  if (glowTextureCache) return glowTextureCache
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.4, 'rgba(255,255,255,0.7)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  glowTextureCache = tex
  return tex
}

/** A billboard glow quad, always facing the camera — its own opacity/
 * scale are driven by the caller via refs (see GlowSprite's own
 * forwardRef-free pattern: callers that need to animate it just grab
 * `matRef`/`meshRef` back out through the render-prop-free approach of
 * passing a ref callback). Kept intentionally dumb (static per mount);
 * effects that need it to fade/grow wrap it themselves via useFrame on
 * the refs below instead of pushing opacity through React state every
 * frame, same "useFrame drives refs, not setState" convention HexMap's
 * own UnitMarker already established for anything that changes every
 * single frame. */
function GlowSprite({
  meshRef, color, size,
}: { meshRef: React.RefObject<THREE.Mesh | null>; color: string; size: number }) {
  const camRef = useRef<THREE.Mesh>(null)
  useProfiledFrame('disparos', (state) => {
    if (meshRef.current) meshRef.current.quaternion.copy(state.camera.quaternion)
  })
  const texture = getGlowTexture()
  return (
    <mesh ref={(m) => { meshRef.current = m; camRef.current = m }}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial
        map={texture} color={color} transparent opacity={1}
        blending={THREE.AdditiveBlending} depthWrite={false}
      />
    </mesh>
  )
}

// PPC — real user spec: "el PPC, que sera un bolo de particulas con arco
// electrico". Cage strands are the filaments that leap ACROSS the bolt and
// make it crackle; tail strands are the ionised channel it drags behind.
const PPC_CAGE_STRANDS = 3
const PPC_TAIL_STRANDS = 2
const PPC_ARC_STRANDS = PPC_CAGE_STRANDS + PPC_TAIL_STRANDS
const PPC_ARC_SEGMENTS = 9
// How many times a second the arc's SHAPE is redrawn. Lightning reads as
// a series of held snapshots, not a smooth wiggle, so this stays well
// under the frame rate on purpose.
const PPC_ARC_HZ = 22
const PPC_PARTICLES = 56
const PPC_HEAD = 0.42 * MECH_FACTOR
const PPC_TAIL_LEN = 3.2 * MECH_FACTOR
/** How far above the ground the bolt is kept when the terrain would
 * otherwise swallow it. Roughly chest height on a mech, so a bolt clearing
 * a ridge still reads as a shot passing over it rather than skimming. */
const PPC_GROUND_CLEARANCE = 0.55 * MECH_FACTOR

const UP_AXIS = new THREE.Vector3(0, 1, 0)
const SIDE_AXIS = new THREE.Vector3(1, 0, 0)
const arcDir = new THREE.Vector3()
const arcU = new THREE.Vector3()
const arcV = new THREE.Vector3()
const flashWorld = new THREE.Vector3()
const ppcBolt = new THREE.Vector3()
const ppcA = new THREE.Vector3()
const ppcB = new THREE.Vector3()

/** Deterministic 0..1 from one number. The arc's jitter comes from this
 * rather than Math.random() so a filament's shape can be pinned to a
 * refresh index: regenerated every frame with real randomness it looks
 * like TV static, but regenerated every frame from a seed that only
 * changes PPC_ARC_HZ times a second it strobes like lightning while its
 * endpoints still follow the moving bolt smoothly. */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}

/** One jagged filament from `a` to `b`, written into a LineSegments
 * position array as `segments` back-to-back pairs, returning the next
 * write offset. The lateral wander is tapered by sin(pi*t) so the
 * filament lands exactly on both endpoints — untapered, the arc visibly
 * detaches from the very thing it is supposed to be arcing between. */
function writeArc(
  arr: Float32Array, offset: number,
  a: THREE.Vector3, b: THREE.Vector3,
  segments: number, amplitude: number, seed: number,
): number {
  arcDir.subVectors(b, a)
  const len = arcDir.length()
  if (len < 1e-4) return offset
  arcDir.multiplyScalar(1 / len)
  // Cross against whichever world axis is least parallel to the run, so
  // a vertical filament doesn't degenerate into a zero-length cross.
  arcU.crossVectors(arcDir, Math.abs(arcDir.y) < 0.9 ? UP_AXIS : SIDE_AXIS).normalize()
  arcV.crossVectors(arcDir, arcU).normalize()
  let px = a.x, py = a.y, pz = a.z
  for (let i = 1; i <= segments; i++) {
    const t = i / segments
    const spread = Math.sin(Math.PI * t) * amplitude
    const du = (hash01(seed + i * 13.7) - 0.5) * 2 * spread
    const dv = (hash01(seed + i * 29.3 + 5.1) - 0.5) * 2 * spread
    const qx = a.x + arcDir.x * len * t + arcU.x * du + arcV.x * dv
    const qy = a.y + arcDir.y * len * t + arcU.y * du + arcV.y * dv
    const qz = a.z + arcDir.z * len * t + arcU.z * du + arcV.z * dv
    arr[offset++] = px; arr[offset++] = py; arr[offset++] = pz
    arr[offset++] = qx; arr[offset++] = qy; arr[offset++] = qz
    px = qx; py = qy; pz = qz
  }
  return offset
}

/** Position/orientation to stretch a unit-length-along-Y cylinder
 * exactly from `from` to `to` — the standard three.js "point a cylinder
 * at something" recipe (align the default +Y axis to the direction via
 * a quaternion, get the real distance, center at the midpoint). Reused
 * by every straight-line effect (beam core/glow, tracers). */
function alignedTransform(from: THREE.Vector3, to: THREE.Vector3) {
  const dir = new THREE.Vector3().subVectors(to, from)
  const length = dir.length()
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5)
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  return { mid, length, quat }
}

/** A static (non-animated-by-itself) two-layer line — bright additive
 * core + a wider, softer glow shell — stretched between two fixed
 * points. Every straight-line weapon effect below wraps this in its own
 * <group> and drives that group's opacity/scale via useFrame refs. */
function StraightBeam({
  from, to, color, coreRadius, glowRadius,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; coreRadius: number; glowRadius: number }) {
  const { mid, length, quat } = useMemo(() => alignedTransform(from, to), [from, to])
  if (length < 0.001) return null
  return (
    <group position={mid} quaternion={quat}>
      <mesh>
        <cylinderGeometry args={[glowRadius, glowRadius, length, 6, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[coreRadius, coreRadius, length, 6, 1, true]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={1} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** Every material AND light under a group, so a single useFrame can fade
 * a whole composite effect (beam core+glow+flash sprites+point light) in
 * one line instead of threading a ref through each sub-element
 * individually. Renamed from setGroupOpacity now that it also drives
 * DynamicLight's own intensity the same way — same fade fraction, same
 * "each element keeps its own base value, scaled by the incoming
 * fraction" trick, just applied to `.intensity` instead of `.opacity`
 * for anything that's a THREE.Light. */
function setGroupFade(group: THREE.Group | null, fade: number) {
  if (!group) return
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const mat = obj.material as THREE.Material & { opacity?: number }
      if (typeof mat.opacity === 'number') {
        // Each material already has its own BASE opacity baked into its
        // JSX (the glow shell is deliberately dimmer than the core) —
        // scaling by the incoming fade fraction preserves that relative
        // balance instead of flattening everything to the same value.
        const base = (mat.userData as { baseOpacity?: number }).baseOpacity ?? mat.opacity
        ;(mat.userData as { baseOpacity?: number }).baseOpacity = base
        mat.opacity = base * fade
      }
    } else if (obj instanceof THREE.Light) {
      const base = (obj.userData as { baseIntensity?: number }).baseIntensity ?? obj.intensity
      ;(obj.userData as { baseIntensity?: number }).baseIntensity = base
      obj.intensity = base * fade
    }
  })
}

export function ImpactFlash({ position, color }: { position: THREE.Vector3; color: string }) {
  const ref = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  const lightColor = useMemo(() => new THREE.Color(color), [color])
  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const t = Math.min(1, (state.clock.elapsedTime - start.current) / 0.35)
    const scale = 0.3 + t * 1.4
    const fade = 1 - t
    ref.current?.scale.setScalar(scale)
    setGroupFade(ref.current, fade)
    // Asked for the WORLD position rather than reusing the `position`
    // prop: one caller (HexMap's own explosion) mounts this at the local
    // origin inside a group that carries the real position, so the prop
    // alone would light the middle of the board.
    if (fade > 0 && ref.current) {
      ref.current.getWorldPosition(flashWorld)
      setPoolLight(
        LIGHT_IMPACT,
        flashWorld.x, flashWorld.y + MECH_FACTOR, flashWorld.z,
        lightColor, 4 * ATTACK_LIGHT_INTENSITY_SCALE * fade, ATTACK_LIGHT_DISTANCE,
      )
    }
  })
  return (
    <group ref={ref} position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15 * MECH_FACTOR, 0.32 * MECH_FACTOR, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** Laser — charges, then fires.
 *
 * One cycle is an energy ball swelling at the muzzle and then, at full size,
 * the beam. A continuous laser runs one long cycle; a pulse laser runs five
 * short ones, which is the whole difference between them and the reason both
 * come out of this one component.
 *
 * The charge is what carries the shot. A beam that simply appears reads as a
 * red line drawn on the screen; a beam you saw coming reads as a weapon
 * firing, and it also gives the light somewhere to build from, so the
 * shooter's own mech is lit before anything crosses the board.
 *
 * Every phase drives the lights as well as the geometry: the muzzle light
 * ramps up with the ball, spikes as it lets go, and the target end only
 * lights while the beam is actually connected. */
function LaserAttack({
  from, to, color, pulses, chargeMs, beamMs, fadeMs,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  pulses: number
  chargeMs: number
  beamMs: number
  fadeMs: number
}) {
  const chargeRef = useRef<THREE.Mesh>(null)
  const beamGroupRef = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  const lightColor = useMemo(() => new THREE.Color(color), [color])
  const cycleMs = chargeMs + beamMs
  const totalMs = cycleMs * pulses

  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsedMs = (state.clock.elapsedTime - start.current) * 1000
    // One overall fade at the very end, so the last beam dies out instead of
    // being cut off mid-shot.
    const tail = elapsedMs <= totalMs
      ? 1
      : Math.max(0, 1 - (elapsedMs - totalMs) / fadeMs)
    const live = elapsedMs < totalMs
    const inCycle = elapsedMs % cycleMs
    const charging = live && inCycle < chargeMs
    const firing = live && !charging

    // Squared, so the ball creeps at first and rushes at the end. A linear
    // swell reads as an object being scaled; this reads as something
    // building up to letting go.
    const chargeT = charging ? inCycle / chargeMs : 0
    const grow = chargeT * chargeT
    if (chargeRef.current) {
      chargeRef.current.visible = charging
      chargeRef.current.scale.setScalar(0.2 + grow * 0.8)
      const mat = chargeRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = (0.3 + grow * 0.7) * tail
    }

    if (beamGroupRef.current) beamGroupRef.current.visible = firing && tail > 0
    setGroupFade(beamGroupRef.current, tail)

    // Builds with the charge and spikes on release, rather than being on
    // or off: this is the light the shooter's own mech is lit by.
    const beamT = firing ? (inCycle - chargeMs) / beamMs : 0
    const level = charging ? grow * 3.5 : (1 - beamT * 0.35) * 6
    setPoolLight(
      LIGHT_MUZZLE, from.x, from.y, from.z,
      lightColor, level * ATTACK_LIGHT_INTENSITY_SCALE * tail, ATTACK_LIGHT_DISTANCE,
    )
    // The far end is lit only while the beam is actually connected -- a
    // target lit during the charge would give the shot away before it left.
    if (firing) {
      setPoolLight(
        LIGHT_IMPACT, to.x, to.y, to.z,
        lightColor, 5 * ATTACK_LIGHT_INTENSITY_SCALE * tail, ATTACK_LIGHT_DISTANCE,
      )
    }
  })

  return (
    <group>
      <group position={[from.x, from.y, from.z]}>
        <GlowSprite meshRef={chargeRef} color={color} size={0.75 * MECH_FACTOR} />
      </group>
      <group ref={beamGroupRef}>
        <StraightBeam
          from={from} to={to} color={color}
          coreRadius={0.03 * MECH_FACTOR} glowRadius={0.08 * MECH_FACTOR}
        />
      </group>
    </group>
  )
}

/** PPC — a bolt of charged particles with an electric arc.
 *
 * Real user spec: "el PPC, que sera un bolo de particulas con arco
 * electrico". So this shot is a physical thing, not a beam: a churning
 * ball of plasma that visibly crosses the board (it is the one energy
 * weapon in this file with a real travel speed — see CATEGORY_SPEED),
 * wrapped in lightning and dragging an ionised tail behind it. That is
 * also what keeps it from just reading as a blue laser.
 *
 * Three primitives share one moving frame:
 *  - the HEAD, a white-hot billboard core inside a wider coloured halo;
 *  - the PARTICLES, a Points cloud spiralling around the flight axis and
 *    streaming off the back, widening and dimming as it disperses;
 *  - the ARC, jagged filaments that leap across the head and trail back
 *    down the channel it just flew through.
 *
 * On arrival the same three flip into an impact burst rather than being
 * swapped for different objects: the head expands and dies, the sparks
 * spray outward and droop under their own weight, and the arcs fan out
 * across the ground where the charge dumps.
 *
 * Three lights, because a bolt this bright that lit nothing would look
 * painted on: one at the muzzle for the launch, one riding WITH the bolt
 * so it sweeps the terrain it passes over, and one at the impact. */
function PpcAttack({
  from, to, color, travelMs, tailMs, groundYAt,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  travelMs: number
  tailMs: number
  /** Ground height under any point of the board, so the bolt can be kept
   * above it. */
  groundYAt?: (x: number, z: number) => number
}) {
  const headRef = useRef<THREE.Group>(null)
  const coreRef = useRef<THREE.Mesh>(null)
  const haloRef = useRef<THREE.Mesh>(null)
  const pointsRef = useRef<THREE.Points>(null)
  const arcsRef = useRef<THREE.LineSegments>(null)
  const start = useRef<number | null>(null)

  // The flight axis and a perpendicular basis on it, fixed for the whole
  // shot: everything below (the swirl, the tail, the cage) is expressed
  // in this frame rather than in world axes, so the effect looks the same
  // whether the shot runs north-south or straight up a hill.
  const path = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from)
    const dist = dir.length()
    dir.multiplyScalar(dist > 1e-4 ? 1 / dist : 0)
    const u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? UP_AXIS : SIDE_AXIS).normalize()
    const v = new THREE.Vector3().crossVectors(dir, u).normalize()
    return { dir, dist, u, v }
  }, [from, to])

  // Each particle keeps its own place in the swirl: an angle around the
  // flight axis, its own spin rate and direction, a radius, and a
  // position in the shed cycle (`age`, running 0..1 and wrapping) so the
  // cloud continuously streams off the back instead of being a rigid
  // blob dragged along. `burst` is the direction it flies on impact.
  const seeds = useMemo(() => Array.from({ length: PPC_PARTICLES }, () => {
    const burst = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
    if (burst.lengthSq() < 1e-4) burst.set(0, 1, 0)
    burst.normalize()
    return {
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 5),
      radius: (0.1 + Math.random() * 0.5) * MECH_FACTOR,
      age: Math.random(),
      rate: 1.5 + Math.random() * 2.5,
      burst,
    }
  }), [])

  // Seeded at the muzzle rather than at zero: an all-zeros buffer would
  // put one frame of the cloud and the arcs at the world origin before
  // the first useFrame ever runs.
  const particlePos = useMemo(() => {
    const arr = new Float32Array(PPC_PARTICLES * 3)
    for (let i = 0; i < PPC_PARTICLES; i++) arr.set([from.x, from.y, from.z], i * 3)
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const particleCol = useMemo(() => new Float32Array(PPC_PARTICLES * 3), [])
  const arcPos = useMemo(() => {
    const arr = new Float32Array(PPC_ARC_STRANDS * PPC_ARC_SEGMENTS * 2 * 3)
    for (let i = 0; i < arr.length; i += 3) arr.set([from.x, from.y, from.z], i)
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const baseColor = useMemo(() => new THREE.Color(color), [color])

  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const t = state.clock.elapsedTime - start.current
    const elapsedMs = t * 1000
    const travelT = Math.min(1, elapsedMs / travelMs)
    const flying = elapsedMs < travelMs
    const impactT = flying ? 0 : Math.min(1, (elapsedMs - travelMs) / tailMs)
    // Squared, so the burst dies fast at first and lingers faintly — a
    // linear fade reads as a light being turned down by hand.
    const die = (1 - impactT) * (1 - impactT)

    ppcBolt.lerpVectors(from, to, travelT)
    // Real user report: "el arma PPC, a veces el ataque viaja por debajo
    // del suelo". A PPC is the one shot here that flies flat and slow, so
    // a straight line from a muzzle to a target lower down the map cuts
    // clean through any rise in between — and at 0,43s per hex there is
    // plenty of time to watch it do it. Riding over the terrain fixes it
    // without turning the bolt into a lob: it only ever climbs, never
    // dips, so a shot across flat ground is exactly as flat as before.
    if (groundYAt) {
      const floor = groundYAt(ppcBolt.x, ppcBolt.z) + PPC_GROUND_CLEARANCE
      if (ppcBolt.y < floor) ppcBolt.y = floor
    }
    // The tail can only be as long as the bolt has actually flown, or at
    // launch it would stick out through the back of the mech.
    const tailLen = Math.min(PPC_TAIL_LEN, travelT * path.dist)

    // ---- head
    if (headRef.current) headRef.current.position.copy(flying ? ppcBolt : to)
    if (haloRef.current) {
      haloRef.current.scale.setScalar(flying ? 1 + Math.sin(t * 38) * 0.1 : 1 + impactT * 3)
      ;(haloRef.current.material as THREE.MeshBasicMaterial).opacity = flying ? 0.85 : 0.85 * die
    }
    if (coreRef.current) {
      coreRef.current.scale.setScalar(flying ? 1 : 1 + impactT * 1.8)
      ;(coreRef.current.material as THREE.MeshBasicMaterial).opacity = flying ? 1 : die
    }

    // ---- particles
    for (let i = 0; i < PPC_PARTICLES; i++) {
      const seed = seeds[i]
      let px: number, py: number, pz: number, bright: number, hot: number
      if (flying) {
        const age = (seed.age + t * seed.rate) % 1
        const ang = seed.angle + t * seed.spin
        // Widens as it goes back: this is plasma being shed, so it
        // disperses behind the head instead of staying a tidy sleeve.
        const r = seed.radius * (0.45 + age * 1.6)
        const axial = -age * tailLen
        const cos = Math.cos(ang) * r
        const sin = Math.sin(ang) * r
        px = ppcBolt.x + path.u.x * cos + path.v.x * sin + path.dir.x * axial
        py = ppcBolt.y + path.u.y * cos + path.v.y * sin + path.dir.y * axial
        pz = ppcBolt.z + path.u.z * cos + path.v.z * sin + path.dir.z * axial
        bright = (1 - age) * (1 - age)
        hot = Math.max(0, 1 - age * 2.5)
      } else {
        const reach = impactT * 2.6 * MECH_FACTOR
        px = to.x + seed.burst.x * reach
        // Sparks are thrown out and then fall — without the droop the
        // burst reads as an expanding sphere, which is an explosion, not
        // a shower of hot debris.
        py = to.y + seed.burst.y * reach - impactT * impactT * 1.8 * MECH_FACTOR
        pz = to.z + seed.burst.z * reach
        bright = die
        hot = Math.max(0, 1 - impactT * 2)
      }
      const j = i * 3
      particlePos[j] = px
      particlePos[j + 1] = py
      particlePos[j + 2] = pz
      // The freshest particles read white-hot and settle into the
      // weapon's own blue as they age. With additive blending, scaling
      // the vertex colour IS the fade — there is no per-point alpha.
      particleCol[j] = (baseColor.r + (1 - baseColor.r) * hot) * bright
      particleCol[j + 1] = (baseColor.g + (1 - baseColor.g) * hot) * bright
      particleCol[j + 2] = (baseColor.b + (1 - baseColor.b) * hot) * bright
    }
    if (pointsRef.current) {
      const geo = pointsRef.current.geometry
      geo.attributes.position.needsUpdate = true
      geo.attributes.color.needsUpdate = true
    }

    // ---- arc
    const phase = Math.floor(t * PPC_ARC_HZ)
    let off = 0
    if (flying) {
      for (let i = 0; i < PPC_CAGE_STRANDS; i++) {
        // Leaps from just ahead of the head to just behind it: this is
        // what makes the bolt crackle rather than merely glow.
        ppcA.copy(ppcBolt).addScaledVector(path.dir, PPC_HEAD * 1.1)
        ppcB.copy(ppcBolt).addScaledVector(path.dir, -PPC_HEAD * 1.7)
        off = writeArc(arcPos, off, ppcA, ppcB, PPC_ARC_SEGMENTS, PPC_HEAD * 1.5, phase * 7.3 + i * 19.7)
      }
      for (let i = 0; i < PPC_TAIL_STRANDS; i++) {
        ppcA.copy(ppcBolt)
        ppcB.copy(ppcBolt).addScaledVector(path.dir, -tailLen)
        off = writeArc(arcPos, off, ppcA, ppcB, PPC_ARC_SEGMENTS, PPC_HEAD * 1.2, phase * 11.9 + i * 31.1 + 100)
      }
    } else {
      // The charge dumps where it lands and fans out along the ground,
      // so the impact arcs spread in the horizontal plane rather than in
      // the flight frame the travelling ones used.
      const spread = (0.9 + impactT * 2.4) * MECH_FACTOR
      for (let i = 0; i < PPC_ARC_STRANDS; i++) {
        const ang = (i / PPC_ARC_STRANDS) * Math.PI * 2 + hash01(i * 3.1) * 0.9
        ppcA.copy(to)
        ppcB.set(to.x + Math.cos(ang) * spread, to.y + 0.3 * MECH_FACTOR, to.z + Math.sin(ang) * spread)
        off = writeArc(arcPos, off, ppcA, ppcB, PPC_ARC_SEGMENTS, PPC_HEAD * 0.9, phase * 5.7 + i * 23.3)
      }
    }
    if (arcsRef.current) {
      arcsRef.current.geometry.attributes.position.needsUpdate = true
      ;(arcsRef.current.material as THREE.LineBasicMaterial).opacity = flying ? 0.95 : 0.95 * die
    }

    // ---- lights
    const launch = Math.max(0, 1 - elapsedMs / (travelMs * 0.35))
    if (launch > 0) {
      setPoolLight(
        LIGHT_MUZZLE, from.x, from.y, from.z,
        baseColor, 7 * ATTACK_LIGHT_INTENSITY_SCALE * launch, ATTACK_LIGHT_DISTANCE,
      )
    }
    if (flying) {
      // Rides along with the bolt, sweeping the terrain it passes over.
      setPoolLight(
        LIGHT_TRAVEL, ppcBolt.x, ppcBolt.y, ppcBolt.z,
        baseColor, 6 * ATTACK_LIGHT_INTENSITY_SCALE, ATTACK_LIGHT_DISTANCE,
      )
    } else {
      setPoolLight(
        LIGHT_IMPACT, to.x, to.y, to.z,
        baseColor, 9 * ATTACK_LIGHT_INTENSITY_SCALE * die, ATTACK_LIGHT_DISTANCE,
      )
    }
  })

  return (
    <group>
      <group ref={headRef} position={[from.x, from.y, from.z]}>
        <GlowSprite meshRef={haloRef} color={color} size={PPC_HEAD * 3.4} />
        <GlowSprite meshRef={coreRef} color="#ffffff" size={PPC_HEAD * 1.5} />
      </group>
      {/* Both of these are written in WORLD space every frame, so their
          own bounding spheres are meaningless and the renderer would
          happily cull them while they are still on screen. */}
      <points ref={pointsRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[particlePos, 3]} />
          <bufferAttribute attach="attributes-color" args={[particleCol, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={getGlowTexture()} size={0.17 * MECH_FACTOR} sizeAttenuation
          vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending}
        />
      </points>
      <lineSegments ref={arcsRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arcPos, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          color={color} transparent opacity={0.95}
          depthWrite={false} blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </group>
  )
}

/** Fast ballistic/Gauss/etc — a short bright tracer that travels the
 * real distance at CATEGORY_SPEED's pace (not a fixed fraction of the
 * total duration regardless of range — see AttackEffect's own travelMs
 * computation), leaving a muzzle flash behind and an impact spark (or a
 * wide miss puff, offset from the target) at the far end. */
function TracerAttack({
  from, to, color, travelMs, tailMs,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; travelMs: number; tailMs: number }) {
  const beamGroupRef = useRef<THREE.Group>(null)
  const muzzleRef = useRef<THREE.Mesh>(null)
  const start = useRef<number | null>(null)
  const lightColor = useMemo(() => new THREE.Color(color), [color])
  const lastSeg = useRef({ from, to })
  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsedMs = (state.clock.elapsedTime - start.current) * 1000
    const travelT = Math.min(1, elapsedMs / travelMs)
    // The tracer itself is a short segment sliding from `from` toward
    // `to`, not the whole line at once — reads as a bullet in flight
    // instead of a static laser.
    const segFrom = new THREE.Vector3().lerpVectors(from, to, Math.max(0, travelT - 0.06))
    const segTo = new THREE.Vector3().lerpVectors(from, to, travelT)
    if (beamGroupRef.current) {
      beamGroupRef.current.visible = travelT < 1
    }
    const postFade = travelT >= 1 ? Math.max(0, 1 - (elapsedMs - travelMs) / tailMs) : 1
    const muzzleFade = Math.max(0, 1 - elapsedMs / (travelMs * 0.3))
    if (muzzleRef.current) {
      const mat = muzzleRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = muzzleFade
    }
    // Impact-end illumination is already covered by ImpactFlash's own
    // light (AttackEffect renders one alongside this on a real hit) —
    // this one only needs to cover the muzzle's own brief flash.
    if (muzzleFade > 0) {
      setPoolLight(
        LIGHT_MUZZLE, from.x, from.y, from.z,
        lightColor, 3 * ATTACK_LIGHT_INTENSITY_SCALE * muzzleFade, ATTACK_LIGHT_DISTANCE,
      )
    }
    setGroupFade(beamGroupRef.current, postFade)
    lastSeg.current = { from: segFrom, to: segTo }
  })
  return (
    <group>
      <group ref={beamGroupRef}>
        <StraightBeam
          from={lastSeg.current.from} to={lastSeg.current.to} color={color}
          coreRadius={0.025 * MECH_FACTOR} glowRadius={0.06 * MECH_FACTOR}
        />
      </group>
      <GlowSprite meshRef={muzzleRef} color={color} size={0.5 * MECH_FACTOR} />
    </group>
  )
}

/** A missile salvo — several bodies launching from the attacker, flying
 * their weapon's own profile, and converging into a cluster of impact
 * flashes. Which profile (and which model) comes from `kind`: see
 * MISSILE_KINDS, and weaponEffectCategory for how a weapon picks one. */
function MissileAttack({
  from, to, color, travelMs, kind, count,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  travelMs: number
  kind: MissileKind
  count: number
}) {
  const distance = from.distanceTo(to)
  const seeds = useMemo(
    () => Array.from({ length: count }, (_, i) => ({
      // Fanned across the salvo's own spread, so a rack of eight arrives
      // as a formation rather than as one missile drawn eight times.
      lateral: count > 1
        ? ((i / (count - 1)) - 0.5) * kind.spread + (Math.random() - 0.5) * kind.spread * 0.25
        : (Math.random() - 0.5) * kind.spread * 0.25,
      // Proportional to the shot, so a long lob rises like a long lob and
      // a point-blank one barely leaves the barrel.
      arcHeight: distance * kind.arcFraction * (0.85 + Math.random() * 0.3),
      // Staggered launch as a fraction of the real travel time (in
      // SECONDS — Missile's useFrame compares this against
      // clock.elapsedTime), so a long slow flight and a short fast one
      // both stagger proportionally instead of bunching up.
      delay: (i / count) * (travelMs / 1000) * 0.22,
    })),
    [count, travelMs, kind, distance],
  )
  return (
    <group>
      {seeds.map((s, i) => (
        <Missile key={i} from={from} to={to} color={color} travelMs={travelMs} kind={kind} {...s} />
      ))}
    </group>
  )
}

/** How many bodies a rack actually puts in the air, read off the weapon's
 * own name ("LRM 20", "SRM 6", "Rocket Launcher 10") and then capped: past
 * a certain point more missiles stop reading as more missiles and just
 * cost draw calls. */
function missileCount(weaponName: string, kind: MissileKind): number {
  const match = weaponName.match(/(\d+)\s*$/)
  const racked = match ? parseInt(match[1], 10) : 5
  return Math.max(2, Math.min(kind.maxCount, racked))
}

// Real .glb missile models (public/models, CREDITS.md — Sketchfab
// "Missile & Bomb Collection - Fighter Jets - Free" by bohmerang,
// CC-BY-NC-SA 4.0, an explicit placeholder pending a commercial-friendly
// replacement), replacing the earlier flat glow-sprite missile head after
// the user asked for "modelos 3d de misiles realistas".
//
// Three of the pack's sixteen models, each picked by the user for a
// specific weapon after reviewing renders of the whole set. They are
// extracted with their long axis on +Z and their origin at their own
// centre, which is the shape Missile's own orientation code expects.
// Cached per URL: the uniform scale that maps a model's own nose-to-tail
// length (its local +Z, baked in at extraction) to the length this file
// wants, plus the centring offset. Same "normalise once, apply per
// instance" split TerrainDecor's RealRock/RealBuilding use.
const missileNorm = new Map<string, { scale: number; offset: THREE.Vector3 }>()

// Real user request: "los misiles pasando cerca de un mech, su propulsion
// generará una luz que se reflejará en el mech". ONE light for the whole
// salvo, not one per missile: they fly in a tight formation, so five lights
// bought five times the shader-recompile cost (see LightPool.tsx) for a
// glow the eye reads as a single moving source anyway. Every missile still
// in the air writes the same slot each frame, so the light rides whichever
// of them is last to land.
const MISSILE_LIGHT_COLOR = new THREE.Color('#ff9a3b')
// The models leave the extractor with their nose on +Z (see extract.html).
const MISSILE_FORWARD = new THREE.Vector3(0, 0, 1)
// Scratch vectors for the flight maths — a salvo recomputing its path three
// times a frame allocated a Vector3 on every one of them.
const missileP = new THREE.Vector3()
const missileA = new THREE.Vector3()
const missileB = new THREE.Vector3()
const missileDir = new THREE.Vector3()

function normalizeMissileSceneOnce(scene: THREE.Group, url: string, length: number) {
  if (missileNorm.has(url)) return
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  const offset = new THREE.Vector3()
  box.getCenter(offset)
  missileNorm.set(url, { scale: size.z > 0 ? length / size.z : 1, offset })
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = false
      obj.receiveShadow = false
    }
  })
}

/** The missile body itself — a `<group>` whose own rotation callers set
 * every frame to point its LOCAL +Z (the model's real nose-to-tail axis)
 * at the current travel direction, the same way StraightBeam points a
 * cylinder's local +Y at its own direction via alignedTransform above.
 * Position is likewise fully caller-driven (Missile's own useFrame). */
function RealMissile({ kind }: { kind: MissileKind }) {
  const { scene } = useGLTF(kind.url)
  normalizeMissileSceneOnce(scene, kind.url, kind.length)
  const instance = useMemo(() => {
    const clone = scene.clone(true)
    const norm = missileNorm.get(kind.url)
    const s = norm?.scale ?? 1
    clone.scale.setScalar(s)
    if (norm) {
      clone.position.set(-norm.offset.x * s, -norm.offset.y * s, -norm.offset.z * s)
    }
    // three.js computes a frustum-culling bounding sphere from the MESH's
    // raw local geometry, before the centring above is conceptually
    // applied from its point of view, so a small fast object like this can
    // be wrongly culled as it crosses the frustum edge. Not worth chasing
    // for something this cheap — just skip culling.
    clone.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.frustumCulled = false
    })
    return clone
  }, [scene, kind])
  return <primitive object={instance} />
}
Object.values(MISSILE_KINDS).forEach((k) => useGLTF.preload(k.url))

function Missile({
  from, to, color, travelMs, kind, lateral, arcHeight, delay,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  travelMs: number
  kind: MissileKind
  lateral: number
  arcHeight: number
  delay: number
}) {
  const headRef = useRef<THREE.Group>(null)
  const trailGroupRef = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  const flashSpawned = useRef(false)
  const [impact, setImpact] = useState<THREE.Vector3 | null>(null)

  // Perpendicular-ish lateral offset so a cluster doesn't fly in one
  // literal overlapping line — projected onto the world XZ plane using
  // the beam's own direction, not a fixed world axis, so it looks right
  // regardless of firing angle.
  const lateralOffset = useMemo(() => {
    const dir = new THREE.Vector3().subVectors(to, from).setY(0).normalize()
    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    return perp.multiplyScalar(lateral)
  }, [from, to, lateral])

  const posAt = (t: number, out: THREE.Vector3) => {
    out.lerpVectors(from, to, t).addScaledVector(lateralOffset, 1 - t * 0.6)
    out.y += Math.sin(Math.PI * t) * arcHeight
    return out
  }

  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsed = state.clock.elapsedTime - start.current - delay
    if (elapsed < 0) {
      if (headRef.current) headRef.current.visible = false
      return
    }
    const travelDuration = travelMs / 1000
    const t = Math.min(1, elapsed / travelDuration)
    const pos = posAt(t, missileP)
    if (t < 1) {
      setPoolLight(
        LIGHT_TRAVEL, pos.x, pos.y, pos.z,
        MISSILE_LIGHT_COLOR, 2.5 * ATTACK_LIGHT_INTENSITY_SCALE, ATTACK_LIGHT_DISTANCE * 0.6,
      )
    }
    if (headRef.current) {
      headRef.current.visible = t < 1
      headRef.current.position.copy(pos)
      // Point the model's own nose-to-tail axis (local +Z, see
      // RealMissile's own doc comment) along the tangent of its own
      // arced flight path (a tiny step behind vs. at `t`, not the
      // straight attacker->target line). Clamped forward-difference near
      // t=0 since t-ε would go negative there.
      const tangentT0 = Math.max(0, t - 0.01)
      const tangentT1 = Math.min(1, t + 0.01)
      missileDir.subVectors(posAt(tangentT1, missileA), posAt(tangentT0, missileB))
      if (missileDir.lengthSq() > 1e-8) {
        headRef.current.quaternion.setFromUnitVectors(MISSILE_FORWARD, missileDir.normalize())
      }
    }
    if (trailGroupRef.current) {
      const trailT = Math.max(0, t - 0.08)
      const trailPos = posAt(trailT, missileA)
      trailGroupRef.current.visible = t < 1 && t > 0.02
      const { mid, length, quat } = alignedTransform(trailPos, pos)
      trailGroupRef.current.position.copy(mid)
      trailGroupRef.current.quaternion.copy(quat)
      trailGroupRef.current.scale.set(1, Math.max(0.001, length), 1)
    }
    if (t >= 1 && !flashSpawned.current) {
      flashSpawned.current = true
      setImpact(pos.clone())
    }
  })

  return (
    <>
      <group ref={headRef}>
        <RealMissile kind={kind} />
      </group>
      <group ref={trailGroupRef}>
        <mesh frustumCulled={false}>
          <cylinderGeometry args={[0.02 * MECH_FACTOR, 0.005 * MECH_FACTOR, 1, 5, 1, true]} />
          <meshBasicMaterial color={color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {impact && <ImpactFlash position={impact} color={color} />}
    </>
  )
}

/** Machine gun — real user request: "sprite para los ataques de machine
 * gun" (it used to just reuse MissileAttack with realModel=false, which
 * reads as a few slow LOBBED glowing balls on a parabolic arc — the
 * wrong feel for a rapid burst of flat, straight tracer rounds).
 * Several short, bright streaks fire in quick succession, dead straight
 * (no arc) with a small per-round spread at the target end for a real
 * "burst cone" instead of every round landing on the exact same point,
 * moving much faster than the missile's own lobbed arc. */
function MachineGunAttack({
  from, to, color, travelMs,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; travelMs: number }) {
  const rounds = useMemo(
    () => Array.from({ length: 6 }, (_, i) => ({
      // Staggered fire, evenly spread across roughly the first half of
      // the volley's own travel time — same "stagger proportional to
      // travelMs" reasoning as MissileAttack's own seeds, so a long shot
      // still reads as one continuous burst instead of the rounds
      // bunching together.
      delay: (i / 6) * (travelMs / 1000) * 0.5,
      spread: new THREE.Vector3(
        (Math.random() - 0.5) * 0.35 * MECH_FACTOR,
        (Math.random() - 0.5) * 0.22 * MECH_FACTOR,
        (Math.random() - 0.5) * 0.35 * MECH_FACTOR,
      ),
    })),
    [travelMs],
  )
  return (
    <>
      {rounds.map((r, i) => <TracerRound key={i} from={from} to={to} color={color} travelMs={travelMs * 0.5} {...r} />)}
    </>
  )
}

/** One MG round — a short, thin, bright streak (the same "aligned
 * cylinder between two points" trick StraightBeam/Missile's own trail
 * already use, just applied to a fast-moving short segment instead of a
 * static beam) racing in a dead-straight line from the muzzle to
 * `to + spread`, leaving a quick spark where it lands. */
function TracerRound({
  from, to, color, travelMs, delay, spread,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; travelMs: number; delay: number; spread: THREE.Vector3 }) {
  const ref = useRef<THREE.Mesh>(null)
  const start = useRef<number | null>(null)
  const flashSpawned = useRef(false)
  const [impact, setImpact] = useState<THREE.Vector3 | null>(null)
  const target = useMemo(() => to.clone().add(spread), [to, spread])

  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsed = state.clock.elapsedTime - start.current - delay
    if (elapsed < 0) {
      if (ref.current) ref.current.visible = false
      return
    }
    const t = Math.min(1, elapsed / (travelMs / 1000))
    const headPos = new THREE.Vector3().lerpVectors(from, target, t)
    const tailPos = new THREE.Vector3().lerpVectors(from, target, Math.max(0, t - 0.1))
    if (ref.current) {
      ref.current.visible = t < 1
      const { mid, length, quat } = alignedTransform(tailPos, headPos)
      ref.current.position.copy(mid)
      ref.current.quaternion.copy(quat)
      ref.current.scale.set(1, Math.max(0.001, length), 1)
    }
    if (t >= 1 && !flashSpawned.current) {
      flashSpawned.current = true
      setImpact(headPos.clone())
    }
  })

  return (
    <>
      <mesh ref={ref} frustumCulled={false}>
        <cylinderGeometry args={[0.015 * MECH_FACTOR, 0.015 * MECH_FACTOR, 1, 5, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.95} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {impact && <ImpactFlash position={impact} color={color} />}
    </>
  )
}

/** Flamer — a short-lived jet of small flame-colored sprites drifting
 * from attacker to target with a bit of random jitter, additive so
 * overlapping particles brighten toward white-hot at the core. */
function FlameAttack({ from, to, color, duration }: { from: THREE.Vector3; to: THREE.Vector3; color: string; duration: number }) {
  const particles = useMemo(
    () => Array.from({ length: 14 }, () => ({
      delay: Math.random() * 0.25,
      jitter: new THREE.Vector3(
        (Math.random() - 0.5) * 0.4 * MECH_FACTOR,
        (Math.random() - 0.5) * 0.3 * MECH_FACTOR,
        (Math.random() - 0.5) * 0.4 * MECH_FACTOR,
      ),
      size: (0.25 + Math.random() * 0.25) * MECH_FACTOR,
    })),
    [],
  )
  return (
    <>
      {particles.map((p, i) => (
        <FlameParticle key={i} from={from} to={to} color={color} duration={duration} {...p} />
      ))}
    </>
  )
}

function FlameParticle({
  from, to, color, duration, delay, jitter, size,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; duration: number; delay: number; jitter: THREE.Vector3; size: number }) {
  const ref = useRef<THREE.Mesh>(null)
  const start = useRef<number | null>(null)
  useProfiledFrame('disparos', (state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsed = state.clock.elapsedTime - start.current - delay
    if (elapsed < 0) {
      if (ref.current) ref.current.visible = false
      return
    }
    const travelDuration = (duration * 0.7) / 1000
    const t = Math.min(1, elapsed / travelDuration)
    const pos = new THREE.Vector3().lerpVectors(from, to, t).addScaledVector(jitter, Math.sin(t * Math.PI))
    if (ref.current) {
      ref.current.visible = true
      ref.current.position.copy(pos)
      ref.current.quaternion.copy(state.camera.quaternion)
      const mat = ref.current.material as THREE.MeshBasicMaterial
      mat.opacity = 1 - t
    }
  })
  return (
    <mesh ref={ref}>
      <planeGeometry args={[size, size]} />
      <meshBasicMaterial map={getGlowTexture()} color={color} transparent opacity={1} blending={THREE.AdditiveBlending} depthWrite={false} />
    </mesh>
  )
}

export interface AttackEffectData {
  attackerPos: [number, number]
  targetPos: [number, number]
  attackerY: number
  targetY: number
  /** The target's own tile ground height (HexMap's groundYAt) — where a
   * miss actually lands, see `to`'s own doc comment below. Unused on a
   * hit (the real target point already has its own Y). */
  groundY: number
  weaponName: string
  hit: boolean
}

// Real user request: "los ataques de los mechs graficamente no pueden
// fallar a mas de 2 tiles del objetivo que son mechs no Storm troopers"
// — hex center-to-center spacing is √3 * HEX_SIZE (hexMath.ts), so this
// caps a miss's lateral drift well inside 2 tiles (max ≈1.15 tiles)
// rather than an arbitrary-feeling number, and reads as "just barely
// missed" — a mech pilot's aim, not a stormtrooper's. HEX-factor scaled.
const MAX_MISS_LATERAL = 2.0 * HEX_SIZE
const MIN_MISS_LATERAL = 0.8 * HEX_SIZE

/** One weapon's whole visual — resolves a category from the weapon
 * name, builds the real 3D from/to points (raised to roughly torso
 * height on a hit), and self-unmounts via onDone once its category's
 * duration has played out. Mounted fresh (a new `key`) per attack_result
 * by whichever caller renders it — see HexMap's own activeAttack prop. */
export function AttackEffect({
  data, onDone, onMissGround, onImpact, groundYAt,
}: {
  data: AttackEffectData
  onDone: () => void
  /** Real user request: "los disparos fallados deben golpear el suelo,
   * no ir al infinito, y deben dejar marcas en el mapa/tile que golpean"
   * — fires once, right away, with the real ground point `to` resolves
   * to on a miss, so the caller (HexMap) can drop a persistent scorch
   * mark there. Never fires on a hit (nothing to mark — the target
   * itself sold the impact). */
  onMissGround?: (pos: [number, number, number]) => void
  /** Fires once, when the shot actually ARRIVES — not when it was
   * launched and not when the whole effect finishes.
   *
   * Real user request: "el flash rojo que se muestra el FPV cuando recibe
   * un hit, no debe salir cuando se resuelve si no cuando la animacion del
   * ataque llega al objetivo". The server resolves an attack the moment it
   * is declared, so anything driven off that fires while the missile is
   * still in the air, and the cockpit shook before it was hit.
   *
   * What "arrives" means depends on the weapon, which is why this lives
   * here rather than being a timer the caller guesses at: a missile
   * arrives after its real travel time, a laser the moment the beam
   * connects (after its charge), a flamer partway through its jet. */
  onImpact?: () => void
  /** Ground height anywhere on the board, in the same space `from`/`to` are
   * in. Used to keep a flat-flying shot from tunnelling through a hill. */
  groundYAt?: (x: number, z: number) => number
}) {
  const category = weaponEffectCategory(data.weaponName)
  const color = CATEGORY_COLOR[category]

  const from = useMemo(() => new THREE.Vector3(data.attackerPos[0], data.attackerY, data.attackerPos[1]), [data])
  const to = useMemo(() => {
    const real = new THREE.Vector3(data.targetPos[0], data.targetY, data.targetPos[1])
    if (data.hit) return real
    // A miss goes past/beside the real target and all the way DOWN TO
    // THE GROUND instead of hovering near torso height with nothing to
    // visibly stop it — real user report, it read as vanishing into
    // nowhere rather than actually missing. Landing on the ground is
    // also what the persistent scorch mark (see onMissGround) sits on.
    const dir = new THREE.Vector3().subVectors(real, from).setY(0).normalize()
    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    const side = Math.random() < 0.5 ? -1 : 1
    const lateral = MIN_MISS_LATERAL + Math.random() * (MAX_MISS_LATERAL - MIN_MISS_LATERAL)
    return new THREE.Vector3(real.x, data.groundY, real.z).add(perp.multiplyScalar(side * lateral))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    if (!data.hit) onMissGround?.([to.x, to.y, to.z])
    // Fire exactly once per mount (a fresh AttackEffect per shot, see its
    // own doc comment) — `to`/`onMissGround` intentionally excluded so a
    // parent re-render passing a new-reference-but-same callback (or,
    // pathologically, a re-render mid-flight) can't fire this twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // tracer/missile/mg travel the REAL distance at a constant speed (see
  // CATEGORY_SPEED) so a long shot visibly takes proportionally longer
  // instead of covering the whole board in the same fixed instant a shot
  // has to cross a bunch of tiles feel like it vanished after only a few
  // of them. The PPC travels too — it fires a particle bolt, not a beam.
  // beam/pulse/flame have no real travel phase (a laser snaps in
  // instantly), so they keep a fixed lifetime regardless of range.
  const speed = CATEGORY_SPEED[category]
  const travelMs = speed != null
    ? Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, (from.distanceTo(to) / speed) * 1000))
    : CATEGORY_DURATION_MS[category]
  const duration = speed != null ? travelMs + IMPACT_TAIL_MS : CATEGORY_DURATION_MS[category]

  useEffect(() => {
    const t = setTimeout(onDone, duration)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration])

  // When this shot lands, per category. Beams and pulses connect the
  // instant their charge finishes; a flame jet reads as arriving about
  // halfway along; everything else travels, and travelMs already is the
  // time it takes.
  const impactAt = speed != null
    ? travelMs
    : (category === 'beam' || category === 'pulse'
      ? LASER_CHARGE_MS
      : duration * 0.5)
  useEffect(() => {
    if (!onImpact) return
    const t = setTimeout(onImpact, impactAt)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactAt])

  if (category === 'beam') {
    return (
      <LaserAttack
        from={from} to={to} color={color} pulses={1}
        chargeMs={LASER_CHARGE_MS} beamMs={LASER_BEAM_MS} fadeMs={LASER_FADE_MS}
      />
    )
  }
  if (category === 'pulse') {
    return (
      <LaserAttack
        from={from} to={to} color={color} pulses={PULSE_COUNT}
        chargeMs={PULSE_CHARGE_MS} beamMs={PULSE_BEAM_MS} fadeMs={LASER_FADE_MS}
      />
    )
  }
  if (category === 'ppc') {
    return (
      <PpcAttack
        from={from} to={to} color={color}
        travelMs={travelMs} tailMs={IMPACT_TAIL_MS} groundYAt={groundYAt}
      />
    )
  }
  if (category === 'missileArc' || category === 'missileDirect' || category === 'rocket') {
    const kind = category === 'rocket'
      ? MISSILE_KINDS.rocket
      : (category === 'missileArc' ? MISSILE_KINDS.arc : MISSILE_KINDS.direct)
    return (
      <MissileAttack
        from={from} to={to} color={color} travelMs={travelMs}
        kind={kind} count={missileCount(data.weaponName, kind)}
      />
    )
  }
  if (category === 'mg') return <MachineGunAttack from={from} to={to} color={color} travelMs={travelMs} />
  if (category === 'flame') return <FlameAttack from={from} to={to} color={color} duration={duration} />
  return (
    <>
      <TracerAttack from={from} to={to} color={color} travelMs={travelMs} tailMs={IMPACT_TAIL_MS} />
      {data.hit && <ImpactFlash position={to} color={color} />}
    </>
  )
}
