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

Third pass (real user request: "sistema PSR/caída/prono... daño a
componentes por crítico... fase de melee... fase de heat"): critical hits
(see app/systems/battletech/criticals.py — rolled automatically here
whenever a hit penetrates to internal structure or lands a natural 2,
right after `mechs.apply_damage`), Piloting Skill Rolls and falling (see
psr.py), and physical/melee attacks — punch/kick/charge/DFA, their own
Target Number formula and hit-location tables — now have their own
resolution (see melee.py's module docstring; the melee phase's gating in
turns.py hasn't changed). Club is the one physical attack still out of
scope (see melee.py's own docstring for why).

Still deliberately out of scope: called shots, damage transfer to
adjacent locations (a destroyed arm/leg's further damage doesn't spill
into the torso), the Cluster Hits Table (SRM/LRM partial-hit resolution —
simplified to flat max damage), submersion, a formal "LOS level" concept
distinct from raw elevation, vehicles/aerospace/infantry/ProtoMechs.
"""

import secrets

from ... import db, events
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
from . import criticals, mechs, pilots, psr, weapons


class OutOfAmmo(ValueError):
    pass


class NoLineOfSight(ValueError):
    pass


class OutOfWeaponRange(ValueError):
    pass


class MechIncapacitated(ValueError):
    """A shut-down or prone mech can't attack (psr.py/turns.py's heat
    phase — a real mech.is_shutdown/is_prone check, not just a UI hint)."""

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


_MOVEMENT_TYPE_TO_ATTACKER_MOVEMENT = {"walk": "walked", "run": "ran", "jump": "jumped"}


def recorded_movement(campaign_id: int, pilot_id: int | None) -> tuple[str, int, bool]:
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

        if real_attacker["mech_id"] is not None:
            attacker_mech_state = mechs.get_mech(real_attacker["mech_id"])
            if attacker_mech_state and (attacker_mech_state["is_shutdown"] or attacker_mech_state["is_prone"]):
                raise MechIncapacitated(f"Unit {attacker_unit_id}'s mech is shut down or prone and can't attack")

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
            attacker_movement, _, _ = recorded_movement(campaign_id, real_attacker["pilot_id"])
        if target_hexes_moved is None or target_jumped is None:
            _, recorded_hexes, recorded_jumped = recorded_movement(campaign_id, real_target["pilot_id"])
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
    weapon_undo_info = None
    if weapon_id is not None:
        weapon_name = mech_weapon["weapon_name"]
        damage = stats["damage"]
        ammo_before = mech_weapon["ammo_remaining"]
        mechs.use_ammo(weapon_id)
        attacker_mech = mechs.get_mech(mech_weapon["mech_id"])
        heat_before = attacker_mech["heat_current"]  # before this shot's own heat is added below
        other_modifiers += heat_penalty(heat_before)
        mechs.add_heat(mech_weapon["mech_id"], stats["heat"])
        weapon_undo_info = {
            "mech_weapon_id": weapon_id, "ammo_before": ammo_before,
            "attacker_mech_id": mech_weapon["mech_id"], "heat_before": heat_before,
        }
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

    attack_payload: dict = {"result": result}
    if weapon_undo_info:
        attack_payload["weapon"] = weapon_undo_info

    if hit:
        loc_d1, loc_d2, loc_roll = roll_2d6()
        location, is_crit = HIT_LOCATION_TABLES[side][loc_roll]
        result["location"] = location
        result["critical"] = is_crit
        result["location_roll"] = loc_roll

        with db.connect() as conn:
            damage_result = mechs.apply_damage(
                conn, target_mech_id, location, rear=(side == "rear"), amount=damage
            )
            result["damage"] = damage_result
            # Official rule: CT or Head internal structure destroyed = whole mech destroyed.
            result["mech_destroyed"] = damage_result["destroyed"] and location in ("CT", "HD")
            attack_payload["before"] = damage_result
            summary = f"Ataque {weapon_name or 'manual'} → impacto en {location} (tirada {roll})"
            if result["mech_destroyed"]:
                summary += " — ¡MECH DESTRUIDO!"
            events.log_event(conn, campaign_id, "attack", summary, attack_payload)

        # Critical hits: rolled whenever this hit penetrated to internal
        # structure, OR on a natural 2 hit-location roll even if armor
        # absorbed everything (Through-Armor Critical — `is_crit` above is
        # exactly that natural-2 flag already, straight from
        # HIT_LOCATION_TABLES). Skipped once the mech is already destroyed
        # (result["mech_destroyed"]) — nothing left to critical.
        if not result["mech_destroyed"] and (damage_result["penetrated"] or is_crit):
            crit_hits = criticals.roll_critical_hits(target_mech_id, location)
            if crit_hits:
                effects = criticals.apply_critical_effects(target_mech_id, crit_hits)
                result["critical_hits"] = effects
                if effects["mech_destroyed"]:
                    result["mech_destroyed"] = True
                elif effects["fell"]:
                    # Destroyed gyro — automatic fall, no PSR (the rulebook's
                    # own exception: a second gyro hit in the same phase
                    # skips the PSR "since it automatically fell").
                    result["fall"] = psr.apply_fall(target_mech_id)
    else:
        # A miss still consumes ammo/adds heat when a real weapon fired
        # (see weapon_undo_info above) — logged (and undoable) too, not
        # just hits, so undo can restore that even when the shot missed
        # (previously not tracked at all — a real gap this fixes).
        with db.connect() as conn:
            summary = f"Ataque {weapon_name or 'manual'} → fallo (tirada {roll})"
            events.log_event(conn, campaign_id, "attack", summary, attack_payload)

    return result
