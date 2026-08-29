import { useEffect, useMemo, useRef } from 'react'
import { useLoader } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { HexTileData } from '../api'
import { HEX_SIZE, hexToWorld } from '../hexMath'
import { groundVariant, hashTile, terrainColor, type GroundVariant } from '../terrain'
import { GRASS_COVER, isGrassTerrain, makeGrassDensitySampler, treeGroveAt } from '../grassPatches'
import { makeTileHeightSampler } from '../tileHeightField'
import { useProfiledFrame } from './PerfProbe'

/** Real user request: "necesito que encuentres y descargues packs de
 * vegetacion, plantas, arbustos, decoracion para estas tiles, ten en cuenta
 * que ahora son hexes de 30m de lado... esa vegetacion debe moverse como
 * movida por el viento... predominaran hierbas y arbustos... quiero que sean
 * procedurales y que sean pequeños dioramas."
 *
 * Real scanned plants (Poly Haven, CC0 — see public/textures/CREDITS.md),
 * scattered over every plains/hills tile.
 *
 * ONE component for the whole board rather than a per-tile one like
 * TerrainDecor, because the only way this is affordable is instancing: a
 * 30m hex is big enough to want dozens of plants, and a map has hundreds of
 * tiles, so the honest count is tens of thousands of plants. As separate
 * meshes that is tens of thousands of draw calls and a certain freeze (this
 * project has already had one, from far fewer trees). Grouped into one
 * InstancedMesh per plant variant it is a couple of dozen draw calls total,
 * no matter how many tiles the map has.
 *
 * The triangle budget is what actually shapes the mix below, and it is why
 * the species are split into tiers rather than scattered evenly:
 * `grass_bermuda_01` is ~45 triangles per variant, so it can carry the dense
 * ground cover at forty-odd per tile for almost nothing, while a real shrub
 * is ~2.7k and has to be counted in ones and twos. Spreading the same number
 * of every species would cost roughly thirty times as much for a worse
 * result. */

const VEG = '/models/vegetation/'
const TREE = '/models/trees/'

/** Terrain that gets something other than grass, and only that.
 *
 * Real user request: "en el agua NO DEBE HABER parches de hierba... solo
 * alguna que otra roca." A riverbed is not a lawn, but it is not bare
 * either — there are stones in it. Listing the tiers explicitly (rather
 * than reusing a grassland density and hoping) is what guarantees no grass
 * tier can ever appear here by accident: anything not named simply does not
 * get placed.
 *
 * Deep water gets fewer, because less of a deep channel's bed is close
 * enough to the surface to read through it at all. */
const TERRAIN_ONLY_TIERS: Record<string, Partial<Record<Tier, number>>> = {
  water: { prop: 1.1 },
  water_deep: { prop: 0.5 },
}

/** Which terrain grows ground cover, and how completely, is grassPatches.ts's
 * GRASS_COVER — shared with the ground shading so the two cannot disagree
 * about where the grass is. TERRAIN_ONLY_TIERS adds terrain that gets props
 * WITHOUT grass; the carpet checks GRASS_COVER separately, so nothing here
 * can put grass on water. */
const VEGETATED = {
  has: (terrain: string) => isGrassTerrain(terrain) || terrain in TERRAIN_ONLY_TIERS,
}

type Tier = 'cover' | 'grass' | 'herb' | 'shrub' | 'prop' | 'sapling' | 'tree' | 'hero'

interface Species {
  /** Model file. Each holds several named variants (Poly Haven ships them
   * laid out side by side in one scene), all sharing one material — which is
   * exactly the shape instancing wants: one material, many geometries. */
  url: string
  tier: Tier
  /** Target height in metres. The board is 1 unit = 1 metre (HEX_SIZE 30 is
   * a 30m hex side), and every instance is scaled so the model reaches this
   * height whatever it measured in the scan.
   *
   * Sizing by target rather than by a multiplier is not tidiness: these
   * models range from 3cm of moss to a 1.26m rock, so one "scale" number
   * means something completely different per species — guessing them by eye
   * put half the set at invisible sizes on the first attempt. Everything
   * stays at real BattleTech scale, per "todo debe estar a escala
   * battletech asi que tiene sentido que sea pequeño". */
  height: number
  /** Per-instance size spread, as a fraction of `height`. */
  spread: number
  /** How far the top of the plant travels in the wind, in world units. 0
   * for anything rigid (rocks, stumps, dead wood). */
  sway: number
  /** Treat every mesh in the file as ONE model rather than as separate
   * variants.
   *
   * The scanned plants each pack several independent specimens into one file,
   * which is why a mesh is normally a variant. A tree is the opposite: its
   * trunk, bark and leaves are separate meshes OF THE SAME TREE, and picking
   * one of them would plant a bare trunk here and a floating canopy there. */
  whole?: boolean
  /** How far to bury the model, as a fraction of its height.
   *
   * These trees are modelled with their full root systems, which otherwise
   * sit proud of the ground like a potted plant. Measured off the renders,
   * the roots run about 18% of the total height below the trunk's flare, so
   * burying that much puts the flare at ground level, which is where a real
   * trunk meets the soil. */
  sink?: number
}

const SPECIES: Record<string, Species> = {
  // --- sparse 3D ground detail. The dense carpet is NOT made of these (see
  // GrassCarpet below): at 45 triangles a tuft, covering ground with them
  // costs an order of magnitude more than it is worth. These sit on top of
  // the carpet as occasional real, lit, three-dimensional clumps.
  bermuda: { url: `${VEG}grass_bermuda_01.glb`, tier: 'cover', height: 0.30, spread: 0.5, sway: 0.05 },
  moss: { url: `${VEG}moss_01.glb`, tier: 'cover', height: 0.16, spread: 0.5, sway: 0 },
  grassMedium: { url: `${VEG}grass_medium_01.glb`, tier: 'grass', height: 0.85, spread: 0.45, sway: 0.16 },
  grassTufts: { url: `${VEG}grass_medium_02.glb`, tier: 'grass', height: 0.75, spread: 0.45, sway: 0.15 },
  weeds: { url: `${VEG}weed_plant_02.glb`, tier: 'herb', height: 0.55, spread: 0.4, sway: 0.12 },
  celandine: { url: `${VEG}celandine_01.glb`, tier: 'herb', height: 0.5, spread: 0.4, sway: 0.11 },
  dandelion: { url: `${VEG}dandelion_01.glb`, tier: 'herb', height: 0.55, spread: 0.4, sway: 0.13 },
  shrubLow: { url: `${VEG}shrub_03.glb`, tier: 'shrub', height: 1.1, spread: 0.35, sway: 0.10 },
  shrubMid: { url: `${VEG}shrub_02.glb`, tier: 'shrub', height: 1.6, spread: 0.35, sway: 0.12 },
  shrubBig: { url: `${VEG}shrub_04.glb`, tier: 'shrub', height: 2.1, spread: 0.3, sway: 0.10 },
  sapling: { url: `${VEG}pine_sapling_small.glb`, tier: 'sapling', height: 4.5, spread: 0.3, sway: 0.08 },
  stump: { url: `${VEG}tree_stump_01.glb`, tier: 'prop', height: 1.3, spread: 0.25, sway: 0 },
  branches: { url: `${VEG}dry_branches_medium_01.glb`, tier: 'prop', height: 0.6, spread: 0.3, sway: 0 },
  stone: { url: `${VEG}stone_01.glb`, tier: 'prop', height: 0.7, spread: 0.4, sway: 0 },
  rocks: { url: `${VEG}rock_moss_set_01.glb`, tier: 'prop', height: 1.5, spread: 0.45, sway: 0 },

  // --- Real trees, converted from the project's own archviz FBX set (see
  // public/models/trees and the conversion notes in CREDITS.md). All five are
  // members of ONE nine-variant set of European deciduous trees, which is
  // where their consistency comes from; the variety comes from using several
  // of them and from per-instance rotation and scale.
  //
  // They are expensive — around 100k triangles each, measured — so they are
  // placed in ones and twos, not scattered. Filling a forest needs a cheaper
  // canopy than real leaf cards can give.
  treeA: { url: `${TREE}eu43-1-mass.glb`, tier: 'tree', height: 14, spread: 0.28, sway: 0.30, whole: true, sink: 0.18 },
  treeB: { url: `${TREE}eu43-4-mass.glb`, tier: 'tree', height: 15, spread: 0.28, sway: 0.30, whole: true, sink: 0.18 },
  treeC: { url: `${TREE}eu43-5-mass.glb`, tier: 'tree', height: 13, spread: 0.28, sway: 0.30, whole: true, sink: 0.18 },
  treeD: { url: `${TREE}eu43-7-mass.glb`, tier: 'tree', height: 14, spread: 0.28, sway: 0.30, whole: true, sink: 0.18 },
  // The two biggest, placed rarely, to break the canopy line.
  heroA: { url: `${TREE}eu43-3.glb`, tier: 'hero', height: 29, spread: 0.2, sway: 0.24, whole: true, sink: 0.18 },
  heroB: { url: `${TREE}eu43-5.glb`, tier: 'hero', height: 33, spread: 0.2, sway: 0.24, whole: true, sink: 0.18 },
}

