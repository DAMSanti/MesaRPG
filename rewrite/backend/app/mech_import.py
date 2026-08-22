"""Fetch + parse real mechs from the public MegaMek-format unit database
that sheets.flechs.net also builds on (a community-standard unit index +
per-mech .mtf files) — requested directly by the user, who compared our
hand-curated catalog plan against that site's much larger, real database.

This module is no longer a live request-time dependency: it used to be
called directly from main.py's /api/mech-import endpoints, but that made
mech creation require internet, violating VISION.md §3's offline-first
requirement. Now it's only ever invoked by scripts/sync_mech_catalog.py,
which walks the whole unit list once (while online) and persists the
result into app/mech_templates.py's local table — that table is what
/api/mech-import actually serves today.

MTF is MegaMek's plain-text unit format: `Key:Value` lines plus a
`Weapons:N` section listing `Weapon Name, Location` pairs. It does NOT
carry internal structure points per location — those are fixed by
tonnage alone under the standard rules (the Internal Structure Table,
same one used to build the Atlas fixture in conftest.py, cross-checked
against it below) — armor, unlike structure, IS chassis-specific and
has to come from the file.
"""

import re
import urllib.parse
import urllib.request

from .equipment import equipment_from_criticals

UNIT_LIST_URL = "https://helm-kore-fragment.s3.amazonaws.com/unitList.xml"
MTF_BASE_URL = "https://helm-kore-fragment.s3.amazonaws.com/mtf/meks/"

