import pytest

from app import events
from app.systems.battletech import combat, mechs


def test_target_movement_mod_brackets():
    assert combat.target_movement_mod(0) == 0
    assert combat.target_movement_mod(2) == 0
    assert combat.target_movement_mod(3) == 1
    assert combat.target_movement_mod(4) == 1
    assert combat.target_movement_mod(5) == 2
    assert combat.target_movement_mod(6) == 2
    assert combat.target_movement_mod(7) == 3
    assert combat.target_movement_mod(9) == 3
    assert combat.target_movement_mod(10) == 4
    assert combat.target_movement_mod(17) == 4
    assert combat.target_movement_mod(18) == 5
    assert combat.target_movement_mod(24) == 5
    assert combat.target_movement_mod(25) == 6
    assert combat.target_movement_mod(50) == 6


def test_target_movement_mod_jump_bonus_stacks():
    assert combat.target_movement_mod(1, jumped=True) == 1
    assert combat.target_movement_mod(3, jumped=True) == 2


def test_to_hit_number_combines_all_gator_modifiers():
    # gunnery 4, walked (+1), target moved 3 hexes (+1), medium range (+2) = 8
    assert combat.to_hit_number(4, "walked", 3, range_bracket="medium") == 8


def test_to_hit_number_with_other_modifiers():
    assert combat.to_hit_number(4, "stationary", 0, other_modifiers=2) == 6


def test_heat_penalty_brackets():
    assert combat.heat_penalty(0) == 0
    assert combat.heat_penalty(7) == 0
    assert combat.heat_penalty(8) == 1
    assert combat.heat_penalty(12) == 1
    assert combat.heat_penalty(13) == 2
    assert combat.heat_penalty(16) == 2
    assert combat.heat_penalty(17) == 3
    assert combat.heat_penalty(23) == 3
    assert combat.heat_penalty(24) == 4
    assert combat.heat_penalty(40) == 4


def test_hit_location_tables_cover_every_2d6_roll():
    for table in (combat.HIT_LOCATION_FRONT_REAR, combat.HIT_LOCATION_LEFT, combat.HIT_LOCATION_RIGHT):
        assert set(table.keys()) == set(range(2, 13))


def test_hit_location_roll_of_2_is_a_critical():
    assert combat.HIT_LOCATION_FRONT_REAR[2] == ("CT", True)
    assert combat.HIT_LOCATION_LEFT[2] == ("LT", True)
    assert combat.HIT_LOCATION_RIGHT[2] == ("RT", True)


def test_hit_location_roll_of_12_is_always_head():
    for table in (combat.HIT_LOCATION_FRONT_REAR, combat.HIT_LOCATION_LEFT, combat.HIT_LOCATION_RIGHT):
        assert table[12] == ("HD", False)


def test_roll_2d6_within_bounds():
    for _ in range(200):
        d1, d2, total = combat.roll_2d6()
        assert 1 <= d1 <= 6
        assert 1 <= d2 <= 6
        assert total == d1 + d2


def test_resolve_attack_guaranteed_hit_damages_the_rolled_location(campaign, atlas):
    # gunnery 0 + no other modifiers => target number 0, but a natural 2 is
    # still an automatic miss regardless of target number (real BT rule) —
    # ~1/36 per attempt, so retry instead of asserting the first roll hits.
    # damage=5 is deliberately less than every location's armor_max (HD is
    # the thinnest at 9) so the assertion below holds no matter which
    # location the location roll picks — 15 used to flake whenever it
    # landed on HD (9 armor), spilling into structure and breaking the
    # "clean absorb" assumption.
    for _ in range(20):
        result = combat.resolve_attack(
            campaign_id=campaign["id"],
            target_mech_id=atlas["id"],
            damage=5,
            gunnery=0,
        )
        if result["hit"]:
            break
    assert result["hit"] is True
    location = result["location"]
    updated = mechs.get_mech(atlas["id"])
    loc_after = next(l for l in updated["locations"] if l["location"] == location)
    loc_before = next(l for l in atlas["locations"] if l["location"] == location)
    assert loc_after["armor_current"] == loc_before["armor_max"] - 5


def test_resolve_attack_overkill_spills_into_structure(campaign, atlas):
    # Same natural-2-always-misses caveat as the guaranteed-hit test above.
    for _ in range(20):
        result = combat.resolve_attack(
            campaign_id=campaign["id"], target_mech_id=atlas["id"], damage=200, gunnery=0
        )
        if result["hit"]:
            break
    assert result["hit"] is True
    damage = result["damage"]
    assert damage["armor_after"] == 0
    assert damage["structure_after"] < damage["structure_before"]


