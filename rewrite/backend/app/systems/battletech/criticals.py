"""Critical hits (CAT3500D "A Game of Armored Combat" rulebook, pp. 30-36
— verified directly against the PDF this session, not just a summary).

Rolled whenever a hit penetrates to internal structure, or on a natural 2
hit-location roll even if armor absorbed everything (Through-Armor
Critical) — see combat.py's resolve_attack and melee.py's
resolve_melee_attack, both of which call roll_critical_hits/
apply_critical_effects right after their own mechs.apply_damage call.

Determining Critical Hits Table (2D6): 2-7 -> none, 8-9 -> 1 critical,
10-11 -> 2 criticals, 12 -> a head or limb (arm/leg) is blown off
entirely; a torso instead rolls 3 normal criticals (a torso can't be
blown off).

Deliberately out of scope, documented (not silent): if every slot in the
struck location is already inapplicable (hit or empty), the critical is
discarded rather than transferring to another location per the Damage
Transfer Diagram — the same simplification level combat.py's own
docstring already accepts for damage transfer generally, so this isn't a
new gap, it's consistent with one already declared.
"""

import secrets

from ... import db
from ...critical_layout import EMPTY
from ...dice_source import DiceSource, RandomDice
from . import mechs, pilots, weapons

TORSO_OR_ARM_LOCATIONS = {"CT", "LT", "RT", "LA", "RA"}
HEAD_OR_LEG_LOCATIONS = {"HD", "LL", "RL"}
# Locations a natural 12 blows off entirely rather than rolling 3 normal
# criticals — everything except the torsos, which can't be blown off.
BLOWABLE_LOCATIONS = {"HD", "LA", "RA", "LL", "RL"}


def _roll_1d6() -> int:
    return secrets.randbelow(6) + 1


def decide_criticals(mech: dict, location: str, dice: DiceSource, pilot_id: int | None = None) -> list[dict]:
    """Pure — decides which slots WOULD be hit without writing anything to
    the database, consuming rolls from `dice` instead of rolling them
    instantly (a dice_source.SuppliedDice mid-replay raises NeedsRoll the
    moment it needs a physical roll that hasn't come back yet — see
    dice_resolution.py). `mech` is a caller-supplied snapshot (mechs.
    get_mech's own shape) rather than re-read here, so a caller building a
    bigger decide phase (combat.py's decide_attack) can pass the SAME
    already-read mech through every decision it makes, guaranteeing they
    all see the same "before" state. Pair with apply_criticals, the only
    half that mutates. roll_critical_hits below is the old all-in-one
    entrypoint (still instant/mutating) implemented in terms of these
    two, kept for callers not yet wired for physical dice."""
    slots = mech["criticals"].get(location, [])
    if not slots:
        return []

    _, _, roll = dice.next_2d6("crit_count", pilot_id)
    if roll <= 7:
        return []

    if roll == 12 and location in BLOWABLE_LOCATIONS:
        return _decide_blow_off_location(location, slots)

    count = 1 if roll <= 9 else 2 if roll <= 11 else 3  # 12 on a torso: 3 normal criticals
    return _decide_assign_criticals(location, slots, count, dice, pilot_id)


def _decide_blow_off_location(location: str, slots: list[dict]) -> list[dict]:
    hits = [
        {"location": location, "slot_index": s["slot_index"], "item_name": s["item_name"]}
        for s in slots if s["item_name"] != EMPTY and not s["hit"]
    ]
    hits.append({"location": location, "slot_index": None, "item_name": "__blown_off__"})
    return hits


