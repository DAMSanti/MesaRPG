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

from ... import db, dice_resolution
from ...dice_source import DiceSource, RandomDice
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


def decide_psr(mech: dict, modifier: int, event: str, dice: DiceSource, pilot_id: int | None = None) -> dict:
    """Pure — the actual PSR logic, consuming its roll from `dice` instead
    of rolling instantly, so a physical-mode pilot's PSR can pause mid-
    resolution the same way combat/criticals rolls do (see dice_source.py/
    dice_resolution.py). roll_psr below is the old instant/auto entrypoint,
    kept for callers not yet wired for physical dice (stand_up)."""
    pilot = pilots.get_pilot(mech["pilot_id"]) if mech["pilot_id"] is not None else None
    piloting = pilot["piloting"] if pilot else 5
    target_number = piloting + modifier
    immobile = mech["is_shutdown"]
    unconscious = pilot is not None and pilot["hits"] >= 6
    if immobile or unconscious:
        return {"event": event, "target_number": target_number, "roll": None, "success": False, "auto_fail": True}
    _, _, roll = dice.next_2d6(f"psr_{event}", pilot_id if pilot_id is not None else mech["pilot_id"])
    return {"event": event, "target_number": target_number, "roll": roll, "success": roll >= target_number, "auto_fail": False}


