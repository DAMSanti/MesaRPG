from app import maps, units
from app.systems.battletech import mechs, pilots
from tests.conftest import ATLAS_LOCATIONS


def _mech(campaign_id, pilot_id=None, chassis="Locust", model="LCT-1V"):
    return mechs.create_mech(
        campaign_id=campaign_id,
        chassis=chassis,
        model=model,
        tonnage=20,
        walk_mp=8,
        run_mp=12,
        pilot_id=pilot_id,
        locations=ATLAS_LOCATIONS,
    )


def test_hill_blocks_ghost_visibility(campaign, pilot):
    m = maps.create_map(campaign["id"], "Valley", width=6, height=6, elevations={(1, 0): 3})
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    ghost = units.create_unit(campaign["id"], m["id"], q=2, r=0, is_ghost=True)

    assert ghost["revealed"] is False

    visibility = units.combined_visibility(campaign["id"], m["id"])
    assert visibility["visible"][ghost["id"]] == []
    assert units.get_unit(ghost["id"])["revealed"] is False


def test_moving_observer_around_hill_reveals_ghost(campaign, pilot):
    m = maps.create_map(campaign["id"], "Valley", width=6, height=6, elevations={(1, 0): 3})
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    ghost = units.create_unit(campaign["id"], m["id"], q=2, r=0, is_ghost=True)

    units.move_unit(observer["id"], q=0, r=1)
    visibility = units.combined_visibility(campaign["id"], m["id"])

    assert pilot["id"] in visibility["visible"][ghost["id"]]
    assert ghost["id"] in visibility["newly_revealed"]
    assert units.get_unit(ghost["id"])["revealed"] is True


def test_revealed_ghost_stays_revealed_once_flagged(campaign, pilot):
    m = maps.create_map(campaign["id"], "Open field", width=6, height=6)
    units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    ghost = units.create_unit(campaign["id"], m["id"], q=1, r=0, is_ghost=True)

    first = units.combined_visibility(campaign["id"], m["id"])
    assert ghost["id"] in first["newly_revealed"]

    second = units.combined_visibility(campaign["id"], m["id"])
    assert ghost["id"] not in second["newly_revealed"], "should only fire once, not every recompute"


def test_a_pilot_is_never_listed_as_seeing_their_own_unit(campaign, pilot):
    # combined_visibility tracks *who spotted whom*; your own unit isn't a
    # target you "spot" (own units drive observation, they don't need it).
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    mine = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])

    visibility = units.combined_visibility(campaign["id"], m["id"])
    assert visibility["visible"][mine["id"]] == []


def test_unit_carries_its_pilots_faction(campaign, pilot):
    # Denormalized on read so the map view can color a unit by faction
    # (player/enemy/npc) without a second round trip to fetch pilots.
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    assert unit["pilot_faction"] == "player"


def test_unit_with_an_enemy_pilot_carries_enemy_faction(campaign):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile Lance Leader", faction="enemy")
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=enemy_pilot["id"])
    assert unit["pilot_faction"] == "enemy"


def test_unit_with_no_pilot_has_no_faction(campaign):
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    ghost = units.create_unit(campaign["id"], m["id"], q=0, r=0, is_ghost=True)
    assert ghost["pilot_faction"] is None


def test_visible_hexes_from_unit_works_without_a_pilot(campaign):
    # combined_visibility only considers pilot-owned observers, so a mech
    # placed on the map without a pilot linked yet never shows up in it —
    # this is the debug view that doesn't care who owns the unit.
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0)

    hexes = units.visible_hexes_from_unit(unit["id"])
    assert (0, 0) in {(h["q"], h["r"]) for h in hexes}
    assert (3, 0) in {(h["q"], h["r"]) for h in hexes}, "open field: nothing should block the far corner"


def test_visible_hexes_from_unit_respects_a_blocking_hill(campaign):
    m = maps.create_map(campaign["id"], "Valley", width=6, height=6, elevations={(1, 0): 3})
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0)

    visible = {(h["q"], h["r"]) for h in units.visible_hexes_from_unit(unit["id"])}
    assert (1, 0) in visible, "the hill itself is always visible, it just blocks past itself"
    assert (2, 0) not in visible, "directly behind the hill, same rule combined_visibility already tests"


