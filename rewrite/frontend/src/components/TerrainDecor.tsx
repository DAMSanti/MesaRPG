import { useMemo } from 'react'
import * as THREE from 'three'
import { hashTile, buildingKind, plainsGroundVariant, terrainTexture } from '../terrain'

// Real bark/leaf CC0 photos (public/textures/CREDITS.md) instead of a 3D
// tree model — a real low-poly .glb pack (Kenney's Nature Kit) was tried
// first, but every variant's canopy material baked in an unnaturally
// teal/turquoise green (not a bug — that's the pack's actual color),
// which fought the realism this was meant to add. A textured trunk
// cylinder plus a loose cluster of small double-sided "leaf card" planes
// (real photographed leaves, alpha-cut from their own opacity map) reads
// as convincingly organic from this game's near-top-down table camera
// without the cost of true per-frame camera-facing billboarding — same
// "cheap but real" reasoning as terrain.ts's own photo ground textures.
const treePhotoCache = new Map<string, THREE.Texture>()
function loadTreePhoto(url: string, repeat = 1): THREE.Texture {
  const cached = treePhotoCache.get(url)
  if (cached) return cached
  const tex = new THREE.TextureLoader().load(url)
  tex.colorSpace = THREE.SRGBColorSpace
  if (repeat !== 1) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat, repeat)
  }
  treePhotoCache.set(url, tex)
  return tex
}
const getBarkTexture = () => loadTreePhoto('/textures/bark.jpg', 2)
// Multiplies bark.jpg (a pale/silvery photo, see BARK_TINT's use below)
// down toward a believable trunk-in-shadow tone.
const BARK_TINT = '#7d6f5f'
const getCanopyPhoto = (species: 'broad' | 'fern') =>
  loadTreePhoto(species === 'broad' ? '/textures/leaf-broad.png' : '/textures/leaf-fern.png')

/** One leaf-card plane, double-sided so both faces of the tiny cluster
 * around the trunk read from any angle without runtime billboarding. */
function LeafCard({
  species, position, rotation, size,
}: { species: 'broad' | 'fern'; position: [number, number, number]; rotation: [number, number, number]; size: number }) {
  return (
    <mesh position={position} rotation={rotation} castShadow>
      <planeGeometry args={[size, size * 1.25]} />
      <meshStandardMaterial
        map={getCanopyPhoto(species)} transparent alphaTest={0.4}
        side={THREE.DoubleSide} roughness={0.85}
      />
    </mesh>
  )
}

/** One tapered branch, oriented from `start` along `dir` for `length` —
 * bark-textured like the trunk it forks from. */
function Branch({
  start, dir, length, radiusBottom, radiusTop,
}: { start: THREE.Vector3; dir: THREE.Vector3; length: number; radiusBottom: number; radiusTop: number }) {
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir), [dir])
  const mid = useMemo(() => start.clone().addScaledVector(dir, length / 2), [start, dir, length])
  return (
    <mesh position={mid} quaternion={quaternion} castShadow>
      <cylinderGeometry args={[radiusTop, radiusBottom, length, 5]} />
      {/* bark.jpg is a pale/silvery photo texture — fine for the trunk,
          which the canopy fully hides, but a branch reaching out past the
          leaf mass read as a stark white stick against the dark canopy
          without this tint (BARK_TINT) muting it toward shadow. */}
      <meshStandardMaterial map={getBarkTexture()} color={BARK_TINT} roughness={0.95} />
    </mesh>
  )
}

/** A whole tree: a trunk that forks into a handful of angled branches
 * (a straight cylinder running into a leaf cloud read as a pole, not a
 * tree — "los troncos... deberian tener ramas como un arbol de verdad"),
 * each tipped with its own small clump of leaf cards (plus one smaller
 * clump near the trunk's own top to fill the silhouette in). Clumping
 * foliage at real branch ends — instead of scattering cards through one
 * global sphere independent of any branch — is what fixes the canopy
 * reading as "una rama mal puesta": every card now hangs off something.
 * `density` controls total card count (forest > light_forest, see the
 * two call sites below), `species` picks which leaf photo. */