type SpeciesKey = keyof typeof SPECIES

/** One drawable variant: a single plant's geometry, recentred so its base
 * sits at the origin, plus which species it came from. */
interface Variant {
  species: SpeciesKey
  index: number
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Model-space height, needed by the wind shader to know how far up a
   * given vertex is and therefore how much it should lean. */
  height: number
}

/** Pulls every mesh out of a loaded model as an independent variant.
 *
 * Two things have to be undone from the source file. Poly Haven lays its
 * variants out in a ROW in one scene, so each carries a translation that has
 * to be baked out or every instance would render metres away from where it
 * was placed; and the pieces sit on their own local origins, so each is
 * recentred in XZ and dropped to y=0 at its base, which is what lets a
 * placement be "put this at this point on the ground" rather than needing to
 * know each model's own quirks. */
function extractVariants(scene: THREE.Object3D, species: SpeciesKey, whole: boolean): Variant[] {
  const out: Variant[] = []
  const geometries: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = []
  scene.updateWorldMatrix(true, true)
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry.clone()
    geometry.applyMatrix4(mesh.matrixWorld)
    geometry.computeBoundingBox()
    geometries.push({
      geometry,
      material: Array.isArray(mesh.material) ? mesh.material[0] : mesh.material,
    })
  })
  if (whole) {
    // ONE origin for the whole model. Re-basing each mesh on its own bounds,
    // which is right for a file of separate specimens, is wrong here and
    // wrong twice over: it drops the canopy to ground level beside its own
    // trunk, and it measures the model's height from the tallest PART rather
    // than from the tree, which made every tree come out several times too
    // big.
    const union = new THREE.Box3()
    for (const g of geometries) union.union(g.geometry.boundingBox!)
    const dx = -(union.min.x + union.max.x) / 2
    const dy = -union.min.y
    const dz = -(union.min.z + union.max.z) / 2
    const height = Math.max(0.01, union.max.y - union.min.y)
    for (const g of geometries) {
      g.geometry.translate(dx, dy, dz)
      g.geometry.computeBoundingBox()
      out.push({ species, index: out.length, geometry: g.geometry, material: g.material, height })
    }
    return out
  }
  for (const g of geometries) {
    const bb = g.geometry.boundingBox!
    g.geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
    g.geometry.computeBoundingBox()
    out.push({
      species, index: out.length, geometry: g.geometry, material: g.material,
      height: Math.max(0.01, bb.max.y - bb.min.y),
    })
  }
  return out
}

/** Wind, as a small vertex displacement patched into the plant's own
 * material rather than a hand-written replacement for it.
 *
 * Deliberately `onBeforeCompile` on the real scanned material, NOT a custom
 * ShaderMaterial: these are photogrammetry plants whose whole value is their
 * real albedo/normal/roughness maps under the scene's real lights, and
 * rewriting the shader would mean reimplementing all of that (an earlier
 * hand-rolled terrain shader in this project shipped visibly broken for
 * exactly this kind of reason). This only adds a few lines to the vertex
 * stage and leaves the lighting untouched.
 *
 * The lean is proportional to `y` over the plant's own height, raised to a
 * power so the base stays planted and the motion concentrates in the tips —
 * a stalk bending, not a whole plant sliding. Phase comes from the INSTANCE's
 * own world position (`instanceMatrix`'s translation column), so twenty
 * thousand plants sharing one material still each move on their own beat;
 * without it the entire field would sway as one rigid sheet. Two different
 * frequencies on x and z keep it from reading as a flat back-and-forth. */
/** The wind, as a patch on whatever material a scanned plant arrived with.
 *
 * A plant's height, its sway and its tone spread used to be uniforms, which
 * meant one material per variant and therefore one draw call per variant —
 * 128 of them for 4.933 instances across just 25 textures. They are vertex
 * ATTRIBUTES now, constant across a geometry but carried in the mesh, so
 * every variant that shares a texture can share one material and ride in a
 * single BatchedMesh. Nothing about the motion changed; only where the
 * three numbers live. */
