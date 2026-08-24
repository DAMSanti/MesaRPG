"""Default critical-slot layout for a mech that has no imported MTF data
(ROADMAP.md Fase R3 follow-up, "ficha interactiva" — requested directly:
a hand-built mech's crit table shouldn't just say "-Empty-" everywhere
once its weapons are known).

Only ever used for a mech created from scratch (see mechs.criticals_imported)
— a mech imported from the public MTF database already carries its real,
authoritative critical layout from app/mech_import.py and this module never
touches it.

Fixed component placement (engine/gyro/cockpit/actuators) is the standard
biped layout from the BattleMech Manual's Critical Hit Table section,
verified there this session — not derived from tonnage or engine rating,
so an unusually-rated engine that would need extra side-torso slots isn't
modeled (a known simplification, not a silent gap: flagged here so it's
easy to find later).
"""

from .systems.battletech.weapons import WEAPON_CATALOG

EMPTY = "-Empty-"

# `None` marks a free slot later filled with a weapon or EMPTY; a string
# marks a slot permanently occupied by a fixed component.
_FIXED_TEMPLATE: dict[str, list[str | None]] = {
    "HD": ["Life Support", "Sensors", "Cockpit", None, "Sensors", "Life Support"],
    "CT": ["Engine", "Engine", "Engine", "Gyro", "Gyro", "Gyro", "Gyro", "Engine", "Engine", "Engine", None, None],
    "LT": [None] * 12,
    "RT": [None] * 12,
    "LA": ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", None, None, None, None, None, None, None, None],
    "RA": ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", None, None, None, None, None, None, None, None],
    "LL": ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", None, None],
    "RL": ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", None, None],
}

# Arms only — which optional actuator slots can be freed to make room for
# a big gun-arm weapon, and in the order a real design would remove them
# (hand first, then lower arm). Matches how e.g. the Atlas mounts its
# arm AC/20: both actuators gone, all 10 of the AC/20's slots fit exactly.
_REMOVABLE_ACTUATOR_SLOTS = [3, 2]  # 0-indexed: Hand Actuator, Lower Arm Actuator


def generate_default_criticals(mech_weapons: list[dict]) -> dict[str, list[str]]:
    """`mech_weapons` is a list of {"weapon_name": str, "location": str} in
    the order they were mounted (stable placement order within a
    location). Returns {location: [item_name, ...]} sized to each
    location's real slot count, ready to insert into mech_criticals."""
    by_location: dict[str, list[str]] = {}
    for w in mech_weapons:
        by_location.setdefault(w["location"], []).append(w["weapon_name"])

    result: dict[str, list[str]] = {}
    for location, template in _FIXED_TEMPLATE.items():
        slots = list(template)
        weapon_names = by_location.get(location, [])
        blocks = [[name] * WEAPON_CATALOG[name]["slots"] for name in weapon_names if name in WEAPON_CATALOG]

        free_count = sum(1 for s in slots if s is None)
        demand = sum(len(b) for b in blocks)

        if location in ("LA", "RA"):
            for slot_i in _REMOVABLE_ACTUATOR_SLOTS:
                if demand <= free_count:
                    break
                slots[slot_i] = None
                free_count += 1

        free_indices = [i for i, s in enumerate(slots) if s is None]
        cursor = 0
        for block in blocks:
            if cursor + len(block) > len(free_indices):
                # Doesn't fit even after freeing actuators — an overloaded
                # design the app doesn't validate at mount time (ROADMAP.md
                # doesn't have crit-capacity checking yet). Drop the block
                # rather than split a weapon across slots or crash.
                continue
            for offset, item_name in enumerate(block):
                slots[free_indices[cursor + offset]] = item_name
            cursor += len(block)

        result[location] = [s if s is not None else EMPTY for s in slots]

    return result