function TreeBillboard({
  seed, species, density, trunkHeight, canopyRadius,
}: { seed: number; species: 'broad' | 'fern'; density: number; trunkHeight: number; canopyRadius: number }) {
  const { branches, cards } = useMemo(() => {
    const rng = (salt: number) => {
      const h = hashTile(0, 0, seed + salt * 7919)
      return (h % 10000) / 10000
    }

    const branchCount = 3 + Math.floor(rng(1) * 3) // 3-5
    const branchTipRadius = canopyRadius * 0.11
    const branches = Array.from({ length: branchCount }, (_, i) => {
      // Forks partway up the trunk, tilted out and up at a real angle
      // (never straight up — that would just look like a thinner trunk)
      // and spread evenly around the trunk so the canopy isn't lopsided.
      const forkY = trunkHeight * (0.45 + rng(i * 5 + 2) * 0.3)
      const theta = (i / branchCount) * Math.PI * 2 + (rng(i * 5 + 3) - 0.5) * 1.4
      const tilt = 0.35 + rng(i * 5 + 4) * 0.45
      // Kept short on purpose — this game's camera is a locked top-down
      // view (mesa/mapeditor OrbitControls has no tilt), so a branch long
      // enough to reach past its own leaf clump reads as a bare stick
      // radiating out from the trunk instead of tree structure.
      const length = canopyRadius * (0.55 + rng(i * 5 + 5) * 0.35)
      const dir = new THREE.Vector3(
        Math.sin(tilt) * Math.cos(theta),
        Math.cos(tilt),
        Math.sin(tilt) * Math.sin(theta),
      ).normalize()
      const start = new THREE.Vector3(0, forkY, 0)
      const tip = start.clone().addScaledVector(dir, length)
      return {
        start, dir, length, tip,
        radiusBottom: canopyRadius * (0.05 + rng(i * 5 + 6) * 0.02),
        radiusTop: branchTipRadius,
      }
    })

    // One foliage clump per branch, plus a smaller one near the trunk's
    // own top — weighted so the trunk-top clump reads as a filler, not a
    // 5th equal branch. Centered 60% of the way from fork to tip with a
    // radius scaled to the branch's own length (not canopyRadius) so the
    // clump's leaf cards fully envelop the branch, base to tip, rather
    // than just haloing its tip and leaving the rest exposed.
    const clumpCenters = [
      ...branches.map(b => ({
        pos: b.start.clone().lerp(b.tip, 0.6),
        radius: b.length * 0.7,
        weight: 1,
      })),
      { pos: new THREE.Vector3(0, trunkHeight * 0.98, 0), radius: canopyRadius * 0.3, weight: 0.6 },
    ]
    const totalWeight = clumpCenters.reduce((sum, c) => sum + c.weight, 0)
    const zAxis = new THREE.Vector3(0, 0, 1)
    const cards: { position: [number, number, number]; rotation: [number, number, number]; size: number }[] = []
    clumpCenters.forEach((clump, ci) => {
      const count = Math.max(3, Math.round((density * clump.weight) / totalWeight))
      for (let i = 0; i < count; i++) {
        const salt = ci * 97 + i
        // Small offset within the clump's own volume...
        const rTheta = rng(salt * 3 + 100) * Math.PI * 2
        const rPhi = Math.acos(2 * rng(salt * 3 + 101) - 1)
        const rRadius = clump.radius * (0.4 + rng(salt * 3 + 102) * 0.6)
        const offset = new THREE.Vector3(
          Math.sin(rPhi) * Math.cos(rTheta),
          Math.cos(rPhi) * 0.8,
          Math.sin(rPhi) * Math.sin(rTheta),
        ).multiplyScalar(rRadius)
        // ...but facing outward from the clump's own center (plus a
        // little random wobble) instead of a fully random orientation —
        // fully random rotation let cards land edge-on to the usual
        // near-top-down camera often enough that the clump read as thin
        // scattered debris rather than a rounded leaf mass.
        const wobbleAxis = new THREE.Vector3(
          rng(salt * 3 + 103) - 0.5, rng(salt * 3 + 104) - 0.5, rng(salt * 3 + 105) - 0.5,
        ).normalize()
        const wobble = new THREE.Quaternion().setFromAxisAngle(wobbleAxis, (rng(salt * 3 + 106) - 0.5) * 1.2)
        const quat = new THREE.Quaternion().setFromUnitVectors(zAxis, offset.clone().normalize()).premultiply(wobble)
        const euler = new THREE.Euler().setFromQuaternion(quat)
        const size = canopyRadius * (0.5 + rng(salt * 3 + 107) * 0.45)
        const position = clump.pos.clone().add(offset)
        cards.push({
          position: [position.x, position.y, position.z],
          rotation: [euler.x, euler.y, euler.z],
          size,
        })
      }
    })

    return { branches, cards }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, density, canopyRadius, trunkHeight])

  return (
    <group>
      <mesh position={[0, trunkHeight / 2, 0]} castShadow>
        <cylinderGeometry args={[canopyRadius * 0.09, canopyRadius * 0.14, trunkHeight, 6]} />
        <meshStandardMaterial map={getBarkTexture()} color={BARK_TINT} roughness={0.95} />
      </mesh>
      {branches.map((b, i) => (
        <Branch key={i} start={b.start} dir={b.dir} length={b.length} radiusBottom={b.radiusBottom} radiusTop={b.radiusTop} />
      ))}
      {cards.map((c, i) => (
        <LeafCard key={i} species={species} position={c.position} rotation={c.rotation} size={c.size} />
      ))}
    </group>
  )
}