def _decide_assign_criticals(location: str, slots: list[dict], count: int, dice: DiceSource, pilot_id: int | None) -> list[dict]:
    """Real user report (2026-08-26, live on campaign 65): a physical-mode
    pilot's critical hit got stuck asking for 1d6 "one after another,
    infinitely". Root cause — this used to retry up to 50 TIMES per
    critical whenever its guessed slot landed on an already-hit/empty one
    (a location with few slots left standing can easily miss dozens of
    guesses in a row), and every retry called `dice.next_1d6` again: fine
    when that was `_roll_1d6()` (instant, `secrets`-based, a plain CPU
    loop) before Fase B, but under a REAL physical die each retry is a
    genuine "please throw again" request to the player — up to 50(!) per
    critical, reading as an infinite loop. The retry itself was always
    just an implementation detail for "pick an applicable slot roughly at
    random", never a real tabletop decision point worth asking the player
    to re-throw for. Fixed to consume the real roll(s) EXACTLY ONCE per
    critical (one 1d6 normally, two for a torso/arm's block+position
    convention — matches how many physical dice a player actually expects
    to throw for one critical); if that one roll doesn't land on an
    applicable slot, the engine picks one from the real candidates,
    deterministically derived from that same roll (no further dice
    needed) rather than re-asking."""
    is_torso_or_arm = location in TORSO_OR_ARM_LOCATIONS
    already_hit = {s["slot_index"] for s in slots if s["hit"]}
    item_by_index = {s["slot_index"]: s["item_name"] for s in slots}

    def applicable(idx: int) -> bool:
        return idx in item_by_index and idx not in already_hit and item_by_index[idx] != EMPTY

    hits = []
    for _ in range(count):
        candidates = [i for i in item_by_index if applicable(i)]
        if not candidates:
            break  # nothing left to hit in this location — discarded, see module docstring
        if is_torso_or_arm:
            block_roll = dice.next_1d6("crit_slot_block", pilot_id)
            slot_roll = dice.next_1d6("crit_slot", pilot_id)
            guess = (0 if block_roll <= 3 else 6) + (slot_roll - 1)
            fallback_seed = block_roll * 6 + slot_roll
        else:
            slot_roll = dice.next_1d6("crit_slot", pilot_id)
            guess = slot_roll - 1
            fallback_seed = slot_roll
        idx = guess if applicable(guess) else candidates[fallback_seed % len(candidates)]
        already_hit.add(idx)
        hits.append({"location": location, "slot_index": idx, "item_name": item_by_index[idx]})
    return hits


def roll_critical_hits(mech_id: int, location: str) -> list[dict]:
    """Rolls 2D6 on the Determining Critical Hits Table, assigns each
    resulting critical to a real slot (re-rolling inapplicable slots —
    already hit, or a bare -Empty- slot with nothing to damage), and
    marks them via mechs.set_critical_hit. A natural 12 against a head or
    limb blows the whole location off instead (all its real slots hit,
    armor/structure zeroed) rather than rolling 3 individual slots.
    Returns [{"location", "slot_index", "item_name"}, ...] for whatever
    was actually struck — empty if the location has no critical table
    (shouldn't happen for a real mech) or nothing left to hit."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return []
    hits = decide_criticals(mech, location, RandomDice(), None)
    for hit in hits:
        if hit["item_name"] == "__blown_off__":
            _apply_blow_off_structure(mech_id, hit["location"])
        elif hit["slot_index"] is not None:
            mechs.set_critical_hit(mech_id, hit["location"], hit["slot_index"], True)
    return hits


def apply_criticals(mech_id: int, hits: list[dict]) -> dict:
    """The mutating half of a decided crit list — marks every slot hit
    (or zeroes a blown-off location's armor/structure), then applies each
    struck component's real consequence (apply_critical_effects, which
    rolls no dice of its own, only reads `hits`). Used by combat.py's
    apply_attack/melee.py's own apply half once decide_criticals (and
    everything else in the same decide phase) has already collected
    every roll it needs."""
    for hit in hits:
        if hit["item_name"] == "__blown_off__":
            _apply_blow_off_structure(mech_id, hit["location"])
        elif hit["slot_index"] is not None:
            mechs.set_critical_hit(mech_id, hit["location"], hit["slot_index"], True)
    return apply_critical_effects(mech_id, hits)


def _apply_blow_off_structure(mech_id: int, location: str) -> None:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT armor_rear_max FROM mech_locations WHERE mech_id = ? AND location = ?",
            (mech_id, location),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE mech_locations SET armor_current = 0, armor_rear_current = ?, structure_current = 0 "
                "WHERE mech_id = ? AND location = ?",
                (0 if row["armor_rear_max"] is not None else None, mech_id, location),
            )


def _blow_off_location(mech_id: int, location: str, slots: list[dict]) -> list[dict]:
    hits = []
    for slot in slots:
        if slot["item_name"] == EMPTY or slot["hit"]:
            continue
        mechs.set_critical_hit(mech_id, location, slot["slot_index"], True)
        hits.append({"location": location, "slot_index": slot["slot_index"], "item_name": slot["item_name"]})
    with db.connect() as conn:
        row = conn.execute(
            "SELECT armor_rear_max FROM mech_locations WHERE mech_id = ? AND location = ?",
            (mech_id, location),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE mech_locations SET armor_current = 0, armor_rear_current = ?, structure_current = 0 "
                "WHERE mech_id = ? AND location = ?",
                (0 if row["armor_rear_max"] is not None else None, mech_id, location),
            )
    hits.append({"location": location, "slot_index": None, "item_name": "__blown_off__"})
    return hits


def _assign_criticals(mech_id: int, location: str, slots: list[dict], count: int) -> list[dict]:
    is_torso_or_arm = location in TORSO_OR_ARM_LOCATIONS
    already_hit = {s["slot_index"] for s in slots if s["hit"]}
    item_by_index = {s["slot_index"]: s["item_name"] for s in slots}

    def applicable(idx: int) -> bool:
        return idx in item_by_index and idx not in already_hit and item_by_index[idx] != EMPTY

    hits = []
    for _ in range(count):
        candidates = [i for i in item_by_index if applicable(i)]
        if not candidates:
            break  # nothing left to hit in this location — discarded, see module docstring
        idx = None
        for _attempt in range(50):
            guess = (
                (0 if _roll_1d6() <= 3 else 6) + (_roll_1d6() - 1) if is_torso_or_arm
                else _roll_1d6() - 1
            )
            if applicable(guess):
                idx = guess
                break
        if idx is None:
            idx = candidates[0]
        already_hit.add(idx)
        mechs.set_critical_hit(mech_id, location, idx, True)
        hits.append({"location": location, "slot_index": idx, "item_name": item_by_index[idx]})
    return hits


# ---- per-component effects (pp. 34-36) -----------------------------------

# Damage from punches/kicks is halved per damaged actuator, and each also
# adds a TN modifier to that mech's own future physical/weapon attacks —
# both read live from mech_criticals by melee.py's own to-hit/damage calc
# (see actuator_damage_fraction below), not mutated here.
ARM_ACTUATORS = {"Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator"}
LEG_ACTUATORS = {"Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator"}


def actuator_damage_fraction(mech_id: int, location: str) -> tuple[int, int]:
    """(numerator, denominator) fraction of full punch/kick damage this
    arm/leg can still deal — halved per damaged upper-or-lower actuator,
    cumulative (both damaged = 1/4). Only the two "muscle" actuators
    reduce damage (Shoulder/Hip and Hand/Foot affect TN or block the
    attack outright, not damage — see melee.py)."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return 1, 1
    relevant = {"Upper Arm Actuator", "Lower Arm Actuator"} if location in ("LA", "RA") else {"Upper Leg Actuator", "Lower Leg Actuator"}
    damaged = sum(1 for s in mech["criticals"].get(location, []) if s["item_name"] in relevant and s["hit"])
    return 1, 2 ** damaged


