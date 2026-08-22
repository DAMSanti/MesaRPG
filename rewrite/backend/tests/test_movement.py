from app import maps, mechs, pilots, units
from app.systems.battletech import movement
from tests.conftest import ATLAS_LOCATIONS


def _mech(campaign_id, pilot_id=None, walk_mp=4, run_mp=6, jump_mp=0):
    return mechs.create_mech(
        campaign_id=campaign_id,
        chassis="Locust",
        model="LCT-1V",
        tonnage=20,
        walk_mp=walk_mp,
        run_mp=run_mp,
        jump_mp=jump_mp,
        pilot_id=pilot_id,
        locations=ATLAS_LOCATIONS,
    )


def test_reachable_hexes_respects_walk_mp_budget(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) in reachable, "2 hexes of plains (cost 1 each) should be within walk_mp=2"
    assert (3, 0) not in reachable, "3 hexes of plains exceeds walk_mp=2"


def test_forest_cost_cuts_reach_compared_to_plains(campaign, pilot):
    m = maps.create_map(campaign["id"], "Woods", width=10, height=6)
    maps.update_tile(m["id"], 1, 0, terrain="forest")
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (1, 0) in reachable, "the forest hex itself costs 2, exactly the whole budget"
    assert (2, 0) not in reachable, "forest (cost 2) + one more plains hex exceeds walk_mp=2"


def test_run_reaches_farther_than_walk(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2, run_mp=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    walk = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    run = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "run")}
    assert (4, 0) in run
    assert (4, 0) not in walk
    assert walk < run


def test_road_is_flat_cost_regardless_of_elevation(campaign, pilot):
    m = maps.create_map(campaign["id"], "Highway", width=10, height=6, elevations={(1, 0): 3})
    maps.update_tile(m["id"], 1, 0, terrain="road")
    mech = _mech(campaign["id"], pilot["id"], walk_mp=1)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (1, 0) in reachable, "road ignores the elevation-climb surcharge, stays a flat cost of 1"


def test_elevation_climb_adds_extra_cost(campaign, pilot):
    m = maps.create_map(campaign["id"], "Hill", width=10, height=6, elevations={(1, 0): 3})
    mech = _mech(campaign["id"], pilot["id"], walk_mp=1)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (1, 0) not in reachable, "plains (1) + climbing 3 levels (+3) = 4 MP, over the walk_mp=1 budget"


def test_cannot_end_movement_on_an_occupied_hex(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    other_mech = _mech(campaign["id"], pilot["id"])
    units.create_unit(campaign["id"], m["id"], q=1, r=0, mech_id=other_mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (1, 0) not in reachable


def test_cannot_pass_through_an_enemy_occupied_hex(campaign, pilot):
    m = maps.create_map(campaign["id"], "Corridor", width=10, height=1)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"])
    units.create_unit(campaign["id"], m["id"], q=1, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) not in reachable, "the enemy at (1,0) blocks the only path further down the corridor"


def test_jump_ignores_terrain_but_respects_distance(campaign, pilot):
    m = maps.create_map(campaign["id"], "Woods", width=10, height=6)
    maps.update_tile(m["id"], 1, 0, terrain="forest")
    mech = _mech(campaign["id"], pilot["id"], walk_mp=1, jump_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "jump")}
    assert (2, 0) in reachable, "jumping ignores the forest's terrain cost entirely"
    assert (3, 0) not in reachable, "but still can't exceed jump_mp as a hex-distance budget"


def test_reachable_hexes_from_unknown_unit_is_none():
    assert movement.reachable_hexes(999999, "walk") is None


def test_reachable_hexes_with_no_mech_is_empty(campaign):
    m = maps.create_map(campaign["id"], "Empty", width=4, height=4)
    ghost = units.create_unit(campaign["id"], m["id"], q=0, r=0, is_ghost=True)
    assert movement.reachable_hexes(ghost["id"], "walk") == []


def test_execute_move_rejects_an_unreachable_destination(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=1)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    try:
        movement.execute_move(campaign["id"], unit["id"], 5, 0, "walk")
        assert False, "should have raised"
    except movement.UnreachableDestination:
        pass


def test_execute_move_faces_the_direction_of_travel(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    # Starts facing 180° (away from +q) — turning around to face 0° costs
    # 3 MP (3 hexsides either way) plus 2 MP to walk the 2 hexes, so the
    # budget needs to cover both, not just the walk itself.
    mech = _mech(campaign["id"], pilot["id"], walk_mp=5)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=180)

    updated = movement.execute_move(campaign["id"], unit["id"], 2, 0, "walk")
    assert updated["q"] == 2
    assert updated["r"] == 0
    assert updated["facing_deg"] == 0, "moved due +q (world +X) — should now face 0 degrees, not its old 180"


def test_turning_around_costs_extra_mp_beyond_the_walk_itself(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    # Same trip as above, but with only enough MP for the 2 hexes of
    # walking and none left over for the 3 MP of turning around first —
    # should be unreachable, unlike the old turn-is-free model.
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=180)

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) not in reachable


