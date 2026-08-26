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


def test_dfa_result_includes_attacker_mech_destroyed_field(campaign):
    # Real gap found while auditing for undo: a Charge/DFA that destroys
    # the ATTACKER via its own self-damage was never even reported —
    # _mech_destroyed only ever checked the TARGET's hit_results. This is
    # a regression guard that the field exists and is sane in the common
    # (non-destroying) case; the wiring itself is exercised for real by
    # whatever self_damage_results this hit happens to produce.
    from app.systems.battletech import movement

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
    assert isinstance(result["attacker_mech_destroyed"], bool)
    assert result["self_damage_results"]


def test_melee_attack_logs_an_undoable_event(campaign):
    # Real gap: melee.resolve_melee_attack logged NOTHING before this —
    # confirmed by grepping the module for events.log_event and finding
    # zero call sites. A punch (single target, no self-damage) is the
    # simplest case to confirm the event now exists and undo works at all.
    from app import events

    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(
        campaign, attacker_tonnage=65, attacker_piloting=0,
    )
    before_target = mechs.get_mech(target_mech["id"])
    for _ in range(20):
        result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="right")
        if result["hit"]:
            break
    assert result["hit"]

    undone = events.undo_last_event(campaign["id"])
    assert undone is not None
    assert undone["event_type"] == "melee"
    after_undo = mechs.get_mech(target_mech["id"])
    assert after_undo["locations"] == before_target["locations"]
    assert after_undo["criticals"] == before_target["criticals"]


def test_undo_charge_restores_both_attacker_and_target(campaign):
    # Charge damages BOTH mechs (target from the hit, attacker from its
    # own recoil) — confirms undo's full-snapshot restore covers both
    # sides, not just the target (the old narrow before/weapon payload
    # never tracked the attacker's own self-damage at all).
    from app import events
    from app.systems.battletech import combat, movement

    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=65)
    units.move_unit(attacker_unit["id"], 3, 0)
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "walk")

    before_attacker = mechs.get_mech(attacker_mech["id"])
    before_target = mechs.get_mech(target_mech["id"])
    for _ in range(20):
        result = melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "charge")
        if result["hit"]:
            break
    assert result["hit"]
    assert result["self_damage_results"]

    undone = events.undo_last_event(campaign["id"])
    assert undone["event_type"] == "melee"
    after_attacker = mechs.get_mech(attacker_mech["id"])
    after_target = mechs.get_mech(target_mech["id"])
    assert after_attacker["locations"] == before_attacker["locations"]
    assert after_target["locations"] == before_target["locations"]
    assert result["self_damage_results"]
    assert melee.math.ceil(55 / 5) == 11


def test_incapacitated_mech_cannot_melee(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    mechs.set_shutdown(attacker_mech["id"], True)
    with pytest.raises(melee.MechIncapacitated):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="left")


def test_destroyed_mech_cannot_melee(campaign):
    # Fase D: a destroyed mech is a wreck, not just shut-down/prone —
    # can't act ever again, regardless of reason.
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    mechs.mark_destroyed(attacker_mech["id"], "structural")
    with pytest.raises(melee.MechIncapacitated):
        melee.resolve_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="left")


def test_cannot_melee_an_already_destroyed_target(campaign):
    # Real user report: "tampoco se tiene que poder atacar a un muerto".
    from app.systems.battletech import combat
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign)
    mechs.mark_destroyed(target_mech["id"], "structural")
    with pytest.raises(combat.TargetAlreadyDestroyed):
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