def test_visible_hexes_from_unit_excludes_whats_directly_behind(campaign):
    # A mech doesn't see equally in every direction — facing_deg=0 means
    # "looking toward +q", so a clear hex due east is visible and the
    # mirror-image hex due west (behind it) is not, even with identical LoS.
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    unit = units.create_unit(campaign["id"], m["id"], q=3, r=0, facing_deg=0)

    visible = {(h["q"], h["r"]) for h in units.visible_hexes_from_unit(unit["id"])}
    assert (6, 0) in visible, "due east, in front — should be visible"
    assert (0, 0) not in visible, "due west, directly behind — should not be"


def test_visible_hexes_from_unit_facing_rotates_the_arc(campaign):
    # Same geometry as above, but facing the opposite way (180°) — front
    # and back should swap.
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    unit = units.create_unit(campaign["id"], m["id"], q=3, r=0, facing_deg=180)

    visible = {(h["q"], h["r"]) for h in units.visible_hexes_from_unit(unit["id"])}
    assert (0, 0) in visible, "now facing west — behind-hex from the other test is now in front"
    assert (6, 0) not in visible, "and the previously-visible east hex is now behind"


def test_visible_hexes_from_unknown_unit_is_none():
    assert units.visible_hexes_from_unit(999999) is None


def test_visible_enemies_from_unit_reports_chassis_model_and_distance(campaign, pilot):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile Lance Leader", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"], chassis="Atlas", model="AS7-D")
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"], facing_deg=0)
    target = units.create_unit(campaign["id"], m["id"], q=3, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    enemies = units.visible_enemies_from_unit(observer["id"])
    assert len(enemies) == 1
    assert enemies[0]["unit_id"] == target["id"]
    assert enemies[0]["mech_id"] == enemy_mech["id"]
    assert enemies[0]["chassis"] == "Atlas"
    assert enemies[0]["model"] == "AS7-D"
    assert enemies[0]["distance"] == 3


def test_visible_enemies_from_unit_excludes_whats_behind(campaign, pilot):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"])
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    observer = units.create_unit(campaign["id"], m["id"], q=3, r=0, pilot_id=pilot["id"], facing_deg=0)
    units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == []


def test_visible_enemies_from_unit_respects_los(campaign, pilot):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"])
    m = maps.create_map(campaign["id"], "Valley", width=6, height=6, elevations={(1, 0): 3})
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"], facing_deg=0)
    units.create_unit(campaign["id"], m["id"], q=2, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == [], "hill directly between them should block LoS"


def test_visible_enemies_from_unit_excludes_same_faction(campaign, pilot):
    ally_mech = _mech(campaign["id"])
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    units.create_unit(campaign["id"], m["id"], q=1, r=0, mech_id=ally_mech["id"], pilot_id=pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == []


def test_visible_enemies_from_unit_includes_unassigned_mechs_as_unknown_contacts(campaign, pilot):
    stray_mech = _mech(campaign["id"])
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    stray = units.create_unit(campaign["id"], m["id"], q=1, r=0, mech_id=stray_mech["id"])

    enemies = units.visible_enemies_from_unit(observer["id"])
    assert [e["unit_id"] for e in enemies] == [stray["id"]]


def test_visible_enemies_from_unit_excludes_units_without_a_mech(campaign, pilot):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    units.create_unit(campaign["id"], m["id"], q=1, r=0, pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == []


def test_visible_enemies_from_unknown_unit_is_none():
    assert units.visible_enemies_from_unit(999999) is None


# ---- attack_side (server-side port of hexMath.ts's attackSide) --------


def test_attack_side_is_front_when_target_faces_the_attacker():
    target = {"q": 0, "r": 0, "facing_deg": 0}
    attacker = {"q": 2, "r": 0}
    assert units.attack_side(attacker, target, "hex") == "front"


def test_attack_side_is_rear_when_target_faces_away_from_the_attacker():
    target = {"q": 0, "r": 0, "facing_deg": 180}
    attacker = {"q": 2, "r": 0}
    assert units.attack_side(attacker, target, "hex") == "rear"


def test_attack_side_is_right_when_attacker_is_off_the_targets_right_flank():
    target = {"q": 0, "r": 0, "facing_deg": 90}
    attacker = {"q": 2, "r": 0}
    assert units.attack_side(attacker, target, "hex") == "right"


def test_attack_side_is_left_when_attacker_is_off_the_targets_left_flank():
    target = {"q": 0, "r": 0, "facing_deg": 270}
    attacker = {"q": 2, "r": 0}
    assert units.attack_side(attacker, target, "hex") == "left"


def test_attack_side_defaults_to_front_when_attacker_and_target_share_a_hex():
    target = {"q": 0, "r": 0, "facing_deg": 45}
    attacker = {"q": 0, "r": 0}
    assert units.attack_side(attacker, target, "hex") == "front"
