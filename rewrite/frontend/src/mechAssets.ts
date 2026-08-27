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
  Atlas: {
    placeholder: `${MECHS_DIR}/atlas-as7-d.glb`,
    models: {
      'AS7-D': `${MECHS_DIR}/atlas-as7-d.glb`,
      'AS7-WGS (Samsonov)': `${MECHS_DIR}/atlas-as7-wgs.glb`,
    },
  },
  Awesome: {
    placeholder: `${MECHS_DIR}/awesome-aws-8q.glb`,
    models: {
      'AWS-8Q': `${MECHS_DIR}/awesome-aws-8q.glb`,
      'AWS-PB': `${MECHS_DIR}/awesome-aws-pb.glb`, // "Pretty Baby"
    },
  },
  BattleMaster: {
    placeholder: `${MECHS_DIR}/battlemaster-blr-1g.glb`,
    models: {
      'BLR-1G': `${MECHS_DIR}/battlemaster-blr-1g.glb`,
      "BLR-1GHE 'HellSinger'": `${MECHS_DIR}/battlemaster-blr-1ghe.glb`,
    },
  },
  Banshee: {
    placeholder: `${MECHS_DIR}/banshee-bnc-3m.glb`,
    models: { 'BNC-3M': `${MECHS_DIR}/banshee-bnc-3m.glb` },
  },
  Blackjack: {
    placeholder: `${MECHS_DIR}/blackjack-bj-1.glb`,
    models: {
      'BJ-1': `${MECHS_DIR}/blackjack-bj-1.glb`,
      // "Arrow" — not in the current catalog under this exact code, but
      // the user confirmed the chassis; registered anyway per
      // resolveMechModelUrl's fallback design (harmless if unmatched).
      'BJ-A': `${MECHS_DIR}/blackjack-bj-a.glb`,
    },
  },
  Catapult: {
    placeholder: `${MECHS_DIR}/catapult-cplt-k2.glb`,
    models: {
      'CPLT-K2': `${MECHS_DIR}/catapult-cplt-k2.glb`,
      'CPLT-C1D': `${MECHS_DIR}/catapult-cplt-c1d.glb`,
      'CPLT-C1': `${MECHS_DIR}/catapult-cplt-c1.glb`,
    },
  },
  Centurion: {
    placeholder: `${MECHS_DIR}/centurion-cn9-a.glb`,
    models: {
      'CN9-A': `${MECHS_DIR}/centurion-cn9-a.glb`,
      "CN9-YLW 'Yen Lo Wang'": `${MECHS_DIR}/centurion-cn9-ylw.glb`,
    },
  },
  Commando: {
    placeholder: `${MECHS_DIR}/commando-com-tdk.glb`,
    // Real user finding (MechLab): "COM-tDK" ("The Death") was never a
    // real catalog variant code (see the old comment this replaces) —
    // harmless before (MechLab's own model dropdown now requires an
    // EXACT match, so this silently emptied Commando's model list
    // instead of just falling back). Anchored to the catalog's actual
    // baseline variant instead — same .glb, just a code that really
    // exists.
    models: { 'COM-1A': `${MECHS_DIR}/commando-com-tdk.glb` },
  },
  Crockett: {
    placeholder: `${MECHS_DIR}/crockett-crk-5003-0.glb`,
    models: { 'CRK-5003-0': `${MECHS_DIR}/crockett-crk-5003-0.glb` },
  },
  // Clan chassis, not in the current mech_templates catalog at all —
  // registered so it's ready the moment that chassis gets added; until
  // then this entry simply never matches anything (harmless).
  Executioner: {
    placeholder: `${MECHS_DIR}/executioner-prime.glb`,
    models: { Prime: `${MECHS_DIR}/executioner-prime.glb` },
  },
  'Hatamoto-Chi': {
    placeholder: `${MECHS_DIR}/hatamotochi-htm-27t.glb`,
    models: { 'HTM-27T': `${MECHS_DIR}/hatamotochi-htm-27t.glb` },
  },
  Highlander: {
    placeholder: `${MECHS_DIR}/highlander-hgn-732.glb`,
    models: { 'HGN-732': `${MECHS_DIR}/highlander-hgn-732.glb` },
  },
  JagerMech: {
    placeholder: `${MECHS_DIR}/jagermech-jm6-fb.glb`,
    // Real user finding (MechLab): "JM6-FB" ("Firebrand") was never a
    // real catalog variant code either — same issue/fix as Commando
    // above, anchored to the real baseline variant instead.
    models: { 'JM6-A': `${MECHS_DIR}/jagermech-jm6-fb.glb` },
  },
  Jenner: {
    placeholder: `${MECHS_DIR}/jenner-jr7-f.glb`,
    models: { 'JR7-F': `${MECHS_DIR}/jenner-jr7-f.glb` },
  },
  Kintaro: {
    placeholder: `${MECHS_DIR}/kintaro-kto-18.glb`,
    models: { 'KTO-18': `${MECHS_DIR}/kintaro-kto-18.glb` },
  },
  Locust: {
    placeholder: `${MECHS_DIR}/locust-lct-1v.glb`,
    models: { 'LCT-1V': `${MECHS_DIR}/locust-lct-1v.glb` },
  },
  // Clan chassis, IS reporting name "Grendel" — not in the current
  // catalog at all (same "ready when the chassis is added" reasoning
  // as Executioner above).
  Mongrel: {
    placeholder: `${MECHS_DIR}/mongrel-prime.glb`,
    // Real user finding (MechLab): "Prime" doesn't exist in this
    // catalog's own Mongrel entries (MGL-T1/MGL-T2) — the chassis itself
    // WAS eventually added to the catalog (this comment used to say the
    // whole chassis was missing), just under different variant codes.
    // Anchored to the catalog's actual baseline variant instead.
    models: { 'MGL-T1': `${MECHS_DIR}/mongrel-prime.glb` },
  },
  // Real user finding (MechLab): an empty `models` here meant NO model
  // ever showed up for this chassis once MechLab started requiring an
  // exact match (its own model dropdown used to just fall back to the
  // placeholder silently) — anchored to the catalog's "(Standard)"
  // baseline variant instead of leaving it unmatched.
  'Rifleman IIC': {
    placeholder: `${MECHS_DIR}/rifleman-iic-1.glb`,
    models: { '(Standard)': `${MECHS_DIR}/rifleman-iic-1.glb` },
  },
  'Shadow Hawk': {
    placeholder: `${MECHS_DIR}/shadowhawk-shd-2h.glb`,
    models: { 'SHD-2H': `${MECHS_DIR}/shadowhawk-shd-2h.glb` },
  },
  Thanatos: {
    placeholder: `${MECHS_DIR}/thanatos-tns-4s.glb`,
    models: { 'TNS-4S (Felix)': `${MECHS_DIR}/thanatos-tns-4s.glb` },
  },
  Thug: {
    placeholder: `${MECHS_DIR}/thug-thg-11eb.glb`,
    models: { 'THG-11Eb': `${MECHS_DIR}/thug-thg-11eb.glb` },
  },
  Thunderbolt: {
    placeholder: `${MECHS_DIR}/thunderbolt-tdr-5se.glb`,
    models: {
      'TDR-5SE': `${MECHS_DIR}/thunderbolt-tdr-5se.glb`,
      'TDR-5S-T (Tallman)': `${MECHS_DIR}/thunderbolt-tdr-5s-t.glb`,
    },
  },
  // Clan chassis (Timber Wolf / "Mad Cat") — the current catalog only
  // has later Mad Cat Mk II/III/IV variants, not the base chassis this
  // model represents; same "ready when added" reasoning as above.
  'Timber Wolf': {
    placeholder: `${MECHS_DIR}/timberwolf-prime.glb`,
    models: { Prime: `${MECHS_DIR}/timberwolf-prime.glb` },
  },
  Trebuchet: {
    placeholder: `${MECHS_DIR}/trebuchet-tbt-5n.glb`,
    models: { 'TBT-5N': `${MECHS_DIR}/trebuchet-tbt-5n.glb` },
  },
  UrbanMech: {
    placeholder: `${MECHS_DIR}/urbanmech-um-r60.glb`,
    models: { 'UM-R60': `${MECHS_DIR}/urbanmech-um-r60.glb` },
  },
  Uziel: {
    placeholder: `${MECHS_DIR}/uziel-uzl-2s.glb`,
    models: { 'UZL-2S': `${MECHS_DIR}/uziel-uzl-2s.glb` },
  },
  Viking: {
    placeholder: `${MECHS_DIR}/viking-vkg-2f.glb`,
    models: { 'VKG-2F': `${MECHS_DIR}/viking-vkg-2f.glb` },
  },
  Vulcan: {
    placeholder: `${MECHS_DIR}/vulcan-vl-2t.glb`,
    models: {
      'VL-2T': `${MECHS_DIR}/vulcan-vl-2t.glb`,
      'VL-5T': `${MECHS_DIR}/vulcan-vl-5t.glb`,
    },
  },
}

export const GENERIC_MECH_PLACEHOLDER = '/models/mech-placeholder.glb'

export function resolveMechModelUrl(chassis: string | null | undefined, model: string | null | undefined): string {
  const entry = chassis ? MECH_CHASSIS_ASSETS[chassis] : undefined
  if (!entry) return GENERIC_MECH_PLACEHOLDER
  if (model && entry.models[model]) return entry.models[model]
  return entry.placeholder
}
