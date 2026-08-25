"""Physical/melee attacks (CAT3500D rulebook pp. 24-28 — verified directly
against the PDF this session, not just a summary).

Target Number = attacker's PILOTING skill (not Gunnery — a real, easy-to-
miss distinction from weapon attacks) + the attack type's own modifier +
the SAME GATOR modifiers a weapon attack gets (attacker/target movement,
terrain, partial cover) EXCEPT heat and sensors, which never apply to
physical attacks.

Deliberately out of scope, documented:
- Club attacks: needs a "carrying a found club" inventory concept this
  app's data model has no home for. Punch, Kick, Charge, and DFA are
  implemented; Club isn't.
- Charge/DFA are declared in the Movement Phase and resolved in the
  Physical Attack Phase in the real rules; this app has no such
  granularity, so they're gated on the attacker's ALREADY-recorded
  movement this round instead (bt_round_moves, via combat.py's own
  recorded_movement) rather than a separate declare-then-resolve step.
- Displacement (charge/DFA pushing the target into an adjacent hex) and
  the "only one charge/DFA/push per target per turn" exclusivity aren't
  modeled — damage/criticals/falls apply, board position doesn't change.
- The "designed without a hand/lower-arm" distinction for punch's TN
  modifiers isn't made — only actual actuator damage (criticals.py) is
  checked, since this app has no separate "as-designed loadout" concept.
"""

import math

from ...hexgrid import Hex
from ...hexgrid import distance as hex_distance
from ...hexgrid import has_los
from ...maps import get_map, tiles_lookup
from ...squaregrid import Cell
from ...squaregrid import distance as square_distance
from ...squaregrid import has_los as square_has_los
from ...units import attack_side, get_unit
from . import combat, criticals, mechs, pilots, psr

MELEE_ATTACK_TYPES = ("punch", "kick", "charge", "dfa")


class UnknownMeleeAttackType(ValueError):
    pass


class NotAdjacent(ValueError):
    pass


class InvalidMeleeAttack(ValueError):
    pass


class MechIncapacitated(ValueError):
    pass


# Punch Location Table (1D6) — Left Side / Front-Rear / Right Side columns.
PUNCH_LOCATION_LEFT = {1: "LT", 2: "LT", 3: "CT", 4: "LA", 5: "LA", 6: "HD"}
PUNCH_LOCATION_FRONT = {1: "LA", 2: "LT", 3: "CT", 4: "RT", 5: "RA", 6: "HD"}
PUNCH_LOCATION_RIGHT = {1: "RT", 2: "RT", 3: "CT", 4: "RA", 5: "RA", 6: "HD"}
PUNCH_LOCATION_TABLES = {
    "left": PUNCH_LOCATION_LEFT, "front": PUNCH_LOCATION_FRONT,
    "right": PUNCH_LOCATION_RIGHT, "rear": PUNCH_LOCATION_FRONT,
}

# Kick Location Table (1D6) — Left Side always the Left Leg, Right Side
# always the Right Leg, Front/Rear split 1-3 Right / 4-6 Left.
KICK_LOCATION_LEFT = {i: "LL" for i in range(1, 7)}
KICK_LOCATION_RIGHT = {i: "RL" for i in range(1, 7)}
KICK_LOCATION_FRONT = {1: "RL", 2: "RL", 3: "RL", 4: "LL", 5: "LL", 6: "LL"}
KICK_LOCATION_TABLES = {
    "left": KICK_LOCATION_LEFT, "front": KICK_LOCATION_FRONT,
    "right": KICK_LOCATION_RIGHT, "rear": KICK_LOCATION_FRONT,
}


def _roll_1d6() -> int:
    import secrets
    return secrets.randbelow(6) + 1


# combat.py's own HIT_LOCATION_TABLES maps roll -> (location, is_critical)
# tuples (it needs the Through-Armor-Critical flag for weapon fire); Charge
# uses the same "normal" Hit Location Table but this module's own
# _apply_grouped_damage just wants a bare location string per roll, same
# shape as PUNCH_LOCATION_TABLES/KICK_LOCATION_TABLES above.
NORMAL_LOCATION_TABLES = {
    side: {roll: loc for roll, (loc, _is_crit) in table.items()}
    for side, table in combat.HIT_LOCATION_TABLES.items()
}


