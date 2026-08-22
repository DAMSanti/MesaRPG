"""Non-weapon equipment catalog — the "de la misma manera que armamento"
counterpart to app/weapons.py. Slot counts are the standard Total Warfare
values, not guessed: Heat Sink/Double Heat Sink confirmed against a real
imported mech's own criticals (the Akuma AKU-1X's "Heat Sinks:13 Double"
mounts in blocks of exactly 3 consecutive slots — the IS Double Heat
Sink value), the rest against Sarna.net's per-item pages.

Deliberately left out (not silently — flagged here): MASC, Targeting
Computer, Null Signature System, Triple Strength Myomer. Each occupies a
number of critical slots that depends on the mech's own tonnage rather
than a fixed value, so a static catalog entry would have to guess.

`heat_dissipation` is only set for Heat Sink/Double Heat Sink (used by
app/mechs.py to recompute a mech's real heat_sinks value from what's
actually mounted, since the MTF "Heat Sinks:N" header field doesn't
distinguish Single from Double — see app/mech_import.py). `jump_bonus`
is only set for Jump Jet — stored for completeness, but nothing
recomputes mechs.jump_mp from it today, since that field already comes
from the MTF's own reliable "Jump MP:" line. Everything else is
informational only: real gameplay effects (Artemis IV's cluster-hit
bonus, ECM's counter-detection, CASE's ammo-explosion containment, ...)
aren't modeled by this app's simplified combat rules yet.
"""

EQUIPMENT_CATALOG: dict[str, dict] = {
    "Heat Sink":            {"slots": 1, "heat_dissipation": 1, "jump_bonus": None},
    "Double Heat Sink":     {"slots": 3, "heat_dissipation": 2, "jump_bonus": None},
    "Jump Jet":             {"slots": 1, "heat_dissipation": None, "jump_bonus": 1},
    "Endo-Steel":           {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "Ferro-Fibrous":        {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "CASE":                 {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "Artemis IV FCS":       {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "Guardian ECM Suite":   {"slots": 2, "heat_dissipation": None, "jump_bonus": None},
    "Beagle Active Probe":  {"slots": 2, "heat_dissipation": None, "jump_bonus": None},
    "TAG":                  {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "C3 Slave Unit":        {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
    "Apollo FCS":           {"slots": 1, "heat_dissipation": None, "jump_bonus": None},
}


class UnknownEquipment(ValueError):
    pass


def get_equipment(name: str) -> dict:
    try:
        return EQUIPMENT_CATALOG[name]
    except KeyError:
        raise UnknownEquipment(f"Unknown equipment {name!r}, expected one of {sorted(EQUIPMENT_CATALOG)}") from None


def equipment_from_criticals(criticals: dict[str, list[str]]) -> list[dict]:
    """Equipment has no dedicated MTF section the way weapons have
    `Weapons:N` — it only ever shows up as entries in the per-location
    critical slot list. Groups each location's criticals by item name;
    for any name recognized in EQUIPMENT_CATALOG whose count is a
    multiple of its slot size, emits one {"equipment_name", "location"}
    per full block — same reconstruction the weapons side already needed
    for scripts/repair_mech_import_data.py, generalized so both fresh
    imports and already-existing mechs derive equipment identically."""
    from collections import Counter

    counts: Counter[tuple[str, str]] = Counter()
    for location, items in criticals.items():
        for item_name in items:
            counts[(location, item_name)] += 1

    result: list[dict] = []
    for (location, item_name), count in counts.items():
        if item_name not in EQUIPMENT_CATALOG:
            continue
        slots = EQUIPMENT_CATALOG[item_name]["slots"]
        if slots <= 0 or count % slots != 0:
            continue
        for _ in range(count // slots):
            result.append({"equipment_name": item_name, "location": location})
    return result
