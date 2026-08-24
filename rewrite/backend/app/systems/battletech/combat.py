"""Core combat resolution (ROADMAP.md Fase R2): to-hit, hit location, damage.

Numbers re-verified on 2026-08-15 against official primary sources supplied
by the user: the CAT3500D "BattleTech: A Game of Armored Combat" rulebook
PDF and the Total Warfare quick-reference tables (Attack Modifiers Table,
'Mech Hit Location Table, Heat Point Table). GATOR modifiers (attacker
movement, range, target movement, heat-to-hit) and the front/left/right hit
location tables all match the official tables exactly — including a bug
found and fixed here (`target_movement_mod` was missing the 18-24 -> +5
and 25+ -> +6 tiers). `heat_penalty()`'s breakpoints are confirmed correct.

Second pass (2026-08-22, "fase de ataque a distancia... siguiendo las
reglas oficiales"): minimum-range modifier and a terrain to-hit bonus are
now real and enforced, not just documented gaps — see
`minimum_range_penalty`/`terrain_to_hit_bonus`/`partial_cover_bonus`'s own
doc comments for the exact rule text and, where the app's data model falls
short of the full official rule, the specific simplification made (each is
called out individually, same discipline as the rest of this module).
`resolve_attack` now optionally takes real `attacker_unit_id`/
`target_unit_id` and, when given, independently computes distance/LoS/
range bracket/side/attacker & target movement from real game state instead
of trusting whatever the client sends — rejecting the shot outright
(`NoLineOfSight`/`OutOfWeaponRange`) if it's not actually possible, the
same "never trust the frontend, re-derive and validate" posture
app/systems/battletech/movement.py's execute_move already has. Omitting
those two IDs keeps the fully-manual legacy path (no validation at all)
for narrative attacks with no real unit on the board.

Still deliberately out of scope: called shots, critical-hit rolls, damage
transfer to adjacent locations, the Cluster Hits Table (SRM/LRM partial-hit
resolution — simplified to flat max damage), submersion, a formal "LOS
level" concept distinct from raw elevation, physical/melee attack rules
(punch/kick tonnage-based damage, their own hit-location table — the
melee phase exists and gates correctly, see turns.py, but resolution still
goes through this same manual/weapon-id path), vehicles/aerospace/
infantry/ProtoMechs.
"""

import secrets

from ... import db
from ...hexgrid import Hex
from ...hexgrid import distance as hex_distance
from ...hexgrid import has_los
from ...hexgrid import line as hex_line
from ...maps import get_map, tiles_lookup
from ...squaregrid import Cell
from ...squaregrid import distance as square_distance
from ...squaregrid import has_los as square_has_los
from ...squaregrid import line as square_line
from ...units import attack_side, get_unit
from . import mechs, pilots, weapons


class OutOfAmmo(ValueError):
    pass


class NoLineOfSight(ValueError):
    pass


class OutOfWeaponRange(ValueError):
    pass

# ---- GATOR to-hit modifiers ---------------------------------------------

ATTACKER_MOVEMENT_MOD = {"stationary": 0, "walked": 1, "ran": 2, "jumped": 3, "prone": 2}
RANGE_MOD = {"short": 0, "medium": 2, "long": 4}

# heat -> to-hit penalty. See module docstring for the verification caveat.
HEAT_TO_HIT_BRACKETS = [(24, 4), (17, 3), (13, 2), (8, 1), (0, 0)]  # (min_heat, penalty), checked high to low


def heat_penalty(heat: int) -> int:
    for min_heat, penalty in HEAT_TO_HIT_BRACKETS:
        if heat >= min_heat:
            return penalty
    return 0


def minimum_range_penalty(min_range: int, target_range: int) -> int:
    """Attack Modifiers Table: "Minimum range: [Minimum] - [Target Range]
    + 1". Verified against two of the manual's own worked examples (AC/5,
    min range 3, firing at range 3 -> +1, at range 2 -> +2; LRM, min range
    6, firing at range 4 -> +3) AND its "Common Misconceptions" section,
    which explicitly refutes the reading that firing exactly AT minimum
    range is penalty-free — it isn't; the formula applies there too (that
    +1 at exactly minimum is real, not an off-by-one bug). 0 whenever
    target_range is at or beyond min_range, or the weapon has none."""
    if min_range <= 0 or target_range > min_range:
        return 0
    return min_range - target_range + 1