def apply_critical_effects(mech_id: int, hits: list[dict]) -> dict:
    """Applies the real consequence of each struck component (pp. 34-36)
    — engine heat buildup, gyro/leg/hip mobility loss, sensors/weapons
    disabled, life support enabling heat damage, ammo explosions, cockpit
    kills. Returns a summary dict for the caller to fold into its own
    event log / broadcast; doesn't log its own event (the caller's attack
    event already describes the shot, this is a detail of it)."""
    summary: dict = {"hits": hits, "fell": False, "mech_destroyed": False, "pilot_killed": False, "ammo_explosions": []}
    mech = mechs.get_mech(mech_id)
    pilot_id = mech["pilot_id"] if mech else None
    for hit in hits:
        item = hit["item_name"]
        if item == "Cockpit":
            if pilot_id is not None:
                pilots.add_pilot_hits(pilot_id, 6)
                pilots.mark_pilot_dead(pilot_id)
                summary["pilot_killed"] = True
            summary["mech_destroyed"] = True
            mechs.mark_destroyed(mech_id, "pilot_killed")
        elif item == "Engine":
            updated = mechs.add_engine_hit(mech_id)
            if updated and updated["engine_hits"] >= 3:
                summary["mech_destroyed"] = True
                mechs.mark_destroyed(mech_id, "structural")
            else:
                # +5 heat/turn for the 1st hit, +10 total for the 2nd —
                # applied as a one-off addition now (mirroring add_heat's
                # existing "heat right now" bookkeeping for weapon fire);
                # turns.py's resolve_heat_phase re-applies +5 per active
                # engine hit every subsequent round on top of this.
                mechs.add_heat(mech_id, 5)
        elif item == "Gyro":
            updated = mechs.add_gyro_hit(mech_id)
            if updated and updated["gyro_hits"] >= 2:
                summary["fell"] = True  # caller triggers psr.apply_fall
        elif item == "Sensors":
            mechs.add_sensor_hit(mech_id)
        elif item == "Life Support":
            mechs.set_life_support_hit(mech_id)
        elif item == "Heat Sink":
            mechs.remove_heat_sink(mech_id)
        elif item in ARM_ACTUATORS or item in LEG_ACTUATORS or item == "__blown_off__":
            pass  # read live where relevant (actuator_damage_fraction above); blow-off already applied
        elif "ammo" in item.lower() and hit["slot_index"] is not None:
            summary["ammo_explosions"].append(explode_ammo(mech_id, hit["location"], hit["slot_index"]))
        # Weapons/other equipment: no extra state to mutate — "destroyed"
        # is derived live from mech_criticals.hit whenever a weapon fires
        # (combat.py/melee.py check this before allowing the shot).
    return summary


