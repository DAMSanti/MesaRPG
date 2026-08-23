import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

/** Which visual treatment a weapon gets, classified from its own catalog
 * name (app/weapons.py's WEAPON_CATALOG) — kept as simple substring
 * matching here rather than a new backend field, since this is purely
 * cosmetic and the catalog's naming is already consistent enough to
 * bucket reliably (every energy weapon says "Laser" or "PPC", every
 * missile rack says "SRM"/"LRM"/"MRM"/"ATM"/"MML"/"Rocket Launcher",
 * every autocannon/Gauss variant reads fine as a fast ballistic tracer,
 * the safe default for anything this doesn't otherwise recognize). */
export type AttackEffectCategory = 'beam' | 'ppc' | 'tracer' | 'missile' | 'mg' | 'flame'

export function weaponEffectCategory(weaponName: string): AttackEffectCategory {
  const n = weaponName.toLowerCase()
  if (n.includes('flamer')) return 'flame'
  if (n.includes('machine gun')) return 'mg'
  if (n.includes('ppc')) return 'ppc'
  if (n.includes('laser')) return 'beam'
  if (
    n.includes('srm') || n.includes('lrm') || n.includes('mrm') || n.includes('atm')
    || n.includes('mml') || n.includes('rocket launcher')
  ) return 'missile'
  return 'tracer'
}

// Per-category color — standard BattleTech convention where one exists
// (IS lasers ruby red, PPCs electric blue), a warm muzzle-flash tone for
// the rest rather than trying to fake a literal tracer color.
const CATEGORY_COLOR: Record<AttackEffectCategory, string> = {
  beam: '#ff3b3b',
  ppc: '#3bb2ff',
  tracer: '#ffb020',
  missile: '#ff8a3b',
  mg: '#ffd23b',
  flame: '#ff6a1f',
}

// Total lifetime (travel + impact + fade) before AttackEffect unmounts
// itself for a category with NO real travel distance (beam/ppc snap in
// instantly regardless of range — that's how BT lore treats energy
// weapons — flame is a short jet, not a projectile). tracer/missile/mg
// instead travel at a fixed real-world SPEED (see CATEGORY_SPEED below)
// so a long shot visibly takes proportionally longer to cross the board
// instead of covering the whole distance in the same fixed instant —
// this table's entries for those three categories are unused fallbacks
// only (kept in case a distance can't be computed).
const CATEGORY_DURATION_MS: Record<AttackEffectCategory, number> = {
  beam: 420,
  ppc: 480,
  tracer: 900,
  missile: 1600,
  mg: 900,
  flame: 420,
}

// World units/second — hex center-to-center spacing is √3 ≈ 1.73 (see
// hexMath.ts), so missile ≈ 0.4s/hex (a slow, clearly-trackable lob) and
// tracer/mg ≈ 0.15s/hex (fast but still visible, unlike the near-instant
// speed a short fixed duration implied for a many-hex shot before —
// that's what made a missile look like it vanished after "a few tiles"
// instead of visibly flying the whole way to the target).
const CATEGORY_SPEED: Partial<Record<AttackEffectCategory, number>> = {
  tracer: 11,
  missile: 4.3,
  mg: 13,
}
const MIN_TRAVEL_MS = 350
const MAX_TRAVEL_MS = 3000
// How long the impact flash/fade lingers after a traveling projectile
// actually reaches its (real-hit or miss-offset) endpoint.
const IMPACT_TAIL_MS = 300

/** Cheap radial-gradient "glow" sprite, generated once and reused for
 * every muzzle flash / impact flash / missile head in the whole app —
 * same "bake a canvas texture instead of shipping an asset" approach
 * terrain.ts already uses for ground textures, just a soft round glow
 * instead of a tileable pattern. */
let glowTextureCache: THREE.Texture | null = null
function getGlowTexture(): THREE.Texture {
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
  useFrame((state) => {
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

/** Every material under a group, so a single useFrame can set opacity on
 * a whole composite effect (beam core+glow+flash sprites) in one line
 * instead of threading a ref through each sub-mesh individually. */
function setGroupOpacity(group: THREE.Group | null, opacity: number) {
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
        mat.opacity = base * opacity
      }
    }
  })
}

