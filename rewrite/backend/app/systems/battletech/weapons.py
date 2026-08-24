"""Weapon catalog (ROADMAP.md Fase R2 follow-up — weapons/equipment).

Every entry verified individually against Sarna.net (BattleTechWiki)'s
per-weapon pages on 2026-08-16 — not the official rulebook PDF directly,
so treat as "verify before a real session", same caveat combat.py
already carries for its to-hit/hit-location tables.

`damage` for missile weapons (SRM/LRM) is the flat maximum per volley
(missile count x per-missile damage — SRM missiles do 2 each, LRM do 1
each), not the cluster-hits-table expected value. Modeling partial
cluster hits (e.g. a 6-missile SRM volley landing anywhere from 2 to 6
hits per the Cluster Hits Table) is explicitly out of scope here, same
as combat.py's existing "cluster weapons" out-of-scope note — this
keeps every weapon behaving as the same all-or-nothing single number
`combat.resolve_attack` already expects.

`heat` is stored but not yet applied anywhere (no heat scale, no
shutdown, no effect on to-hit) — that's the deliberately separate next
phase, not silently forgotten.

`slots` (critical slots occupied) added for app/critical_layout.py's
default-criticals generator — verified against the Weapons and Equipment
table in the bundled 7th-print BattleMech Manual (rewrite/772641868-...
.txt), not just recalled from memory, same discipline as everything else
in this file.
"""

