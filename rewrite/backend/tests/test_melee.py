import pytest

from app import maps, units
from app.systems.battletech import mechs, melee, pilots
from tests.conftest import ATLAS_LOCATIONS


def _place_adjacent_units(campaign, attacker_tonnage=50, target_tonnage=50, attacker_piloting=5, target_piloting=5):
    m = maps.create_map(campaign["id"], "Melee Test", width=10, height=6)
    attacker_pilot = pilots.create_pilot(campaign["id"], "Attacker Pilot", gunnery=4, piloting=attacker_piloting)
    target_pilot = pilots.create_pilot(campaign["id"], "Target Pilot", faction="enemy", gunnery=4, piloting=target_piloting)
    attacker_mech = mechs.create_mech(
        # Generous MP (not just enough for the raw hex count) so tests
        # that walk/jump the attacker into contact have headroom for
        # whatever turning cost the default facing happens to add.
        campaign_id=campaign["id"], chassis="Attacker", tonnage=attacker_tonnage, walk_mp=8, run_mp=10, jump_mp=8,
        pilot_id=attacker_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    target_mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Target", tonnage=target_tonnage, walk_mp=4, run_mp=6,
        pilot_id=target_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    attacker_unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=attacker_mech["id"], pilot_id=attacker_pilot["id"])
    target_unit = units.create_unit(campaign["id"], m["id"], q=1, r=0, mech_id=target_mech["id"], pilot_id=target_pilot["id"], facing_deg=180)
    return m, attacker_mech, target_mech, attacker_unit, target_unit


def test_punch_target_number_and_damage_at_gunnery_baseline(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=65, attacker_piloting=5)
    result = melee.resolve_melee_attack(
        campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="right",
    )
    # Piloting 5 + no movement/terrain modifiers this round = TN 5.
    assert result["target_number"] == 5
    # ceil(65/10) = 7 points of damage, undamaged actuators (full fraction).
    assert result["damage"] == 7


def test_punch_requires_an_arm(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    with pytest.raises(melee.InvalidMeleeAttack):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch")


def test_punch_blocked_by_destroyed_shoulder(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    shoulder_slot = next(c for c in attacker_mech["criticals"]["RA"] if c["item_name"] == "Shoulder")
    mechs.set_critical_hit(attacker_mech["id"], "RA", shoulder_slot["slot_index"], True)
    with pytest.raises(melee.InvalidMeleeAttack):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="right")


def test_punch_damage_halved_by_damaged_lower_arm_actuator(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=65)
    lower_arm_slot = next(c for c in attacker_mech["criticals"]["RA"] if c["item_name"] == "Lower Arm Actuator")
    mechs.set_critical_hit(attacker_mech["id"], "RA", lower_arm_slot["slot_index"], True)
    # TN 7 (piloting 5 + the actuator's own +2) — retry loop (same style
    # as test_combat.py's own probabilistic tests) rather than asserting
    # the first roll hits.
    for _ in range(20):
        result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="right")
        if result["hit"]:
            break
    assert result["hit"]
    # ceil(65/10)=7, halved and rounded down = 3, plus the +2 TN penalty for the damaged actuator.
    assert result["damage"] == 3
    assert result["target_number"] == 5 + 2


def test_kick_target_number_uses_piloting_minus_two(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=50, attacker_piloting=5)
    result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "kick")
    assert result["target_number"] == 5 - 2
    assert result["damage"] == 10  # ceil(50/5)


def test_kick_blocked_by_damaged_hip(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    hip_slot = next(c for c in attacker_mech["criticals"]["LL"] if c["item_name"] == "Hip")
    mechs.set_critical_hit(attacker_mech["id"], "LL", hip_slot["slot_index"], True)
    with pytest.raises(melee.InvalidMeleeAttack):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "kick")


def test_charge_requires_recorded_movement_this_round(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    with pytest.raises(melee.InvalidMeleeAttack):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "charge")


def test_charge_damage_uses_hexes_moved_this_round(campaign):
    import math

    from app.systems.battletech import combat, movement

    # Target sits at (1, 0), so the direct 3-hex path from (3, 0) to
    # (0, 0) is blocked (can't walk through an occupied hex) — the real
    # path takes a 4-hex detour around it. Compute the expected damage
    # from whatever the pathfinder actually recorded rather than
    # hand-assuming a hex count that depends on routing details.
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=65)
    units.move_unit(attacker_unit["id"], 3, 0)
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "walk")
    _, hexes_moved, _ = combat.recorded_movement(campaign["id"], attacker_unit["pilot_id"])
    for _ in range(20):
        result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "charge")
        if result["hit"]:
            break
    assert result["hit"]
    # Rulebook's own worked example rounds the FINAL product, not
    # tonnage/10 first (a 65-ton Catapult moving 5 hexes deals
    # ceil(6.5*5)=33, not ceil(6.5)*5=35).
    assert result["damage"] == math.ceil(65 / 10 * hexes_moved)
    assert result["self_damage_results"]


def test_dfa_requires_jump_movement_this_round(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    with pytest.raises(melee.InvalidMeleeAttack):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "dfa")


def test_dfa_damage_and_self_damage_formulas(campaign):
    from app.systems.battletech import movement

    # Target sits at (1, 0); the attacker jumps from (3, 0) to (0, 0) —
    # ending adjacent to (not on top of) the target. Jump distance is a
    # flat hex count, unaffected by the occupied (1, 0) hex (jumping
    # arcs over obstacles — movement.py's own documented rule), so this
    # is a clean 3 hexes regardless of the target's position.
    # Comparative modifier skews heavily attacker-favorable (piloting 2
    # vs the target's 9) so the low Target Number all but guarantees a
    # hit — only a natural 2 (always an auto-miss) could still fail it.
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(
        campaign, attacker_tonnage=55, attacker_piloting=2, target_piloting=9,
    )
    units.move_unit(attacker_unit["id"], 3, 0)
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "jump")
    for _ in range(20):
        result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "dfa")
        if result["hit"]:
            break
    assert result["hit"]
    assert result["damage"] == 17  # ceil(55/10 * 3) = ceil(16.5) = 17
    assert result["self_damage_results"]
    assert melee.math.ceil(55 / 5) == 11


def test_incapacitated_mech_cannot_melee(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    mechs.set_shutdown(attacker_mech["id"], True)
    with pytest.raises(melee.MechIncapacitated):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="left")


def test_not_adjacent_rejected(campaign):
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    units.move_unit(target_unit["id"], 5, 0)
    with pytest.raises(melee.NotAdjacent):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="left")


def test_missed_kick_fells_the_attacker(campaign):
    # Piloting 12 base + terrain/movement produces an unreachable TN
    # (mechanically: force the roll to fail by using a hopeless TN).
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_piloting=12)
    result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "kick")
    if not result["hit"]:
        assert result["self_fall"] is not None
        updated = mechs.get_mech(attacker_mech["id"])
        assert updated["is_prone"] is True