function ImpactFlash({ position, color }: { position: THREE.Vector3; color: string }) {
  const ref = useRef<THREE.Group>(null)
  const start = useRef<number | null>(null)
  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const t = Math.min(1, (state.clock.elapsedTime - start.current) / 0.35)
    const scale = 0.3 + t * 1.4
    const fade = 1 - t
    ref.current?.scale.setScalar(scale)
    setGroupOpacity(ref.current, fade)
  })
  return (
    <group ref={ref} position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.15, 0.32, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/** Laser/PPC — the beam snaps in at full brightness and holds briefly,
 * then fades; PPC is just wider/bluer/a touch slower so it reads as a
 * heavier weapon without a whole separate animation curve. */
function BeamAttack({ from, to, color, duration, thick }: { from: THREE.Vector3; to: THREE.Vector3; color: string; duration: number; thick: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const flashRef = useRef<THREE.Mesh>(null)
  const start = useRef<number | null>(null)
  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsedMs = (state.clock.elapsedTime - start.current) * 1000
    const holdUntil = duration * 0.35
    const fade = elapsedMs <= holdUntil ? 1 : Math.max(0, 1 - (elapsedMs - holdUntil) / (duration - holdUntil))
    setGroupOpacity(groupRef.current, fade)
    if (flashRef.current) {
      const mat = flashRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = fade
    }
  })
  return (
    <group ref={groupRef}>
      <StraightBeam from={from} to={to} color={color} coreRadius={thick ? 0.045 : 0.03} glowRadius={thick ? 0.13 : 0.08} />
      <GlowSprite meshRef={flashRef} color={color} size={thick ? 0.9 : 0.6} />
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
  const lastSeg = useRef({ from, to })
  useFrame((state) => {
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
    if (muzzleRef.current) {
      const mat = muzzleRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = Math.max(0, 1 - elapsedMs / (travelMs * 0.3))
    }
    setGroupOpacity(beamGroupRef.current, postFade)
    lastSeg.current = { from: segFrom, to: segTo }
  })
  return (
    <group>
      <group ref={beamGroupRef}>
        <StraightBeam from={lastSeg.current.from} to={lastSeg.current.to} color={color} coreRadius={0.025} glowRadius={0.06} />
      </group>
      <GlowSprite meshRef={muzzleRef} color={color} size={0.5} />
    </group>
  )
}

/** SRM/LRM/etc — a small cluster of glowing projectiles launches from
 * the attacker and arcs to the target over the effect's full duration,
 * each with a short fading trail, converging into a cluster of impact
 * flashes on arrival — the "barrage" the user specifically asked for,
 * distinct from a single beam/tracer. */
function MissileAttack({
  from, to, color, travelMs, count, realModel = true,
}: { from: THREE.Vector3; to: THREE.Vector3; color: string; travelMs: number; count: number; realModel?: boolean }) {
  const seeds = useMemo(
    () => Array.from({ length: count }, (_, i) => ({
      lateral: (i - (count - 1) / 2) * 0.12 + (Math.random() - 0.5) * 0.05,
      arcHeight: 0.5 + Math.random() * 0.4,
      // Staggered launch, as a fraction of the real travel time (in
      // SECONDS — Missile's useFrame compares delay directly against
      // clock.elapsedTime) rather than a fixed offset, so a long/slow
      // flight and a short/fast one both stagger proportionally instead
      // of a fast volley bunching into one simultaneous clump.
      delay: (i / count) * (travelMs / 1000) * 0.2,
    })),
    [count, travelMs],
  )
  return (
    <group>
      {seeds.map((s, i) => (
        <Missile key={i} from={from} to={to} color={color} travelMs={travelMs} realModel={realModel} {...s} />
      ))}
    </group>
  )
}

// Real .glb missile model (public/models, CREDITS.md — Sketchfab "Missile
// & Bomb Collection - Fighter Jets - Free" by bohmerang, CC-BY-NC-SA
// 4.0, used as an explicit placeholder pending a commercial-friendly
// replacement — see CREDITS.md) replacing the earlier flat glow-sprite
// missile head, per explicit request for "modelos 3d de misiles
// realistas" after the existing laser/missile effects read as "un poco
// cutres". The AGM-114 Hellfire mesh specifically, extracted from a
// 16-missile collection via a one-off gltf-transform script (kept
// alongside the model's own CREDITS.md entry for provenance) — the
// user's own pick as "el mejor candidato" after reviewing the set.
const MISSILE_MODEL_URL = '/models/missile-hellfire.glb'
// World units, nose to tail — small and fast-moving on screen, so this
// only needs to read as "a real missile shape" at a glance, not survive
// close scrutiny the way a stationary decoration would.
const MISSILE_LENGTH = 0.4

// Cached once from the shared source scene: the uniform scale factor
// that maps the model's own longest raw dimension (its nose-to-tail
// length — confirmed via bounding-box inspection to be its LOCAL +Z
// axis, not +Y like this file's other primitives default to) to
// MISSILE_LENGTH, plus the centering offset and which raw axis that was.
// Same "compute once, apply per-instance scaled by each clone's own
// final scale" split TerrainDecor.tsx's RealRock/RealBuilding use, for
// the identical reason: baking a raw-unit offset into the shared scene
// at module scale 1 only cancels out correctly when every instance
// happens to share that same scale, which these don't in general even
// though today only one MISSILE_LENGTH is ever used.
let missileScale: number | null = null
let missileOffset: THREE.Vector3 | null = null
function normalizeMissileSceneOnce(scene: THREE.Group) {
  if (missileScale !== null) return
  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  box.getSize(size)
  missileScale = size.z > 0 ? MISSILE_LENGTH / size.z : 1
  missileOffset = new THREE.Vector3()
  box.getCenter(missileOffset)
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = false
      obj.receiveShadow = false
    }
  })
}