// A handful of cached, canvas-baked leaf silhouettes (alpha-cutout PNG-
// style textures, same "bake it once, no external asset" approach as
// terrain.ts's procedural patterns) — each a distinct outline (oak-ish
// lobed, simple oval, maple-ish pointed) so fallen leaves actually read
// as leaves instead of the flat solid-colour rectangles ("cuadrados
// amarillos") this replaces. Baked once per shape at module load and
// reused by every LeafLitter instance; only the plane's own tint
// (vertex-free — meshStandardMaterial's own `color`) varies per leaf, so
// one shape serves every autumn hue without rebaking the canvas per colour.
type LeafShape = 'oval' | 'lobed' | 'maple'
const leafTextureCache = new Map<LeafShape, THREE.Texture>()
function drawLeafPath(ctx: CanvasRenderingContext2D, size: number, shape: LeafShape) {
  const c = size / 2
  ctx.beginPath()
  if (shape === 'oval') {
    ctx.ellipse(c, c, size * 0.28, size * 0.46, 0, 0, Math.PI * 2)
  } else if (shape === 'lobed') {
    // A simple 3-lobe oak-ish outline via alternating wide/narrow radii.
    const lobes = 6
    for (let i = 0; i <= lobes; i++) {
      const t = i / lobes
      const ang = -Math.PI / 2 + t * Math.PI
      const wobble = i % 2 === 0 ? 1 : 0.72
      const x = c + Math.sin(ang) * size * 0.32 * wobble
      const y = c - Math.cos(ang) * size * 0.46
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    for (let i = lobes; i >= 0; i--) {
      const t = i / lobes
      const ang = -Math.PI / 2 + t * Math.PI
      const wobble = i % 2 === 0 ? 1 : 0.72
      const x = c - Math.sin(ang) * size * 0.32 * wobble
      const y = c - Math.cos(ang) * size * 0.46
      ctx.lineTo(x, y)
    }
    ctx.closePath()
  } else {
    // Pointed maple-ish diamond-with-shoulders silhouette.
    ctx.moveTo(c, c - size * 0.46)
    ctx.lineTo(c + size * 0.3, c - size * 0.05)
    ctx.lineTo(c + size * 0.16, c + size * 0.12)
    ctx.lineTo(c, c + size * 0.46)
    ctx.lineTo(c - size * 0.16, c + size * 0.12)
    ctx.lineTo(c - size * 0.3, c - size * 0.05)
    ctx.closePath()
  }
}
function getLeafTexture(shape: LeafShape): THREE.Texture {
  const cached = leafTextureCache.get(shape)
  if (cached) return cached
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  drawLeafPath(ctx, size, shape)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  // A faint center vein reads well even at this tiny on-screen size,
  // and costs nothing extra since it's baked into the same texture.
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(size / 2, size * 0.1)
  ctx.lineTo(size / 2, size * 0.9)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(canvas)
  leafTextureCache.set(shape, tex)
  return tex
}

// Fallen-leaf litter (forest) / grass tufts (plains) — thin, cheap,
// scattered by a per-decal hash so they land at a different spot/angle
// each time without needing per-tile state. Deliberately sparse (most
// calls return nothing) per the "sin mucha densidad, desperdigado" ask —
// a light dusting of personality, not a lawn's worth of geometry.
const LEAF_SHAPES: LeafShape[] = ['oval', 'lobed', 'maple']
function LeafLitter({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'leaf-litter')
  if (seed % 100 >= 45) return null
  const count = 1 + (seed % 2)
  const colors = ['#a8702f', '#c78a35', '#8a5a26', '#b5893a', '#d9a441', '#7a4a1f']
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `leaf-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = 0.12 + ((s >>> 8) % 100) / 100 * 0.6
        const size = 0.08 + ((s >>> 16) % 100) / 100 * 0.07
        const shape = LEAF_SHAPES[s % LEAF_SHAPES.length]
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, 0.015, Math.sin(angle) * dist]}
            rotation={[-Math.PI / 2, 0, (s % 628) / 100]}
          >
            <planeGeometry args={[size, size]} />
            <meshStandardMaterial
              map={getLeafTexture(shape)} color={colors[s % colors.length]}
              transparent alphaTest={0.4} side={THREE.DoubleSide}
            />
          </mesh>
        )
      })}
    </group>
  )
}

// Small scattered rocks/gravel — plains' answer to "piedrecitas", also
// used lightly on bare-dirt-variant plains tiles where they read
// naturally as part of the ground. Cheap low-poly icosahedra (never a
// perfect sphere — a rock silhouette needs visible facets), tinted from
// a narrow grey/tan range so a cluster still reads as "stones", not
// confetti.
function Pebbles({ q, r }: { q: number; r: number }) {
  const seed = hashTile(q, r, 'pebbles')
  if (seed % 100 >= 35) return null
  const count = 1 + (seed % 3)
  const colors = ['#8b8378', '#6f6a62', '#a39a8a', '#5f5b54']
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `pebble-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = 0.08 + ((s >>> 8) % 100) / 100 * 0.7
        const size = 0.02 + ((s >>> 16) % 100) / 100 * 0.035
        const flat = 0.55 + ((s >>> 20) % 100) / 100 * 0.3
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * dist, size * flat * 0.5, Math.sin(angle) * dist]}
            rotation={[(s % 628) / 100, ((s >>> 4) % 628) / 100, ((s >>> 9) % 628) / 100]}
            scale={[1, flat, 1]}
            castShadow
          >
            <icosahedronGeometry args={[size, 0]} />
            <meshStandardMaterial color={colors[s % colors.length]} roughness={0.95} flatShading />
          </mesh>
        )
      })}
    </group>
  )
}