# Attack Modifiers Table, "Range and Terrain": "+1 per intervening hex; +1
# if target in light woods/jungle" / "+2 per intervening hex; +2 if target
# in heavy woods/jungle". Only the "target's own hex" half is modeled here
# (see module docstring) — intervening-hex woods penalties fold into
# whether the shot has LOS at all (hexgrid.py's has_los), not a separate
# to-hit add-on, since a blocked shot never reaches resolve_attack.
TERRAIN_TO_HIT_BONUS = {"forest": 2, "light_forest": 1}


def terrain_to_hit_bonus(terrain: str) -> int:
    return TERRAIN_TO_HIT_BONUS.get(terrain, 0)


def partial_cover_bonus(
    attacker_pos: tuple[int, int], target_pos: tuple[int, int], target_elevation: int,
    tiles: dict[tuple[int, int], dict], grid_type: str,
) -> int:
    """Attack Modifiers Table: "Partial Cover: +1; ... it does not block
    LOS to that 'Mech" (p. 26). The full official rule keys off a formal
    "LOS level" and adjacency to a hex one level lower along the sightline
    — this app has no LOS-level concept separate from raw elevation, so
    it's simplified to: the hex immediately before the target along the
    line of fire is lower than the target's own hex (there's a dip right
    in front of the target's legs). 0 if there's no such hex (adjacent
    targets have no hex "immediately before" them) or it isn't lower."""
    line_fn = square_line if grid_type == "square" else hex_line
    cell_cls = Cell if grid_type == "square" else Hex
    path = line_fn(cell_cls(*attacker_pos), cell_cls(*target_pos))
    if len(path) < 2:
        return 0
    before = path[-2]
    before_key = (before.x, before.y) if grid_type == "square" else (before.q, before.r)
    before_tile = tiles.get(before_key)
    if before_tile is None:
        return 0
    return 1 if before_tile["elevation"] < target_elevation else 0


def target_movement_mod(hexes_moved: int, jumped: bool = False) -> int:
    if hexes_moved <= 2:
        mod = 0
    elif hexes_moved <= 4:
        mod = 1
    elif hexes_moved <= 6:
        mod = 2
    elif hexes_moved <= 9:
        mod = 3
    elif hexes_moved <= 17:
        mod = 4
    elif hexes_moved <= 24:
        mod = 5
    else:
        mod = 6
    return mod + (1 if jumped else 0)


def to_hit_number(
    gunnery: int,
    attacker_movement: str,
    target_hexes_moved: int,
    target_jumped: bool = False,
    range_bracket: str = "short",
    other_modifiers: int = 0,
) -> int:
    return (
        gunnery
        + ATTACKER_MOVEMENT_MOD[attacker_movement]
        + target_movement_mod(target_hexes_moved, target_jumped)
        + RANGE_MOD[range_bracket]
        + other_modifiers
    )


# ---- hit location (2d6) --------------------------------------------------

# roll -> (location, is_critical)
HIT_LOCATION_FRONT_REAR = {
    2: ("CT", True), 3: ("RA", False), 4: ("RA", False), 5: ("RL", False),
    6: ("RT", False), 7: ("CT", False), 8: ("LT", False), 9: ("LL", False),
    10: ("LA", False), 11: ("LA", False), 12: ("HD", False),
}
HIT_LOCATION_LEFT = {
    2: ("LT", True), 3: ("LL", False), 4: ("LA", False), 5: ("LA", False),
    6: ("LL", False), 7: ("LT", False), 8: ("CT", False), 9: ("RT", False),
    10: ("RA", False), 11: ("RL", False), 12: ("HD", False),
}
HIT_LOCATION_RIGHT = {
    2: ("RT", True), 3: ("RL", False), 4: ("RA", False), 5: ("RA", False),
    6: ("RL", False), 7: ("RT", False), 8: ("CT", False), 9: ("LT", False),
    10: ("LA", False), 11: ("LL", False), 12: ("HD", False),
}
HIT_LOCATION_TABLES = {
    "front": HIT_LOCATION_FRONT_REAR,
    "rear": HIT_LOCATION_FRONT_REAR,
    "left": HIT_LOCATION_LEFT,
    "right": HIT_LOCATION_RIGHT,
}