/** The missile body itself — a `<group>` whose own rotation callers set
 * every frame to point its LOCAL +Z (the model's real nose-to-tail
 * axis, confirmed by inspecting its bounding box) at the current travel
 * direction, the same way StraightBeam points a cylinder's local +Y at
 * its own direction via alignedTransform above. Position is likewise
 * fully caller-driven (Missile's own useFrame), not managed here. */
function RealMissile() {
  const { scene } = useGLTF(MISSILE_MODEL_URL)
  normalizeMissileSceneOnce(scene)
  const instance = useMemo(() => {
    const clone = scene.clone(true)
    const s = missileScale ?? 1
    clone.scale.setScalar(s)
    if (missileOffset) {
      clone.position.set(-missileOffset.x * s, -missileOffset.y * s, -missileOffset.z * s)
    }
    // The model's raw local geometry sits far from its own node origin
    // (a leftover offset from the multi-missile collection it was
    // extracted from — see CREDITS.md), which we cancel out above via
    // position/scale on this wrapper. But three.js computes frustum-
    // culling bounding spheres from the MESH's raw local geometry before
    // that cancellation is conceptually "applied" from its perspective,
    // and a fast-moving small object like this can end up wrongly culled
    // as it crosses the camera frustum boundary. Not worth chasing
    // further for an object this small/cheap — just skip culling.
    clone.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.frustumCulled = false
    })
    return clone
  }, [scene])
  return <primitive object={instance} />
}
useGLTF.preload(MISSILE_MODEL_URL)