def explode_ammo(mech_id: int, location: str, slot_index: int) -> dict:
    """Shared by a critical hit striking an ammo slot AND the Heat
    Scale's own ammo-explosion check (turns.py's resolve_heat_phase) —
    same consequence either way: the whole bin's remaining Damage Value
    hits internal structure directly (bypassing armor), plus 2 automatic
    wounds to the pilot.

    mech_criticals has no formal link from an ammo slot to which
    mech_weapons row it feeds — a hand-built mech (critical_layout.py)
    doesn't even generate ammo critical slots at all today (only real
    MTF imports do, spelled however the source file happened to). This
    matches the slot's item_name back to a mounted weapon by substring
    overlap as a best effort; if nothing matches, the explosion still
    happens (2 pilot wounds) but deals no structure damage — a documented
    simplification, not a silent guess."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"mech_id": mech_id, "damage": 0}
    item_name = next(
        (s["item_name"] for s in mech["criticals"].get(location, []) if s["slot_index"] == slot_index),
        None,
    )
    matched = None
    if item_name:
        needle = item_name.lower()
        matched = next((w for w in mech["weapons"] if w["ammo_remaining"] and w["weapon_name"].lower() in needle), None)

    shots_remaining = matched["ammo_remaining"] if matched else 0
    per_shot_damage = weapons.get_weapon(matched["weapon_name"])["damage"] if matched else 0
    total_damage = shots_remaining * per_shot_damage

    damage_result = None
    if total_damage:
        with db.connect() as conn:
            damage_result = mechs.apply_damage(conn, mech_id, location, rear=False, amount=total_damage)
    if matched:
        for _ in range(shots_remaining):
            mechs.use_ammo(matched["id"])
    if mech["pilot_id"] is not None:
        pilots.add_pilot_hits(mech["pilot_id"], 2)

    return {
        "mech_id": mech_id, "location": location, "slot_index": slot_index,
        "damage": total_damage, "damage_result": damage_result,
    }


def explode_ammo_by_weapon(mech_id: int, mech_weapon_id: int) -> dict:
    """The Heat Scale's own ammo-explosion check (turns.py's
    resolve_heat_phase) picks a mounted weapon's ammo bin to explode by
    Damage Value, not a specific critical slot — unlike explode_ammo
    above, no location is known to apply the damage to (a hand-built
    mech's ammo isn't even represented as a critical slot at all, see
    critical_layout.py), so this applies the destroyed structure damage
    to the center torso as the "most interior" simplification, and still
    zeroes the weapon's ammo + wounds the pilot for real."""
    mech = mechs.get_mech(mech_id)
    if mech is None:
        return {"mech_id": mech_id, "damage": 0}
    weapon = next((w for w in mech["weapons"] if w["id"] == mech_weapon_id), None)
    shots_remaining = weapon["ammo_remaining"] if weapon else 0
    per_shot_damage = weapons.get_weapon(weapon["weapon_name"])["damage"] if weapon else 0
    total_damage = (shots_remaining or 0) * per_shot_damage

    damage_result = None
    if total_damage:
        with db.connect() as conn:
            damage_result = mechs.apply_damage(conn, mech_id, "CT", rear=False, amount=total_damage)
    if weapon:
        for _ in range(shots_remaining or 0):
            mechs.use_ammo(weapon["id"])
    if mech["pilot_id"] is not None:
        pilots.add_pilot_hits(mech["pilot_id"], 2)

    return {"mech_id": mech_id, "mech_weapon_id": mech_weapon_id, "damage": total_damage, "damage_result": damage_result}
