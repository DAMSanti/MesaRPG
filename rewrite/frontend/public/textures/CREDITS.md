# Texture credits

All files are real CC0 (public domain) photo textures from
[ambientCG](https://ambientcg.com/) — free to use, modify, and
redistribute without attribution, credited here anyway for provenance.

- `table-wood.jpg` — [Wood095](https://ambientcg.com/view?id=Wood095), 1K color/diffuse map only (normal/roughness/displacement maps dropped, unused).
- `sky.jpg` — [Day Sky HDRI 067B](https://ambientcg.com/view?id=DaySkyHDRI067B), 1K tonemapped equirectangular JPG (the `.exr`/`.hdr` originals weren't needed).
- `grass.jpg` — [Grass001](https://ambientcg.com/view?id=Grass001), 1K color/diffuse map only (AO/normal/roughness/displacement maps dropped, unused) — plains tiles' terrain texture (terrain.ts), replacing the earlier procedural canvas pattern for that one terrain type.
- `forest-floor.jpg` — [Moss002](https://ambientcg.com/view?id=Moss002), 1K color/diffuse map only — forest tiles' terrain texture, darkened via terrainColor()'s material tint (dense canopy shadow, seen from directly above) rather than used at its own bright/lawn-like tone.
- `dirt.jpg` — [Ground051](https://ambientcg.com/view?id=Ground051), 1K color/diffuse map only — a minority of plains tiles (terrain.ts's `plainsGroundVariant`) render this bare-earth-with-pebbles photo instead of grass.jpg, so a field reads as patchy ground rather than a single uniform lawn.
- `road.jpg` — [Asphalt002](https://ambientcg.com/view?id=Asphalt002), 1K color/diffuse map only, downscaled to 512px — plain worn asphalt with no baked-in centerline (see RoadMarkings.tsx, which paints the line markings itself from each tile's real neighbor connections), replacing the earlier procedural canvas pattern for road tiles.
- `hill-grass.jpg` — [Grass004](https://ambientcg.com/view?id=Grass004), 1K color/diffuse map only, downscaled to 512px — hills tiles' terrain texture (terrain.ts), replacing the flat elevation-based color ramp that stood in for a texture before this existed. A different grass photo from `grass.jpg` (plains) on purpose, so a hill still reads as visually distinct ground, not just "plains but taller".
- `water-bed.jpg` — [Ground021](https://ambientcg.com/view?id=Ground021), 1K color/diffuse map only, downscaled to 512px — a real riverbed/pebble photo (its own ambientCG tags include "bed" and "river"), replacing an earlier procedural ripple pattern as water/water_deep tiles' terrain texture — this is the tile's own still floor, seen through the separate animated translucent `WaterSurface` TerrainDecor.tsx renders above it. No dedicated "water surface" CC0 photo material exists on ambientCG or Poly Haven (checked both APIs directly, zero results for water/lake/pond/sea/ocean/wave/ripple as a Material/texture category) — real-time water surfaces aren't textured from a static photo anywhere, they're built from animation and lighting, which is what `WaterSurface` actually does for the moving part.
- `rough.jpg` — [Ground110](https://ambientcg.com/view?id=Ground110), 1K color/diffuse map only, downscaled to 512px — a real scattered-gravel/broken-stone ground photo, replacing the earlier procedural stroke/speckle pattern (`drawRough`, deleted) as 'rough' ("Rocoso") tiles' terrain texture, paired with real 3D rock models (see below) per explicit request for "textura realista" plus "modelos de rocas".
- `rubble.jpg` — [Ground108](https://ambientcg.com/view?id=Ground108), 1K color/diffuse map only, downscaled to 512px — literally tagged "debris"/"rubble" by ambientCG itself; replacing the earlier procedural pattern (`drawRubble`, deleted) as 'rubble' ("Escombros") tiles' terrain texture, paired with real 3D debris-chunk models (see below).
- `swamp.jpg` — [Ground106](https://ambientcg.com/view?id=Ground106), 1K color/diffuse map only, downscaled to 512px — a real murky mud-and-leaf-litter forest-floor photo, replacing the earlier procedural pattern (`drawSwamp`, deleted) as 'swamp' ("Pantano") tiles' terrain texture — this is the tile's own still floor, seen through the separate opaque `MudSurface` TerrainDecor.tsx renders above it (same floor/surface split water/water_deep use), which is what actually carries the murky/wet impression from directly above.
- `snow.jpg` — [Snow005](https://ambientcg.com/view?id=Snow005), 1K color/diffuse map only, downscaled to 512px — clean fluffy snow, replacing the earlier procedural gradient+speckle pattern (`drawSnow`, deleted) as 'snow' tiles' terrain texture. Paired with a persistent mech footprint trail (HexMap.tsx's `FootprintTrail`) rather than a 3D model — a real user request ("me gustaria que se queden las huellas de los mechs que anden por la nieve"), not a per-tile decoration.
- `sidewalk.jpg` — [Concrete008](https://ambientcg.com/view?id=Concrete008), 1K color/diffuse map only, downscaled to 512px — classic poured-concrete slab pavement with expansion-joint lines, per explicit request ("quiero que la base tenga la textura como de una acera"). This is 'building' tiles' own GROUND texture, not the buildings themselves standing on it — see the real building models below (standing buildingKind 0-2, and ruined buildingKind 3/4, which reuse the same three models with a dark scorch tint rather than a separate procedural ruin).

## 3D models — CC0, no attribution required

All from [Poly Haven](https://polyhaven.com/) (photogrammetry scans), each welded + simplified offline
(`gltf-transform weld` + `simplify`) from its much heavier source down to roughly 2.5k-5k triangles — a
single instance or two per 'rough'/'rubble' tile, not the "dozens of trees per forest tile" scale that made
the tree model above worth trimming so much harder. Textures kept at Poly Haven's own 1K resolution.
TerrainDecor.tsx's `RealRock`.

- `rock-boulder.glb` — [Rock 09](https://polyhaven.com/a/rock_09), 12.4k → 4.3k triangles. 'rough' tiles, natural color.
- `rock-face.glb` — [Rock Face 01](https://polyhaven.com/a/rock_face_01), 20.2k → 5k triangles. Reused for
  both terrains with different material tints — a real rock's own colors for 'rough', and a dusty
  grey (`#8a8478`) recolor for 'rubble' so the same angular-chunk geometry reads as broken masonry there
  instead of a natural stone.
- `rubble-block.glb` — [Concrete Road Barrier](https://polyhaven.com/a/concrete_road_barrier), 60.9k → 4.3k
  triangles. 'rubble' tiles, natural color — an actual man-made concrete slab, the clearest "trozos grandes
  de escombros" read of the three models.

A 4th candidate (`boulder_01`, "Boulder 01") was downloaded and dropped — its 66k-triangle mesh resisted
`simplify` (barely reduced to 54k even at an aggressive ratio/error tolerance, likely due to fully
hard-faceted normals blocking edge-collapse), too heavy to risk repeating the forest-biome freeze a
high-poly model scattered across many tiles caused earlier this project.

## Not CC0 — attribution required

- `realistic-tree.glb` — ["Realistic Tree" by Daniel](https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc),
  licensed [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). Simplified from ~20k to ~5k triangles
  (`gltf-transform weld` + `simplify --ratio 0.1 --error 0.05`) — a forest tile places 1-2 instances and a
  map can have dozens of forest tiles, and the original triangle count froze rendering on a forest-biome
  map in practice. TerrainDecor.tsx's `RealTree` — every forest/light_forest tile's tree.
- `bark-branch.jpg` / `leaf-sprig.png` — diffuse (and, for the leaf, alpha) maps extracted directly from
  `realistic-tree.glb`'s own `trunk`/`normal_leaves` materials and wired onto its meshes by material name
  in `RealTree`'s `normalizeTreeSceneOnce` — three.js's GLTFLoader doesn't surface a `.map` for either
  material (confirmed by inspecting the loaded materials directly: `hasMap: false` on every mesh), because
  the file wires its diffuse texture through `KHR_materials_pbrSpecularGlossiness`'s `diffuseTexture` slot,
  not the standard `baseColorTexture` GLTFLoader looks for. Same source images, just applied by hand instead
  of relying on the loader to find them. `bark-branch.jpg` downscaled from 1024px to 512px and re-encoded as
  JPG; `leaf-sprig.png` downscaled from 256px to 384px (its own RGBA alpha channel, no separate opacity mask
  needed) — a real leaf-and-twig cluster rather than one single leaf.

- `building-skyscraper.glb` — "Skyscraper", exact Sketchfab source page/license not yet confirmed —
  user-provided (dropped directly into the repo root, per explicit request — every freely-downloadable,
  no-login-required CC0 source checked first (Poly Haven, Poly Pizza/Google Poly, itch.io) turned out
  low-poly/stylized rather than realistic, and Sketchfab, the one source with genuinely realistic ones,
  requires a login this project doesn't have). **Please share the original URL so this credit (and its
  license, if CC-BY) can be filled in properly.** Simplified cleanly (`gltf-transform weld` + `simplify
  --ratio 0.06 --error 0.02`, ~212k → ~18.5k vertices).

  Originally one of THREE different real building models (this one, plus a ~13.6MB/~100k-vertex highrise
  and a ~34.7MB/~250k-vertex hotel — [Melodia City Hotel](https://sketchfab.com/3d-models/melodia-city-hotel-a2fb8e4065ce470296d6d801daa37f18)
  by [Dreaming Dogg](https://sketchfab.com/DreamingDogg), CC-BY-4.0), one per building "kind". Both of
  those were CAD exports (thousands of per-face split vertices from hard-faceted normals) that resisted
  `gltf-transform simplify` even at very loose error tolerances — confirmed directly during a later
  performance pass (barely a 10% file-size drop, vertex count nearly unchanged). With up to 50-70 building
  tiles possible on one city-biome map, that was a severe real stuttering cost ("me va a tirones", direct
  user report) — replaced with this one already-cheap model for all three kind slots, differentiated by a
  per-kind tint/size range instead of by distinct geometry (see TerrainDecor.tsx's `BUILDING_KIND_TINT`/
  `BUILDING_KIND_SIZE`). Their `.glb` files were removed from `public/models`; the original source files
  the user dropped in the repo root (`highrise_apartment_building.glb`, `melodia_city_hotel.glb`) are
  untouched if this tradeoff ever gets revisited (e.g. real GPU instancing instead of substitution).

TerrainDecor.tsx's `RealBuilding` — standing 'building' tiles (buildingKind 0-2) and ruined ones (3/4, same
model with a scorch tint), scaled by FOOTPRINT (the larger of the model's own X/Z extent), not height — a
hex tile's own radius bounds the footprint regardless of a model's own raw scale (the exact "aparece fuera
de su tile" bug a real user report already caught on `RealRock`, designed around here from the start
instead). Height is left to fall out of the model's own actual proportions rather than forcing a uniform
box.

- `missile-hellfire.glb` — a single AGM-114 Hellfire mesh extracted from ["Missile & Bomb Collection - Fighter
  Jets - Free"](https://sketchfab.com/3d-models/missile-bomb-collection-fighter-jets-free) by
  [bohmerang](https://sketchfab.com/bohmerang), licensed
  [CC-BY-NC-SA 4.0](http://creativecommons.org/licenses/by-nc-sa/4.0/). **Used as an explicit user-approved
  placeholder** ("si encuentras alguno con licencia mas restrictiva, podemos ponerlo com oplaceholder") pending
  a commercial-friendly (CC0/CC-BY) replacement, since this collection's NC-SA terms don't clear it for
  eventual commercial use. User provided the full 16-model collection file directly and picked this specific
  missile ("yo creo que AGM-114 Hellfire es el mejor candidato") after comparing candidates. Extracted with a
  one-off `@gltf-transform` SDK script (not the CLI, which has no single-node-extraction command): re-parented
  the target node (`AGM-114 Hellfire_15`) onto the scene root via `scene.addChild()` (auto-detaching it from
  its original ancestor chain), removed every other top-level scene child, then `prune()`'d now-unreferenced
  resources — left with just that node's own mesh, material, and 2 textures (278 vertices, 669KB). Used by
  AttackEffects.tsx's `RealMissile`/`Missile` for the 'missile' attack category's guided-missile bodies;
  the 'mg' (machine-gun) category reuses the same `Missile`/`MissileAttack` components but keeps the original
  flat additive-glow-sprite look (`realModel={false}`) since a burst of real missile bodies reads wrong for
  bullets.

Real tree models were tried twice. First as low-poly `.glb` meshes (Kenney's CC0 Nature Kit), but every
variant's canopy material turned out to be an unnaturally teal/turquoise green in-engine (not a rendering
bug — that's the pack's actual baked `baseColorFactor`, `leafsGreen` = `rgb(41,201,171)`), which fought the
realism the user asked for. A procedural trunk/branch-cylinders-plus-billboarded-leaf-card hybrid replaced
it, using this same CC-BY-4.0 model's own extracted textures on cheap procedural geometry rather than its
real mesh — cheap, but still read as "árboles cutres" up close, per direct user feedback after being told
the real downloaded model wasn't being used. `realistic-tree.glb` (this entry) is the real mesh, simplified
and texture-patched as described above; the procedural trunk/branch/leaf-card geometry it replaced
(`TreeBillboard`, `LeafInstances`, `Branch`) was deleted, along with the now-unused `bark.jpg`,
`leaf-fern.png` and `leaf-broad.png` that geometry used to render.