def _damage_groups(total: int) -> list[int]:
    groups = [5] * (total // 5)
    if total % 5:
        groups.append(total % 5)
    return groups


def _apply_single_hit(mech_id: int, location: str, rear: bool, amount: int) -> dict:
    """One hit-location roll + damage application + critical-hit follow-
    up, the same sequence combat.py's resolve_attack does for a weapon
    shot — used here per 5-point grouping (charge/DFA) or once (punch/
    kick's own single grouping)."""
    from ... import db
    with db.connect() as conn:
        damage_result = mechs.apply_damage(conn, mech_id, location, rear=rear, amount=amount)
    crit_summary = None
    if not damage_result["destroyed"] and damage_result["penetrated"]:
        crit_hits = criticals.roll_critical_hits(mech_id, location)
        if crit_hits:
            crit_summary = criticals.apply_critical_effects(mech_id, crit_hits)
    return {"location": location, "amount": amount, "damage": damage_result, "critical_hits": crit_summary}


def _apply_grouped_damage(mech_id: int, total: int, location_table: dict[int, str], side: str, rear: bool = False, dice: str = "1d6") -> list[dict]:
    """Splits `total` into 5-point Damage Value groupings and rolls a
    separate hit location for each (Charge/DFA/falling all group damage
    this way — see their own callers). `dice` picks the right die for
    whichever table this is: Punch/Kick's own Location Tables are rolled
    on 1D6, but Charge's target damage uses the NORMAL 2D6 Hit Location
    Table (NORMAL_LOCATION_TABLES, derived from combat.py's own 2D6-keyed
    HIT_LOCATION_TABLES) — a real bug caught by test_melee.py's own charge
    test before this parameter existed (every grouped-damage call rolled
    1D6 regardless of which table it was indexing into, KeyError'ing
    against the 2D6 table's 2-12 keys)."""
    table = location_table[side]
    roll_fn = _roll_1d6 if dice == "1d6" else lambda: combat.roll_2d6()[2]
    return [
        _apply_single_hit(mech_id, table[roll_fn()], rear, amount)
        for amount in _damage_groups(total)
    ]


def _mech_destroyed(hit_results: list[dict]) -> bool:
    for r in hit_results:
        if r["damage"]["destroyed"] and r["location"] in ("CT", "HD"):
            return True
        if r["critical_hits"] and r["critical_hits"]["mech_destroyed"]:
            return True
    return False


def _fell(hit_results: list[dict]) -> bool:
    return any(r["critical_hits"] and r["critical_hits"]["fell"] for r in hit_results)


def _arm_actuator_hit(mech: dict, arm_loc: str, item_name: str) -> bool:
    return any(c["item_name"] == item_name and c["hit"] for c in mech["criticals"].get(arm_loc, []))


def resolve_melee_attack(
    campaign_id: int, attacker_unit_id: int, target_unit_id: int,
    attack_type: str, arm: str | None = None,
) -> dict:
    """Validates adjacency/LOS/incapacitation, computes the Target Number
    and damage for `attack_type` (see module docstring for exactly which
    of the seven official physical attacks this covers), rolls to hit
    (combat.roll_2d6, same dice as weapon fire), applies damage/criticals/
    falls on a hit, and returns a result dict shaped like combat.py's own
    resolve_attack (hit/location/damage/mech_destroyed) plus melee-
    specific fields (self_damage_results for charge/DFA, fall)."""
    if attack_type not in MELEE_ATTACK_TYPES:
        raise UnknownMeleeAttackType(f"Unknown melee attack_type {attack_type!r}, expected one of {MELEE_ATTACK_TYPES}")

    attacker = get_unit(attacker_unit_id)
    target = get_unit(target_unit_id)
    if attacker is None or attacker["mech_id"] is None:
        raise ValueError(f"Unit {attacker_unit_id} has no mech")
    if target is None or target["mech_id"] is None:
        raise ValueError(f"Unit {target_unit_id} has no mech")
    attacker_mech = mechs.get_mech(attacker["mech_id"])
    target_mech = mechs.get_mech(target["mech_id"])
    if attacker_mech is None or target_mech is None:
        raise ValueError("Unknown mech")
    if attacker_mech["is_shutdown"] or attacker_mech["is_prone"]:
        raise MechIncapacitated(f"Unit {attacker_unit_id}'s mech is shut down or prone and can't attack")

    m = get_map(attacker["map_id"])
    grid_type = m["grid_type"] if m else "hex"
    tiles = tiles_lookup(attacker["map_id"])
    attacker_pos = (attacker["q"], attacker["r"])
    target_pos = (target["q"], target["r"])
    cell_cls = Cell if grid_type == "square" else Hex
    dist_fn = square_distance if grid_type == "square" else hex_distance
    los_fn = square_has_los if grid_type == "square" else has_los

    dist = dist_fn(cell_cls(*attacker_pos), cell_cls(*target_pos))
    if dist > 1:
        raise NotAdjacent(f"Unit {attacker_unit_id} is not adjacent to unit {target_unit_id}")

    attacker_elevation = tiles.get(attacker_pos, {}).get("elevation", 0)
    target_tile = tiles.get(target_pos, {})
    target_elevation = target_tile.get("elevation", 0)
    if not los_fn(cell_cls(*attacker_pos), attacker_elevation, cell_cls(*target_pos), target_elevation, tiles):
        raise combat.NoLineOfSight(f"No line of sight from unit {attacker_unit_id} to unit {target_unit_id}")

    side = attack_side(attacker, target, grid_type)

    attacker_pilot = pilots.get_pilot(attacker["pilot_id"]) if attacker["pilot_id"] is not None else None
    piloting = attacker_pilot["piloting"] if attacker_pilot else 5
    target_pilot = pilots.get_pilot(target["pilot_id"]) if target["pilot_id"] is not None else None
    target_piloting = target_pilot["piloting"] if target_pilot else 5

    attacker_movement, attacker_hexes, attacker_jumped = combat.recorded_movement(campaign_id, attacker["pilot_id"])
    target_movement, target_hexes, target_jumped = combat.recorded_movement(campaign_id, target["pilot_id"])

    terrain_bonus = combat.terrain_to_hit_bonus(target_tile.get("terrain", "plains"))
    cover_bonus = combat.partial_cover_bonus(attacker_pos, target_pos, target_elevation, tiles, grid_type)

    if attack_type == "punch":
        target_number, damage, hit_side = _prep_punch(attacker_mech, arm, piloting, attacker_movement, target_hexes, target_jumped, terrain_bonus, cover_bonus, side)
        location_table = PUNCH_LOCATION_TABLES
        dice = "1d6"
        self_damage = 0
    elif attack_type == "kick":
        target_number, damage, hit_side = _prep_kick(attacker_mech, piloting, attacker_movement, target_hexes, target_jumped, terrain_bonus, cover_bonus, side)
        location_table = KICK_LOCATION_TABLES
        dice = "1d6"
        self_damage = 0
    elif attack_type == "charge":
        if attacker_movement not in ("walked", "ran") or attacker_hexes <= 0:
            raise InvalidMeleeAttack("Charge requires having walked/run into contact this round")
        target_number = (
            piloting + (piloting - target_piloting)
            + combat.ATTACKER_MOVEMENT_MOD[attacker_movement] + combat.target_movement_mod(target_hexes, target_jumped)
            + terrain_bonus + cover_bonus
        )
        damage = math.ceil(attacker_mech["tonnage"] / 10 * attacker_hexes)
        self_damage = math.ceil(target_mech["tonnage"] / 10)
        # Charge uses the NORMAL (2D6) Hit Location Table, unlike every
        # other physical attack here — see NORMAL_LOCATION_TABLES's own
        # doc comment.
        location_table = NORMAL_LOCATION_TABLES
        dice = "2d6"
        hit_side = side
    else:  # dfa
        if attacker_movement != "jumped":
            raise InvalidMeleeAttack("Death From Above requires having jumped into contact this round")
        # No terrain modifier for DFA (explicit rulebook exception);
        # partial cover still applies, same as every other physical attack.
        target_number = (
            piloting + (piloting - target_piloting)
            + combat.ATTACKER_MOVEMENT_MOD["jumped"] + combat.target_movement_mod(target_hexes, target_jumped)
            + cover_bonus
        )
        damage = math.ceil(attacker_mech["tonnage"] / 10 * 3)
        self_damage = math.ceil(attacker_mech["tonnage"] / 5)
        location_table = PUNCH_LOCATION_TABLES
        dice = "1d6"
        hit_side = side

    d1, d2, roll = combat.roll_2d6()
    hit = roll >= target_number or roll == 12
    if roll == 2:
        hit = False

    result: dict = {
        "attack_type": attack_type, "attacker_unit_id": attacker_unit_id, "target_unit_id": target_unit_id,
        "attacker_mech_id": attacker["mech_id"], "target_mech_id": target["mech_id"],
        "target_number": target_number, "roll": roll, "roll_dice": [d1, d2], "hit": hit,
        "damage": None, "hit_results": [], "self_damage_results": [], "mech_destroyed": False, "fall": None, "self_fall": None,
    }

    if hit:
        result["damage"] = damage
        rear = hit_side == "rear"
        if attack_type in ("charge", "dfa"):
            hit_results = _apply_grouped_damage(target["mech_id"], damage, location_table, hit_side, rear, dice)
        else:
            table = location_table[hit_side]
            location = table[_roll_1d6()]
            hit_results = [_apply_single_hit(target["mech_id"], location, rear, damage)]
        result["hit_results"] = hit_results
        result["mech_destroyed"] = _mech_destroyed(hit_results)
        if not result["mech_destroyed"] and _fell(hit_results):
            result["fall"] = psr.apply_fall(target["mech_id"])

        if self_damage:
            if attack_type == "dfa":
                # Attacker's own damage from a successful DFA is rolled on
                # the Kick Location Table's Front column specifically.
                self_results = _apply_grouped_damage(attacker["mech_id"], self_damage, KICK_LOCATION_TABLES, "front", rear=False, dice="1d6")
            else:
                self_results = _apply_grouped_damage(attacker["mech_id"], self_damage, NORMAL_LOCATION_TABLES, "front", rear=False, dice="2d6")
            result["self_damage_results"] = self_results
            if _fell(self_results) and not (result["fall"] and result["fall"].get("mech_id") == attacker["mech_id"]):
                result["self_fall"] = psr.apply_fall(attacker["mech_id"])

        if attack_type == "kick":
            # Kicked target must PSR (own consequence, not the attacker's).
            psr_result = psr.roll_psr(target["mech_id"], 0, "kicked")
            result["target_psr"] = psr_result
            if not psr_result["success"] and not result["fall"]:
                result["fall"] = psr.apply_fall(target["mech_id"])
    elif attack_type == "kick":
        # A missed kick always fells the attacker (rulebook: automatic
        # fall, 2-level fall damage, rear hit location — captured by
        # psr.apply_fall's own Front-only simplification, see its
        # docstring; using "front" here for the attacker's own tumble is
        # an accepted simplification of the real rule's "always rear").
        result["self_fall"] = psr.apply_fall(attacker["mech_id"], levels=2)

    return result


def _leg_actuator_state(mech: dict) -> tuple[bool, int, tuple[int, int]]:
    """(both_hips_ok, tn_penalty, damage_fraction) — checked across BOTH
    legs (the rulebook's Kick attack doesn't let the attacker pick which
    leg kicks the way Punch lets them pick an arm), using whichever leg
    is less damaged for the damage fraction (a mech would kick with its
    better leg) and summing the TN penalty from both (cumulative, same
    as the rulebook's own "cumulative" language for actuator damage)."""
    hips_ok = True
    tn_penalty = 0
    fractions = []
    for loc in ("LL", "RL"):
        crits = mech["criticals"].get(loc, [])
        if any(c["item_name"] == "Hip" and c["hit"] for c in crits):
            hips_ok = False
        if any(c["item_name"] == "Upper Leg Actuator" and c["hit"] for c in crits):
            tn_penalty += 1
        if any(c["item_name"] == "Lower Leg Actuator" and c["hit"] for c in crits):
            tn_penalty += 2
        fractions.append(criticals.actuator_damage_fraction(mech["id"], loc))
    best = min(fractions, key=lambda f: f[1] / f[0])
    return hips_ok, tn_penalty, best


def _prep_kick(attacker_mech, piloting, attacker_movement, target_hexes, target_jumped, terrain_bonus, cover_bonus, side):
    hips_ok, tn_penalty, (num, den) = _leg_actuator_state(attacker_mech)
    if not hips_ok:
        raise InvalidMeleeAttack("Both hip actuators must be undamaged to kick")
    target_number = (
        piloting - 2 + tn_penalty
        + combat.ATTACKER_MOVEMENT_MOD[attacker_movement] + combat.target_movement_mod(target_hexes, target_jumped)
        + terrain_bonus + cover_bonus
    )
    base_damage = math.ceil(attacker_mech["tonnage"] / 5)
    damage = max(1, (base_damage * num) // den)
    return target_number, damage, side


def _prep_punch(attacker_mech, arm, piloting, attacker_movement, target_hexes, target_jumped, terrain_bonus, cover_bonus, side):
    if arm not in ("left", "right"):
        raise InvalidMeleeAttack("Punch requires arm='left' or arm='right'")
    arm_loc = "LA" if arm == "left" else "RA"
    if _arm_actuator_hit(attacker_mech, arm_loc, "Shoulder"):
        raise InvalidMeleeAttack(f"Shoulder actuator destroyed in {arm_loc}, can't punch with that arm")
    tn_penalty = 0
    if _arm_actuator_hit(attacker_mech, arm_loc, "Hand Actuator"):
        tn_penalty += 1
    if _arm_actuator_hit(attacker_mech, arm_loc, "Lower Arm Actuator"):
        tn_penalty += 2
    target_number = (
        piloting + tn_penalty
        + combat.ATTACKER_MOVEMENT_MOD[attacker_movement] + combat.target_movement_mod(target_hexes, target_jumped)
        + terrain_bonus + cover_bonus
    )
    num, den = criticals.actuator_damage_fraction(attacker_mech["id"], arm_loc)
    base_damage = math.ceil(attacker_mech["tonnage"] / 10)
    damage = max(1, (base_damage * num) // den)
    return target_number, damage, side