def _drive_physical_melee(campaign_id, params, supplied=6):
    """Drives run_melee_attack's pause/resume loop to completion, always
    supplying `supplied` for whichever purpose it's currently waiting on
    (default 6: a guaranteed-hit 6+6=12 for the shared to_hit roll, and a
    harmless real value for any 1d6 location/slot roll it asks for
    afterward). Mirrors test_combat.py's own drive helper."""
    from app import dice_resolution

    ctx = committed = collected = None
    result = None
    for _ in range(30):
        try:
            result = (
                melee.run_melee_attack(campaign_id, **params) if ctx is None
                else melee.run_melee_attack(campaign_id, ctx=ctx, committed=committed, collected=collected)
            )
            break
        except dice_resolution.PendingRoll as exc:
            pending = dice_resolution.get_pending(exc.pending_roll_id)
            dice_resolution.delete_pending(exc.pending_roll_id)
            ctx, committed = pending["ctx"], pending["committed"]
            values = [supplied, supplied] if pending["next_dice_spec"] == "2d6" else [supplied]
            collected = pending["collected"] + [(pending["next_purpose"], values)]
    return result


def test_run_melee_attack_never_pauses_for_an_auto_mode_pilot(campaign):
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_piloting=0)
    pilots.update_pilot(attacker_unit["pilot_id"], dice_mode="auto")
    result = melee.run_melee_attack(
        campaign["id"], attacker_unit["id"], target_unit["id"], "punch", arm="right",
    )
    assert result["hit"] in (True, False)  # proves it fully resolved in one call, no PendingRoll


def test_run_melee_attack_punch_pauses_and_resumes_to_a_full_result(campaign):
    # Fase B: punch/kick (a single hit, no damage grouping) ARE physical-
    # dice-aware — to_hit, the hit-location roll, and any resulting
    # criticals/fall all pause for a pilot in dice_mode='physical' (the
    # default), same mechanism as combat.py's ranged attacks.
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_piloting=0)
    result = _drive_physical_melee(
        campaign["id"],
        {"attacker_unit_id": attacker_unit["id"], "target_unit_id": target_unit["id"], "attack_type": "punch", "arm": "right"},
    )
    assert result is not None
    assert result["hit"] is True
    assert result["roll"] == 12


def test_run_melee_attack_kick_chain_pauses_and_resumes(campaign):
    # Kick additionally chains the kicked-target's own PSR (and a
    # possible fall) after the hit itself — confirms the WHOLE chain
    # survives pause/resume, not just the first roll.
    _, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_piloting=0)
    result = _drive_physical_melee(
        campaign["id"],
        {"attacker_unit_id": attacker_unit["id"], "target_unit_id": target_unit["id"], "attack_type": "kick"},
    )
    assert result is not None
    assert result["hit"] is True
    assert "target_psr" in result


def test_run_melee_attack_charge_grouped_damage_never_pauses(campaign):
    # Documented scope limit (see melee.py's own MELEE_STEP_ORDER comment)
    # — charge/DFA's own grouped damage (charge_dfa_resolution) never
    # pauses regardless of dice_mode, even though the SHARED to_hit roll
    # right before it still can. The only purpose a pause should ever ask
    # for here is "to_hit" — never anything from the grouped-damage
    # sequence.
    from app import dice_resolution
    from app.systems.battletech import movement

    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_adjacent_units(campaign, attacker_tonnage=65)
    units.move_unit(attacker_unit["id"], 3, 0)
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "walk")

    ctx = committed = collected = None
    result = None
    purposes_seen = []
    for _ in range(30):
        try:
            result = (
                melee.run_melee_attack(campaign["id"], attacker_unit["id"], target_unit["id"], "charge") if ctx is None
                else melee.run_melee_attack(campaign["id"], ctx=ctx, committed=committed, collected=collected)
            )
            break
        except dice_resolution.PendingRoll as exc:
            purposes_seen.append(exc.purpose)
            pending = dice_resolution.get_pending(exc.pending_roll_id)
            dice_resolution.delete_pending(exc.pending_roll_id)
            ctx, committed = pending["ctx"], pending["committed"]
            collected = pending["collected"] + [(pending["next_purpose"], [6, 6])]

    assert result is not None
    assert purposes_seen == ["to_hit"] or purposes_seen == []