function Missile({
  from, to, color, travelMs, lateral, arcHeight, delay, realModel,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  travelMs: number
  lateral: number
  arcHeight: number
  delay: number
  // false for 'mg' (machine-gun bursts, which also reuse this same
  // Missile/MissileAttack pair) — a real guided-missile body reads as
  // absurd for MG rounds, so those keep the original flat glow sprite
  // instead of RealMissile.
  realModel: boolean
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

  const posAt = (t: number) => {
    const base = new THREE.Vector3().lerpVectors(from, to, t).add(lateralOffset.clone().multiplyScalar(1 - t * 0.6))
    base.y += Math.sin(Math.PI * t) * arcHeight
    return base
  }

  useFrame((state) => {
    if (start.current === null) start.current = state.clock.elapsedTime
    const elapsed = state.clock.elapsedTime - start.current - delay
    if (elapsed < 0) {
      if (headRef.current) headRef.current.visible = false
      return
    }
    const travelDuration = travelMs / 1000
    const t = Math.min(1, elapsed / travelDuration)
    const pos = posAt(t)
    if (headRef.current) {
      headRef.current.visible = t < 1
      headRef.current.position.copy(pos)
      if (realModel) {
        // A real 3D body, unlike the flat glow sprite the MG variant
        // still uses below, needs to actually point somewhere rather
        // than always billboard the camera — the tangent of its own
        // arced flight path (a tiny step behind vs. at `t`, not the
        // straight attacker->target line), pointing the model's own
        // nose-to-tail axis (local +Z, see RealMissile's own doc
        // comment) along it. Clamped forward-difference near t=0 since
        // t-ε would go negative there.
        const tangentT0 = Math.max(0, t - 0.01)
        const tangentT1 = Math.min(1, t + 0.01)
        const dir = new THREE.Vector3().subVectors(posAt(tangentT1), posAt(tangentT0))
        if (dir.lengthSq() > 1e-8) {
          headRef.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize())
        }
      } else {
        headRef.current.quaternion.copy(state.camera.quaternion)
      }
    }
    if (trailGroupRef.current) {
      const trailT = Math.max(0, t - 0.08)
      const trailPos = posAt(trailT)
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
        {realModel ? (
          <RealMissile />
        ) : (
          <mesh frustumCulled={false}>
            <planeGeometry args={[0.16, 0.16]} />
            <meshBasicMaterial map={getGlowTexture()} color={color} transparent blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        )}
      </group>
      <group ref={trailGroupRef}>
        <mesh frustumCulled={false}>
          <cylinderGeometry args={[0.02, 0.005, 1, 5, 1, true]} />
          <meshBasicMaterial color={color} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>
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
      jitter: new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.4),
      size: 0.25 + Math.random() * 0.25,
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
  useFrame((state) => {
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
  weaponName: string
  hit: boolean
}

/** One weapon's whole visual — resolves a category from the weapon
 * name, builds the real 3D from/to points (raised to roughly torso
 * height, and nudged sideways off the true target on a miss so the shot
 * visibly goes wide instead of "hitting" a target the roll actually
 * missed), and self-unmounts via onDone once its category's duration
 * has played out. Mounted fresh (a new `key`) per attack_result by
 * whichever caller renders it — see HexMap's own activeAttack prop. */
export function AttackEffect({ data, onDone }: { data: AttackEffectData; onDone: () => void }) {
  const category = weaponEffectCategory(data.weaponName)
  const color = CATEGORY_COLOR[category]

  const from = useMemo(() => new THREE.Vector3(data.attackerPos[0], data.attackerY, data.attackerPos[1]), [data])
  const to = useMemo(() => {
    const real = new THREE.Vector3(data.targetPos[0], data.targetY, data.targetPos[1])
    if (data.hit) return real
    // A miss goes past/beside the real target instead of "hitting" it —
    // a fixed lateral+vertical offset large enough to clearly not be the
    // target's own silhouette, small enough to still read as aimed at
    // them rather than a random direction.
    const dir = new THREE.Vector3().subVectors(real, from).setY(0).normalize()
    const perp = new THREE.Vector3(-dir.z, 0, dir.x)
    const side = Math.random() < 0.5 ? -1 : 1
    return real.clone().add(perp.multiplyScalar(side * (0.9 + Math.random() * 0.6))).add(new THREE.Vector3(0, 0.6 + Math.random() * 0.5, 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // tracer/missile/mg travel the REAL distance at a constant speed (see
  // CATEGORY_SPEED) so a long shot visibly takes proportionally longer
  // instead of covering the whole board in the same fixed instant a shot
  // has to cross a bunch of tiles feel like it vanished after only a few
  // of them. beam/ppc/flame have no real travel phase (energy weapons
  // snap in instantly), so they keep a fixed lifetime regardless of range.
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

  if (category === 'beam') return <BeamAttack from={from} to={to} color={color} duration={duration} thick={false} />
  if (category === 'ppc') return <BeamAttack from={from} to={to} color={color} duration={duration} thick />
  if (category === 'missile') return <MissileAttack from={from} to={to} color={color} travelMs={travelMs} count={5} realModel />
  if (category === 'mg') return <MissileAttack from={from} to={to} color={color} travelMs={travelMs} count={3} realModel={false} />
  if (category === 'flame') return <FlameAttack from={from} to={to} color={color} duration={duration} />
  return (
    <>
      <TracerAttack from={from} to={to} color={color} travelMs={travelMs} tailMs={IMPACT_TAIL_MS} />
      {data.hit && <ImpactFlash position={to} color={color} />}
    </>
  )
}
