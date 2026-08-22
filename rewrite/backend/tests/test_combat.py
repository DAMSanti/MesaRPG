import pytest

from app import combat, mechs


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
    undone = combat.undo_last_action(campaign["id"])
    assert undone is not None
    after = next(l for l in mechs.get_mech(atlas["id"])["locations"] if l["location"] == "CT")
    assert after["armor_current"] == before["armor_current"]
    assert after["structure_current"] == before["structure_current"]


def test_undo_with_nothing_to_undo_returns_none(campaign):
    assert combat.undo_last_action(campaign["id"]) is None


def test_undo_only_reverts_within_its_own_campaign(campaign, atlas):
    from app import campaigns as campaigns_module

    other_campaign = campaigns_module.create_campaign("Other")
    assert combat.undo_last_action(other_campaign["id"]) is None