# MTF spells the same weapon (and, via _normalize_mtf_item_name below,
# any critical-slot component — Engine, "ISDouble Heat Sink", ammo bins,
# ...) several different ways depending on which era/tool produced the
# file: plain Sarna-style names ("Medium Laser", older 3025-era files), a
# glued-on "IS"/"CL" tech-base prefix ("ISMediumLaser"), or a fully
# concatenated CamelCase internal name with no separators at all
# ("ERMediumLaser", "StreakSRM6", "LBXAC10"). All of these get folded
# down to the one canonical, spaced Sarna-style name app/weapons.py's
# WEAPON_CATALOG keys on, via (in order):
#   1. strip the leading "<count> " token every line carries,
#   2. strip a "Prototype"/"Improved"/one-shot-suffix wrapper that
#      doesn't change the underlying weapon's stats,
#   3. a literal-alias lookup for names that don't decompose
#      mechanically (family renames like "LBXAC10" -> "LB 10-X AC",
#      abbreviations like "SNPPC", "HAG20"),
#   4. strip a glued "IS"/"CL" tech-base prefix,
#   5. a generic CamelCase/digit splitter as a last resort, so any
#      future file spelling a *known* weapon in yet another
#      concatenated form still has a chance of matching.
# This still doesn't invent stats for anything WEAPON_CATALOG doesn't
# model (electronics, C3 gear, physical weapons, artillery, ...) —
# those fall through unmatched and the caller reports them as
# unsupported, same as before.
MTF_WEAPON_ALIASES = {
    "Autocannon/2": "AC/2",
    "Autocannon/5": "AC/5",
    "Autocannon/10": "AC/10",
    "Autocannon/20": "AC/20",
    "AC2": "AC/2",
    "AC5": "AC/5",
    "AC10": "AC/10",
    "AC20": "AC/20",
    "MG": "Machine Gun",
    "MachineGun": "Machine Gun",
    # Family/abbreviation renames that don't decompose via CamelCase
    # splitting or a simple space-insertion (word order or symbol
    # changes, not just missing spaces).
    "LBXAC2": "LB 2-X AC",
    "LBXAC5": "LB 5-X AC",
    "LBXAC10": "LB 10-X AC",
    "LBXAC20": "LB 20-X AC",
    "SNPPC": "Snub-Nose PPC",
    "HAG20": "HAG/20",
    "HAG30": "HAG/30",
    "HAG40": "HAG/40",
    "LAC2": "Light AC/2",
    "LAC5": "Light AC/5",
    "LAC/2": "Light AC/2",
    "LAC/5": "Light AC/5",
    "Light Auto Cannon/2": "Light AC/2",
    "Light Auto Cannon/5": "Light AC/5",
    "APGaussRifle": "AP Gauss Rifle",
    "SBGR": "Silver Bullet Gauss Rifle",
    "MagShot": "Magshot",
    "AntiMissileSystem": "AMS",
    "Anti-Missile System": "AMS",
    "ERPPC": "ER PPC",
    "RotaryAC2": "Rotary AC/2",
    "RotaryAC5": "Rotary AC/5",
    "RotaryAC10": "Rotary AC/10",
    "Rotary AC 2": "Rotary AC/2",  # post-CamelSplit form ("RotaryAC2")
    "Rotary AC 5": "Rotary AC/5",
    "Rotary AC 10": "Rotary AC/10",
    "UltraAC2": "Ultra AC/2",
    "UltraAC5": "Ultra AC/5",
    "UltraAC10": "Ultra AC/10",
    "UltraAC20": "Ultra AC/20",
    "Ultra AC 2": "Ultra AC/2",  # post-CamelSplit form ("UltraAC2")
    "Ultra AC 5": "Ultra AC/5",
    "Ultra AC 10": "Ultra AC/10",
    "Ultra AC 20": "Ultra AC/20",
    # CamelSplit has no way to know "X-Pulse" keeps its hyphen (it isn't
    # a case/digit boundary), so the concatenated form comes out
    # "Small X Pulse Laser" while already-spaced files keep the hyphen —
    # both are folded onto the hyphenated Sarna-style name.
    "Small X Pulse Laser": "Small X-Pulse Laser",
    "Medium X Pulse Laser": "Medium X-Pulse Laser",
    "Large X Pulse Laser": "Large X-Pulse Laser",
    # Extended-range and Streak-guided ammo modes for standard LRMs
    # don't change total per-missile damage, only range/accuracy — both
    # out of this app's simplified flat-damage combat model, so they
    # reuse the base launcher's stats.
    "Extended LRM 5": "LRM 5",
    "Extended LRM 10": "LRM 10",
    "Extended LRM 15": "LRM 15",
    "Extended LRM 20": "LRM 20",
    "Streak LRM 5": "LRM 5",
    "Streak LRM 10": "LRM 10",
    "Streak LRM 15": "LRM 15",
    "Streak LRM 20": "LRM 20",
    # VSP ("Variable Speed Pulse") lasers are aliased to the plain
    # Pulse Laser of the same weight class — same role, and TechManual
    # doesn't diverge enough for this app's flat single-value combat
    # math to care, given the existing "flat max damage" precedent for
    # cluster/variable weapons below.
    "Small VSP": "Small Pulse Laser",
    "Small VSP Laser": "Small Pulse Laser",
    "Medium VSP": "Medium Pulse Laser",
    "Medium VSP Laser": "Medium Pulse Laser",
    "Large VSP": "Large Pulse Laser",
    "Large VSP Laser": "Large Pulse Laser",
    "Particle Cannon": "PPC",  # older-TRO fluff name for the same weapon
    "Plasma Cannon": "Plasma Rifle",  # Clan equivalent, same flat stats here
    "Vehicle Flamer": "Flamer",
    # Non-weapon equipment names (app/equipment.py's EQUIPMENT_CATALOG) that
    # don't decompose cleanly via the generic CamelSplit below — same
    # reasoning as the weapon aliases above, just for the equipment side of
    # this shared normalizer.
    "C3SlaveUnit": "C3 Slave Unit",  # generic split gives "C 3 Slave Unit"
    # Already-normalized form some mechs got stored with before this alias
    # existed (repair_mech_import_data.py re-normalizes whatever's
    # currently in the DB, not the original raw MTF text, so a value that
    # was already through the generic CamelSplit once needs its own
    # matching entry here too).
    "C 3 Slave Unit": "C3 Slave Unit",
    "Apollo": "Apollo FCS",  # MRM targeting FCS, not a generic aim computer
}

# MTF weapon lines always carry a leading "<count> " token, even for a
# single copy (e.g. "1 ISHeavyPPC, Left Arm") — the atlas_as7d.mtf test
# fixture happens to predate this convention, which is why it was never
# stripped before.
_WEAPON_QTY_PREFIX = re.compile(r"^\d+\s+")

# A "Prototype"/"Improved" wrapper (either as a separate leading word or
# glued on as a trailing word) marks an earlier/refined production run
# with the same in-game stats as the base weapon in this app's scope —
# same reasoning as "IS"/"CL": a tech-base/provenance flag, not a
# different weapon. One-shot suffixes similarly reuse the base weapon's
# per-shot stats, just fired only once.
_MODIFIER_AFFIXES = re.compile(
    r"^(Prototype\s+|Improved\s+)|(\s+Prototype|\s*\((OS|I-OS|PP)\))$"
)