// Two visually distinct "species" instead of one repeated blade cluster
// — a fine three-blade tuft (as before) and a bushier, rounder clump —
// each with its own small colour range so a field doesn't read as one
// model copy-pasted. A dirt-variant plains tile (see
// terrain.ts::plainsGroundVariant) gets noticeably sparser grass, since
// bare earth patches shouldn't be as overgrown as the grass tiles around
// them.
// Three visually distinct "species" — a fine three-blade tuft, a
// bushier rounder clump, and a tall sparse dry-grass pair — each with
// its own colour range so a field doesn't read as one model
// copy-pasted. Threshold/count bumped well up from the original "light
// dusting" density per direct feedback ("hay pocas, variedad y
// cantidad") — most plains tiles now carry several clusters, not a
// minority carrying one. A dirt-variant plains tile (see
// terrain.ts::plainsGroundVariant) still gets noticeably sparser grass,
// since bare earth patches shouldn't be as overgrown as the grass tiles
// around them.
function GrassTufts({ q, r, sparse }: { q: number; r: number; sparse: boolean }) {
  const seed = hashTile(q, r, 'grass-tuft')
  const threshold = sparse ? 45 : 92
  if (seed % 100 >= threshold) return null
  const count = (sparse ? 1 : 2) + (seed % 4)
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const s = hashTile(q, r, `tuft-${i}`)
        const angle = (s % 360) * (Math.PI / 180)
        const dist = 0.08 + ((s >>> 8) % 100) / 100 * 0.7
        const bladeScale = 0.7 + ((s >>> 16) % 100) / 100 * 0.5
        const px = Math.cos(angle) * dist
        const pz = Math.sin(angle) * dist
        const species = (s >>> 24) % 3
        if (species === 0) {
          // Bushy round clump — several short blades fanned around a
          // center point.
          const palette = ['#5c8a3f', '#4a7332', '#6b9748']
          const blades = 5
          return (
            <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale * 0.85}>
              {Array.from({ length: blades }, (_, b) => {
                const bAng = (b / blades) * Math.PI * 2
                return (
                  <mesh
                    key={b}
                    position={[Math.cos(bAng) * 0.02, 0.045, Math.sin(bAng) * 0.02]}
                    rotation={[Math.sin(bAng) * 0.3, 0, Math.cos(bAng) * 0.3]}
                    castShadow
                  >
                    <coneGeometry args={[0.012, 0.09, 3]} />
                    <meshStandardMaterial color={palette[b % palette.length]} />
                  </mesh>
                )
              })}
            </group>
          )
        }
        if (species === 1) {
          // Tall, sparse dry-grass pair — thinner and taller than the
          // other two species, pale straw tones instead of green, reads
          // as a different plant entirely rather than the same blade
          // recoloured.
          const palette = ['#a89a4e', '#8f8240', '#b8ab63']
          return (
            <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale * 1.15}>
              {[-1, 1].map((lean) => (
                <mesh key={lean} position={[lean * 0.012, 0.09, 0]} rotation={[0, 0, lean * 0.22]} castShadow>
                  <coneGeometry args={[0.007, 0.18, 3]} />
                  <meshStandardMaterial color={palette[lean === -1 ? 0 : 1]} />
                </mesh>
              ))}
            </group>
          )
        }
        // Fine three-blade tuft — the original species.
        const palette = ['#4d7a3d', '#3f6b34', '#5a8a44']
        return (
          <group key={i} position={[px, 0, pz]} rotation={[0, (s % 628) / 100, 0]} scale={bladeScale}>
            {[-1, 0, 1].map((lean) => (
              <mesh key={lean} position={[lean * 0.015, 0.055, 0]} rotation={[0, 0, lean * 0.35]} castShadow>
                <coneGeometry args={[0.01, 0.11, 3]} />
                <meshStandardMaterial color={palette[lean === 0 ? 0 : 1]} />
              </mesh>
            ))}
          </group>
        )
      })}
    </group>
  )
}

