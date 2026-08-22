# Texture credits

All files are real CC0 (public domain) photo textures from
[ambientCG](https://ambientcg.com/) — free to use, modify, and
redistribute without attribution, credited here anyway for provenance.

- `table-wood.jpg` — [Wood095](https://ambientcg.com/view?id=Wood095), 1K color/diffuse map only (normal/roughness/displacement maps dropped, unused).
- `sky.jpg` — [Day Sky HDRI 067B](https://ambientcg.com/view?id=DaySkyHDRI067B), 1K tonemapped equirectangular JPG (the `.exr`/`.hdr` originals weren't needed).
- `grass.jpg` — [Grass001](https://ambientcg.com/view?id=Grass001), 1K color/diffuse map only (AO/normal/roughness/displacement maps dropped, unused) — plains tiles' terrain texture (terrain.ts), replacing the earlier procedural canvas pattern for that one terrain type.
- `forest-floor.jpg` — [Moss002](https://ambientcg.com/view?id=Moss002), 1K color/diffuse map only — forest tiles' terrain texture, darkened via terrainColor()'s material tint (dense canopy shadow, seen from directly above) rather than used at its own bright/lawn-like tone.
- `dirt.jpg` — [Ground051](https://ambientcg.com/view?id=Ground051), 1K color/diffuse map only — a minority of plains tiles (terrain.ts's `plainsGroundVariant`) render this bare-earth-with-pebbles photo instead of grass.jpg, so a field reads as patchy ground rather than a single uniform lawn.
- `bark.jpg` — [Bark006](https://ambientcg.com/view?id=Bark006), color/diffuse map only, downscaled to 512px — TerrainDecor.tsx's forest-tile trees' trunk texture.
- `leaf-broad.png` — cropped to a single leaf from [Leaf001](https://ambientcg.com/view?id=Leaf001)'s Color+Opacity maps (composited into one RGBA PNG — the source ships them as separate JPGs, one greyscale alpha mask), downscaled to 384px tall — TerrainDecor.tsx's light_forest canopy billboard cards.
- `leaf-fern.png` — same Color+Opacity compositing, from [Leaf003](https://ambientcg.com/view?id=Leaf003) (a compound fern-like frond, visually distinct from leaf-broad's simple oval) — dense/`forest` canopy billboard cards, so light_forest and forest read as different tree species, not just "fewer/more of the same leaf".
- `road.jpg` — [Asphalt002](https://ambientcg.com/view?id=Asphalt002), 1K color/diffuse map only, downscaled to 512px — plain worn asphalt with no baked-in centerline (see RoadMarkings.tsx, which paints the line markings itself from each tile's real neighbor connections), replacing the earlier procedural canvas pattern for road tiles.

Tree models were tried first as real low-poly `.glb` meshes (Kenney's CC0
Nature Kit), but every variant's canopy material turned out to be an
unnaturally teal/turquoise green in-engine (not a rendering bug — that's
the pack's actual baked `baseColorFactor`, `leafsGreen` = `rgb(41,201,171)`),
which fought the realism the user asked for. Billboarded real leaf photos
(this entry) replaced them entirely — see TerrainDecor.tsx's `TreeBillboard`.