def test_facing_picker_can_request_a_pricier_facing_within_budget(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    # Enough MP to walk 2 hexes (facing 0° already, cheapest) plus turn
    # one extra hexside (1 MP) to end facing 60° instead.
    mech = _mech(campaign["id"], pilot["id"], walk_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=0)

    updated = movement.execute_move(campaign["id"], unit["id"], 2, 0, "walk", facing_deg=60)
    assert updated["facing_deg"] == 60


def test_facing_picker_rejects_a_facing_that_exceeds_the_budget(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    # Exactly enough to walk 2 hexes facing 0° — no MP left to also turn
    # to 180° (3 more MP) once there.
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=0)

    try:
        movement.execute_move(campaign["id"], unit["id"], 2, 0, "walk", facing_deg=180)
        assert False, "should have raised"
    except movement.UnreachableDestination:
        pass


def test_execute_move_records_a_bt_round_moves_row(campaign, pilot):
    m = maps.create_map(campaign["id"], "Woods", width=10, height=6)
    maps.update_tile(m["id"], 1, 0, terrain="forest")
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    movement.execute_move(campaign["id"], unit["id"], 1, 0, "walk")

    from app import db
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM bt_round_moves WHERE campaign_id = ? AND pilot_id = ?",
            (campaign["id"], pilot["id"]),
        ).fetchone()
    assert row["unit_id"] == unit["id"]
    assert row["movement_type"] == "walk"
    assert row["hexes_moved"] == 1
    assert row["mp_spent"] == 2