function makeWindMaterial(source: THREE.Material) {
  const material = (source as THREE.MeshStandardMaterial).clone()
  const uniforms = {
    uTime: { value: 0 },
  }
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float aPlantHeight;
        attribute float aSway;
        attribute float aTint;
        varying float vTreeTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Where this copy of the plant stands. BatchedMesh keeps its
        // per-instance transform in batchingMatrix (declared by the
        // batching_vertex chunk, which three includes ahead of this one);
        // InstancedMesh keeps it in instanceMatrix. Both spellings stay
        // because the grass carpet still instances.
        #ifdef USE_BATCHING
          vec3 instOrigin = batchingMatrix[3].xyz;
        #elif defined(USE_INSTANCING)
          vec3 instOrigin = instanceMatrix[3].xyz;
        #else
          vec3 instOrigin = vec3(0.0);
        #endif
        float lean = pow(clamp(transformed.y / aPlantHeight, 0.0, 1.0), 1.6);
        // Hashed per instance, not a linear ramp — see the carpet material
        // for why a linear phase is a plane wave and shows up as scrolling
        // stripes rather than as decorrelated plants.
        float phase = fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        // Two crossing waves rather than one plane wave — see the carpet's
        // own material for why a single one shows up as a straight bar
        // sweeping the board from a top-down camera.
        float g1 = sin(uTime * 0.37 + instOrigin.x * 0.0027 + instOrigin.z * 0.0019);
        float g2 = sin(uTime * 0.24 - instOrigin.x * 0.0016 + instOrigin.z * 0.0034);
        float gust = 0.68 + 0.28 * (g1 * 0.6 + g2 * 0.4);
        transformed.x += sin(uTime * 1.7 + phase) * lean * aSway * gust;
        transformed.z += cos(uTime * 1.3 + phase * 0.7) * lean * aSway * gust * 0.6;
        // Per-instance tone. Real user report: a stand of the same model
        // reads as one colour stamped over and over, however the geometry is
        // varied. Hashing a shade out of the instance's own position costs
        // nothing (no per-instance colour buffer, no extra draw call) and is
        // what turns a repeated model into a mixed wood. The three channels
        // are shifted by different amounts so it varies in hue as well as in
        // brightness, which is how real foliage differs tree to tree.
        vTreeTint = 1.0 + (fract(sin(dot(instOrigin.xz, vec2(41.13, 289.7))) * 24634.63) - 0.5) * aTint;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTreeTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vec3(vTreeTint, mix(1.0, vTreeTint, 0.72), mix(1.0, vTreeTint, 1.3));`)
  }
  // Scanned foliage has no business looking wet or plastic, and these
  // materials arrive with whatever the scan pipeline defaulted to.
  material.roughness = Math.min(1, (material.roughness ?? 1) * 1.15)
  material.metalness = 0
  // Real scanned plants are thin, single-sided shells; without this the
  // blades vanish from whichever side the camera happens to be on.
  material.side = THREE.DoubleSide
  return { material, uniforms }
}

/** How many of each tier a tile gets, by which ground patch it is (see
 * terrain.ts's groundVariant). Bare earth is not bare of everything — it
 * gets the weeds and stones that colonise a worn patch, just very little
 * grass; a meadow is the lush end. */
/** Real user spec, per ground patch: "las verdes claras tendran algo de
 * hierba con alguna roca, las verdes oscuras estaran practicamente tapadas
 * con alguna roca, y las de tierra tendran poco arbusto disperso y mas
 * rocas." */
const DENSITY: Record<GroundVariant, Partial<Record<Tier, number>>> = {
  grassDark: { cover: 22, grass: 30, herb: 12, shrub: 2.6, prop: 0.8, sapling: 0.12 },
  grassLight: { cover: 10, grass: 11, herb: 5, shrub: 1.6, prop: 1.0, sapling: 0.10 },
  earth: { cover: 2, grass: 1.5, herb: 1.5, shrub: 1.2, prop: 2.6, sapling: 0.03 },
}

/** Grass cards per tile — the layer that actually makes the ground "tupido".
 *
 * A 30m hex is ~2340 m². Genuinely covering that with scanned grass geometry
 * is tens of thousands of clumps PER TILE, which no amount of instancing
 * reaches; the base coverage keeps coming from the ground photo underneath.
 * What these buy is what a photo cannot do — real silhouettes breaking the
 * ground line, parallax as the camera moves, and wind. At four triangles a
 * card they are affordable in the thousands per tile, where a scanned clump
 * is affordable in the dozens. */
const CARPET_DENSITY: Record<GroundVariant, number> = { grassDark: 15000, grassLight: 6500, earth: 900 }

/** Forest floors do not draw from the three ground photos, so their density
 * is set by TERRAIN instead of by which photo the tile picked. Dense forest
 * gets the same candidate count as the thickest grassland and then skips the
 * patch field entirely (GRASS_COVER), which is what turns it into full
 * cover; light forest is asked to be exactly the dark-grass plains case. */
const CARPET_DENSITY_BY_TERRAIN: Record<string, number> = {
  forest: 15000,
  light_forest: 15000,
}

function carpetDensity(tile: HexTileData): number {
  return CARPET_DENSITY_BY_TERRAIN[tile.terrain] ?? CARPET_DENSITY[groundVariant(tile.q, tile.r)]
}

/** Same idea for the scattered 3D plants: a forest floor is read as the
 * lushest grassland case rather than as whatever the noise field would have
 * called the ground under the trees. */
const PLANT_DENSITY_TERRAIN: Record<string, GroundVariant> = {
  forest: 'grassDark',
  light_forest: 'grassDark',
}

/** Where the grass actually grows is decided by the shared patch field in
 * grassPatches.ts, not here — the ground mesh shades the soil under a mat
 * from the very same field, and two independent versions of "where is the
 * grass thick" would drift apart and put the tint under nothing. The number
 * above is therefore CANDIDATES, most of which that field rejects. */
const CARPET_MEAN_KEEP = 0.45

/** Hard ceiling on carpet cards for the WHOLE board, whatever the map size.
 * Per-tile density is scaled down uniformly if a map would blow through it,
 * so a huge map degrades to thinner grass instead of to an unusable frame
 * rate — this layer's cost stops depending on how big a map someone builds.
 * 520k cards is ~2M triangles, in ONE draw call. */
const CARPET_MAX_CARDS = 900000

const TIER_SPECIES: Record<Tier, SpeciesKey[]> = {
  cover: ['bermuda', 'moss'],
  grass: ['grassMedium', 'grassTufts'],
  herb: ['weeds', 'celandine', 'dandelion'],
  shrub: ['shrubLow', 'shrubMid', 'shrubBig'],
  prop: ['stone', 'rocks', 'branches', 'stump'],
  sapling: ['sapling'],
  tree: ['treeA', 'treeB', 'treeC', 'treeD'],
  hero: ['heroA', 'heroB'],
}

/** Tiers a terrain gets ON TOP of whatever its ground patch already grows.
 *
 * Trees belong to the terrain, not to the ground under it: a forest hex has
 * trees because it is a forest, not because the noise field happened to call
 * its soil dark. Kept separate from DENSITY for that reason, and so plains
 * can never sprout a forest by accident.
 *
 * A dense hex now carries nine trees and a light one three or four, which is
 * a wood rather than a garden. That only became affordable with the mass
 * build's cluster canopy: same trunk and same leaf texture, but the canopy
 * rebuilt as a few hundred cluster cards instead of thousands of individual
 * leaves, which is 4-20k triangles against ~100k for the same tree's hero
 * build. At the hero cost these counts would be tens of millions of
 * triangles a frame.
 *
 * The heroes stay rare on purpose. They keep their real leaves, they are
 * there to break the canopy line, and one of them still costs as much as
 * twenty-five of its neighbours put together.
 *
 * They also have to be much TALLER than the mass trees, not slightly. Real
 * user report: at similar heights they were indistinguishable, so the whole
 * board read as one kind of tree and the expensive ones were paying for
 * detail nobody could find. Standing head and shoulders over the canopy is
 * what makes a hero legible as a hero. */
const TERRAIN_EXTRA_TIERS: Record<string, Partial<Record<Tier, number>>> = {
  // Candidates, not trees. The crown test below turns most of them away, and
  // asking for far more than can fit is what makes the tile end up as full as
  // its own geometry allows rather than as full as a guess.
  forest: { tree: 90, hero: 1.2 },
  light_forest: { tree: 16, hero: 0.35 },
}

/** Tiers whose placements are CANDIDATES, thinned by the grove field so trees
 * land in stands with clearings between them rather than evenly spaced like
 * an orchard (real user request: "quiero los arboles en grupos como lo que
 * hicimos con la hierba"). Roughly 55% of candidates survive on average, so
 * the counts above are set correspondingly higher than the trees actually
 * wanted. */
const GROUPED_TIERS = new Set<Tier>(['tree', 'hero'])

/** How wide a tree's canopy is, as a fraction of its height, and how much of
 * that width two neighbours may share.
 *
 * Real user request: "quiero esa cantidad de arboles pero que las copas no
 * choquen, que se toquen." Purely random placement inside a tile has trees
 * landing on top of each other, which from the ground reads as one confused
 * green mass rather than as individual trees. Rejecting any candidate that
 * lands too close to one already placed (dart throwing) spaces them out
 * without imposing a grid, and it is self-regulating: ask for thirty, get
 * however many genuinely fit.
 *
 * TOUCH under 1 is what makes the crowns touch rather than merely clear each
 * other -- at 1 they would stand a full canopy apart, which is a park, not a
 * wood. */
const CANOPY_WIDTH = 0.55
const CANOPY_TOUCH = 0.7

/** Bare earth's props are stone, not deadfall — "las de tierra tendran poco
 * arbusto disperso y mas rocas". Weighted by repetition rather than by a
 * separate weight table, which keeps the pick a plain modulo. */
const EARTH_PROPS: SpeciesKey[] = ['rocks', 'rocks', 'stone', 'stone', 'branches']

/** A riverbed's own props: water-worn stone, no dead wood or stumps —
 * those would be floating debris, not bed. */
const WATER_PROPS: SpeciesKey[] = ['rocks', 'stone']

/** Real user request: "quiero que sean procedurales y que sean pequeños
 * dioramas."
 *
 * Scattering every species independently gives an even, soup-like mix where
 * nothing means anything. A diorama is the opposite: a small number of tiles
 * get one COMPOSED scene instead — a rotting stump with dead branches, moss
 * and weeds crowding it; a mossy rock outcrop; a thicket; a patch in bloom.
 * Each is a recipe of what to place, how many, and how tightly clustered,
 * dropped at one spot on the tile with the ordinary scatter carrying on
 * around it. That contrast (a dense, deliberate little scene inside an
 * otherwise loose field) is what makes it read as a place rather than as
 * decoration. */
interface DioramaPart { species: SpeciesKey; count: number; radius: number; scale?: number }
const DIORAMAS: { key: string; weight: number; parts: DioramaPart[] }[] = [
  {
    key: 'deadfall',
    weight: 3,
    parts: [
      { species: 'stump', count: 1, radius: 0, scale: 1.25 },
      { species: 'branches', count: 2, radius: 3.2 },
      { species: 'moss', count: 7, radius: 3.6 },
      { species: 'weeds', count: 3, radius: 3.8 },
      { species: 'grassMedium', count: 3, radius: 4.4 },
    ],
  },
  {
    key: 'outcrop',
    weight: 3,
    parts: [
      { species: 'rocks', count: 3, radius: 2.6, scale: 1.3 },
      { species: 'stone', count: 1, radius: 1.6, scale: 1.2 },
      { species: 'moss', count: 8, radius: 3.4 },
      { species: 'grassTufts', count: 4, radius: 4.2 },
    ],
  },
  {
    key: 'thicket',
    weight: 3,
    parts: [
      { species: 'shrubBig', count: 1, radius: 0.8, scale: 1.2 },
      { species: 'shrubMid', count: 3, radius: 3.0 },
      { species: 'shrubLow', count: 3, radius: 3.6 },
      { species: 'grassMedium', count: 4, radius: 4.4 },
    ],
  },
  {
    key: 'bloom',
    weight: 2,
    parts: [
      { species: 'dandelion', count: 7, radius: 3.6 },
      { species: 'celandine', count: 6, radius: 4.0 },
      { species: 'grassTufts', count: 5, radius: 4.4 },
    ],
  },
  {
    key: 'lonetree',
    weight: 2,
    parts: [
      { species: 'sapling', count: 1, radius: 0, scale: 1.35 },
      { species: 'grassMedium', count: 5, radius: 4.0 },
      { species: 'shrubLow', count: 2, radius: 4.4 },
      { species: 'moss', count: 4, radius: 3.0 },
    ],
  },
]
const DIORAMA_TOTAL_WEIGHT = DIORAMAS.reduce((n, d) => n + d.weight, 0)
/** Roughly one tile in eight. Often enough to find them while looking around
 * a map, rare enough that they stay a find rather than a pattern. */
const DIORAMA_CHANCE = 0.13

/** Placement radius for the ordinary scatter, as a fraction of the apothem —
 * kept inside the tile so nothing ever straddles a border and floats over a
 * neighbour that sits at a different height. */
const SCATTER_RADIUS = HEX_SIZE * 0.72
/** Trunks may stand almost to the tile's own edge, since only the trunk has
 * to belong to the tile. Just short of the apothem so a trunk never lands in
 * the groove between hexes. */
const TRUNK_RADIUS = HEX_SIZE * Math.cos(Math.PI / 6) * 0.94

interface Placement { species: SpeciesKey; variantPick: number; x: number; z: number; rotY: number; scale: number }

/** A deterministic 0..1 stream from a tile's own coordinates — same tile
 * always grows the same plants in the same spots, across reloads and
 * re-renders alike (Math.random would reshuffle the whole map on every
 * React re-render). */
function rand(q: number, r: number, salt: string, i: number): number {
  return (hashTile(q, r, `${salt}-${i}`) % 100000) / 100000
}

function placeTile(tile: HexTileData): Placement[] {
  const { q, r } = tile
  const variant = PLANT_DENSITY_TERRAIN[tile.terrain] ?? groundVariant(q, r)
  // Terrain listed here gets ONLY the tiers it names — a riverbed's stones,
  // and nothing else. Everything else takes the full grassland mix.
  const only = TERRAIN_ONLY_TIERS[tile.terrain]
  const empty: Record<Tier, number> = {
    cover: 0, grass: 0, herb: 0, shrub: 0, prop: 0, sapling: 0, tree: 0, hero: 0,
  }
  const density: Record<Tier, number> = only
    ? { ...empty, ...only }
    : { ...empty, ...DENSITY[variant], ...(TERRAIN_EXTRA_TIERS[tile.terrain] ?? {}) }
  const out: Placement[] = []
  // Crowns already claimed on this tile, so the next tree can be turned away
  // if it would grow inside one. Tile-local: a tree just over the border in
  // the next hex is not accounted for, which shows up as the occasional
  // close pair at a seam and is not worth carrying neighbour state for.
  const crowns: { x: number; z: number; r: number }[] = []
  let n = 0

  const push = (species: SpeciesKey, x: number, z: number, scaleMul: number) => {
    const s = SPECIES[species]
    const j = rand(q, r, 'veg-size', n)
    out.push({
      species,
      variantPick: hashTile(q, r, `veg-pick-${n}`),
      x,
      z,
      rotY: rand(q, r, 'veg-rot', n) * Math.PI * 2,
      // Target height; the variant's own measured height turns it into a
      // real scale factor when the matrix is built.
      scale: s.height * (1 - s.spread / 2 + j * s.spread) * scaleMul,
    })
    n++
  }

  // Ordinary scatter. Fractional densities are a real probability, not a
  // rounding error: 1.4 shrubs means one for sure and a 40% chance of a
  // second, which across a map is what stops every tile looking equally
  // populated.
  // Heroes before the mass trees, deliberately. Both compete for the same
  // ground through the crown test below, and whichever runs first wins it --
  // so with the mass trees going first a hero, whose crown is the widest
  // thing on the tile, was being turned away almost every time. Real user
  // report: "los arboles heroe han desaparecido." They are the anchors of a
  // stand; the rest fills in around them.
  const tierOrder: Tier[] = ['hero', 'tree', 'cover', 'grass', 'herb', 'shrub', 'prop', 'sapling']
  for (const tier of tierOrder) {
    const want = density[tier]
    const count = Math.floor(want) + (rand(q, r, `veg-frac-${tier}`, 0) < want % 1 ? 1 : 0)
    const pool = tier === 'prop'
      ? (only ? WATER_PROPS : variant === 'earth' ? EARTH_PROPS : TIER_SPECIES[tier])
      : TIER_SPECIES[tier]
    for (let i = 0; i < count; i++) {
      // Square root on the radius spreads points evenly over the disc
      // instead of bunching them at the centre, which is what a plain
      // uniform radius would do.
      const angle = rand(q, r, `veg-a-${tier}`, i) * Math.PI * 2
      // Trees stand anywhere on the tile; everything else keeps to the
      // inscribed disc. Real user clarification: "lo que tiene que entrar en
      // el patch es el tronco no la copa" -- a crown may hang over the border
      // like a real one does, and confining the TRUNK to a disc inside the
      // hex was leaving a bare ring around every tile.
      const reach = GROUPED_TIERS.has(tier) ? TRUNK_RADIUS : SCATTER_RADIUS
      const dist = Math.sqrt(rand(q, r, `veg-d-${tier}`, i)) * reach
      const px = Math.cos(angle) * dist
      const pz = Math.sin(angle) * dist
      const species = pool[hashTile(q, r, `veg-s-${tier}-${i}`) % pool.length]
      if (GROUPED_TIERS.has(tier)) {
        const [wx, wz] = hexToWorld(q, r)
        if (rand(q, r, `veg-grove-${tier}`, i) > treeGroveAt(wx + px, wz + pz)) continue
        const radius = SPECIES[species].height * CANOPY_WIDTH * CANOPY_TOUCH
        let clash = false
        for (const c of crowns) {
          if (Math.hypot(px - c.x, pz - c.z) < radius + c.r) { clash = true; break }
        }
        if (clash) continue
        crowns.push({ x: px, z: pz, r: radius })
      }
      push(species, px, pz, 1)
    }
  }

  // ...and, on a minority of tiles, one composed diorama on top of it.
  // Not on terrain with an explicit tier list: every diorama recipe is built
  // out of grassland species, and a stump with weeds around it on a riverbed
  // would be exactly the grass this terrain is not supposed to have.
  if (!only && rand(q, r, 'diorama-roll', 0) < DIORAMA_CHANCE) {
    let pickWeight = rand(q, r, 'diorama-kind', 0) * DIORAMA_TOTAL_WEIGHT
    const diorama = DIORAMAS.find((d) => (pickWeight -= d.weight) < 0) ?? DIORAMAS[0]
    const centreAngle = rand(q, r, 'diorama-pos', 0) * Math.PI * 2
    const centreDist = rand(q, r, 'diorama-pos', 1) * SCATTER_RADIUS * 0.5
    const cx = Math.cos(centreAngle) * centreDist
    const cz = Math.sin(centreAngle) * centreDist
    for (const part of diorama.parts) {
      for (let i = 0; i < part.count; i++) {
        const a = rand(q, r, `${diorama.key}-a-${part.species}`, i) * Math.PI * 2
        const d = Math.sqrt(rand(q, r, `${diorama.key}-d-${part.species}`, i)) * part.radius
        push(part.species, cx + Math.cos(a) * d, cz + Math.sin(a) * d, part.scale ?? 1)
      }
    }
  }
  return out
}


/** Resolution of the per-tile height grid below. 12 spans a 30m hex at ~5m
 * steps, which is finer than any real slope changes over. */
/** A fast deterministic 0..1 stream for one tile. xorshift rather than a
 * fresh hash per draw, because the carpet pulls five numbers per card and
 * hashing each one turns into real time at half a million cards. */
function makeTileRng(q: number, r: number, salt: string) {
  let state = hashTile(q, r, salt) | 0
  if (state === 0) state = 0x6d2b79f5
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1000000) / 1000000
  }
}


// ---------------------------------------------------------------------------
// The dense layer: grass cards
// ---------------------------------------------------------------------------

/** A tuft of blades painted into an alpha texture, drawn on two crossed
 * quads. Four triangles per tuft against a scanned clump's forty-five, which
 * is the entire reason the ground can be thick with grass at all: the same
 * triangle budget buys roughly ten times as many plants.
 *
 * Painted procedurally rather than shipped as an image — same approach the
 * project's other alpha-mapped foliage already uses — so it costs no download
 * and its colours can be tuned against the ground photo directly. */
let grassCardTexture: THREE.CanvasTexture | null = null
function getGrassCardTexture(): THREE.CanvasTexture {
  if (grassCardTexture) return grassCardTexture
  const W = 128
  const H = 128
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  // Deterministic: the same tuft image every load, so nothing about the
  // board's look depends on when it was opened.
  let seed = 0x9e3779b9
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return ((seed >>> 0) % 100000) / 100000
  }
  const BLADES = 11
  for (let i = 0; i < BLADES; i++) {
    // Blades fan out from a base clustered near the middle of the card, so a
    // tuft reads as one plant rather than as a hedge of parallel strips.
    const baseX = W * (0.5 + (rnd() - 0.5) * 0.62)
    const tipX = baseX + (rnd() - 0.5) * W * 0.55
    const tipY = H * (0.06 + rnd() * 0.42)
    const halfWidth = W * (0.018 + rnd() * 0.022)
    // Greens picked around the ground photo's own mean (68,92,40) and spread
    // either side of it, so the geometry and the texture underneath read as
    // the same species of grass rather than two different plants.
    const shade = 0.72 + rnd() * 0.55
    ctx.fillStyle = `rgb(${Math.round(74 * shade)}, ${Math.round(104 * shade)}, ${Math.round(44 * shade)})`
    ctx.beginPath()
    ctx.moveTo(baseX - halfWidth, H)
    ctx.quadraticCurveTo(baseX - halfWidth * 0.6, H * 0.55, tipX, tipY)
    ctx.quadraticCurveTo(baseX + halfWidth * 0.6, H * 0.55, baseX + halfWidth, H)
    ctx.closePath()
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  // Same anisotropy fix every other texture in this project needed — without
  // it, thousands of these at a distance alias into speckle.
  tex.anisotropy = 16
  grassCardTexture = tex
  return tex
}

/** Two quads crossed at right angles, base at y=0, one unit tall and one unit
 * wide, so an instance matrix can scale it straight into metres.
 *
 * Normals point straight UP rather than out of each quad's face. That is
 * deliberate and standard for foliage cards: with real face normals the two
 * quads light completely differently from each other and a field of them
 * turns into a patchwork of bright and black slivers. Borrowing the ground's
 * own normal makes every blade take light the way the ground under it does. */
let grassCardGeometry: THREE.BufferGeometry | null = null
function getGrassCardGeometry(): THREE.BufferGeometry {
  if (grassCardGeometry) return grassCardGeometry
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let quad = 0; quad < 2; quad++) {
    const dx = quad === 0 ? 0.5 : 0
    const dz = quad === 0 ? 0 : 0.5
    const base = quad * 4
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz)
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0)
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1)
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  grassCardGeometry = g
  return g
}

/** Card height range in metres — real grass, at the board's real 1 unit = 1
 * metre scale. Small on purpose ("tiene sentido que sea pequeño"); density,
 * not size, is what makes it read as thick. */
const CARD_MIN_HEIGHT = 0.34
const CARD_MAX_HEIGHT = 0.95
/** Cards are wider than they are tall, which is what lets a manageable number
 * of them close up the gaps between each other seen from above. */
const CARD_WIDTH_RATIO = 1.9

/** Real user request: "quiero que la hierba en la casilla de bosque y bosque
 * denso sea algo mas oscura que el resto, casi acorde con el color de la
 * textura de su tile."
 *
 * The tint is `terrainColor()` itself — the exact multiply the tile's own
 * ground texture is already drawn with (forest gets a dense-canopy darkening,
 * light_forest a milder one, open ground none at all). Reusing it rather than
 * picking a matching green by eye is what guarantees "acorde con el color de
 * la textura de su tile" stays true if that shade is ever retuned, instead of
 * drifting apart the first time someone adjusts one of them.
 *
 * Grass under a canopy is genuinely darker anyway, so this is not only a
 * colour match — it is the same reason the canopy multiply exists at all. */
function carpetTintFor(terrain: string): string {
  return terrainColor(terrain)
}

function makeCarpetMaterial(tint: string) {
  const uniforms = { uTime: { value: 0 } }
  const material = new THREE.MeshStandardMaterial({
    color: tint,
    map: getGrassCardTexture(),
    // alphaTest instead of transparency: a transparent material would have to
    // be depth-sorted, and half a million cards cannot be sorted per frame.
    // Cut-out alpha renders in the ordinary opaque pass, no sorting at all.
    alphaTest: 0.42,
    transparent: false,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying float vTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 instOrigin = instanceMatrix[3].xyz;
        // Only the top edge moves; the base is rooted. transformed.y is
        // already 0..1 by construction, so it doubles as the lean factor.
        float lean = transformed.y * transformed.y;
        // Per-instance RANDOM phase, hashed from the instance's position.
        //
        // This used to be x * 0.7 + z * 0.9, meant to decorrelate
        // neighbouring plants — but a linear function of position is a plane
        // wave, and that one had a 5.5m wavelength, so instead of
        // decorrelating anything it locked the whole field into fine
        // diagonal corduroy that scrolled across the board. Real user report
        // from the table view, twice: "se ven como unas lineas moviendose
        // sobre la hierba... sigue viendose MUY claramente."
        //
        // Hashing breaks the correlation completely: two plants a metre
        // apart get unrelated phases, so no crest can form anywhere and
        // there is nothing left to read as a line, at any camera angle.
        float phase = fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
        // The gust — how hard the wind is blowing — is deliberately almost
        // uniform in SPACE and varies in TIME. Any spatial term here is a
        // travelling wave, and a travelling wave seen from directly above is
        // a bar sweeping the board; wavelengths this long (hundreds of
        // metres, well past the size of a map) mean neighbouring tiles gust
        // together, which is what real wind does anyway. The strength rises
        // and falls, and because every blade's own phase is random the field
        // reads as picking up and dying down rather than as a front passing
        // through.
        float g1 = sin(uTime * 0.42 - instOrigin.x * 0.0032 - instOrigin.z * 0.0021);
        float g2 = sin(uTime * 0.27 + instOrigin.x * 0.0018 - instOrigin.z * 0.0039);
        float gust = 0.58 + 0.32 * (g1 * 0.58 + g2 * 0.42);
        transformed.x += sin(uTime * 2.1 + phase) * lean * 0.16 * gust;
        transformed.z += cos(uTime * 1.6 + phase * 0.6) * lean * 0.11 * gust;
        // Per-instance shade, hashed from the instance's own position rather
        // than stored per instance: half a million colours would be another
        // 6MB of buffer for something a single sine can produce for free.
        vTint = 0.80 + 0.34 * fract(sin(dot(instOrigin.xz, vec2(12.9898, 78.233))) * 43758.5453);`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTint;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTint;`)
  }
  return { material, uniforms }
}

/** The whole board's grass in ONE InstancedMesh.
 *
 * Matrices are composed by hand straight into the instance buffer instead of
 * through Object3D. At this count that is not micro-optimisation: half a
 * million Object3D updates allocate and cost seconds, while a rotation about
 * Y with a scale is nine multiplies written directly into the array. */
/** One batch per distinct grass tint. Splitting by tint rather than colouring
 * each instance keeps the whole board at a handful of draw calls: a
 * per-instance colour would be another three floats on every one of hundreds
 * of thousands of cards, for a value that only ever takes two or three
 * distinct settings. */
/** How many hexes across one cullable region of vegetation is.
 *
 * A batch that spans the whole map cannot be frustum-culled in any useful
 * way, which is why these all carried `frustumCulled={false}`: in the
 * first-person view, where you see a narrow cone of the board, every plant
 * on it was still being submitted. Measured, vegetation is 54% of the GPU
 * time, so that is a lot to be throwing away.
 *
 * Splitting by region fixes it, but not for free, and the first attempt
 * measured badly enough to change the design. There are ~96 distinct
 * plant species-variants holding only ~4.300 instances between them —
 * about 45 instances per draw — so cutting the board into regions took
 * plants from 96 draws to 521 and the whole board from 670 to 1.756. GPU
 * time did fall exactly as predicted (7,8 → 2,5 ms: the culling works),
 * but the CPU cost of five times the draw calls swamped it and GM view
 * went from 51 fps to 24.
 *
 * So this is not a global setting. It is worth doing where the camera sees
 * a narrow slice of the board and culling can throw most of it away — the
 * first-person cockpit — and it is worth NOT doing where the camera sees
 * the whole board at once, because there culling can discard nothing and
 * the extra draws are pure loss. A view passes `null` to keep one batch
 * per species, exactly as before. */
export const VEGETATION_REGION_SPAN = 6

/** Which cullable region a tile belongs to, or one shared region when
 * `span` is null. */
export function vegetationRegion(q: number, r: number, span: number | null): string {
  if (span === null) return '*'
  return `${Math.floor(q / span)},${Math.floor(r / span)}`
}

/** Distance, in world units, past which a region stops drawing real
 * plants and shows a billboard of its trees instead — the user's own call,
 * "el LoD a partir de 6 hexes", in the cockpit.
 *
 * Hex spacing is sqrt(3) * HEX_SIZE, so this is six hexes of real board. */
export const LOD_DISTANCE = 6 * Math.sqrt(3) * HEX_SIZE

/** Smallest board on which the level of detail is worth switching on.
 *
 * Measured in the cockpit, on a quiet machine, six samples each:
 *
 *   sin LOD   9,26 ms   (9,24-9,30)
 *   con LOD   9,26 ms   (8,93-9,34)
 *
 * An exact wash on this 120-tile board, and that is the interesting result
 * rather than a disappointing one. Regions cost draw calls — a species that
 * spanned the board in one batch becomes one batch per region — and the LOD
 * wins them back by skipping everything beyond six hexes. Here the two
 * cancel to within the noise.
 *
 * They stop cancelling as the board grows, and only one way. The COST is
 * bounded by the LOD radius: however big the map, only the regions within
 * six hexes draw their real plants, so the near-side bill is the same on a
 * huge board as on this one. The SAVING is everything beyond that radius,
 * which is what grows. Without the LOD the whole board is drawn whatever
 * its size.
 *
 * So the threshold sits just above the size that measured as a wash. Below
 * it there is nothing to gain and no reason to carry the extra machinery;
 * above it the gap opens in the LOD's favour and keeps opening.
 *
 * (An earlier version of this comment put the break-even at ~650 tiles,
 * derived from timings taken while four of the app's own views were open
 * in another browser. Those numbers were noise.) */
export const LOD_MIN_TILES = 200
/** Regions swap back to full detail a little nearer than they swapped out
 * of it. Without the gap a region sitting exactly on the line flickers
 * between a forest and a billboard as the camera breathes. */
const LOD_HYSTERESIS = 0.88

/** The baked billboards, four trees in one 2x2 sheet — see the bake script
 * in the tooling notes. One sheet is what makes a whole distant region cost
 * ONE draw call: with a texture per tree it would cost four. */
const IMPOSTOR_ATLAS_URL = '/models/trees/impostor-atlas.png'
const IMPOSTOR_COLS = 2

/** Where each mass tree sits in the sheet.
 *
 * `frame` over `height` is how much taller the baked square tile is than
 * the tree inside it: the bake frames the model's own longest dimension in
 * a square, so the quad has to be that much bigger than the tree it stands
 * for or every distant tree would come out slightly short. */
const IMPOSTOR_TILES: Record<string, { col: number; row: number; frameRatio: number }> = {
  'eu43-1-mass': { col: 0, row: 0, frameRatio: 223.02 / 218.64 },
  'eu43-4-mass': { col: 1, row: 0, frameRatio: 458.51 / 449.52 },
  'eu43-5-mass': { col: 0, row: 1, frameRatio: 625.32 / 613.06 },
  'eu43-7-mass': { col: 1, row: 1, frameRatio: 759.54 / 744.65 },
}

function impostorTileFor(url: string) {
  const name = url.split('/').pop()?.replace('.glb', '') ?? ''
  return IMPOSTOR_TILES[name] ?? null
}

const impostorVertexShader = /* glsl */ `
  attribute vec2 aTile;
  varying vec2 vUv;
  varying float vTint;
  void main() {
    // Yaw-only billboard: a tree leans with the terrain, never with the
    // camera's pitch. Turning it on both axes would tip whole forests
    // backwards the moment you looked up.
    vec3 instancePos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    // Scale rides in the instance matrix's own columns, so one shared unit
    // quad serves every tree.
    float sx = length(instanceMatrix[0].xyz);
    float sy = length(instanceMatrix[1].xyz);
    vec3 toCam = cameraPosition - instancePos;
    toCam.y = 0.0;
    // Degenerate only if the camera is exactly overhead, where a
    // yaw-billboard has no meaningful facing anyway.
    vec3 right = length(toCam) > 0.0001
      ? normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toCam)))
      : vec3(1.0, 0.0, 0.0);
    vec3 world = instancePos + right * (position.x * sx) + vec3(0.0, position.y * sy, 0.0);
    vUv = (uv + aTile) / ${IMPOSTOR_COLS}.0;
    // Same hashed per-instance tone spread the real trees get, so a
    // billboard forest is not four colours repeated.
    vTint = fract(sin(instancePos.x * 12.9898 + instancePos.z * 78.233) * 43758.5453);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const impostorFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vTint;
  void main() {
    vec4 texel = texture2D(uMap, vUv);
    // Cut, not blended: a sorted-transparency forest of billboards is a
    // sorting problem, and an alpha test has none. The threshold is low
    // because the bake's own antialiased edges thin out under mipmaps.
    if (texel.a < 0.35) discard;
    gl_FragColor = vec4(texel.rgb * (0.88 + vTint * 0.24), 1.0);
  }
