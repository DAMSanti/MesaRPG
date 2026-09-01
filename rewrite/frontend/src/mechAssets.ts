/** Curated per-chassis 3D assets (public/models/mechs/*.glb) — hand-matched
 * against the real mech catalog's chassis/model strings (app/mech_templates,
 * synced from MTF data) so exact matches use `===`, no fuzzy parsing needed.
 * Model codes are copied verbatim, including nicknames/quotes, from
 * `SELECT DISTINCT chassis, model FROM mech_templates`.
 *
 * Fallback is 3 tiers deep (see resolveMechModelUrl):
 *   1. This exact chassis+model has its own asset.
 *   2. This chassis has at least one asset — its `placeholder` stands in
 *      for every other model of that chassis until a specific one is added.
 *   3. No asset for this chassis at all — Mech3D's own generic
 *      mech-placeholder.glb (unbranded) is the final fallback.
 *
 * Adding a new model: drop the .glb in public/models/mechs/, add one line
 * here. If it's the first asset for a chassis, it becomes that chassis'
 * placeholder too — no other wiring needed, Mech3D normalizes every
 * model's own bounding box at load time (see its useMemo), so a
 * differently-scaled/pivoted source model doesn't need manual scale
 * tuning to sit right on the hex.
 */
export interface ChassisAssets {
  /** Stands in for any model of this chassis without its own entry below. */
  placeholder: string
  /** Exact `mech.model` string -> its own specific asset. */
  models: Record<string, string>
}

const MECHS_DIR = '/models/mechs'