def roll_2d6() -> tuple[int, int, int]:
    d1, d2 = secrets.randbelow(6) + 1, secrets.randbelow(6) + 1
    return d1, d2, d1 + d2


# ---- damage application + undo log --------------------------------------


def _apply_damage(conn, mech_id: int, location: str, rear: bool, amount: int) -> dict:
    row = conn.execute(
        """
        SELECT armor_current, armor_rear_current, structure_current
        FROM mech_locations WHERE mech_id = ? AND location = ?
        """,
        (mech_id, location),
    ).fetchone()
    before = dict(row)

    use_rear = rear and before["armor_rear_current"] is not None
    armor_field = "armor_rear_current" if use_rear else "armor_current"
    armor_before = before[armor_field]

    absorbed = min(amount, armor_before)
    armor_after = armor_before - absorbed
    remaining = amount - absorbed
    structure_after = max(0, before["structure_current"] - remaining)

    conn.execute(
        f"UPDATE mech_locations SET {armor_field} = ?, structure_current = ? "
        "WHERE mech_id = ? AND location = ?",
        (armor_after, structure_after, mech_id, location),
    )

    return {
        "mech_id": mech_id,
        "location": location,
        "armor_field": armor_field,
        "armor_before": armor_before,
        "armor_after": armor_after,
        "structure_before": before["structure_current"],
        "structure_after": structure_after,
        "destroyed": structure_after == 0,
    }


_MOVEMENT_TYPE_TO_ATTACKER_MOVEMENT = {"walk": "walked", "run": "ran", "jump": "jumped"}


def _recorded_movement(campaign_id: int, pilot_id: int | None) -> tuple[str, int, bool]:
    """(attacker_movement, hexes_moved, jumped) from this round's real
    recorded move (bt_round_moves, one row per pilot per round — see
    app/systems/battletech/movement.py's _upsert_round_move) — 'stationary'/
    0/False for a pilot who hasn't moved yet this round, or has no pilot
    at all (an NPC-controlled unit)."""
    if pilot_id is None:
        return "stationary", 0, False
    with db.connect() as conn:
        row = conn.execute(
            "SELECT movement_type, hexes_moved FROM bt_round_moves WHERE campaign_id = ? AND pilot_id = ?",
            (campaign_id, pilot_id),
        ).fetchone()
    if row is None:
        return "stationary", 0, False
    movement_type = row["movement_type"]
    return (
        _MOVEMENT_TYPE_TO_ATTACKER_MOVEMENT.get(movement_type, "stationary"),
        row["hexes_moved"],
        movement_type == "jump",
    )