def roll_psr(mech_id: int, modifier: int, event: str) -> dict:
    """A single Piloting Skill Roll for mech_id's pilot. `modifier` is the
    event's own Target Number add-on (see module docstring — the caller
    picks it). A shut-down mech, or a pilot at the sheet's own fatal
    wound-track box (6, see pilots.add_pilot_hits), automatically fails
    without a roll — the real rule for "Immobile 'Mechs and Unconscious
    Warriors". Prone is deliberately NOT auto-fail here (real bug fixed:
    it used to be, which made stand_up below permanently unable to
    succeed — a prone mech attempting to stand IS the roll, not a
    disqualifying state for it; apply_fall's own separate was_immobile
    check already made this same distinction, just this generic check
    hadn't caught up to it)."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"event": event, "target_number": None, "roll": None, "success": False, "auto_fail": True}
    return decide_psr(mech, modifier, event, RandomDice(), None)


def _damage_groups(total: int) -> list[int]:
    groups = [5] * (total // 5)
    if total % 5:
        groups.append(total % 5)
    return groups or [0]


def decide_fall(mech: dict, levels: int, dice: DiceSource, pilot_id: int | None = None) -> dict:
    """Pure — decides everything a fall needs (damage grouping + a hit
    location roll per group + the pilot's seatbelt roll) without marking
    the mech prone or writing any damage/wound yet. was_immobile is read
    from `mech` as handed in (BEFORE the caller marks it prone in the
    apply half — falling doesn't retroactively make the mech "was already
    immobile" for the seatbelt's own automatic-fail check, same rule as
    before this split, just now evaluated up front instead of ordered
    around a set_prone call in the middle). Pair with apply_fall_decision."""
    was_immobile = bool(mech["is_shutdown"])
    roll_pilot_id = pilot_id if pilot_id is not None else mech["pilot_id"]
    total_damage = math.ceil(mech["tonnage"] / 10) * (levels + 1)
    damage_groups = []
    for amount in _damage_groups(total_damage):
        if amount == 0:
            continue
        _, _, loc_roll = dice.next_2d6("fall_location", roll_pilot_id)
        damage_groups.append({"location": _FALL_HIT_LOCATION[loc_roll], "amount": amount})

    seatbelt = None
    if mech["pilot_id"] is not None:
        pilot = pilots.get_pilot(mech["pilot_id"])
        target_number = pilot["piloting"] if pilot else 5
        if was_immobile or target_number > 12:
            seatbelt = {"event": "fall_seatbelt", "target_number": target_number, "roll": None, "success": False, "auto_fail": True}
        else:
            _, _, roll = dice.next_2d6("fall_seatbelt", roll_pilot_id)
            seatbelt = {"event": "fall_seatbelt", "target_number": target_number, "roll": roll, "success": roll >= target_number, "auto_fail": False}

    return {
        "mech_id": mech["id"], "pilot_id": mech["pilot_id"], "levels": levels,
        "total_damage": total_damage, "damage_groups": damage_groups, "seatbelt": seatbelt,
    }


def apply_fall_decision(decision: dict) -> dict:
    """The mutating half — marks the mech prone, applies each damage
    group, and wounds the pilot if the seatbelt roll failed. Returns the
    same shape apply_fall always has (mech_id/levels/total_damage/
    damage_results/seatbelt/pilot_wounded)."""
    mech_id = decision["mech_id"]
    mechs.set_prone(mech_id, True)
    damage_results = []
    with db.connect() as conn:
        for group in decision["damage_groups"]:
            damage_results.append(
                mechs.apply_damage(conn, mech_id, group["location"], rear=False, amount=group["amount"])
            )
    pilot_wounded = False
    seatbelt = decision["seatbelt"]
    if decision["pilot_id"] is not None and seatbelt is not None and not seatbelt["success"]:
        pilots.add_pilot_hits(decision["pilot_id"], 1)
        pilot_wounded = True
    return {
        "mech_id": mech_id, "levels": decision["levels"], "total_damage": decision["total_damage"],
        "damage_results": damage_results, "seatbelt": seatbelt, "pilot_wounded": pilot_wounded,
    }


def apply_fall(mech_id: int, levels: int = 0) -> dict:
    """A mech falls: marks it prone, applies fall damage (ceil(tonnage/10)
    x (levels fallen + 1), 5-point groupings, Front hit-location column —
    see module docstring), then rolls the pilot's own "seatbelt" PSR
    (pass = no wound, fail = 1 wound). Automatic 1 wound instead of a roll
    if the mech was ALREADY immobile before this fall (shut down) or the
    modified Target Number would exceed 12. Old instant/auto entrypoint
    (RandomDice) — kept for callers not yet wired for physical dice
    (stand_up below); implemented on top of decide_fall/apply_fall_
    decision, which any physical-mode-aware caller should use directly."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"mech_id": mech_id}
    decision = decide_fall(mech, levels, RandomDice(), None)
    return apply_fall_decision(decision)


STAND_UP_STEP_ORDER = ["psr", "fall"]


def _prepare_stand_up(mech_id: int, unit_id: int | None) -> dict:
    """No dice involved in the two early-exit cases (already standing, a
    destroyed gyro that can never stand again) — captured here so
    run_stand_up can short-circuit before entering the step machine at
    all, same spirit as combat.py's own _prepare_attack running once,
    up front, before any roll-dependent step. `unit_id` is never used by
    this module's own logic (stand_up has always been purely mech-
    centric) — it only rides along in ctx so main.py's endpoint can
    re-fetch the right unit for its own post-resolution bookkeeping
    (movement.record_free_move) on a resumed call, without this module
    needing to know what a "unit" even is."""
    mech = mechs.get_mech(mech_id)
    already_standing = mech is None or not mech["is_prone"]
    gyro_destroyed = not already_standing and mech["gyro_hits"] >= 2
    return {
        "mech_id": mech_id,
        "unit_id": unit_id,
        "campaign_id": mech["campaign_id"] if mech else None,
        "pilot_id": mech["pilot_id"] if mech else None,
        "already_standing": already_standing,
        "gyro_destroyed": gyro_destroyed,
    }


def _step_stand_up_psr(ctx: dict, dice: DiceSource) -> dict:
    mech = mechs.get_mech(ctx["mech_id"])
    return decide_psr(mech, 0, "stand_up", dice, ctx["pilot_id"])


def _step_stand_up_fall(ctx: dict, dice: DiceSource) -> dict:
    mech = mechs.get_mech(ctx["mech_id"])
    decision = decide_fall(mech, 0, dice, ctx["pilot_id"])
    return apply_fall_decision(decision)


def _needs_stand_up_step(step: str, committed: dict) -> bool:
    if step == "psr":
        return True
    if step == "fall":
        psr_result = committed.get("psr")
        return bool(psr_result) and not psr_result["success"]
    raise ValueError(step)


def _run_stand_up_step_fn(step: str, ctx: dict, dice: DiceSource):
    if step == "psr":
        return _step_stand_up_psr(ctx, dice)
    if step == "fall":
        return _step_stand_up_fall(ctx, dice)
    raise ValueError(step)


def _finalize_stand_up(ctx: dict, committed: dict) -> dict:
    psr_result = committed["psr"]
    result: dict = {"mech_id": ctx["mech_id"], "psr": psr_result, "stood_up": psr_result["success"]}
    if psr_result["success"]:
        mechs.set_prone(ctx["mech_id"], False)
    else:
        result["fall"] = committed["fall"]
    return result


def run_stand_up(
    mech_id: int | None = None, unit_id: int | None = None, *, ctx: dict | None = None,
    committed: dict | None = None, collected: list | None = None, force_auto: bool = False,
) -> dict:
    """The Fase B driver — same shape as combat.py's run_attack/melee.py's
    run_melee_attack. A prone mech attempts to stand (Piloting Skill
    Roll, +0 — costs MP, enforced by movement.py's own caller, not here).
    Success clears is_prone; failure falls again in place (0 levels).
    A destroyed gyro (2nd gyro critical) never allows standing back up
    at all — real rule, checked here rather than via decide_psr's own
    auto-fail so a destroyed-gyro mech is reported distinctly from a
    normal failed roll. Raises dice_resolution.PendingRoll if a step
    needs a real physical die. `unit_id` is optional and only meaningful
    on the INITIAL call — see _prepare_stand_up's own doc comment."""
    if ctx is None:
        ctx = _prepare_stand_up(mech_id, unit_id)
        committed = {}
        collected = []

    if ctx["already_standing"]:
        return {"mech_id": ctx["mech_id"], "already_standing": True}
    if ctx["gyro_destroyed"]:
        return {"mech_id": ctx["mech_id"], "stood_up": False, "gyro_destroyed": True}

    first = True
    for step in STAND_UP_STEP_ORDER:
        if step in committed:
            continue
        if not _needs_stand_up_step(step, committed):
            continue
        this_step_collected = collected if first else []
        first = False
        result = dice_resolution.run_step(
            lambda dice, _step=step: _run_stand_up_step_fn(_step, ctx, dice), this_step_collected,
            campaign_id=ctx["campaign_id"], kind="stand_up", step=step, ctx=ctx, committed=committed,
            force_auto=force_auto,
        )
        committed[step] = result

    return _finalize_stand_up(ctx, committed)


def stand_up(mech_id: int) -> dict:
    """Old, fully synchronous entrypoint — ALWAYS instant (force_auto),
    kept 100% behavior-identical to before Fase B. See run_stand_up for
    the physical-dice-aware entrypoint."""
    return run_stand_up(mech_id, force_auto=True)