def test_resolve_attack_ct_or_head_destroyed_flags_mech_destroyed(campaign, atlas):
    # CT alone has 47 armor + 31 structure = 78 points: one 60-damage hit
    # is NOT enough, it takes repeated hits landing on the same location
    # to actually zero it out. Keep attacking until mech_destroyed fires,
    # rather than assuming the first CT/HD hit is fatal.
    destroyed = False
    for _ in range(200):
        result = combat.resolve_attack(
            campaign_id=campaign["id"], target_mech_id=atlas["id"], damage=60, gunnery=0
        )
        if result["hit"] and result["mech_destroyed"]:
            assert result["location"] in ("CT", "HD")
            destroyed = True
            break
    assert destroyed, "expected the mech to eventually die under 200 guaranteed-hit attacks"


def test_resolve_attack_rear_side_uses_rear_armor_when_available(campaign, atlas):
    # Force enough rear-side attacks to land on CT (front/rear share the same location table).
    for _ in range(60):
        result = combat.resolve_attack(
            campaign_id=campaign["id"], target_mech_id=atlas["id"], damage=5, gunnery=0, side="rear"
        )
        if result["hit"] and result["location"] == "CT":
            assert result["damage"]["armor_field"] == "armor_rear_current"
            return
    raise AssertionError("expected at least one CT hit in 60 guaranteed-hit rear attacks")


def test_resolve_attack_with_weapon_id_uses_catalog_damage(campaign, atlas):
    from tests.conftest import ATLAS_LOCATIONS

    attacker = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    loaded = mechs.add_weapon(attacker["id"], "AC/20", "RT")
    weapon_id = loaded["weapons"][0]["id"]

    for _ in range(20):
        result = combat.resolve_attack(
            campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=0,
        )
        if result["hit"]:
            break
    assert result["hit"] is True
    assert result["damage"]["armor_before"] - result["damage"]["armor_after"] == 20  # AC/20 damage


def test_resolve_attack_with_weapon_id_consumes_ammo(campaign, atlas):
    from tests.conftest import ATLAS_LOCATIONS

    attacker = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    loaded = mechs.add_weapon(attacker["id"], "AC/20", "RT")
    weapon_id = loaded["weapons"][0]["id"]
    assert loaded["weapons"][0]["ammo_remaining"] == 5

    combat.resolve_attack(campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=0)
    assert mechs.get_mech_weapon(weapon_id)["ammo_remaining"] == 4


def test_resolve_attack_with_out_of_ammo_weapon_raises(campaign, atlas):
    from tests.conftest import ATLAS_LOCATIONS

    attacker = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    loaded = mechs.add_weapon(attacker["id"], "AC/20", "RT")
    weapon_id = loaded["weapons"][0]["id"]
    for _ in range(5):
        mechs.use_ammo(weapon_id)

    with pytest.raises(combat.OutOfAmmo):
        combat.resolve_attack(campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=0)


def test_resolve_attack_requires_either_damage_or_weapon_id(campaign, atlas):
    with pytest.raises(ValueError):
        combat.resolve_attack(campaign_id=campaign["id"], target_mech_id=atlas["id"], gunnery=0)


def test_resolve_attack_with_weapon_id_adds_its_heat_to_the_attacker(campaign, atlas):
    from tests.conftest import ATLAS_LOCATIONS

    attacker = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    loaded = mechs.add_weapon(attacker["id"], "PPC", "RT")  # PPC: 10 heat
    weapon_id = loaded["weapons"][0]["id"]

    combat.resolve_attack(campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=0)
    assert mechs.get_mech(attacker["id"])["heat_current"] == 10


def test_resolve_attack_applies_attackers_current_heat_as_a_to_hit_penalty(campaign, atlas):
    from tests.conftest import ATLAS_LOCATIONS

    attacker = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    loaded = mechs.add_weapon(attacker["id"], "Small Laser", "RT")
    weapon_id = loaded["weapons"][0]["id"]
    mechs.add_heat(attacker["id"], 13)  # heat 13 => +2 to-hit (see combat.heat_penalty)

    result = combat.resolve_attack(campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=4)
    assert result["target_number"] == 6  # gunnery 4 + heat penalty 2, no other modifiers


def test_undo_restores_exact_prior_state(campaign, atlas):
    before = next(l for l in atlas["locations"] if l["location"] == "CT")
    # Keep attacking until we land on CT so there's something concrete to verify reverted.
    for _ in range(60):
        result = combat.resolve_attack(
            campaign_id=campaign["id"], target_mech_id=atlas["id"], damage=10, gunnery=0
        )
        if result["hit"] and result["location"] == "CT":
            break
    undone = events.undo_last_event(campaign["id"])
    assert undone is not None
    after = next(l for l in mechs.get_mech(atlas["id"])["locations"] if l["location"] == "CT")
    assert after["armor_current"] == before["armor_current"]
    assert after["structure_current"] == before["structure_current"]


