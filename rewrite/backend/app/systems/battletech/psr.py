"""Piloting Skill Rolls and falling (CAT3500D rulebook, pp. 40-43 —
verified directly against the PDF this session).

TN = Piloting Skill + the specific event's own modifier (callers pick the
right modifier per the rulebook's Piloting Skill Roll Table — this module
doesn't hold a giant event->modifier lookup, since each caller already
knows exactly which event it's resolving and what the rulebook says about
it: melee.py knows a missed kick is +0, psr.apply_fall's own seatbelt
check is +0, etc). Immobile mech or unconscious pilot -> automatic
failure, no roll (real rule).

Deliberately simplified: fall damage always uses the Front hit-location
column — the real Facing After Fall Table's new-facing/hit-column mapping
(which side takes the damage depends on how the mech happens to topple)
isn't modeled. Falling into water, displacement, and the Domino Effect
(falling onto another mech) are also out of scope — the rest of falling
(prone state, real damage, the pilot's own "seatbelt" PSR) is implemented
for real.
"""

import math
import secrets

from ... import db
from . import mechs, pilots

# Front column only — see module docstring's Facing After Fall
# simplification.
_FALL_HIT_LOCATION = {
    2: "CT", 3: "RA", 4: "RA", 5: "RL", 6: "RT", 7: "CT",
    8: "LT", 9: "LL", 10: "LA", 11: "LA", 12: "HD",
}


def _roll_2d6() -> tuple[int, int, int]:
    d1, d2 = secrets.randbelow(6) + 1, secrets.randbelow(6) + 1
    return d1, d2, d1 + d2


def roll_psr(mech_id: int, modifier: int, event: str) -> dict:
    """A single Piloting Skill Roll for mech_id's pilot. `modifier` is the
    event's own Target Number add-on (see module docstring — the caller
    picks it). A mech that's shut down or already prone, or a pilot at
    the sheet's own fatal wound-track box (6, see pilots.add_pilot_hits),
    automatically fails without a roll — the real rule for "Immobile
    'Mechs and Unconscious Warriors"."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"event": event, "target_number": None, "roll": None, "success": False, "auto_fail": True}
    pilot = pilots.get_pilot(mech["pilot_id"]) if mech["pilot_id"] is not None else None
    piloting = pilot["piloting"] if pilot else 5
    target_number = piloting + modifier
    immobile = mech["is_shutdown"] or mech["is_prone"]
    unconscious = pilot is not None and pilot["hits"] >= 6
    if immobile or unconscious:
        return {"event": event, "target_number": target_number, "roll": None, "success": False, "auto_fail": True}
    _, _, roll = _roll_2d6()
    return {"event": event, "target_number": target_number, "roll": roll, "success": roll >= target_number, "auto_fail": False}


def _damage_groups(total: int) -> list[int]:
    groups = [5] * (total // 5)
    if total % 5:
        groups.append(total % 5)
    return groups or [0]


def apply_fall(mech_id: int, levels: int = 0) -> dict:
    """A mech falls: marks it prone, applies fall damage (ceil(tonnage/10)
    x (levels fallen + 1), 5-point groupings, Front hit-location column —
    see module docstring), then rolls the pilot's own "seatbelt" PSR
    (pass = no wound, fail = 1 wound). Automatic 1 wound instead of a roll
    if the mech was ALREADY immobile before this fall (shut down) or the
    modified Target Number would exceed 12 — captured before marking the
    mech prone, since falling doesn't retroactively make the mech "was
    already immobile" for this specific check."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"mech_id": mech_id}
    was_immobile = bool(mech["is_shutdown"])
    mechs.set_prone(mech_id, True)

    total_damage = math.ceil(mech["tonnage"] / 10) * (levels + 1)
    damage_results = []
    with db.connect() as conn:
        for amount in _damage_groups(total_damage):
            if amount == 0:
                continue
            _, _, loc_roll = _roll_2d6()
            location = _FALL_HIT_LOCATION[loc_roll]
            damage_results.append(mechs.apply_damage(conn, mech_id, location, rear=False, amount=amount))

    seatbelt = None
    pilot_wounded = False
    if mech["pilot_id"] is not None:
        pilot = pilots.get_pilot(mech["pilot_id"])
        target_number = (pilot["piloting"] if pilot else 5)
        if was_immobile or target_number > 12:
            seatbelt = {"event": "fall_seatbelt", "target_number": target_number, "roll": None, "success": False, "auto_fail": True}
        else:
            _, _, roll = _roll_2d6()
            seatbelt = {"event": "fall_seatbelt", "target_number": target_number, "roll": roll, "success": roll >= target_number, "auto_fail": False}
        if not seatbelt["success"]:
            pilots.add_pilot_hits(mech["pilot_id"], 1)
            pilot_wounded = True

    return {
        "mech_id": mech_id, "levels": levels, "total_damage": total_damage,
        "damage_results": damage_results, "seatbelt": seatbelt, "pilot_wounded": pilot_wounded,
    }


def stand_up(mech_id: int) -> dict:
    """A prone mech attempts to stand (Piloting Skill Roll, +0 — costs MP,
    enforced by movement.py's own caller, not here). Success clears
    is_prone; failure falls again in place (0 levels — psr.apply_fall)."""
    mech = mechs.get_mech(mech_id)
    if mech is None or not mech["is_prone"]:
        return {"mech_id": mech_id, "already_standing": True}
    result = roll_psr(mech_id, 0, "stand_up")
    if result["success"]:
        mechs.set_prone(mech_id, False)
        return {"mech_id": mech_id, "psr": result, "stood_up": True}
    fall = apply_fall(mech_id, levels=0)
    return {"mech_id": mech_id, "psr": result, "stood_up": False, "fall": fall}