# Tech-base prefix glued onto the component name with no separator
# ("ISHeavyPPC", "CLERPPC") — only strip it when what follows still
# looks like a real word, so we don't mangle a name that's genuinely
# meant to start with those letters.
_TECH_BASE_PREFIX = re.compile(r"^(IS|CL)(?=[A-Z])")

# Splits a concatenated CamelCase internal name into words: before an
# uppercase letter that follows a lowercase letter or digit ("ERMedium"
# -> "ER Medium"), before an uppercase letter that starts a new word
# after a run of capitals ("ERMedium" boundary, "SRM6Launcher" ->
# "SRM6 Launcher"), and between a letter and a digit ("SRM6" -> "SRM 6").
_CAMEL_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])")


def _normalize_mtf_item_name(raw: str) -> str:
    """Cleans up any MTF component name — a weapon in the Weapons:
    section, or a fixed/critical-slot entry (Engine, "ISDouble Heat
    Sink", "ISApollo", ammo bins, ...). The same concatenated-CamelCase/
    tech-base-prefix mess afflicts both (a critical slot literally lists
    "ISHeavyPPC" the same way the Weapons: line does), and a name that
    isn't a real weapon just falls through the alias table unmatched and
    comes out as its own cleaned-up spaced form ("Endo-Steel" untouched,
    "ISC3SlaveUnit" -> "C 3 Slave Unit") rather than matching anything —
    harmless, since only the Weapons: section's output is ever looked up
    against WEAPON_CATALOG."""
    name = _WEAPON_QTY_PREFIX.sub("", raw).strip()
    name = _MODIFIER_AFFIXES.sub("", name).strip()
    if name in MTF_WEAPON_ALIASES:
        return MTF_WEAPON_ALIASES[name]
    stripped = _TECH_BASE_PREFIX.sub("", name)
    if stripped in MTF_WEAPON_ALIASES:
        return MTF_WEAPON_ALIASES[stripped]
    # A concatenated modifier ("ImprovedHeavyGaussRifle",
    # "MediumPulseLaserPrototype") only becomes whitespace-delimited
    # after the CamelCase split below, so the affix strip runs again
    # on the split result.
    split = _MODIFIER_AFFIXES.sub("", _CAMEL_SPLIT.sub(" ", stripped)).strip()
    if split in MTF_WEAPON_ALIASES:
        return MTF_WEAPON_ALIASES[split]
    return split

LOCATION_ALIASES = {
    "Head": "HD", "Center Torso": "CT", "Left Torso": "LT", "Right Torso": "RT",
    "Left Arm": "LA", "Right Arm": "RA", "Left Leg": "LL", "Right Leg": "RL",
}

# Internal Structure Table (standard rule, tonnage -> points per
# location) — 20 to 100 tons in 5-ton steps, the only tonnages a
# standard biped 'Mech can be built at.
_STRUCTURE_TABLE: dict[int, dict[str, int]] = {
    20: {"HD": 3, "CT": 6, "LT": 5, "RT": 5, "LA": 3, "RA": 3, "LL": 4, "RL": 4},
    25: {"HD": 3, "CT": 8, "LT": 6, "RT": 6, "LA": 4, "RA": 4, "LL": 6, "RL": 6},
    30: {"HD": 3, "CT": 10, "LT": 7, "RT": 7, "LA": 5, "RA": 5, "LL": 7, "RL": 7},
    35: {"HD": 3, "CT": 11, "LT": 8, "RT": 8, "LA": 6, "RA": 6, "LL": 8, "RL": 8},
    40: {"HD": 3, "CT": 12, "LT": 10, "RT": 10, "LA": 6, "RA": 6, "LL": 10, "RL": 10},
    45: {"HD": 3, "CT": 14, "LT": 11, "RT": 11, "LA": 7, "RA": 7, "LL": 11, "RL": 11},
    50: {"HD": 3, "CT": 16, "LT": 12, "RT": 12, "LA": 8, "RA": 8, "LL": 12, "RL": 12},
    55: {"HD": 3, "CT": 18, "LT": 13, "RT": 13, "LA": 9, "RA": 9, "LL": 13, "RL": 13},
    60: {"HD": 3, "CT": 20, "LT": 14, "RT": 14, "LA": 10, "RA": 10, "LL": 14, "RL": 14},
    65: {"HD": 3, "CT": 21, "LT": 15, "RT": 15, "LA": 10, "RA": 10, "LL": 15, "RL": 15},
    70: {"HD": 3, "CT": 22, "LT": 15, "RT": 15, "LA": 11, "RA": 11, "LL": 15, "RL": 15},
    75: {"HD": 3, "CT": 23, "LT": 16, "RT": 16, "LA": 12, "RA": 12, "LL": 16, "RL": 16},
    80: {"HD": 3, "CT": 25, "LT": 17, "RT": 17, "LA": 13, "RA": 13, "LL": 17, "RL": 17},
    85: {"HD": 3, "CT": 27, "LT": 18, "RT": 18, "LA": 14, "RA": 14, "LL": 18, "RL": 18},
    90: {"HD": 3, "CT": 29, "LT": 19, "RT": 19, "LA": 15, "RA": 15, "LL": 19, "RL": 19},
    95: {"HD": 3, "CT": 30, "LT": 20, "RT": 20, "LA": 16, "RA": 16, "LL": 20, "RL": 20},
    100: {"HD": 3, "CT": 31, "LT": 21, "RT": 21, "LA": 17, "RA": 17, "LL": 21, "RL": 21},
}