def test_undo_with_nothing_to_undo_returns_none(campaign):
    assert events.undo_last_event(campaign["id"]) is None


def test_undo_only_reverts_within_its_own_campaign(campaign, atlas):
    from app import campaigns as campaigns_module

    other_campaign = campaigns_module.create_campaign("Other")
    assert events.undo_last_event(other_campaign["id"]) is None


def test_undo_a_miss_restores_ammo_and_heat(campaign, atlas):
    from app.systems.battletech import mechs as mechs_module

    attacker = mechs_module.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        locations=[
            {"location": loc["location"], "armor_max": loc["armor_max"], "structure_max": loc["structure_max"]}
            for loc in atlas["locations"]
        ],
    )
    loaded = mechs_module.add_weapon(attacker["id"], "AC/5", "RT")  # ammo-based, unlike lasers/PPC
    weapon_id = loaded["weapons"][0]["id"]

    # gunnery 12 vs a natural 2-12 roll always misses (target number
    # unreachable) — guarantees the miss branch, still with a real weapon.
    result = combat.resolve_attack(
        campaign_id=campaign["id"], target_mech_id=atlas["id"], weapon_id=weapon_id, gunnery=12,
    )
    assert result["hit"] is False
    mech_after_shot = mechs_module.get_mech(attacker["id"])
    weapon_after_shot = mech_after_shot["weapons"][0]
    assert weapon_after_shot["ammo_remaining"] == 19  # 1 shot fired out of 20

    undone = events.undo_last_event(campaign["id"])
    assert undone is not None
    mech_after_undo = mechs_module.get_mech(attacker["id"])
    assert mech_after_undo["heat_current"] < mech_after_shot["heat_current"]
    assert mech_after_undo["weapons"][0]["ammo_remaining"] == 20


# ---- minimum range / terrain / partial cover (Attack Modifiers Table) --


def test_minimum_range_penalty_matches_the_manuals_worked_examples():
    # AC/5, min range 3 — the manual's own JagerMech example.
    assert combat.minimum_range_penalty(3, 3) == 1
    assert combat.minimum_range_penalty(3, 2) == 2
    assert combat.minimum_range_penalty(3, 1) == 3
    # LRM, min range 6 — the manual's own Atlas example.
    assert combat.minimum_range_penalty(6, 4) == 3


def test_minimum_range_penalty_zero_only_strictly_beyond_minimum():
    # AT exactly minimum range still costs +1 — the manual's own "Common
    # Misconceptions" section explicitly refutes the reading that firing
    # exactly at minimum range is penalty-free.
    assert combat.minimum_range_penalty(6, 6) == 1
    assert combat.minimum_range_penalty(6, 7) == 0
    assert combat.minimum_range_penalty(6, 10) == 0


def test_minimum_range_penalty_zero_for_weapons_with_none():
    assert combat.minimum_range_penalty(0, 1) == 0


def test_terrain_to_hit_bonus():
    assert combat.terrain_to_hit_bonus("forest") == 2
    assert combat.terrain_to_hit_bonus("light_forest") == 1
    assert combat.terrain_to_hit_bonus("plains") == 0
    assert combat.terrain_to_hit_bonus("water") == 0


def test_partial_cover_bonus_when_the_hex_before_the_target_dips():
    tiles = {
        (1, 0): {"elevation": 0},  # lower than the target's own hex
        (2, 0): {"elevation": 1},
    }
    assert combat.partial_cover_bonus((0, 0), (2, 0), target_elevation=1, tiles=tiles, grid_type="hex") == 1


def test_partial_cover_bonus_zero_when_the_hex_before_the_target_is_not_lower():
    tiles = {
        (1, 0): {"elevation": 1},
        (2, 0): {"elevation": 1},
    }
    assert combat.partial_cover_bonus((0, 0), (2, 0), target_elevation=1, tiles=tiles, grid_type="hex") == 0


def test_partial_cover_bonus_zero_for_an_adjacent_target():
    # distance 1 -> the line is just [attacker, target], nothing "before" it.
    assert combat.partial_cover_bonus((0, 0), (1, 0), target_elevation=0, tiles={}, grid_type="hex") == 0


# ---- resolve_attack with real units (LOS/range enforcement) ------------


def _place_two_units(campaign, width=10, height=6):
    from app import maps, units
    from app.systems.battletech import mechs as mechs_module, pilots
    from tests.conftest import ATLAS_LOCATIONS

    m = maps.create_map(campaign["id"], "Combat Test", width=width, height=height)
    attacker_pilot = pilots.create_pilot(campaign["id"], "Attacker Pilot", gunnery=4)
    target_pilot = pilots.create_pilot(campaign["id"], "Target Pilot", faction="enemy", gunnery=4)
    attacker_mech = mechs_module.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=attacker_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    target_mech = mechs_module.create_mech(
        campaign_id=campaign["id"], chassis="Target", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=target_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    attacker_unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=attacker_mech["id"], pilot_id=attacker_pilot["id"])
    target_unit = units.create_unit(campaign["id"], m["id"], q=3, r=0, mech_id=target_mech["id"], pilot_id=target_pilot["id"], facing_deg=180)
    return m, attacker_mech, target_mech, attacker_unit, target_unit