WEAPON_CATALOG: dict[str, dict] = {
    "Small Laser":  {"damage": 3,  "heat": 1,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": None, "slots": 1},
    "Medium Laser": {"damage": 5,  "heat": 3,  "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": None, "slots": 1},
    "Large Laser":  {"damage": 8,  "heat": 8,  "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": None, "slots": 2},
    "PPC":          {"damage": 10, "heat": 10, "min_range": 3, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 3},
    "Machine Gun":  {"damage": 2,  "heat": 0,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": 200,  "slots": 1},
    "AC/2":         {"damage": 2,  "heat": 1,  "min_range": 4, "short": 8, "medium": 16, "long": 24, "ammo_per_ton": 45,   "slots": 1},
    "AC/5":         {"damage": 5,  "heat": 1,  "min_range": 3, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": 20,   "slots": 4},
    "AC/10":        {"damage": 10, "heat": 3,  "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 10,   "slots": 7},
    "AC/20":        {"damage": 20, "heat": 7,  "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 5,    "slots": 10},
    "SRM 2":        {"damage": 4,  "heat": 2,  "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 50,   "slots": 1},
    "SRM 4":        {"damage": 8,  "heat": 3,  "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 25,   "slots": 1},
    "SRM 6":        {"damage": 12, "heat": 4,  "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 15,   "slots": 2},
    "LRM 5":        {"damage": 5,  "heat": 2,  "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 24,   "slots": 1},
    "LRM 10":       {"damage": 10, "heat": 4,  "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 12,   "slots": 2},
    "LRM 15":       {"damage": 15, "heat": 5,  "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 8,    "slots": 3},
    "LRM 20":       {"damage": 20, "heat": 6,  "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 6,    "slots": 5},

    # Second pass (2026-08-21): the 16 weapons above only covered ~33%
    # of the weapon mounts in the local 2840-mech catalog synced from
    # scripts/sync_mech_catalog.py — everything below is what real
    # imported 'Mechs actually carry beyond Introductory-tech gear.
    # Values are standard/IS-flavored TechManual stats, cross-checked
    # against Sarna.net (BattleTechWiki) per-weapon pages on
    # 2026-08-21 (a representative sample fetched directly; the rest
    # follow the same well-established, edition-stable numbers) — same
    # "verify before a real session" caveat as above.
    #
    # Variable-damage weapons (Snub-Nose PPC, Heavy Gauss Rifle) and
    # cluster weapons (LB-X ACs, HAGs, Silver Bullet Gauss, MRM, MML,
    # ATM) use their single maximum/short-range damage value, same
    # simplification already applied to SRM/LRM above — no per-range
    # damage falloff or partial-cluster-hit modeling anywhere in this
    # app. ATM and MML additionally have multiple ammo modes (HE/
    # Standard/ER for ATM, SRM/LRM for MML); the Standard-ammo/LRM-mode
    # numbers are used.
    "ER Small Laser":  {"damage": 5,  "heat": 2,  "min_range": 0, "short": 2, "medium": 4,  "long": 6,  "ammo_per_ton": None, "slots": 1},
    "ER Medium Laser": {"damage": 5,  "heat": 5,  "min_range": 0, "short": 4, "medium": 8,  "long": 12, "ammo_per_ton": None, "slots": 1},
    "ER Large Laser":  {"damage": 8,  "heat": 12, "min_range": 0, "short": 7, "medium": 14, "long": 19, "ammo_per_ton": None, "slots": 2},
    "ER PPC":          {"damage": 10, "heat": 15, "min_range": 0, "short": 7, "medium": 14, "long": 23, "ammo_per_ton": None, "slots": 2},
    "ER Micro Laser":  {"damage": 3,  "heat": 1,  "min_range": 0, "short": 2, "medium": 4,  "long": 6,  "ammo_per_ton": None, "slots": 1},
    "Micro Pulse Laser":       {"damage": 3,  "heat": 1,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": None, "slots": 1},
    "Small Pulse Laser":       {"damage": 3,  "heat": 2,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": None, "slots": 1},
    "Medium Pulse Laser":      {"damage": 6,  "heat": 4,  "min_range": 0, "short": 2, "medium": 4,  "long": 6,  "ammo_per_ton": None, "slots": 1},
    "Large Pulse Laser":       {"damage": 9,  "heat": 10, "min_range": 0, "short": 3, "medium": 7,  "long": 10, "ammo_per_ton": None, "slots": 2},
    "ER Medium Pulse Laser":   {"damage": 7,  "heat": 6,  "min_range": 0, "short": 4, "medium": 8,  "long": 12, "ammo_per_ton": None, "slots": 1},
    "ER Large Pulse Laser":    {"damage": 10, "heat": 13, "min_range": 0, "short": 7, "medium": 15, "long": 23, "ammo_per_ton": None, "slots": 3},
    "Small X-Pulse Laser":     {"damage": 3,  "heat": 3,  "min_range": 0, "short": 2, "medium": 3,  "long": 4,  "ammo_per_ton": None, "slots": 1},
    "Medium X-Pulse Laser":    {"damage": 6,  "heat": 6,  "min_range": 0, "short": 3, "medium": 6,  "long": 8,  "ammo_per_ton": None, "slots": 2},
    "Large X-Pulse Laser":     {"damage": 9,  "heat": 14, "min_range": 0, "short": 4, "medium": 8,  "long": 12, "ammo_per_ton": None, "slots": 3},
    "Heavy Small Laser":       {"damage": 6,  "heat": 3,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": None, "slots": 1},
    "Heavy Medium Laser":      {"damage": 10, "heat": 7,  "min_range": 0, "short": 2, "medium": 4,  "long": 6,  "ammo_per_ton": None, "slots": 1},
    "Heavy Large Laser":       {"damage": 16, "heat": 18, "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": None, "slots": 3},
    "Light PPC":       {"damage": 5,  "heat": 5,  "min_range": 3, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 2},
    "Heavy PPC":       {"damage": 15, "heat": 15, "min_range": 3, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 4},
    "Snub-Nose PPC":   {"damage": 10, "heat": 10, "min_range": 0, "short": 9, "medium": 13, "long": 15, "ammo_per_ton": None, "slots": 2},
    "Plasma Rifle":    {"damage": 10, "heat": 10, "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 10,   "slots": 2},
    "Flamer":          {"damage": 2,  "heat": 3,  "min_range": 0, "short": 1, "medium": 2,  "long": 3,  "ammo_per_ton": None, "slots": 1},
    "ER Flamer":       {"damage": 2,  "heat": 4,  "min_range": 0, "short": 2, "medium": 4,  "long": 6,  "ammo_per_ton": None, "slots": 1},

    "Gauss Rifle":       {"damage": 15, "heat": 1, "min_range": 2, "short": 7, "medium": 15, "long": 22, "ammo_per_ton": 8,  "slots": 7},
    "Light Gauss Rifle": {"damage": 8,  "heat": 1, "min_range": 3, "short": 8, "medium": 17, "long": 25, "ammo_per_ton": 16, "slots": 5},
    "Heavy Gauss Rifle": {"damage": 25, "heat": 2, "min_range": 4, "short": 6, "medium": 13, "long": 20, "ammo_per_ton": 4,  "slots": 11},
    "AP Gauss Rifle":    {"damage": 3,  "heat": 1, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 40, "slots": 1},
    "Silver Bullet Gauss Rifle": {"damage": 15, "heat": 1, "min_range": 2, "short": 7, "medium": 15, "long": 22, "ammo_per_ton": 6, "slots": 6},
    "Magshot":           {"damage": 2,  "heat": 1, "min_range": 0, "short": 4, "medium": 8,  "long": 12, "ammo_per_ton": 50, "slots": 1},
    "LB 2-X AC":  {"damage": 2,  "heat": 1, "min_range": 4, "short": 9, "medium": 18, "long": 27, "ammo_per_ton": 45, "slots": 1},
    "LB 5-X AC":  {"damage": 5,  "heat": 1, "min_range": 3, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 20, "slots": 2},
    "LB 10-X AC": {"damage": 10, "heat": 2, "min_range": 0, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": 10, "slots": 6},
    "LB 20-X AC": {"damage": 20, "heat": 6, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 5,  "slots": 11},
    "Ultra AC/2":  {"damage": 2,  "heat": 1, "min_range": 2, "short": 8, "medium": 17, "long": 25, "ammo_per_ton": 45, "slots": 3},
    "Ultra AC/5":  {"damage": 5,  "heat": 1, "min_range": 2, "short": 6, "medium": 13, "long": 20, "ammo_per_ton": 20, "slots": 5},
    "Ultra AC/10": {"damage": 10, "heat": 3, "min_range": 0, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": 10, "slots": 7},
    "Ultra AC/20": {"damage": 20, "heat": 8, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 5,  "slots": 10},
    "Rotary AC/2": {"damage": 2,  "heat": 1, "min_range": 2, "short": 8, "medium": 17, "long": 25, "ammo_per_ton": 45, "slots": 6},
    "Rotary AC/5": {"damage": 5,  "heat": 1, "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 20, "slots": 6},
    "Light AC/2": {"damage": 2, "heat": 1, "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 45, "slots": 1},
    "Light AC/5": {"damage": 5, "heat": 1, "min_range": 0, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 20, "slots": 2},
    "Light Machine Gun": {"damage": 1, "heat": 0, "min_range": 0, "short": 1, "medium": 2, "long": 3, "ammo_per_ton": 200, "slots": 1},
    "Heavy Machine Gun": {"damage": 3, "heat": 0, "min_range": 0, "short": 1, "medium": 2, "long": 3, "ammo_per_ton": 100, "slots": 1},
    "HAG/20": {"damage": 20, "heat": 4, "min_range": 1, "short": 8, "medium": 16, "long": 24, "ammo_per_ton": 6, "slots": 6},
    "HAG/30": {"damage": 30, "heat": 6, "min_range": 1, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 4, "slots": 8},
    "HAG/40": {"damage": 40, "heat": 8, "min_range": 1, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": 3, "slots": 10},

    "Streak SRM 2": {"damage": 4,  "heat": 2, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 50, "slots": 1},
    "Streak SRM 4": {"damage": 8,  "heat": 3, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 25, "slots": 1},
    "Streak SRM 6": {"damage": 12, "heat": 4, "min_range": 0, "short": 3, "medium": 6,  "long": 9,  "ammo_per_ton": 15, "slots": 2},
    "MRM 10": {"damage": 10, "heat": 3,  "min_range": 0, "short": 3, "medium": 8, "long": 15, "ammo_per_ton": 24, "slots": 2},
    "MRM 20": {"damage": 20, "heat": 6,  "min_range": 0, "short": 3, "medium": 8, "long": 15, "ammo_per_ton": 12, "slots": 3},
    "MRM 30": {"damage": 30, "heat": 10, "min_range": 0, "short": 3, "medium": 8, "long": 15, "ammo_per_ton": 8,  "slots": 5},
    "MRM 40": {"damage": 40, "heat": 12, "min_range": 0, "short": 3, "medium": 8, "long": 15, "ammo_per_ton": 6,  "slots": 7},
    "MML 3": {"damage": 3, "heat": 2, "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 32, "slots": 2},
    "MML 5": {"damage": 5, "heat": 3, "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 24, "slots": 3},
    "MML 7": {"damage": 7, "heat": 4, "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 16, "slots": 4},
    "MML 9": {"damage": 9, "heat": 5, "min_range": 6, "short": 7, "medium": 14, "long": 21, "ammo_per_ton": 13, "slots": 5},
    "ATM 3": {"damage": 6,  "heat": 2, "min_range": 4, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 20, "slots": 2},
    "ATM 6": {"damage": 12, "heat": 4, "min_range": 4, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 10, "slots": 3},
    "ATM 9": {"damage": 18, "heat": 6, "min_range": 4, "short": 5, "medium": 10, "long": 15, "ammo_per_ton": 7,  "slots": 5},
    "Rocket Launcher 10": {"damage": 10, "heat": 3, "min_range": 0, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 1},
    "Rocket Launcher 15": {"damage": 15, "heat": 4, "min_range": 0, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 1},
    "Rocket Launcher 20": {"damage": 20, "heat": 5, "min_range": 0, "short": 6, "medium": 12, "long": 18, "ammo_per_ton": None, "slots": 1},
}


class UnknownWeapon(ValueError):
    pass


def get_weapon(name: str) -> dict:
    try:
        return WEAPON_CATALOG[name]
    except KeyError:
        raise UnknownWeapon(f"Unknown weapon {name!r}, expected one of {sorted(WEAPON_CATALOG)}") from None