/** Cheap procedural "models" for terrain worth a 3D shape beyond flat
 * colour/texture — forest gets a tree (+ scattered fallen leaves),
 * plains gets scattered grass tufts, building gets a rooftop block.
 * Everything else reads fine from the texture alone; a mesh for those
 * would be decoration without a mechanism. Shape/size/tint vary per tile
 * via a coordinate hash (deterministic — same tile always looks the same,
 * unlike Math.random which would reshuffle on every re-render) so a
 * cluster of trees or buildings doesn't look like one model copy-pasted. */
export function TerrainDecor({ terrain, height, q, r }: { terrain: string; height: number; q: number; r: number }) {
  if (terrain === 'forest' || terrain === 'light_forest') {
    const dense = terrain === 'forest'
    const species = dense ? 'fern' : 'broad'
    const seed = hashTile(q, r, 'forest-decor')
    // Real trees read as much bigger than the old cone/sphere primitives
    // did at the same nominal size — sized up generously per the "se nos
    // han quedado pequeños" ask, dense forest taller still so a dense
    // tile visibly looms over a light one, not just "more leaf cards".
    const trunkHeight = (dense ? 1.5 : 1.0) + ((seed >>> 3) % 100) / 100 * (dense ? 0.5 : 0.35)
    const canopyRadius = (dense ? 0.85 : 0.62) + ((seed >>> 10) % 100) / 100 * 0.2
    const density = dense ? 22 : 13
    const jitterX = (((seed >>> 8) % 100) / 100 - 0.5) * 0.3
    const jitterZ = (((seed >>> 14) % 100) / 100 - 0.5) * 0.3
    const rotY = ((seed >>> 20) % 628) / 100

    // Dense forest gets a second, smaller tree offset from the first —
    // the clearest way to read as genuinely denser canopy rather than
    // "the same single tree, just bigger" like light_forest's one tree.
    const seed2 = hashTile(q, r, 'forest-decor-2')
    const trunkHeight2 = 0.85 + ((seed2 >>> 3) % 100) / 100 * 0.4
    const canopyRadius2 = 0.5 + ((seed2 >>> 10) % 100) / 100 * 0.15
    const jitterX2 = (((seed2 >>> 8) % 100) / 100 - 0.5) * 0.65
    const jitterZ2 = (((seed2 >>> 14) % 100) / 100 - 0.5) * 0.65
    const rotY2 = ((seed2 >>> 20) % 628) / 100

    return (
      <>
        <group position={[jitterX, height, jitterZ]} rotation={[0, rotY, 0]}>
          <TreeBillboard seed={seed} species={species} density={density} trunkHeight={trunkHeight} canopyRadius={canopyRadius} />
        </group>
        {dense && (
          <group position={[jitterX2, height, jitterZ2]} rotation={[0, rotY2, 0]}>
            <TreeBillboard seed={seed2} species={species} density={16} trunkHeight={trunkHeight2} canopyRadius={canopyRadius2} />
          </group>
        )}
        <group position={[0, height, 0]}>
          <LeafLitter q={q} r={r} />
        </group>
      </>
    )
  }
  if (terrain === 'plains') {
    const dirt = plainsGroundVariant(q, r) === 'dirt'
    return (
      <group position={[0, height, 0]}>
        <GrassTufts q={q} r={r} sparse={dirt} />
        <Pebbles q={q} r={r} />
      </group>
    )
  }
  if (terrain === 'building') {
    const kind = buildingKind(q, r)
    const seed = hashTile(q, r, 'building-decor')
    const jitter = (shift: number, spread: number) => ((seed >>> shift) % 100) / 100 * spread
    // The rooftop texture (skylights, AC units, panel grid, or the
    // collapsed/scorched look for ruins) is what actually reads as "a
    // textured building" — it was being drawn on the flat tile underneath
    // and then completely hidden by an opaque, untextured box sitting on
    // top of it. Applying it as the box's own material fixes that.
    const roofMap = terrainTexture('building', q, r)

    if (kind === 0) {
      // clean single tower
      const h = 0.55 + jitter(4, 0.5)
      const fp = 0.75 + jitter(8, 0.25)
      return (
        <mesh position={[0, height + h / 2, 0]} castShadow>
          <boxGeometry args={[fp, h, fp]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
      )
    }
    if (kind === 1) {
      // stepped tower — a smaller plain rooftop-equipment housing on top
      // of the main, fully textured block
      const h1 = 0.4 + jitter(4, 0.3)
      const h2 = 0.25 + jitter(10, 0.25)
      return (
        <group>
          <mesh position={[0, height + h1 / 2, 0]} castShadow>
            <boxGeometry args={[0.85, h1, 0.85]} />
            <meshStandardMaterial map={roofMap} />
          </mesh>
          <mesh position={[0, height + h1 + h2 / 2, 0]} castShadow>
            <boxGeometry args={[0.45, h2, 0.45]} />
            <meshStandardMaterial color="#4d5458" />
          </mesh>
        </group>
      )
    }
    if (kind === 2) {
      // wide low warehouse
      const h = 0.32 + jitter(4, 0.2)
      return (
        <mesh position={[0, height + h / 2, 0]} castShadow>
          <boxGeometry args={[0.95, h, 0.95]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
      )
    }
    // kind 3/4: ruined — an uneven, broken silhouette instead of a clean
    // box, textured with the collapsed/scorched roof (drawBuildingRuined).
    // The small debris chunks stay plain-coloured — they're rubble, not
    // building, so the building texture wouldn't belong on them.
    const mainH = kind === 4 ? 0.12 + jitter(4, 0.15) : 0.3 + jitter(4, 0.3)
    return (
      <group>
        <mesh position={[0, height + mainH / 2, 0]} rotation={[0, jitter(0, 0.3), 0]} castShadow>
          <boxGeometry args={[0.7, mainH, 0.7]} />
          <meshStandardMaterial map={roofMap} />
        </mesh>
        <mesh position={[0.3, height + 0.08, 0.2]} rotation={[0.15, 0.4, 0.1]} castShadow>
          <boxGeometry args={[0.3, 0.16, 0.3]} />
          <meshStandardMaterial color="#4a4038" />
        </mesh>
        <mesh position={[-0.25, height + 0.06, -0.25]} rotation={[-0.1, 0.8, 0.2]} castShadow>
          <boxGeometry args={[0.25, 0.12, 0.25]} />
          <meshStandardMaterial color="#443a34" />
        </mesh>
      </group>
    )
  }
  return null
}