class UnknownTonnage(ValueError):
    pass


class MechImportError(ValueError):
    pass


class NotBiped(ValueError):
    """Raised for a Quad/Tripod/LAM/QuadVee unit — the whole data model
    (MECH_LOCATIONS, the fixed critical-slot template, the Internal
    Structure Table above) assumes 8 biped locations. A quad's own MTF
    uses different location names (Front/Rear Left/Right Leg instead of
    arms) that this parser was never taught, so a naive parse would
    silently produce wrong armor/criticals rather than fail loudly —
    raising here instead lets callers (the sync script) skip it and
    count it, rather than store bad data. Real quad/tripod support is a
    documented future gap (VISION.md's HexMap.tsx doc comment), not
    something to half-implement here."""


def structure_for_tonnage(tonnage: int, location: str) -> int:
    if tonnage not in _STRUCTURE_TABLE:
        raise UnknownTonnage(f"No standard Internal Structure Table entry for {tonnage}t")
    return _STRUCTURE_TABLE[tonnage][location]


def parse_mtf(text: str) -> dict:
    lines = [line.rstrip("\n") for line in text.splitlines()]
    chassis = lines[1].strip()
    model = lines[2].strip() if len(lines) > 2 else ""

    # Keys are lowercased on both write and read below — older-format
    # files spell these "Mass"/"Walk MP"/"LA Armor", but some newer
    # Record Sheets-era files spell the very same fields "mass"/
    # "walk mp"/"LA armor" (and inconsistently: the SAME file can mix
    # "Config:Biped" with "mass:80" and "LA armor:26"). A case-sensitive
    # lookup against only the capitalized spelling silently missed every
    # one of these — tonnage/movement/armor all quietly defaulted to
    # 0/empty while weapons/criticals (parsed separately below, straight
    # off the raw lines rather than through this dict) still came out
    # fully populated, producing a mech with a complete weapons loadout
    # sitting on an entirely blank record sheet.
    fields: dict[str, str] = {}
    for line in lines:
        if ":" in line:
            key, _, value = line.partition(":")
            fields.setdefault(key.strip().lower(), value.strip())

    if fields.get("config", "").strip().lower() != "biped":
        raise NotBiped(f"{chassis} {model} is {fields.get('config', 'unknown config')!r}, not Biped")

    tonnage = int(fields.get("mass", "0"))
    walk_mp = int(fields.get("walk mp", "0") or 0)
    jump_mp = int(fields.get("jump mp", "0") or 0)
    # MTF has no explicit run value — the standard rule derives it from
    # walking (ceil(walk * 1.5)); editable before submitting, like every
    # other imported field.
    run_mp = -(-walk_mp * 3 // 2)

    heat_sinks = 10
    heat_match = re.match(r"(\d+)", fields.get("heat sinks", ""))
    if heat_match:
        heat_sinks = int(heat_match.group(1))

    locations = []
    for loc in ["HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"]:
        armor_key = {"LT": "LT Armor", "RT": "RT Armor"}.get(loc, f"{loc} Armor").lower()
        armor_raw = fields.get(armor_key)
        if armor_raw is None:
            continue
        entry = {
            "location": loc,
            "armor_max": int(armor_raw),
            "structure_max": structure_for_tonnage(tonnage, loc),
        }
        rear_key = {"LT": "RTL Armor", "RT": "RTR Armor", "CT": "RTC Armor"}.get(loc)
        rear_key = rear_key.lower() if rear_key else None
        if rear_key and fields.get(rear_key) is not None:
            entry["armor_rear_max"] = int(fields[rear_key])
        locations.append(entry)

    weapons = _parse_weapons(lines)
    criticals = _parse_criticals(lines)
    equipment = equipment_from_criticals(criticals)

    return {
        "chassis": chassis,
        "model": model,
        "tonnage": tonnage,
        "walk_mp": walk_mp,
        "run_mp": run_mp,
        "jump_mp": jump_mp,
        "heat_sinks": heat_sinks,
        "locations": locations,
        "weapons": weapons,
        "criticals": criticals,
        "equipment": equipment,
    }


# MTF section headers for each location's critical slot list, in the
# exact "Location Name:" form the file uses (distinct from the
# "LA Armor:" style keys parsed above).
_CRITICAL_SECTION_HEADERS = {
    "Head:": "HD", "Center Torso:": "CT", "Left Torso:": "LT", "Right Torso:": "RT",
    "Left Arm:": "LA", "Right Arm:": "RA", "Left Leg:": "LL", "Right Leg:": "RL",
}


def _parse_criticals(lines: list[str]) -> dict[str, list[str]]:
    criticals: dict[str, list[str]] = {}
    current_loc: str | None = None
    for line in lines:
        header_loc = _CRITICAL_SECTION_HEADERS.get(line.strip())
        if header_loc:
            current_loc = header_loc
            criticals[current_loc] = []
            continue
        if current_loc is not None:
            if not line.strip():
                current_loc = None
                continue
            # A critical slot lists a component name the exact same
            # raw/concatenated way the Weapons: section does ("ISHeavyPPC",
            # "ISDouble Heat Sink") — same cleanup, not just for the ones
            # that happen to be weapons. Anything that isn't a recognized
            # weapon (Engine, Endo-Steel, ammo bins, "-Empty-", ...) just
            # comes out as its own cleaned-up name, unmatched but readable.
            criticals[current_loc].append(_normalize_mtf_item_name(line.strip()))
    return criticals


def _parse_weapons(lines: list[str]) -> list[dict]:
    weapons = []
    in_section = False
    for line in lines:
        if line.startswith("Weapons:"):
            in_section = True
            continue
        if in_section:
            if not line.strip():
                break
            if "," not in line:
                continue
            # "Name, Location" or "Name, Location, Ammo:N" — the trailing
            # ammo-type field (LB-X/MRM launchers, mainly) used to make the
            # whole line's location lookup fail and silently vanish the
            # weapon, since it was never split off.
            name, location_name, *_ = (part.strip() for part in line.split(","))
            weapon_name = _normalize_mtf_item_name(name)
            location = LOCATION_ALIASES.get(location_name)
            if location is None:
                continue
            weapons.append({"weapon_name": weapon_name, "location": location})
    return weapons


def list_all_units() -> list[dict]:
    """The full {"name", "file"} index — used by scripts/sync_mech_catalog.py
    to walk every unit once; the live per-keystroke search below still
    exists only because this module is the thing the sync script calls
    into, not because anything hits it live anymore (see
    app/mech_templates.py for what actually serves /api/mech-import now)."""
    return _fetch_unit_list()


def search_units(query: str, limit: int = 20) -> list[dict]:
    units = _fetch_unit_list()
    q = query.lower().strip()
    if not q:
        return []
    matches = [u for u in units if q in u["name"].lower()]
    return matches[:limit]


_unit_list_cache: list[dict] | None = None


def _fetch_unit_list() -> list[dict]:
    global _unit_list_cache
    if _unit_list_cache is not None:
        return _unit_list_cache
    import xml.etree.ElementTree as ET

    try:
        with urllib.request.urlopen(UNIT_LIST_URL, timeout=10) as resp:
            xml_bytes = resp.read()
    except Exception as exc:
        raise MechImportError(f"No se pudo descargar el listado de unidades: {exc}") from exc
    root = ET.fromstring(xml_bytes)
    _unit_list_cache = [
        {"name": el.get("d"), "file": el.get("f")}
        for el in root.findall("u")
        if el.get("d") and el.get("f")
    ]
    return _unit_list_cache


def import_mech(filename: str) -> dict:
    url = MTF_BASE_URL + urllib.parse.quote(filename)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            text = resp.read().decode("utf-8")
    except Exception as exc:
        raise MechImportError(f"No se pudo descargar {filename}: {exc}") from exc
    return parse_mtf(text)