def resolve_attack(
    campaign_id: int,
    gunnery: int | None = None,
    target_mech_id: int | None = None,
    damage: int | None = None,
    weapon_id: int | None = None,
    attacker_movement: str | None = None,
    target_hexes_moved: int | None = None,
    target_jumped: bool | None = None,
    range_bracket: str | None = None,
    side: str | None = None,
    other_modifiers: int = 0,
    attacker_unit_id: int | None = None,
    target_unit_id: int | None = None,
) -> dict:
    """`damage` (legacy/manual) or `weapon_id` (a mounted mech_weapons row)
    — the latter looks damage up from app/weapons.py's catalog, consumes
    one shot of ammo if the weapon uses any (whether the shot hits or not
    — firing uses the round either way), adds a to-hit penalty from the
    attacker's CURRENT heat (before this shot's own heat is added, since
    the penalty reflects the heat already built up going into the shot),
    and then adds this weapon's heat to the attacker for next time.

    `attacker_unit_id`/`target_unit_id` (both required together) turn on
    real validation: distance, LOS, range bracket, side, terrain/partial-
    cover bonus, and attacker/target movement are all independently
    computed from actual positions/this round's recorded moves — anything
    the caller also passes for those fields is IGNORED in favor of the
    real value (never trust the frontend's suggestion, same posture
    movement.py's execute_move already has). No LOS -> NoLineOfSight;
    beyond the weapon's own long range -> OutOfWeaponRange — both raised
    before any ammo is spent or heat is added, so a rejected shot has no
    side effects at all. `gunnery` is also derived from the attacker's own
    pilot record when omitted (falls back to 4 if the unit has no pilot),
    so a caller with a real attacker_unit_id doesn't need to look its
    pilot's skill up separately just to pass it through. Omitting either
    ID keeps the old fully-manual path (whatever the caller passes is
    trusted as-is, defaulting to stationary/0/short/front/gunnery 4) for a
    narrative attack with no real unit on the board."""
    mech_weapon = None
    stats = None
    if weapon_id is not None:
        mech_weapon = mechs.get_mech_weapon(weapon_id)
        if mech_weapon is None:
            raise ValueError(f"Unknown weapon_id {weapon_id!r}")
        if mech_weapon["ammo_remaining"] == 0:
            raise OutOfAmmo(f"Weapon {weapon_id} is out of ammo")
        stats = weapons.get_weapon(mech_weapon["weapon_name"])

    if attacker_unit_id is not None and target_unit_id is not None:
        real_attacker = get_unit(attacker_unit_id)
        real_target = get_unit(target_unit_id)
        if real_attacker is None:
            raise ValueError(f"Unknown attacker_unit_id {attacker_unit_id!r}")
        if real_target is None:
            raise ValueError(f"Unknown target_unit_id {target_unit_id!r}")
        if target_mech_id is None:
            target_mech_id = real_target["mech_id"]

        m = get_map(real_attacker["map_id"])
        grid_type = m["grid_type"] if m else "hex"
        tiles = tiles_lookup(real_attacker["map_id"])
        attacker_pos = (real_attacker["q"], real_attacker["r"])
        target_pos = (real_target["q"], real_target["r"])
        attacker_elevation = tiles.get(attacker_pos, {}).get("elevation", 0)
        target_tile = tiles.get(target_pos, {})
        target_elevation = target_tile.get("elevation", 0)

        cell_cls = Cell if grid_type == "square" else Hex
        dist_fn = square_distance if grid_type == "square" else hex_distance
        los_fn = square_has_los if grid_type == "square" else has_los
        dist = dist_fn(cell_cls(*attacker_pos), cell_cls(*target_pos))
        if not los_fn(cell_cls(*attacker_pos), attacker_elevation, cell_cls(*target_pos), target_elevation, tiles):
            raise NoLineOfSight(f"No line of sight from unit {attacker_unit_id} to unit {target_unit_id}")

        side = attack_side(real_attacker, real_target, grid_type)
        other_modifiers += terrain_to_hit_bonus(target_tile.get("terrain", "plains"))
        other_modifiers += partial_cover_bonus(attacker_pos, target_pos, target_elevation, tiles, grid_type)

        if gunnery is None:
            attacker_pilot = pilots.get_pilot(real_attacker["pilot_id"]) if real_attacker["pilot_id"] is not None else None
            gunnery = attacker_pilot["gunnery"] if attacker_pilot else 4

        if attacker_movement is None:
            attacker_movement, _, _ = _recorded_movement(campaign_id, real_attacker["pilot_id"])
        if target_hexes_moved is None or target_jumped is None:
            _, recorded_hexes, recorded_jumped = _recorded_movement(campaign_id, real_target["pilot_id"])
            if target_hexes_moved is None:
                target_hexes_moved = recorded_hexes
            if target_jumped is None:
                target_jumped = recorded_jumped

        if stats is not None:
            if dist > stats["long"]:
                raise OutOfWeaponRange(
                    f"{mech_weapon['weapon_name']} (long range {stats['long']}) can't reach {dist} hexes"
                )
            range_bracket = "short" if dist <= stats["short"] else "medium" if dist <= stats["medium"] else "long"
            other_modifiers += minimum_range_penalty(stats["min_range"], dist)

    if gunnery is None:
        gunnery = 4
    if attacker_movement is None:
        attacker_movement = "stationary"
    if target_hexes_moved is None:
        target_hexes_moved = 0
    if target_jumped is None:
        target_jumped = False
    if range_bracket is None:
        range_bracket = "short"
    if side is None:
        side = "front"

    weapon_name = None
    if weapon_id is not None:
        weapon_name = mech_weapon["weapon_name"]
        damage = stats["damage"]
        mechs.use_ammo(weapon_id)
        attacker_mech = mechs.get_mech(mech_weapon["mech_id"])
        other_modifiers += heat_penalty(attacker_mech["heat_current"])
        mechs.add_heat(mech_weapon["mech_id"], stats["heat"])
    if damage is None:
        raise ValueError("resolve_attack requires either `damage` or `weapon_id`")
    if target_mech_id is None:
        raise ValueError("resolve_attack requires either `target_mech_id` or `target_unit_id`")

    target_number = to_hit_number(
        gunnery, attacker_movement, target_hexes_moved, target_jumped, range_bracket, other_modifiers
    )
    d1, d2, roll = roll_2d6()
    hit = roll >= target_number or roll == 12
    if roll == 2:
        hit = False  # natural 2 always misses

    result = {
        "target_mech_id": target_mech_id,
        "attacker_unit_id": attacker_unit_id,
        "target_unit_id": target_unit_id,
        "attacker_mech_id": (
            real_attacker["mech_id"] if attacker_unit_id is not None
            else mech_weapon["mech_id"] if mech_weapon is not None
            else None
        ),
        "weapon_id": weapon_id,
        "weapon_name": weapon_name,
        "target_number": target_number,
        "roll": roll,
        "roll_dice": [d1, d2],
        "hit": hit,
        "location": None,
        "critical": False,
        "damage": None,
        "mech_destroyed": False,
    }

    if hit:
        loc_d1, loc_d2, loc_roll = roll_2d6()
        location, is_crit = HIT_LOCATION_TABLES[side][loc_roll]
        result["location"] = location
        result["critical"] = is_crit
        result["location_roll"] = loc_roll

        with db.connect() as conn:
            damage_result = _apply_damage(
                conn, target_mech_id, location, rear=(side == "rear"), amount=damage
            )
            result["damage"] = damage_result
            # Official rule: CT or Head internal structure destroyed = whole mech destroyed.
            result["mech_destroyed"] = damage_result["destroyed"] and location in ("CT", "HD")
            _record_action(conn, campaign_id, "attack", {"before": damage_result, "result": result})

    return result


def _record_action(conn, campaign_id: int, action_type: str, payload: dict) -> None:
    import json

    conn.execute(
        "INSERT INTO combat_actions (campaign_id, action_type, payload) VALUES (?, ?, ?)",
        (campaign_id, action_type, json.dumps(payload)),
    )


def undo_last_action(campaign_id: int) -> dict | None:
    import json

    with db.connect() as conn:
        row = conn.execute(
            """
            SELECT id, action_type, payload FROM combat_actions
            WHERE campaign_id = ? AND undone = 0
            ORDER BY id DESC LIMIT 1
            """,
            (campaign_id,),
        ).fetchone()
        if not row:
            return None

        payload = json.loads(row["payload"])
        if row["action_type"] == "attack":
            before = payload["before"]
            conn.execute(
                f"UPDATE mech_locations SET {before['armor_field']} = ?, structure_current = ? "
                "WHERE mech_id = ? AND location = ?",
                (before["armor_before"], before["structure_before"], before["mech_id"], before["location"]),
            )

        conn.execute("UPDATE combat_actions SET undone = 1 WHERE id = ?", (row["id"],))
        return {"action_id": row["id"], "action_type": row["action_type"], "reverted": payload}