`

/** One region's worth of distant trees, as camera-facing billboards.
 *
 * This is the whole point of the level of detail: a region that would cost
 * forty-odd draw calls of real plants costs ONE of these. It is also why
 * regions came back — you cannot swap distant trees for billboards while
 * every tree on the board is a single batch. */
function ImpostorBatch({ instances, meshRef }: {
  instances: { matrices: THREE.Matrix4[]; tiles: Float32Array }
  meshRef: React.RefObject<THREE.InstancedMesh | null>
}) {
  const texture = useLoader(THREE.TextureLoader, IMPOSTOR_ATLAS_URL)
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1, 1)
    // Origin at the foot, so scaling by a tree's height grows it upward
    // out of the ground instead of around its own middle.
    geo.translate(0, 0.5, 0)
    return geo
  }, [])
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: impostorVertexShader,
    fragmentShader: impostorFragmentShader,
    uniforms: { uMap: { value: texture } },
  }), [texture])

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
  }, [texture])
  useEffect(() => () => { material.dispose(); geometry.dispose() }, [material, geometry])

  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    instances.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
    mesh.geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(instances.tiles, 2))
    mesh.computeBoundingSphere()
  }, [instances, meshRef])

  if (instances.matrices.length === 0) return null
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, instances.matrices.length]}
      userData={{ perfGroup: 'árboles' }}
      visible={false}
      frustumCulled
    />
  )
}

/** One cullable region: its real plants, its billboard stand-in, and the
 * switch between them.
 *
 * Both sets exist from the start and only their `visible` flag moves. The
 * alternative — mounting and unmounting batches as the camera walks — would
 * rebuild geometry mid-flight and hitch exactly when the player is moving,
 * which is the one moment a frame drop is felt.
 *
 * The test is against the region's CENTRE rather than its nearest corner.
 * A corner test would flip a region the moment its edge crossed the line,
 * which for a region several hexes across means swapping trees that are
 * still close enough to look at. */
function VegetationRegion({ regionKey, center, buckets, impostor, lodDistance }: {
  regionKey: string
  center: THREE.Vector3
  buckets: { key: string; variant: Variant; matrices: THREE.Matrix4[] }[]
  impostor: { matrices: THREE.Matrix4[]; tiles: Float32Array } | null
  /** World units past which this region shows its billboards, or null to
   * never do that — which is every view except the cockpit. */
  lodDistance: number | null
}) {
  const fullRef = useRef<THREE.Group>(null)
  const impostorRef = useRef<THREE.InstancedMesh>(null)
  const far = useRef(false)

  useProfiledFrame('LOD vegetación', (state) => {
    if (lodDistance === null) return
    const distance = state.camera.position.distanceTo(center)
    // Hysteresis: out at the line, back in a little nearer than it.
    const threshold = far.current ? lodDistance * LOD_HYSTERESIS : lodDistance
    const next = distance > threshold
    if (next === far.current) return
    far.current = next
    if (fullRef.current) fullRef.current.visible = !next
    if (impostorRef.current) impostorRef.current.visible = next
  })

  return (
    <>
      <group ref={fullRef}>
        {buckets.map((b) => (
          <VegetationBatch key={b.key} variant={b.variant} matrices={b.matrices} />
        ))}
      </group>
      {impostor && lodDistance !== null && (
        <ImpostorBatch key={`${regionKey}:imp`} instances={impostor} meshRef={impostorRef} />
      )}
    </>
  )
}

function GrassCarpet({ tiles, tilesKey, lookup, regionSpan }: {
  tiles: HexTileData[]
  tilesKey: string
  lookup: Map<string, HexTileData>
  regionSpan: number | null
}) {
  const groups = useMemo(() => {
    // Keyed by tint AND region: one batch per tint per region, so each has
    // real bounds and can be culled when the camera looks elsewhere.
    const byTint = new Map<string, { tint: string; tiles: HexTileData[] }>()
    for (const t of tiles) {
      // GRASS terrain only. VEGETATED is deliberately wider than this (water
      // is in it, for its stones), and using it here would carpet a river.
      if (!isGrassTerrain(t.terrain)) continue
      const tint = carpetTintFor(t.terrain)
      const key = `${tint}|${vegetationRegion(t.q, t.r, regionSpan)}`
      const group = byTint.get(key)
      if (group) group.tiles.push(t)
      else byTint.set(key, { tint, tiles: [t] })
    }
    // The card budget is for the WHOLE board, so it has to be worked out
    // across every group at once and handed down as one shared factor.
    // Letting each group cap itself would multiply the ceiling by the number
    // of tints and quietly undo the limit.
    const wanted = tiles
      .filter((t) => isGrassTerrain(t.terrain))
      .reduce((n, t) => n + carpetDensity(t), 0) * CARPET_MEAN_KEEP
    return {
      groups: [...byTint.entries()],
      budget: wanted > CARPET_MAX_CARDS ? CARPET_MAX_CARDS / wanted : 1,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, regionSpan])

  return (
    <>
      {groups.groups.map(([key, group]) => (
        <GrassCarpetBatch
          key={key} tint={group.tint} tiles={group.tiles} tilesKey={tilesKey}
          lookup={lookup} budget={groups.budget}
        />
      ))}
    </>
  )
}

function GrassCarpetBatch({ tint, tiles, tilesKey, lookup, budget }: {
  tint: string
  tiles: HexTileData[]
  tilesKey: string
  lookup: Map<string, HexTileData>
  /** Shared board-wide thinning factor — see GrassCarpet. */
  budget: number
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const { material, uniforms } = useMemo(() => makeCarpetMaterial(tint), [tint])
  useEffect(() => () => material.dispose(), [material])

  const matrices = useMemo(() => {
    // Already filtered to one tint group by the caller; `budget` is the
    // board-wide thinning factor, applied uniformly so a big map thins out
    // rather than dropping whole tiles (bald hexes would be obvious, where a
    // uniform thinning just reads as shorter grass). Counts here are
    // CANDIDATES, most of which the patch field rejects, so the budget is
    // measured against their mean survival rate.
    const live = tiles
    const total = Math.ceil(
      live.reduce((n, t) => n + carpetDensity(t), 0) * CARPET_MEAN_KEEP * budget,
    )
    const array = new Float32Array(total * 16)
    const apothem = HEX_SIZE * Math.cos(Math.PI / 6)
    let n = 0
    for (const tile of live) {
      const count = Math.round(carpetDensity(tile) * budget)
      if (count <= 0) continue
      const [wx, wz] = hexToWorld(tile.q, tile.r)
      const sampleY = makeTileHeightSampler(tile, lookup)
      const patchAt = makeGrassDensitySampler(wx, wz)
      const rnd = makeTileRng(tile.q, tile.r, 'carpet')
      // A dense forest floor is undergrowth wall to wall, with no bare
      // stretches for the patch field to carve out — see GRASS_COVER.
      const fullyCovered = GRASS_COVER[tile.terrain]?.full ?? false
      for (let i = 0; i < count && n < total; i++) {
        // Rejection-sample the real hexagon rather than settling for its
        // inscribed circle, which would leave a bare ring around every tile
        // exactly where two tiles meet and it would show most.
        //
        // A candidate that lands outside is DROPPED, never nudged or reused.
        // An earlier version kept the last try when all of them missed,
        // which put roughly one card in two thousand at a uniformly random
        // point of the bounding square instead of inside the hex — invisible
        // in the middle of the board, where it just lands on a neighbour,
        // and a real user report at its edge: "hay hierba que se sale del
        // tablero, eso no puede pasar."
        //
        // The test is the hexagon's own three edge-normal pairs. Corners sit
        // at angle i*60 with position (R sin, R cos), so the flats face +-x
        // at the apothem and the slanted edges give the second term. An
        // earlier bound on |z| was simply wrong for this orientation (the
        // hexagon reaches R, not the apothem, along z) and quietly shaved
        // the top and bottom tips off every tile's grass.
        const inHex = (px: number, pz: number) => Math.abs(px) <= apothem
          && Math.abs(px) * 0.5 + Math.abs(pz) * (Math.sqrt(3) / 2) <= apothem
        let x = 0
        let z = 0
        let placed = false
        for (let tryCount = 0; tryCount < 8 && !placed; tryCount++) {
          x = (rnd() - 0.5) * 2 * HEX_SIZE
          z = (rnd() - 0.5) * 2 * HEX_SIZE
          placed = inHex(x, z)
        }
        if (!placed) continue
        // The patch field decides whether this candidate becomes a plant at
        // all. Rejection sampling rather than a per-tile count, so the mats
        // land where the FIELD says and stay continuous across borders.
        if (!fullyCovered && rnd() > patchAt(x, z)) continue
        const h = CARD_MIN_HEIGHT + rnd() * (CARD_MAX_HEIGHT - CARD_MIN_HEIGHT)
        const w = h * CARD_WIDTH_RATIO
        const a = rnd() * Math.PI
        const c = Math.cos(a) * w
        const sn = Math.sin(a) * w
        const o = n * 16
        array[o] = c; array[o + 1] = 0; array[o + 2] = -sn; array[o + 3] = 0
        array[o + 4] = 0; array[o + 5] = h; array[o + 6] = 0; array[o + 7] = 0
        array[o + 8] = sn; array[o + 9] = 0; array[o + 10] = c; array[o + 11] = 0
        array[o + 12] = wx + x; array[o + 13] = sampleY(x, z); array[o + 14] = wz + z; array[o + 15] = 1
        n++
      }
    }
    return { array, count: n }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, tint, budget])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices.array, 16)
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = matrices.count
    // Bounds over the instances actually written, which is what makes this
    // batch cullable now that it covers one region rather than the map.
    mesh.computeBoundingSphere()
  }, [matrices])

  useProfiledFrame('hierba (viento)', (state) => { uniforms.uTime.value = state.clock.elapsedTime })

  if (matrices.count === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[getGrassCardGeometry(), material, matrices.count]}
      userData={{ perfGroup: 'hierba' }}
      receiveShadow
      castShadow={false}
      // Culling is ON again, which it could not be while one batch covered
      // the whole board. The old comment here blamed three.js for testing
      // "one instance at the origin" — that was the wrong diagnosis. An
      // InstancedMesh does get bounds over all its instances, but only once
      // something computes them, and only for the matrices written by that
      // point; computed too early it really does cover nothing, which is
      // what made forest tiles lose their trees in the first-person view.
      // The effect above now recomputes them right after writing.
    />
  )
}

export function GroundVegetation({ tiles, lookup, regionSpan, lodDistance }: {
  tiles: HexTileData[]
  lookup: Map<string, HexTileData>
  /** Hexes across one cullable region, or null for one batch per species
   * across the whole board. See VEGETATION_REGION_SPAN for the measured
   * reason this is a per-view decision. */
  regionSpan: number | null
  /** World units past which a region swaps its plants for billboards, or
   * null for no level of detail at all. Only meaningful with regions: with
   * one batch per species across the board there is nothing to swap. */
  lodDistance?: number | null
}) {
  /** Everything below is keyed on this rather than on `tiles` itself.
   *
   * Real user report, in the first-person view: "cuando termina el
   * movimiento, las decoraciones flickerean, desaparecen y vuelven a
   * aparecer." Finishing a move refetches the session, which hands HexMap a
   * NEW tiles array holding the very same terrain — a different object, so
   * every memo depending on the array identity threw away and rebuilt the
   * entire board's vegetation, hundreds of thousands of instances, for a map
   * that had not changed at all. Comparing what the tiles actually SAY costs
   * a few hundred string concatenations and skips all of it.
   *
   * Only the fields the vegetation genuinely depends on go in: where a tile
   * is, what grows there, and how high it sits. */
  const tilesKey = useMemo(
    () => tiles.map((t) => `${t.q},${t.r},${t.terrain},${t.elevation}`).join('|'),
    [tiles],
  )
  const gltfs = useGLTF(SPECIES_URLS) as unknown as { scene: THREE.Group }[]

  // Keyed on the loaded scenes' own identities, NOT on the array `useGLTF`
  // returns. That array is rebuilt on every render even though the scenes
  // inside it are cached and stable, so depending on it made this memo (and
  // the placement memo below, which depends on this one) recompute every
  // single frame — rebuilding every plant on the board sixty times a second,
  // which measured at 1 fps and looked for all the world like a rendering
  // cost rather than the pure bookkeeping bug it was.
  const sceneKey = gltfs.map((g) => g?.scene?.uuid ?? '').join('|')
  // One entry per species, each a list of that model's own variants.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const variants = useMemo(() => {
    const byUrl = new Map<string, { scene: THREE.Group }>()
    SPECIES_URLS.forEach((u, i) => byUrl.set(u, gltfs[i]))
    const map = new Map<SpeciesKey, Variant[]>()
    for (const key of Object.keys(SPECIES) as SpeciesKey[]) {
      const gltf = byUrl.get(SPECIES[key].url)
      if (gltf?.scene) map.set(key, extractVariants(gltf.scene, key, SPECIES[key].whole ?? false))
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey])

  // Every plant on the board, bucketed by the exact variant that draws it —
  // one bucket becomes one InstancedMesh.
  const buckets = useMemo(() => {
    const out = new Map<string, { variant: Variant; matrices: THREE.Matrix4[] }>()
    const dummy = new THREE.Object3D()
    for (const tile of tiles) {
      if (!VEGETATED.has(tile.terrain)) continue
      const [wx, wz] = hexToWorld(tile.q, tile.r)
      // The tile's own real surface, so a plant sits ON the ground however
      // the ground is ramped, bumped or cratered — not on a flat guess.
      const surfaceAt = makeTileHeightSampler(tile, lookup)
      for (const p of placeTile(tile)) {
        const pool = variants.get(p.species)
        if (!pool || pool.length === 0) continue
        const species = SPECIES[p.species]
        // A whole model's meshes are parts of ONE tree and every one of them
        // takes the SAME matrix; anything else is a pool of separate
        // specimens and one gets picked. Getting this wrong plants bare
        // trunks in one place and floating canopies in another.
        const parts = species.whole ? pool : [pool[p.variantPick % pool.length]]
        // Measured against the TALLEST part, so a canopy mesh that never
        // reaches the ground cannot scale its own tree to twice the size.
        const modelHeight = species.whole
          ? Math.max(...pool.map((v) => v.height))
          : parts[0].height
        const scale = p.scale / modelHeight
        dummy.position.set(
          wx + p.x,
          surfaceAt(p.x, p.z) - p.scale * (species.sink ?? 0),
          wz + p.z,
        )
        dummy.rotation.set(0, p.rotY, 0)
        dummy.scale.setScalar(scale)
        dummy.updateMatrix()
        for (const variant of parts) {
          const bucketKey = `${vegetationRegion(tile.q, tile.r, regionSpan)}::${p.species}:${variant.index}`
          let bucket = out.get(bucketKey)
          if (!bucket) { bucket = { variant, matrices: [] }; out.set(bucketKey, bucket) }
          bucket.matrices.push(dummy.matrix.clone())
        }
      }
    }
    // Regrouped by region, because the level of detail switches a whole
    // region at once and each one needs its own centre to measure from.
    const regions = new Map<string, {
      key: string
      buckets: { key: string; variant: Variant; matrices: THREE.Matrix4[] }[]
      sum: THREE.Vector3
      count: number
      impostorMatrices: THREE.Matrix4[]
      impostorTiles: number[]
    }>()
    for (const [key, bucket] of out) {
      const regionKey = key.slice(0, key.indexOf('::'))
      let region = regions.get(regionKey)
      if (!region) {
        region = {
          key: regionKey,
          buckets: [],
          sum: new THREE.Vector3(),
          count: 0,
          impostorMatrices: [],
          impostorTiles: [],
        }
        regions.set(regionKey, region)
      }
      region.buckets.push({ key, ...bucket })
      for (const matrix of bucket.matrices) {
        region.sum.x += matrix.elements[12]
        region.sum.y += matrix.elements[13]
        region.sum.z += matrix.elements[14]
        region.count++
      }
    }

    // The billboards, built from the same placements the real trees use so
    // a swap lands a tree exactly where its model stood. Only the mass
    // trees: heroes are roughly one in thirty and are the ones you look at,
    // so they keep their geometry at any distance.
    for (const tile of tiles) {
      if (!VEGETATED.has(tile.terrain)) continue
      const [wx, wz] = hexToWorld(tile.q, tile.r)
      const regionKey = vegetationRegion(tile.q, tile.r, regionSpan)
      const region = regions.get(regionKey)
      if (!region) continue
      const surfaceAt = makeTileHeightSampler(tile, lookup)
      for (const placement of placeTile(tile)) {
        const species = SPECIES[placement.species]
        const tile2d = impostorTileFor(species.url)
        if (!tile2d) continue
        const size = placement.scale * tile2d.frameRatio
        dummy.position.set(
          wx + placement.x,
          surfaceAt(placement.x, placement.z) - placement.scale * (species.sink ?? 0),
          wz + placement.z,
        )
        // No rotation: the shader turns the quad to face the camera, and a
        // rotation baked in here would fight it.
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(size, size, size)
        dummy.updateMatrix()
        region.impostorMatrices.push(dummy.matrix.clone())
        region.impostorTiles.push(tile2d.col, tile2d.row)
      }
    }

    return [...regions.values()].map((region) => ({
      key: region.key,
      buckets: region.buckets,
      center: region.count > 0
        ? region.sum.clone().multiplyScalar(1 / region.count)
        : new THREE.Vector3(),
      impostor: region.impostorMatrices.length > 0
        ? {
          matrices: region.impostorMatrices,
          tiles: new Float32Array(region.impostorTiles),
        }
        : null,
    }))
    // Deliberately keyed on the tiles' CONTENT, not on the array holding
    // them — see `tilesKey` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, variants, regionSpan])

  return (
    <>
      {/* The carpet stays at full detail at any distance on purpose. It
          covers the ground continuously, so dropping it past the level-of-
          detail line would draw a visible circle of bare ground around the
          player — and it is two draw calls, not forty. */}
      <GrassCarpet tiles={tiles} tilesKey={tilesKey} lookup={lookup} regionSpan={regionSpan} />
      {buckets.map((region) => (
        <VegetationRegion
          key={region.key}
          regionKey={region.key}
          center={region.center}
          buckets={region.buckets}
          impostor={region.impostor}
          lodDistance={regionSpan === null ? null : (lodDistance ?? null)}
        />
      ))}
    </>
  )
}

/** Which variants can share one material.
 *
 * Everything the renderer has to bind: the maps, and the few material
 * settings that change the shader rather than a uniform. */
function materialKey(material: THREE.Material): string {
  const m = material as THREE.MeshStandardMaterial
  const id = (t: THREE.Texture | null | undefined) => t?.uuid ?? '-'
  return [
    m.type,
    id(m.map), id(m.normalMap), id(m.roughnessMap), id(m.metalnessMap),
    id(m.alphaMap), id(m.aoMap), id(m.emissiveMap),
    m.alphaTest, m.transparent, m.side, m.vertexColors,
  ].join('|')
}

/** The wind's three per-plant numbers, written into the geometry itself.
 *
 * They used to be uniforms, which forced one material per variant. As
 * attributes they are constant across a geometry and so redundant per
 * vertex, but they let every variant sharing a texture share ONE material —
 * fewer programs to bind, and the same wind. */
function bakeWindAttributes(geometry: THREE.BufferGeometry, height: number, sway: number, tint: number) {
  if (geometry.getAttribute('aPlantHeight')) return
  const count = geometry.getAttribute('position').count
  const fill = (value: number) => {
    const array = new Float32Array(count)
    array.fill(value)
    return new THREE.BufferAttribute(array, 1)
  }
  geometry.setAttribute('aPlantHeight', fill(height))
  geometry.setAttribute('aSway', fill(sway))
  geometry.setAttribute('aTint', fill(tint))
}

/** One wind material per distinct source material, shared board-wide.
 *
 * WHY THIS IS NOT A BatchedMesh, which was built, measured and removed.
 *
 * BatchedMesh draws many DIFFERENT geometries with one material in a single
 * call, and it did exactly what it promised: the board went from 664 draw
 * calls to 482, vegetation from 128 to 37. It was still slower, and not
 * marginally. Measured on a quiet machine, six samples each, ranges that do
 * not overlap:
 *
 *   InstancedMesh   664 draws   10,49 ms   (10,10-10,56)
 *   BatchedMesh     482 draws   14,43 ms   (14,02-14,72)
 *
 * Fewer draw calls, 27% more time. The reason is what this board's
 * vegetation is: 4.933 copies of only 128 distinct geometries, about 38
 * copies each. InstancedMesh draws those with ONE hardware-instanced call
 * and the GPU replays the same small geometry out of cache. BatchedMesh
 * turns every copy into its own sub-draw: fewer API calls, but it gives up
 * hardware instancing, so the GPU does strictly more work per copy.
 * BatchedMesh is for many DISTINCT geometries with FEW copies each, which
 * is the opposite of a meadow. It would be the right tool for scattered
 * one-off props; it is the wrong one here.
 *
 * (An earlier attempt at this comparison, run while four of the app's own
 * views were open in another browser, had the same InstancedMesh build
 * measuring 60, 51 and 44 fps. Nothing could be concluded from that, and
 * for a while the wrong thing was.)
 *
 * What survived the experiment is this: the wind's parameters became vertex
 * attributes, so variants that share a texture now share one material
 * instead of cloning their own. It does not change the draw count — one
 * geometry still needs one InstancedMesh — but it does cut the number of
 * shader programs the renderer binds per frame. */
const windMaterialCache = new Map<string, { material: THREE.Material; uniforms: { uTime: { value: number } } }>()

function sharedWindMaterial(source: THREE.Material) {
  const key = materialKey(source)
  let entry = windMaterialCache.get(key)
  if (!entry) {
    entry = makeWindMaterial(source)
    windMaterialCache.set(key, entry)
  }
  return entry
}

function VegetationBatch({ variant, matrices }: { variant: Variant; matrices: THREE.Matrix4[] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const species = SPECIES[variant.species]
  const tier = species.tier
  const { material, uniforms } = useMemo(() => sharedWindMaterial(variant.material), [variant.material])

  const geometry = useMemo(() => {
    // Trees get a real per-instance tone spread; the small plants do not
    // need one, being small and already varied across several species.
    bakeWindAttributes(
      variant.geometry, variant.height, species.sway,
      tier === 'tree' || tier === 'hero' ? 0.34 : 0,
    )
    return variant.geometry
  }, [variant, species.sway, tier])

  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
    mesh.instanceMatrix.needsUpdate = true
    // An InstancedMesh's own bounding sphere spans its instances, but only
    // once something computes it, and only for the matrices written so far.
    // This is what makes the frustum test below mean anything.
    mesh.computeBoundingSphere()
  }, [matrices])

  useProfiledFrame('vegetación (viento)', (state) => { uniforms.uTime.value = state.clock.elapsedTime })

  if (matrices.length === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, matrices.length]}
      userData={{ perfGroup: tier === 'tree' || tier === 'hero' ? 'árboles' : 'plantas' }}
      receiveShadow
      // No castShadow on purpose. A shadow map re-renders every caster from
      // the light's point of view, so switching it on here would double the
      // cost of the heaviest thing on the board for shadows that, at grass
      // scale, land almost entirely underneath the plant casting them.
      castShadow={false}
    />
  )
}

// Same preload convention the other .glb decor in this project uses — starts
// the fetch as soon as the module is imported rather than when the first
// tile that needs it renders.
/** The exact array the hook below asks for, hoisted so the preload and the
 * hook are the SAME call.
 *
 * They were not, and it cost a second download of every model. drei caches
 * a load under the argument it was given, so preloading each url as a
 * string filled cache entries that a later `useGLTF(array)` never looked
 * at: measured on a cold load, eu43-3.glb (17,8 MB) and eu43-5.glb (11 MB)
 * were each fetched twice, 29 MB of pure waste out of 98 MB. */
const SPECIES_URLS = [...new Set(Object.values(SPECIES).map((s) => s.url))]

useGLTF.preload(SPECIES_URLS)