def test_reachable_hexes_path_is_the_real_route_not_just_the_destination(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    by_hex = {(h["q"], h["r"]): h for h in movement.reachable_hexes(unit["id"], "walk")}
    entry = by_hex[(2, 0)]
    assert entry["path"] == [{"q": 1, "r": 0}, {"q": 2, "r": 0}], "every hex actually stepped through, in order"
    assert len(entry["path"]) == entry["hexes"]


def test_reachable_hexes_facings_only_lists_affordable_turns(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    # facing_deg=0 already points straight at (2, 0) (the direction of
    # travel) — 2 MP for the walk itself, 1 MP left over affords a single
    # hexside of turn either way, but not the 2+ MP a sharper turn needs.
    mech = _mech(campaign["id"], pilot["id"], walk_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=0)

    by_hex = {(h["q"], h["r"]): h for h in movement.reachable_hexes(unit["id"], "walk")}
    assert set(by_hex[(2, 0)]["facings"]) == {0, 60, 300}


def test_reachable_hexes_facings_include_every_direction_with_enough_leftover_mp(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=5)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=0)

    by_hex = {(h["q"], h["r"]): h for h in movement.reachable_hexes(unit["id"], "walk")}
    # 2 MP to walk there + 3 leftover — enough to turn all the way around
    # (max distance between any two of the 6 hex facings is 3 steps).
    assert set(by_hex[(2, 0)]["facings"]) == {0, 60, 120, 180, 240, 300}


def test_jump_reachable_hexes_allow_every_facing_for_free(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], jump_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"], facing_deg=0)

    by_hex = {(h["q"], h["r"]): h for h in movement.reachable_hexes(unit["id"], "jump")}
    assert set(by_hex[(2, 0)]["facings"]) == {0, 60, 120, 180, 240, 300}
    assert by_hex[(2, 0)]["path"] == [{"q": 2, "r": 0}]


# ---- heat generated by movement --------------------------------------


def test_walking_generates_one_heat(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    movement.execute_move(campaign["id"], unit["id"], 1, 0, "walk")
    assert mechs.get_mech(mech["id"])["heat_current"] == 1


def test_running_generates_two_heat(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=2, run_mp=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    movement.execute_move(campaign["id"], unit["id"], 1, 0, "run")
    assert mechs.get_mech(mech["id"])["heat_current"] == 2


def test_jumping_a_short_hop_still_generates_the_three_heat_minimum(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], jump_mp=2)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    movement.execute_move(campaign["id"], unit["id"], 1, 0, "jump")
    assert mechs.get_mech(mech["id"])["heat_current"] == 3, "1 hex jumped, but the Heat Scale floors jump heat at 3"


def test_jumping_a_long_hop_generates_one_heat_per_hex(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], jump_mp=5)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])

    movement.execute_move(campaign["id"], unit["id"], 5, 0, "jump")
    assert mechs.get_mech(mech["id"])["heat_current"] == 5


# ---- heat reducing available MP ---------------------------------------


def test_heat_above_five_cuts_one_mp_off_the_walk_budget(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.add_heat(mech["id"], 5)

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) in reachable, "3 walk_mp - 1 heat penalty = 2 MP still reaches 2 hexes of plains"
    assert (3, 0) not in reachable


def test_heat_penalty_also_shrinks_the_jump_budget(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], jump_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.add_heat(mech["id"], 10)

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "jump")}
    assert (1, 0) in reachable, "3 jump_mp - 2 heat penalty (heat 10-14) = 1 MP"
    assert (2, 0) not in reachable


# ---- leg actuator / hip damage reducing MP -----------------------------


def test_hip_actuator_destroyed_halves_walk_mp(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.ensure_default_criticals(mech["id"])
    mechs.set_critical_hit(mech["id"], "LL", 0, True)  # Hip is always slot 0

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) in reachable, "4 walk_mp halved by the hip hit = 2 MP"
    assert (3, 0) not in reachable


def test_both_hips_destroyed_is_not_worse_than_one(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.ensure_default_criticals(mech["id"])
    mechs.set_critical_hit(mech["id"], "LL", 0, True)
    mechs.set_critical_hit(mech["id"], "RL", 0, True)

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) in reachable, "a second hip hit doesn't stack any further reduction"


def test_leg_actuator_destroyed_costs_one_mp_each(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.ensure_default_criticals(mech["id"])
    mechs.set_critical_hit(mech["id"], "LL", 1, True)  # Upper Leg Actuator
    mechs.set_critical_hit(mech["id"], "RL", 3, True)  # Foot Actuator, other leg — cumulative

    reachable = {(h["q"], h["r"]) for h in movement.reachable_hexes(unit["id"], "walk")}
    assert (2, 0) in reachable, "4 walk_mp - 2 actuator hits = 2 MP"
    assert (3, 0) not in reachable


def test_destroyed_leg_makes_the_mech_immobile(campaign, pilot):
    m = maps.create_map(campaign["id"], "Flat", width=10, height=6)
    mech = _mech(campaign["id"], pilot["id"], walk_mp=4, run_mp=6, jump_mp=3)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    mechs.update_location(mech["id"], "LL", structure_current=0)

    assert movement.reachable_hexes(unit["id"], "walk") == []
    assert movement.reachable_hexes(unit["id"], "run") == []
    assert movement.reachable_hexes(unit["id"], "jump") == []