export const MECH_CHASSIS_ASSETS: Record<string, ChassisAssets> = {
  // Placeholder tier, same pipeline as Warhammer below (AssetStudio ->
  // Blender: body+skeleton extracted straight from the real game, weapons
  // parented to the shared skeleton's bones, animations pushed to muted NLA
  // tracks). Every catalog variant shares this one exported body/skeleton.
  Annihilator: {
    placeholder: `${MECHS_DIR}/Annihilator.glb`,
    models: Object.fromEntries([
      'ANH-1A', 'ANH-1E', 'ANH-1G', 'ANH-1X', 'ANH-2A', 'ANH-2AX', 'ANH-3A',
      'ANH-4A', 'ANH-5W', 'C', "C 'Gausszilla'", 'C 2',
    ].map((model) => [model, `${MECHS_DIR}/Annihilator.glb`])),
  },
  Assassin: {
    placeholder: `${MECHS_DIR}/Assassin.glb`,
    models: Object.fromEntries([
      "'Servitor'", 'ASN-101', 'ASN-109', 'ASN-21', 'ASN-23', 'ASN-30',
      'ASN-30 (Alice)', 'ASN-99',
    ].map((model) => [model, `${MECHS_DIR}/Assassin.glb`])),
  },
  Archer: {
    placeholder: `${MECHS_DIR}/Archer.glb`,
    models: Object.fromEntries([
      '(Wolf)', 'ARC-1A', 'ARC-2K', 'ARC-2R', 'ARC-2Rb', 'ARC-2S', 'ARC-2W',
      'ARC-4M', 'ARC-4M2', 'ARC-5CS', 'ARC-5R', 'ARC-5S', 'ARC-5W', 'ARC-6S',
      'ARC-6W', 'ARC-7C', 'ARC-7L', 'ARC-7S', 'ARC-8M', 'ARC-9K', 'ARC-9KC',
      'ARC-9M', 'ARC-9R', 'ARC-9W', 'C', 'C 2',
    ].map((model) => [model, `${MECHS_DIR}/Archer.glb`])),
  },
  // Replaces the old hand-authored atlas-as7-d/atlas-as7-wgs pair (moved to
  // public/models/mechs/legacy/, kept on disk but unreferenced) with the
  // same placeholder-tier pipeline as Warhammer/Annihilator/Archer/Assassin.
  Atlas: {
    placeholder: `${MECHS_DIR}/Atlas.glb`,
    models: Object.fromEntries([
      'AS7-00 (Jurn)', 'AS7-A', 'AS7-C', 'AS7-CM', 'AS7-D', 'AS7-D (Danielle)',
      'AS7-D(C)', 'AS7-D-DC', 'AS7-Dr', 'AS7-K', 'AS7-K-DC', 'AS7-K2',
      'AS7-K2 (Jedra)', 'AS7-K3', 'AS7-K4', 'AS7-RS', 'AS7-S', 'AS7-S2',
      'AS7-S3', 'AS7-S3-DC', 'AS7-S4', 'AS7-WGS (Samsonov)', 'AS8-D', 'AS8-K',
      'AS8-S', 'C', 'C 2', 'C 3',
    ].map((model) => [model, `${MECHS_DIR}/Atlas.glb`])),
  },
  // Replaces the old hand-authored awesome-aws-8q/awesome-aws-pb pair (moved
  // to legacy/ — 'AWS-PB' was never a real catalog code, see the Commando
  // fix above for the same class of mistake).
  Awesome: {
    placeholder: `${MECHS_DIR}/Awesome.glb`,
    models: Object.fromEntries([
      'AWS-10KM', 'AWS-11H', 'AWS-11M', 'AWS-11R', 'AWS-11V', 'AWS-8Q',
      'AWS-8Q (Buck)', 'AWS-8R', 'AWS-8T', 'AWS-8V', 'AWS-9M', 'AWS-9Ma',
      'AWS-9Q', 'AWS-9Q (Klatt)',
    ].map((model) => [model, `${MECHS_DIR}/Awesome.glb`])),
  },
  // Replaces the old hand-authored battlemaster-blr-1g/1ghe pair (moved to
  // legacy/) with the placeholder-tier pipeline.
  BattleMaster: {
    placeholder: `${MECHS_DIR}/Battlemaster.glb`,
    models: Object.fromEntries([
      'BLR-10S', 'BLR-10S2', 'BLR-1D', 'BLR-1G', 'BLR-1G (Red Corsair)',
      'BLR-1G-DC', "BLR-1GHE 'HellSinger'", 'BLR-1Gb', 'BLR-1Gbc', 'BLR-1Gc',
      'BLR-1Gd', 'BLR-1S', 'BLR-2C', 'BLR-3M', 'BLR-3M (Rogers)', 'BLR-3M-DC',
      'BLR-3S', 'BLR-4L', 'BLR-4S', 'BLR-4S (Calvin II)', 'BLR-4S (Calvin)',
      'BLR-5M', 'BLR-6C', 'BLR-6G', 'BLR-6M', 'BLR-6R', 'BLR-6X', 'BLR-CM',
      'BLR-K3', 'BLR-K4', 'BLR-M3', 'C', 'C 2', 'C 3',
    ].map((model) => [model, `${MECHS_DIR}/Battlemaster.glb`])),
  },
  // Replaces the old hand-authored banshee-bnc-3m (moved to legacy/) with
  // the placeholder-tier pipeline.
  Banshee: {
    placeholder: `${MECHS_DIR}/Banshee.glb`,
    models: Object.fromEntries([
      'BNC-11X', 'BNC-12S', 'BNC-1E', 'BNC-3E', 'BNC-3M', 'BNC-3MC', 'BNC-3Mr',
      'BNC-3Q', 'BNC-3S', 'BNC-3S (Reinesblatt)', 'BNC-5S', 'BNC-5S (Sawyer)',
      'BNC-5S (Vandergriff)', 'BNC-6S', 'BNC-7S', 'BNC-8S', 'BNC-9S', 'BNC-9S2',
    ].map((model) => [model, `${MECHS_DIR}/Banshee.glb`])),
  },
  // Replaces the old hand-authored blackjack-bj-1/bj-a pair (moved to
  // legacy/ — "BJ-A"/"Arrow" was never a real catalog code either, same
  // class of mistake as the old Commando/Awesome entries) with the
  // placeholder-tier pipeline.
  Blackjack: {
    placeholder: `${MECHS_DIR}/Blackjack.glb`,
    models: Object.fromEntries([
      'BJ-1', 'BJ-1DB', 'BJ-1DC', 'BJ-1X', 'BJ-2', 'BJ-2r', 'BJ-3', 'BJ-4', 'BJ-5', 'C',
    ].map((model) => [model, `${MECHS_DIR}/Blackjack.glb`])),
  },
  // Real catalog chassis name is "Black Knight" (with a space) — file/asset
  // naming uses "Blackknight" (no space), same one-word convention as every
  // other placeholder-tier .glb.
  'Black Knight': {
    placeholder: `${MECHS_DIR}/Blackknight.glb`,
    models: Object.fromEntries([
      'BL-10-KNT (Ross)', 'BL-12-KNT', 'BL-18-KNT', 'BL-6-KNT', 'BL-6-KNT (Ian)', 'BL-6-RR',
      'BL-6b-KNT', 'BL-7-KNT', 'BL-7-KNT-L', 'BL-9-KNT', "BL-X-KNT 'Red Reaper'",
      'BLK-NT-2Y', 'BLK-NT-3A', 'BLK-NT-3B', 'BLK-NT-4D', 'BLK-NT-5H',
    ].map((model) => [model, `${MECHS_DIR}/Blackknight.glb`])),
  },
  // First chassis from the MW5:Mercenaries (Unreal Engine) extraction
  // pipeline instead of the original HBS/Unity one — source is FModel's
  // own UEFormat (.uemodel/.ueanim), imported via the io_scene_ueformat
  // Blender addon, not AssetStudio+FBX. Real upside: 85 of its own
  // BSW_-prefixed animations, not a single borrowed atlas_ clip anywhere
  // — no retargeting needed for this one. Textures aren't wired up yet
  // (the importer only sets material NAMES/indices, no node graph), so
  // it currently renders untextured — same "mesh first, texture later"
  // order every other placeholder-tier chassis went through.
  Bushwacker: {
    placeholder: `${MECHS_DIR}/Bushwacker.glb`,
    models: Object.fromEntries([
      'BSW-L1', 'BSW-S2', 'BSW-S2r', 'BSW-X1', 'BSW-X2', 'BSW-X4',
    ].map((model) => [model, `${MECHS_DIR}/Bushwacker.glb`])),
  },
  // Replaces the old hand-authored catapult-cplt-{k2,c1,c1d} trio (moved to
  // legacy/) with the placeholder-tier pipeline.
  Catapult: {
    placeholder: `${MECHS_DIR}/Catapult.glb`,
    models: Object.fromEntries([
      'CPLT-6K', 'CPLT-A1', 'CPLT-C1', "CPLT-C1 (Jenny) 'Butterbee'", 'CPLT-C1b', 'CPLT-C2',
      'CPLT-C3', 'CPLT-C4', 'CPLT-C4C', 'CPLT-C5', 'CPLT-C5A', 'CPLT-C6', 'CPLT-H2', 'CPLT-K2',
      'CPLT-K2K', 'CPLT-K3', 'CPLT-K4', 'CPLT-K5', 'CPLT-K6',
    ].map((model) => [model, `${MECHS_DIR}/Catapult.glb`])),
  },
  // Replaces the old hand-authored centurion-cn9-{a,ylw} pair (moved to
  // legacy/) with the placeholder-tier pipeline.
  Centurion: {
    placeholder: `${MECHS_DIR}/Centurion.glb`,
    models: Object.fromEntries([
      'CN10-B', 'CN10-J', 'CN10-W', 'CN9-A', 'CN9-AH', 'CN9-AL', 'CN9-Ar', 'CN9-D', 'CN9-D3',
      'CN9-D3D', 'CN9-D4D', 'CN9-D5', 'CN9-D9', 'CN9-Da', 'CN9-H', "CN9-YLW 'Yen Lo Wang'",
      "CN9-YLW2 'Yen Lo Wang'", "CN9-YLW3 'Yen Lo Wang'",
    ].map((model) => [model, `${MECHS_DIR}/Centurion.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Cataphract: {
    placeholder: `${MECHS_DIR}/Cataphract.glb`,
    models: Object.fromEntries([
      'CTF-0X', 'CTF-1X', 'CTF-2X', 'CTF-2X (George)', 'CTF-3D', 'CTF-3L', 'CTF-3LL',
      'CTF-3X (Sara)', 'CTF-4L', 'CTF-4X', 'CTF-5D', 'CTF-5L', 'CTF-5LL', 'CTF-5MOC (Naomi)',
    ].map((model) => [model, `${MECHS_DIR}/Cataphract.glb`])),
  },
  Cicada: {
    placeholder: `${MECHS_DIR}/Cicada.glb`,
    models: Object.fromEntries([
      'CDA-2A', 'CDA-2B', 'CDA-3C', 'CDA-3F', 'CDA-3G', 'CDA-3M', 'CDA-3MA', 'CDA-3P', 'CDA-4A',
    ].map((model) => [model, `${MECHS_DIR}/Cicada.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset (Commando used to be
  // one of the "no placeholder-tier replacement yet" chassis in the big
  // comment below — real user request added its own asset, so it's
  // removed from that list now).
  Commando: {
    placeholder: `${MECHS_DIR}/Commando.glb`,
    models: Object.fromEntries([
      'COM-1A', 'COM-1B', 'COM-1C', 'COM-1D', 'COM-2D', 'COM-2Dr', 'COM-3A', 'COM-4H', 'COM-5S',
      'COM-7B', 'COM-7S', 'COM-7S2 (Freyr)', 'COM-8S', 'COM-9S',
    ].map((model) => [model, `${MECHS_DIR}/Commando.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Crab: {
    placeholder: `${MECHS_DIR}/Crab.glb`,
    models: Object.fromEntries([
      'CRB-20', 'CRB-27', 'CRB-27b', 'CRB-27sl', 'CRB-30', 'CRB-45', 'CRB-54', 'CRB-C',
    ].map((model) => [model, `${MECHS_DIR}/Crab.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Cyclops: {
    placeholder: `${MECHS_DIR}/Cyclops.glb`,
    models: Object.fromEntries([
      'C', 'CP-10-HQ', 'CP-10-Q', 'CP-10-Z', 'CP-11-A', 'CP-11-A-DC', 'CP-11-B', 'CP-11-C',
      'CP-11-C2', 'CP-11-C3', 'CP-11-G', 'CP-11-H', 'CP-12-K',
    ].map((model) => [model, `${MECHS_DIR}/Cyclops.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Dragon: {
    placeholder: `${MECHS_DIR}/Dragon.glb`,
    models: Object.fromEntries([
      'DRG-1C', 'DRG-2Y (Yoriyoshi)', 'DRG-5N', 'DRG-5Nr', 'DRG-7N',
    ].map((model) => [model, `${MECHS_DIR}/Dragon.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Enforcer: {
    placeholder: `${MECHS_DIR}/Enforcer.glb`,
    models: Object.fromEntries([
      'ENF-4R', 'ENF-4R (Daniel)', 'ENF-5D', 'ENF-5D (Daniel)', 'ENF-5R',
    ].map((model) => [model, `${MECHS_DIR}/Enforcer.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Flea: {
    placeholder: `${MECHS_DIR}/Flea.glb`,
    models: Object.fromEntries([
      "'Fire Ant'", 'FLE-15', 'FLE-16', 'FLE-17', 'FLE-19', 'FLE-20', 'FLE-21', 'FLE-4',
    ].map((model) => [model, `${MECHS_DIR}/Flea.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Grasshopper: {
    placeholder: `${MECHS_DIR}/Grasshopper.glb`,
    models: Object.fromEntries([
      '(Reynolds)', 'GHR-5H', 'GHR-5J', 'GHR-5N', 'GHR-6K', 'GHR-7K', "GHR-7K 'Gravedigger'",
      'GHR-7P', 'GHR-7X', 'GHR-8K', 'GHR-C',
    ].map((model) => [model, `${MECHS_DIR}/Grasshopper.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Griffin: {
    placeholder: `${MECHS_DIR}/Griffin.glb`,
    models: Object.fromEntries([
      'C', 'GRF-1A', 'GRF-1DS', "GRF-1E 'Sparky'", "GRF-1E2 'Sparky 2.0'", 'GRF-1N', 'GRF-1RG',
      'GRF-1S', 'GRF-2N', 'GRF-3M', 'GRF-3N', 'GRF-3RG', 'GRF-4N', 'GRF-4R', 'GRF-5K', 'GRF-5L',
      'GRF-5M', 'GRF-6CS', 'GRF-6R', 'GRF-6S', 'GRF-6S (Francine II)', 'GRF-6S (Francine)', 'GRF-6S2',
    ].map((model) => [model, `${MECHS_DIR}/Griffin.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset — exported later than
  // the batch above (the first export attempt hadn't actually finished).
  Hatchetman: {
    placeholder: `${MECHS_DIR}/Hatchetman.glb`,
    models: Object.fromEntries([
      'HCT-3F', 'HCT-3F (Austin)', 'HCT-5D', 'HCT-5DD', 'HCT-5DT', 'HCT-5K', 'HCT-5S',
      'HCT-5S (Austin)', 'HCT-6D', 'HCT-6M', 'HCT-6S', 'HCT-7D', 'HCT-7R', 'HCT-7S', 'HCT-8S',
    ].map((model) => [model, `${MECHS_DIR}/Hatchetman.glb`])),
  },
  // Replaces the old hand-authored highlander-hgn-732 (moved to legacy/)
  // with the placeholder-tier pipeline.
  Highlander: {
    placeholder: `${MECHS_DIR}/Highlander.glb`,
    models: Object.fromEntries([
      'HGN-641-X-2', 'HGN-694', 'HGN-732', 'HGN-732 (Colleen)', 'HGN-732 (Jorgensson)', 'HGN-732b',
      'HGN-733', 'HGN-733C', 'HGN-733P', 'HGN-734', 'HGN-736', 'HGN-738', 'HGN-740',
    ].map((model) => [model, `${MECHS_DIR}/Highlander.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Hunchback: {
    placeholder: `${MECHS_DIR}/Hunchback.glb`,
    models: Object.fromEntries([
      'C', 'HBK-4G', 'HBK-4G (Hohiro)', 'HBK-4G (Shakir)', 'HBK-4H', 'HBK-4J', 'HBK-4N', 'HBK-4P',
      'HBK-4SP', 'HBK-5H', 'HBK-5M', 'HBK-5N', 'HBK-5P', 'HBK-5S', 'HBK-5SG', 'HBK-5SS', 'HBK-6N',
      'HBK-6P', 'HBK-6S', 'HBK-7R', 'HBK-7S', 'HBK-7X-4',
    ].map((model) => [model, `${MECHS_DIR}/Hunchback.glb`])),
  },
  // Replaces the old hand-authored jagermech-jm6-fb (moved to legacy/ —
  // "JM6-FB"/"Firebrand" was never a real catalog code, same class of
  // mistake as the old Commando/Awesome/Blackjack entries) with the
  // placeholder-tier pipeline.
  JagerMech: {
    placeholder: `${MECHS_DIR}/Jagermech.glb`,
    models: Object.fromEntries([
      'JM6-A', 'JM6-DD', 'JM6-DDa', 'JM6-DG', 'JM6-DGr', 'JM6-H', 'JM6-S', 'JM7-C3BS', 'JM7-D',
      'JM7-DD', 'JM7-F', 'JM7-G',
    ].map((model) => [model, `${MECHS_DIR}/Jagermech.glb`])),
  },
  // Brand new chassis, no prior hand-authored asset.
  Javelin: {
    placeholder: `${MECHS_DIR}/Javelin.glb`,
    models: Object.fromEntries([
      'JVN-10A', "JVN-10F 'Fire Javelin'", 'JVN-10N', 'JVN-10P', "JVN-11A 'Fire Javelin'", 'JVN-11B',
      'JVN-11D', 'JVN-11D (Farrell)', 'JVN-11F', 'JVN-11P', 'JVN-12N',
    ].map((model) => [model, `${MECHS_DIR}/Javelin.glb`])),
  },
  // Real user request: "mueve todos los modelos antiguos [a legacy], no
  // solo los que reemplazamos" — every hand-authored chassis below without
  // a placeholder-tier replacement yet had its .glb moved to legacy/ too,
  // so its entry is removed rather than left pointing at a missing file
  // (resolveMechModelUrl's own 3-tier fallback means these chassis just
  // land on GENERIC_MECH_PLACEHOLDER until each gets its own new asset —
  // exactly the same "no asset for this chassis at all" case the fallback
  // was already designed for, not a new failure mode). Crockett,
  // Executioner, Hatamoto-Chi, Jenner, Kintaro,
  // Locust, Mongrel, Rifleman IIC, Shadow Hawk, Thanatos, Thug,
  // Thunderbolt, Timber Wolf, Trebuchet, UrbanMech, Uziel, Viking, Vulcan.
  // NOTE — Jenner specifically: LIMB_MESH_NAMES/the real footstep-IK path
  // in Mech3D.tsx and HexMap.tsx were written against ITS specific mesh/
  // bone names (foot bones `PieD`/`PieI`); losing this entry doesn't break
  // either — both already treat "chassis without them" as the expected
  // default case (HexMap falls back to its geometric footprint
  // approximation) — but re-add Jenner's own placeholder-tier entry first
  // if a nicer look, not just a safe fallback, is wanted back sooner.
  // Placeholder tier: extracted straight from the real BattleTech game via
  // AssetStudio (real skin/skeleton/animation, un-annotated in MechLab) —
  // not hand-authored like the chassis above. See Mech3D.tsx's own
  // GAME_CLIP_SUFFIXES for how its unmodified HBS-named animation clips
  // (e.g. "warhammer_moveCoreIdle") still resolve without renaming.
  // All 29 real catalog variants share this one exported body/skeleton —
  // only their weapon loadout differs, which Mech3D's own `weapons` prop
  // already resolves per-unit from the real ficha at render time (see
  // weaponMountOfMesh/weaponVisualBucket), so every variant just points at
  // the same .glb rather than needing its own model file.
  Warhammer: {
    placeholder: `${MECHS_DIR}/Warhammer.glb`,
    models: Object.fromEntries([
      'C', 'C 2', 'C 3', 'WHD-10CT', 'WHM-10K', 'WHM-10T', 'WHM-11T', 'WHM-4L', 'WHM-5L',
      'WHM-6D', 'WHM-6K', 'WHM-6L', 'WHM-6R', 'WHM-6Rb', 'WHM-6Rk', 'WHM-7A', 'WHM-7CS',
      'WHM-7K', 'WHM-7M', 'WHM-7M-DC', 'WHM-7S', 'WHM-8D', 'WHM-8D2', 'WHM-8K', 'WHM-8M',
      'WHM-8R', 'WHM-9D', 'WHM-9K', 'WHM-9S', "WHM-X7 'The Lich'",
    ].map((model) => [model, `${MECHS_DIR}/Warhammer.glb`])),
  },
  Charger: {
    placeholder: `${MECHS_DIR}/Charger.glb`,
    models: Object.fromEntries([
      'CGR-1A1', 'CGR-1A5', 'CGR-1A9', 'CGR-1L', 'CGR-1X1', 'CGR-2A2', 'CGR-3K',
      'CGR-3Kr', 'CGR-C', 'CGR-KMZ', 'CGR-SA5', "CGR-SB 'Challenger'",
    ].map((model) => [model, `${MECHS_DIR}/Charger.glb`])),
  },
  Crusader: {
    placeholder: `${MECHS_DIR}/Crusader.glb`,
    models: Object.fromEntries([
      'CRD-10S', 'CRD-2R', 'CRD-3D', 'CRD-3K', 'CRD-3L', 'CRD-3R', 'CRD-3R (Crael)',
      'CRD-4BR', 'CRD-4D', 'CRD-4K', 'CRD-4L', 'CRD-5K', 'CRD-5M', 'CRD-5S', 'CRD-6D',
      'CRD-6M', 'CRD-6T', 'CRD-7D', 'CRD-7L', 'CRD-7M', 'CRD-7M2', 'CRD-7W', 'CRD-8L',
      'CRD-8R', 'CRD-8S', 'CRD-9BR', 'CRD-9R', 'CRD-9S',
    ].map((model) => [model, `${MECHS_DIR}/Crusader.glb`])),
  },
  Dervish: {
    placeholder: `${MECHS_DIR}/Dervish.glb`,
    models: Object.fromEntries([
      'DV-11DK', 'DV-1S', 'DV-6M', 'DV-6Md', 'DV-6Mr', 'DV-7D', 'DV-8D',
      "DV-8D2 'Lightbringer'", 'DV-9D',
    ].map((model) => [model, `${MECHS_DIR}/Dervish.glb`])),
  },
  Firestarter: {
    placeholder: `${MECHS_DIR}/Firestarter.glb`,
    models: Object.fromEntries([
      'FS9-A', 'FS9-B', 'FS9-C', 'FS9-H', 'FS9-K', "FS9-M 'Mirage II'",
      "FS9-M 'Mirage'", 'FS9-M2', 'FS9-M3', 'FS9-M4', 'FS9-P', 'FS9-S',
      'FS9-S1', 'FS9-S2', 'FS9-S3', 'FS9-X81',
    ].map((model) => [model, `${MECHS_DIR}/Firestarter.glb`])),
  },
  'Hatamoto-Chi': {
    placeholder: `${MECHS_DIR}/Hatamotochi.glb`,
    models: Object.fromEntries([
      'HTM-26T', 'HTM-27T', 'HTM-27T (Daniel II)', 'HTM-27T (Daniel)',
      'HTM-28T', 'HTM-28T (Shin)', 'HTM-28Tr',
    ].map((model) => [model, `${MECHS_DIR}/Hatamotochi.glb`])),
  },
  Jenner: {
    placeholder: `${MECHS_DIR}/Jenner.glb`,
    models: Object.fromEntries([
      'JR10-X', 'JR7-A', 'JR7-C', 'JR7-C2', 'JR7-C3', 'JR7-C4', 'JR7-D',
      'JR7-F', 'JR7-K', 'JR7-K (Grace II)', 'JR7-K (Grace)', 'JR7-K (Samuli)', 'JR7-N',
    ].map((model) => [model, `${MECHS_DIR}/Jenner.glb`])),
  },
  'Jenner IIC': {
    placeholder: `${MECHS_DIR}/JennerIIC.glb`,
    models: Object.fromEntries([
      '(Standard)', '2', '3', '4', '5',
    ].map((model) => [model, `${MECHS_DIR}/JennerIIC.glb`])),
  },
  'King Crab': {
    placeholder: `${MECHS_DIR}/Kingcrab.glb`,
    models: Object.fromEntries([
      'KGC-000', 'KGC-0000', 'KGC-000b', 'KGC-001', 'KGC-005', 'KGC-005r',
      'KGC-007', 'KGC-008', 'KGC-008B', 'KGC-009', 'KGC-009C', 'KGC-010', 'KGC-011',
    ].map((model) => [model, `${MECHS_DIR}/Kingcrab.glb`])),
  },
  Kintaro: {
    placeholder: `${MECHS_DIR}/Kintaro.glb`,
    models: Object.fromEntries([
      'KTO-18', 'KTO-19', 'KTO-19b', 'KTO-20', 'KTO-21', 'KTO-C', 'KTO-K',
    ].map((model) => [model, `${MECHS_DIR}/Kintaro.glb`])),
  },
  Kodiak: {
    placeholder: `${MECHS_DIR}/Kodiak.glb`,
    models: Object.fromEntries([
      '(Cale)', '(Standard)', '2', '3', '4', '5', '6',
    ].map((model) => [model, `${MECHS_DIR}/Kodiak.glb`])),
  },
  Locust: {
    placeholder: `${MECHS_DIR}/Locust.glb`,
    models: Object.fromEntries([
      'C', 'LCT-1E', 'LCT-1L', 'LCT-1M', 'LCT-1S', 'LCT-1V', 'LCT-1V2', 'LCT-1Vb',
      'LCT-3D', 'LCT-3M', 'LCT-3S', 'LCT-3V', 'LCT-5M', 'LCT-5M2', 'LCT-5M3',
      'LCT-5S', 'LCT-5T', 'LCT-5V', 'LCT-5W', 'LCT-5W2', 'LCT-6M', 'LCT-7S',
      'LCT-7V', 'LCT-7V2',
    ].map((model) => [model, `${MECHS_DIR}/Locust.glb`])),
  },
  Longbow: {
    placeholder: `${MECHS_DIR}/Longbow.glb`,
    models: Object.fromEntries([
      'LGB-0C', 'LGB-0H', 'LGB-0W', 'LGB-0W2', 'LGB-10C', 'LGB-10K', 'LGB-12C',
      'LGB-12R', 'LGB-13C', 'LGB-13NAIS', 'LGB-14C', 'LGB-14Q', 'LGB-14V',
      'LGB-7Q', 'LGB-7V', 'LGB-8C', 'LGB-8V',
    ].map((model) => [model, `${MECHS_DIR}/Longbow.glb`])),
  },
  Marauder: {
    placeholder: `${MECHS_DIR}/Marauder.glb`,
    models: Object.fromEntries([
      '(Bounty Hunter-3015)', '(Bounty Hunter-3044)', 'Bounty Hunter 3138', 'C',
      'MAD-11D', 'MAD-1R', 'MAD-2R', 'MAD-2T', 'MAD-3D', 'MAD-3L', 'MAD-3M',
      'MAD-3R', 'MAD-4X', 'MAD-5CS', 'MAD-5D', 'MAD-5D-DC', 'MAD-5L', 'MAD-5M',
      'MAD-5R', 'MAD-5S', 'MAD-5T', 'MAD-6L', 'MAD-7C', 'MAD-7D', 'MAD-7M',
      'MAD-7R', 'MAD-7S', 'MAD-9D', 'MAD-9M', 'MAD-9M2', 'MAD-9S', 'MAD-9W',
      'MAD-9W2', 'MAD-SD (Douglass)', 'Red Hunter', 'Red Hunter 3146',
    ].map((model) => [model, `${MECHS_DIR}/Marauder.glb`])),
  },
  'Marauder II': {
    placeholder: `${MECHS_DIR}/Marauderii.glb`,
    models: Object.fromEntries([
      '(Bounty Hunter)', 'C', 'MAD-10D', 'MAD-4A', 'MAD-4H', 'MAD-4K', 'MAD-4L',
      'MAD-4S', 'MAD-5A', 'MAD-5B', 'MAD-5C', 'MAD-5W', 'MAD-6A', 'MAD-6C',
      'MAD-6D', 'MAD-6M', 'MAD-6S', 'MAD-8K',
    ].map((model) => [model, `${MECHS_DIR}/Marauderii.glb`])),
  },
  Mauler: {
    placeholder: `${MECHS_DIR}/Mauler.glb`,
    models: Object.fromEntries([
      'MAL-1K', 'MAL-1R', 'MAL-2R', 'MAL-3R', "MAL-4X 'Todesbote'", 'MAL-C',
    ].map((model) => [model, `${MECHS_DIR}/Mauler.glb`])),
  },
  Nightstar: {
    placeholder: `${MECHS_DIR}/Nightstar.glb`,
    models: Object.fromEntries([
      'NSR-10D', 'NSR-9FC', 'NSR-9J', 'NSR-9J (Brubaker)', 'NSR-9SS',
    ].map((model) => [model, `${MECHS_DIR}/Nightstar.glb`])),
  },
  Orion: {
    placeholder: `${MECHS_DIR}/Orion.glb`,
    models: Object.fromEntries([
      'C', 'C 2', 'ON1-C', 'ON1-H', 'ON1-K', 'ON1-K (Kerensky)', 'ON1-M', 'ON1-M-DC',
      'ON1-MA', 'ON1-MB', 'ON1-MC', 'ON1-MD', 'ON1-V', 'ON1-V-DC', 'ON1-VA',
      'ON2-M', 'ON3-M', 'ON3-MX',
    ].map((model) => [model, `${MECHS_DIR}/Orion.glb`])),
  },
  Panther: {
    placeholder: `${MECHS_DIR}/Panther.glb`,
    models: Object.fromEntries([
      'PNT-10K', 'PNT-10K2', 'PNT-10KA', 'PNT-12A', 'PNT-12K', 'PNT-12K2',
      'PNT-12KC', 'PNT-13K', 'PNT-14R', 'PNT-14S', 'PNT-16K', 'PNT-8Z',
      'PNT-9ALAG', 'PNT-9R', 'PNT-C', 'PNT-CA',
    ].map((model) => [model, `${MECHS_DIR}/Panther.glb`])),
  },
  'Phoenix Hawk': {
    placeholder: `${MECHS_DIR}/Phoenixhawk.glb`,
    models: Object.fromEntries([
      'C', 'C 2', 'PXH-1', 'PXH-1-EC', 'PXH-1D', 'PXH-1K', 'PXH-1Kk',
      'PXH-1b (Special)', 'PXH-1bC', 'PXH-1c (Special)', 'PXH-2', 'PXH-2K',
      'PXH-3D', 'PXH-3K', 'PXH-3M', 'PXH-3M (Masters)', 'PXH-3PL', 'PXH-3S',
      'PXH-4L', 'PXH-4L (Sante)', 'PXH-4M', 'PXH-4W', 'PXH-5L', 'PXH-6D',
      'PXH-7CS', 'PXH-7K', 'PXH-7S', 'PXH-8CS', 'PXH-9', 'PXH-99',
    ].map((model) => [model, `${MECHS_DIR}/Phoenixhawk.glb`])),
  },
  Quickdraw: {
    placeholder: `${MECHS_DIR}/Quickdraw.glb`,
    models: Object.fromEntries([
      'QKD-4G', 'QKD-4H', 'QKD-5A', 'QKD-5K', 'QKD-5K2', 'QKD-5M', 'QKD-5Mr',
      'QKD-8K', 'QKD-8P', 'QKD-8X', 'QKD-9G', 'QKD-9M', 'QKD-C',
    ].map((model) => [model, `${MECHS_DIR}/Quickdraw.glb`])),
  },
  Raven: {
    placeholder: `${MECHS_DIR}/Raven.glb`,
    models: Object.fromEntries([
      'RVN-1X', 'RVN-2X', 'RVN-3L', 'RVN-3M', 'RVN-3X', 'RVN-4L', 'RVN-4LC',
      'RVN-4Lr', 'RVN-4X', 'RVN-5L', "RVN-SR 'Shattered Raven'", "RVN-SS 'Shattered Raven'",
    ].map((model) => [model, `${MECHS_DIR}/Raven.glb`])),
  },
  Rifleman: {
    placeholder: `${MECHS_DIR}/Rifleman.glb`,
    models: Object.fromEntries([
      'C', 'C 2', 'C 3', 'RFL-1N', 'RFL-2N', 'RFL-3C', 'RFL-3Cr', 'RFL-3N',
      'RFL-4D', 'RFL-5CS', 'RFL-5D', 'RFL-5M', 'RFL-6D', 'RFL-6X', 'RFL-7G',
      'RFL-7M', 'RFL-7N', 'RFL-7N2', 'RFL-7X', 'RFL-8D', 'RFL-8X', 'RFL-9T',
      'RFL-X3 MUSE WIND',
    ].map((model) => [model, `${MECHS_DIR}/Rifleman.glb`])),
  },
  'Shadow Hawk': {
    placeholder: `${MECHS_DIR}/Shadowhawk.glb`,
    models: Object.fromEntries([
      'C', 'SHD-11CS', 'SHD-12C', 'SHD-1R', 'SHD-2D', 'SHD-2D2', 'SHD-2H',
      'SHD-2Hb', 'SHD-2Ht', 'SHD-2K', 'SHD-3K', 'SHD-4H', 'SHD-5D',
      'SHD-5D (Sandy)', 'SHD-5M', 'SHD-5R', 'SHD-5S', 'SHD-6D', 'SHD-7CS',
      'SHD-7H', 'SHD-7M', 'SHD-8L', 'SHD-9D',
    ].map((model) => [model, `${MECHS_DIR}/Shadowhawk.glb`])),
  },
  'Shadow Hawk IIC': {
    placeholder: `${MECHS_DIR}/ShadowHawkIIC.glb`,
    models: Object.fromEntries([
      '(Standard)', '10', '11', '2', '3', '4', '5', '6', '7', '8', '9',
    ].map((model) => [model, `${MECHS_DIR}/ShadowHawkIIC.glb`])),
  },
  Spider: {
    placeholder: `${MECHS_DIR}/Spider.glb`,
    models: Object.fromEntries([
      'SDR-10K', 'SDR-5D', 'SDR-5K', 'SDR-5V', 'SDR-7K', 'SDR-7K2', 'SDR-7KC',
      'SDR-7Kr', 'SDR-7M', 'SDR-8K', 'SDR-8M', 'SDR-8R', 'SDR-8X', 'SDR-8Xr',
      'SDR-9M', 'SDR-C',
    ].map((model) => [model, `${MECHS_DIR}/Spider.glb`])),
  },
  Stalker: {
    placeholder: `${MECHS_DIR}/Stalker.glb`,
    models: Object.fromEntries([
      'STK-3F', 'STK-3F (Jagawen)', 'STK-3F (Jamison)', 'STK-3Fb', 'STK-3Fk',
      'STK-3H', 'STK-4N', 'STK-4P', 'STK-5M', 'STK-5S', 'STK-6M', 'STK-7C3BS',
      'STK-7D', 'STK-9F',
    ].map((model) => [model, `${MECHS_DIR}/Stalker.glb`])),
  },
  Thunderbolt: {
    placeholder: `${MECHS_DIR}/Thunderbolt.glb`,
    models: Object.fromEntries([
      'C', 'C 2', 'TDR-10M', 'TDR-10M (Ilyena)', 'TDR-10M (Salazar)', 'TDR-10S',
      'TDR-10SE', 'TDR-11S', 'TDR-11SE', 'TDR-12R', 'TDR-17S', 'TDR-1C',
      'TDR-5D', 'TDR-5S', 'TDR-5S-T (Tallman)', 'TDR-5SE', 'TDR-5SS', 'TDR-5Sb',
      'TDR-5Sd', 'TDR-60-RLA', 'TDR-7M', 'TDR-7S', 'TDR-7SE', 'TDR-8M', 'TDR-9M',
      'TDR-9NAIS', 'TDR-9Nr', 'TDR-9S', 'TDR-9SE', 'TDR-9T', 'TDR-9W',
    ].map((model) => [model, `${MECHS_DIR}/Thunderbolt.glb`])),
  },
  Trebuchet: {
    placeholder: `${MECHS_DIR}/Trebuchet.glb`,
    models: Object.fromEntries([
      'TBT-3C', 'TBT-5J', 'TBT-5K', 'TBT-5N', 'TBT-5S', 'TBT-7K', 'TBT-7M',
      'TBT-8B', 'TBT-9K', 'TBT-9N', 'TBT-9R', 'TBT-K7R', 'TBT-XK7',
    ].map((model) => [model, `${MECHS_DIR}/Trebuchet.glb`])),
  },
  UrbanMech: {
    placeholder: `${MECHS_DIR}/Urbanmech.glb`,
    models: Object.fromEntries([
      'UM-AIV', 'UM-R60', 'UM-R60L', 'UM-R63', 'UM-R68', 'UM-R69', 'UM-R70',
      'UM-R80', 'UM-R93', 'UM-R96',
    ].map((model) => [model, `${MECHS_DIR}/Urbanmech.glb`])),
  },
  Victor: {
    placeholder: `${MECHS_DIR}/Victor.glb`,
    models: Object.fromEntries([
      'C', 'VTR-10D', 'VTR-10L', 'VTR-10S', 'VTR-11D', 'VTR-12D', 'VTR-9A',
      'VTR-9A1', 'VTR-9B', 'VTR-9B (Li)', 'VTR-9B (Shoji)', 'VTR-9D', 'VTR-9K',
      'VTR-9K2 (St. James)', 'VTR-9Ka', 'VTR-9S', 'VTR-C', 'VTR-Cr',
    ].map((model) => [model, `${MECHS_DIR}/Victor.glb`])),
  },
  Vindicator: {
    placeholder: `${MECHS_DIR}/Vindicator.glb`,
    models: Object.fromEntries([
      "VND-1AA 'Avenging Angel'", 'VND-1R', 'VND-1R (Vong)', 'VND-1SIC', 'VND-1X',
      'VND-3L', 'VND-3LD (Dao)', 'VND-3Lr', 'VND-4L', 'VND-5L', 'VND-6L', 'VND-7L',
    ].map((model) => [model, `${MECHS_DIR}/Vindicator.glb`])),
  },
  Viper: {
    placeholder: `${MECHS_DIR}/Viper.glb`,
    models: Object.fromEntries([
      'VP-1', 'VP-5', 'VP-7', 'VP-8', 'VP-9',
    ].map((model) => [model, `${MECHS_DIR}/Viper.glb`])),
  },
  Champion: {
    placeholder: `${MECHS_DIR}/Champion.glb`,
    models: Object.fromEntries([
      'C', 'CHP-1N', 'CHP-1N2', 'CHP-1Nb', 'CHP-2N', 'CHP-3N', 'CHP-3P',
    ].map((model) => [model, `${MECHS_DIR}/Champion.glb`])),
  },
  Wolverine: {
    placeholder: `${MECHS_DIR}/Wolverine.glb`,
    models: Object.fromEntries([
      'WVR-10D', 'WVR-10R', 'WVR-10V2', 'WVR-11M', 'WVR-1R', 'WVR-3R', 'WVR-6D',
      'WVR-6K', 'WVR-6M', 'WVR-6R', 'WVR-7D', 'WVR-7K', 'WVR-7M', 'WVR-7M2',
      'WVR-8C', 'WVR-8D', 'WVR-8K', 'WVR-9D', 'WVR-9K', 'WVR-9M', 'WVR-9R',
      'WVR-9W', 'WVR-9W2',
    ].map((model) => [model, `${MECHS_DIR}/Wolverine.glb`])),
  },
}

export const GENERIC_MECH_PLACEHOLDER = '/models/mech-placeholder.glb'

export function resolveMechModelUrl(chassis: string | null | undefined, model: string | null | undefined): string {
  const entry = chassis ? MECH_CHASSIS_ASSETS[chassis] : undefined
  if (!entry) return GENERIC_MECH_PLACEHOLDER
  if (model && entry.models[model]) return entry.models[model]
  return entry.placeholder
}