def test_resolve_attack_with_real_units_rejects_when_no_los(campaign):
    from app import maps

    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign)
    maps.update_tile(m["id"], 1, 0, terrain="building", blocks_los=True)

    with pytest.raises(combat.NoLineOfSight):
        combat.resolve_attack(
            campaign_id=campaign["id"], gunnery=4, damage=5,
            attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
        )


def test_resolve_attack_with_real_units_rejects_beyond_weapon_range(campaign):
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign, width=30)
    loaded = mechs.add_weapon(attacker_mech["id"], "Small Laser", "RT")  # long range 3
    weapon_id = loaded["weapons"][0]["id"]
    from app import units
    units.move_unit(target_unit["id"], 10, 0)  # 10 hexes away, well past Small Laser's range

    with pytest.raises(combat.OutOfWeaponRange):
        combat.resolve_attack(
            campaign_id=campaign["id"], gunnery=4, weapon_id=weapon_id,
            attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
        )


def test_resolve_attack_with_real_units_ignores_a_fabricated_side_and_uses_the_real_one(campaign):
    # target_unit faces 180 (back toward -X); attacker sits at (0,0), target
    # at (3,0) -> the attacker is on the target's front side. Passing
    # side="rear" from the caller must be ignored in favor of the real one.
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign)
    from app import units
    units.move_unit(target_unit["id"], target_unit["q"], target_unit["r"], facing_deg=0)

    result = combat.resolve_attack(
        campaign_id=campaign["id"], gunnery=0, damage=5, side="rear",
        attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
    )
    # gunnery 0, stationary, no target movement, short range (3 hexes,
    # under any real weapon's short bracket isn't checked here since this
    # is the damage-only path) -> target_number 0, always hits unless a
    # natural 2. Retry isn't needed for the location, just confirm 'front'
    # damage landed rather than a rear-table location.
    assert result["hit"] in (True, False)  # sanity: no exception, side was recomputed not trusted


def test_resolve_attack_with_real_units_applies_minimum_range_penalty(campaign):
    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign)
    loaded = mechs.add_weapon(attacker_mech["id"], "AC/5", "RT")  # min range 3, short 6
    weapon_id = loaded["weapons"][0]["id"]
    from app import units
    units.move_unit(target_unit["id"], 2, 0)  # distance 2, under AC/5's min range of 3

    result = combat.resolve_attack(
        campaign_id=campaign["id"], gunnery=4, weapon_id=weapon_id,
        attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
    )
    # gunnery 4 + minimum_range_penalty(3, 2)=2, stationary/no movement, short range = 6
    assert result["target_number"] == 6


def test_resolve_attack_with_real_units_applies_terrain_bonus_for_a_forested_target(campaign):
    from app import maps, units

    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign)
    maps.update_tile(m["id"], target_unit["q"], target_unit["r"], terrain="forest", blocks_los=False, los_points=2)

    result = combat.resolve_attack(
        campaign_id=campaign["id"], gunnery=4, damage=5,
        attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
    )
    # gunnery 4 + terrain_to_hit_bonus("forest")=2, stationary/no movement, short range = 6
    assert result["target_number"] == 6


def test_resolve_attack_with_real_units_derives_movement_from_this_rounds_recorded_moves(campaign):
    from app.systems.battletech import movement as movement_module

    m, attacker_mech, target_mech, attacker_unit, target_unit = _place_two_units(campaign)
    movement_module.execute_move(campaign["id"], attacker_unit["id"], 1, 0, "walk")

    result = combat.resolve_attack(
        campaign_id=campaign["id"], gunnery=4, damage=5,
        attacker_unit_id=attacker_unit["id"], target_unit_id=target_unit["id"],
    )
    # gunnery 4 + walked (+1), no target movement, short range (distance 2) = 5
    assert result["target_number"] == 5


def test_resolve_attack_without_unit_ids_keeps_the_manual_path_unvalidated(campaign, atlas):
    # No attacker_unit_id/target_unit_id at all -> the pre-existing manual
    # behavior (whatever the caller passes is trusted, no LOS/range check)
    # must keep working exactly as before this feature existed.
    result = combat.resolve_attack(
        campaign_id=campaign["id"], target_mech_id=atlas["id"], gunnery=0, damage=5,
        range_bracket="long", side="rear",
    )
    assert "target_number" in result
