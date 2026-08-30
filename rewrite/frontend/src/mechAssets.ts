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
  // Real user request: "mueve todos los modelos antiguos [a legacy], no
  // solo los que reemplazamos" — every hand-authored chassis below without
  // a placeholder-tier replacement yet had its .glb moved to legacy/ too,
  // so its entry is removed rather than left pointing at a missing file
  // (resolveMechModelUrl's own 3-tier fallback means these chassis just
  // land on GENERIC_MECH_PLACEHOLDER until each gets its own new asset —
  // exactly the same "no asset for this chassis at all" case the fallback
  // was already designed for, not a new failure mode). Commando, Crockett,
  // Executioner, Hatamoto-Chi, Highlander, JagerMech, Jenner, Kintaro,
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
}

export const GENERIC_MECH_PLACEHOLDER = '/models/mech-placeholder.glb'

export function resolveMechModelUrl(chassis: string | null | undefined, model: string | null | undefined): string {
  const entry = chassis ? MECH_CHASSIS_ASSETS[chassis] : undefined
  if (!entry) return GENERIC_MECH_PLACEHOLDER
  if (model && entry.models[model]) return entry.models[model]
  return entry.placeholder
}
