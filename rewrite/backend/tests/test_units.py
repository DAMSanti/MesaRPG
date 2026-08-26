import pytest

from app import events, maps, units
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


def test_an_enemy_observer_never_reveals_a_ghost_to_the_player_team(campaign):
    # Real user report: the reveal cinematic fired even for a ghost
    # placed somewhere the PLAYER team had no LoS to at all. Root cause —
    # a non-ghost ENEMY unit (any enemy created before the auto-ghost fix
    # elsewhere still is one) counted as a valid "observer" the same as a
    # player one, so it could "spot" a freshly placed enemy ghost and
    # incorrectly flip it revealed even with zero player LoS involved.
    from app import db

    m = maps.create_map(campaign["id"], "Open field", width=6, height=3)
    enemy_a = pilots.create_pilot(campaign["id"], "Enemy A", faction="enemy")
    enemy_b = pilots.create_pilot(campaign["id"], "Enemy B", faction="enemy")
    observer_a = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=enemy_a["id"], facing_deg=0)
    # enemy_a's own unit auto-ghosts too now — forced back to non-ghost/
    # revealed here to simulate the pre-auto-ghost-fix data this
    # regression is actually about (an already-existing enemy unit from
    # before that fix), a real non-ghost observer that can plainly see
    # enemy_b's own hex.
    with db.connect() as conn:
        conn.execute("UPDATE units SET is_ghost = 0, revealed = 1 WHERE id = ?", (observer_a["id"],))
    ghost = units.create_unit(campaign["id"], m["id"], q=2, r=0, pilot_id=enemy_b["id"])
    assert ghost["is_ghost"] is True, "enemy_b's own unit auto-ghosts regardless"

    visibility = units.combined_visibility(campaign["id"], m["id"])
    assert enemy_a["id"] in visibility["visible"][ghost["id"]], "enemy_a genuinely has LoS to it"
    assert ghost["id"] not in visibility["newly_revealed"], "but a non-player observer must never trigger a reveal"
    assert units.get_unit(ghost["id"])["revealed"] is False


def test_combined_visibility_reports_team_visible_hexes(campaign, pilot):
    # Real user request: "niebla de guerra real en el table view... casillas
    # que el equipo jugador no ve" — combined_visibility's new
    # "visible_hexes" key is the union of every 'player'-faction unit's own
    # facing-cone LoS (same computation visible_hexes_from_unit already
    # does per-unit for the debug overlay).
    m = maps.create_map(campaign["id"], "Open field", width=6, height=3)
    units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"], facing_deg=0)

    visibility = units.combined_visibility(campaign["id"], m["id"])
    visible_hexes = {(h["q"], h["r"]) for h in visibility["visible_hexes"]}
    assert (0, 0) in visible_hexes
    assert (3, 0) in visible_hexes, "clear line of sight in the facing direction"


def test_combined_visibility_team_hexes_exclude_enemy_units(campaign):
    m = maps.create_map(campaign["id"], "Open field", width=6, height=3)
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=enemy_pilot["id"], facing_deg=0)

    visibility = units.combined_visibility(campaign["id"], m["id"])
    assert visibility["visible_hexes"] == []


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


def test_placing_an_enemy_pilots_unit_is_automatically_a_hidden_contact(campaign):
    # Real user report: "los enemigos se colocan en el mapa y están
    # ocultos hasta que el equipo les ve... el GM no tiene que colocarle
    # como oculto, es algo automático" — nothing in the frontend ever
    # passed is_ghost=True explicitly (no such UI ever existed), so the
    # reveal cinematic could never fire in practice. An enemy pilot's
    # unit is now always a hidden contact from creation, regardless of
    # whatever is_ghost the caller passed.
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=enemy_pilot["id"], is_ghost=False)
    assert unit["is_ghost"] is True
    assert unit["revealed"] is False


def test_placing_a_player_pilots_unit_is_never_a_hidden_contact(campaign, pilot):
    # player/npc pilots are unaffected — only "enemy" auto-ghosts.
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"])
    assert unit["is_ghost"] is False
    assert unit["revealed"] is True


def test_unit_with_no_pilot_has_no_faction(campaign):
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    ghost = units.create_unit(campaign["id"], m["id"], q=0, r=0, is_ghost=True)
    assert ghost["pilot_faction"] is None


def test_create_unit_with_an_approved_mech_succeeds(campaign, atlas):
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=atlas["id"])
    assert unit["mech_id"] == atlas["id"]


def test_delete_unit_removes_it(campaign, atlas):
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=atlas["id"])
    assert units.delete_unit(unit["id"]) is True
    assert units.get_unit(unit["id"]) is None


def test_delete_unit_returns_false_for_unknown_id():
    assert units.delete_unit(999999) is False


def test_delete_unit_does_not_delete_the_mech(campaign, atlas):
    # "Quitar del mapa" — the mech stays in the campaign, just unplaced.
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=atlas["id"])
    units.delete_unit(unit["id"])
    assert mechs.get_mech(atlas["id"]) is not None


def test_placing_a_mech_on_a_second_map_removes_it_from_the_first(campaign, atlas):
    map_a = maps.create_map(campaign["id"], "Map A", width=4, height=4)
    map_b = maps.create_map(campaign["id"], "Map B", width=4, height=4)
    unit_a = units.create_unit(campaign["id"], map_a["id"], q=0, r=0, mech_id=atlas["id"])

    unit_b = units.create_unit(campaign["id"], map_b["id"], q=1, r=1, mech_id=atlas["id"])

    assert units.get_unit(unit_a["id"]) is None
    assert units.get_unit(unit_b["id"]) is not None
    assert units.list_units(map_a["id"]) == []
    assert [u["id"] for u in units.list_units(map_b["id"])] == [unit_b["id"]]


def test_placing_a_mech_twice_on_the_same_map_moves_it_not_duplicates(campaign, atlas):
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    first = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=atlas["id"])
    second = units.create_unit(campaign["id"], m["id"], q=2, r=2, mech_id=atlas["id"])

    assert units.get_unit(first["id"]) is None
    remaining = units.list_units(m["id"])
    assert [u["id"] for u in remaining] == [second["id"]]
    assert (remaining[0]["q"], remaining[0]["r"]) == (2, 2)


def test_create_unit_rejects_a_pending_mech(campaign, pilot):
    # Real user request: a mech the GM hasn't reviewed yet can't be
    # placed on the board — approval has to come first.
    pending = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", model="LCT-1V", tonnage=20,
        walk_mp=8, run_mp=12, pilot_id=pilot["id"], locations=ATLAS_LOCATIONS, status="pending",
    )
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    with pytest.raises(units.MechNotApproved):
        units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=pending["id"])


def test_create_unit_rejects_a_rejected_mech(campaign, pilot):
    rejected = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", model="LCT-1V", tonnage=20,
        walk_mp=8, run_mp=12, pilot_id=pilot["id"], locations=ATLAS_LOCATIONS, status="pending",
    )
    mechs.review_mech(rejected["id"], "rejected", "not allowed")
    m = maps.create_map(campaign["id"], "Open field", width=4, height=4)
    with pytest.raises(units.MechNotApproved):
        units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=rejected["id"])


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


def test_visible_enemies_from_unit_excludes_an_already_destroyed_mech(campaign, pilot):
    # Real user report: "no se tiene que poder atacar a un muerto" — a
    # destroyed wreck kept showing up as a valid target (GMView's own
    # target-picker red tile wash, and it could keep a ranged/melee phase
    # artificially alive by counting as "someone to shoot at").
    from app.systems.battletech import mechs as mechs_module

    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile Lance Leader", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"], chassis="Atlas", model="AS7-D")
    mechs_module.mark_destroyed(enemy_mech["id"], "structural")
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    observer = units.create_unit(campaign["id"], m["id"], q=0, r=0, pilot_id=pilot["id"], facing_deg=0)
    units.create_unit(campaign["id"], m["id"], q=3, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == []


def test_visible_enemies_from_unit_excludes_whats_behind(campaign, pilot):
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"])
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    observer = units.create_unit(campaign["id"], m["id"], q=3, r=0, pilot_id=pilot["id"], facing_deg=0)
    units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == []


def test_visible_enemies_from_unit_require_facing_false_includes_whats_behind(campaign, pilot):
    # require_facing=False (real user report: melee.py's resolve_melee_
    # attack never checks facing, only adjacency+LOS — turns.py's
    # _pilots_with_melee_targets uses this to match that rule instead of
    # the stricter facing-cone default used everywhere else, like FPV's
    # own "what do I see" HUD).
    enemy_pilot = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    enemy_mech = _mech(campaign["id"], enemy_pilot["id"])
    m = maps.create_map(campaign["id"], "Open field", width=8, height=3)
    observer = units.create_unit(campaign["id"], m["id"], q=3, r=0, pilot_id=pilot["id"], facing_deg=0)
    target = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=enemy_mech["id"], pilot_id=enemy_pilot["id"])

    assert units.visible_enemies_from_unit(observer["id"]) == [], "still excluded by default"
    enemies = units.visible_enemies_from_unit(observer["id"], require_facing=False)
    assert [e["unit_id"] for e in enemies] == [target["id"]]


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


# ---- D&D units (ROADMAP.md Fase R4 — a unit has mech_id/pilot_id OR
# dnd_character_id, never both, depending on the owning campaign's
# system) -------------------------------------------------------------

def test_create_dnd_unit_has_no_battletech_fields(dnd_campaign):
    from app.systems.dnd5e import characters
    char = characters.create_character(dnd_campaign["id"], "Elowen", ac=15, hp_max=12)
    m = maps.create_map(dnd_campaign["id"], "Tavern", width=6, height=6)
    unit = units.create_unit(dnd_campaign["id"], m["id"], q=1, r=2, dnd_character_id=char["id"])

    assert unit["mech_id"] is None
    assert unit["pilot_id"] is None
    assert unit["dnd_character_id"] == char["id"]
    assert unit["dnd_name"] == "Elowen"
    assert unit["dnd_ac"] == 15
    assert unit["dnd_hp_current"] == 12
    assert unit["dnd_hp_max"] == 12


def test_dnd_unit_round_trips_through_list_units(dnd_campaign):
    from app.systems.dnd5e import characters
    char = characters.create_character(dnd_campaign["id"], "Thorn")
    m = maps.create_map(dnd_campaign["id"], "Tavern", width=6, height=6)
    units.create_unit(dnd_campaign["id"], m["id"], q=0, r=0, dnd_character_id=char["id"])

    listed = units.list_units(m["id"])
    assert len(listed) == 1
    assert listed[0]["dnd_character_id"] == char["id"]
    assert listed[0]["dnd_name"] == "Thorn"


def test_multiple_dnd_characters_placed_same_campaign(dnd_campaign):
    from app.systems.dnd5e import characters
    a = characters.create_character(dnd_campaign["id"], "Elowen")
    b = characters.create_character(dnd_campaign["id"], "Thorn")
    m = maps.create_map(dnd_campaign["id"], "Tavern", width=6, height=6)
    units.create_unit(dnd_campaign["id"], m["id"], q=0, r=0, dnd_character_id=a["id"])
    units.create_unit(dnd_campaign["id"], m["id"], q=1, r=1, dnd_character_id=b["id"])

    names = {u["dnd_name"] for u in units.list_units(m["id"])}
    assert names == {"Elowen", "Thorn"}


def test_undo_unit_placed_deletes_it(campaign, pilot):
    m = maps.create_map(campaign["id"], "Field", width=4, height=4)
    mech = _mech(campaign["id"], pilot_id=pilot["id"])
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"])

    events.undo_last_event(campaign["id"])
    assert units.get_unit(unit["id"]) is None


def test_undo_unit_removed_recreates_it_at_the_same_spot(campaign, pilot):
    m = maps.create_map(campaign["id"], "Field", width=4, height=4)
    mech = _mech(campaign["id"], pilot_id=pilot["id"])
    unit = units.create_unit(campaign["id"], m["id"], q=2, r=3, mech_id=mech["id"], facing_deg=120)

    units.delete_unit(unit["id"])
    assert units.list_units(m["id"]) == []

    events.undo_last_event(campaign["id"])
    remaining = units.list_units(m["id"])
    assert len(remaining) == 1
    assert (remaining[0]["q"], remaining[0]["r"], remaining[0]["facing_deg"]) == (2, 3, 120)
    assert remaining[0]["mech_id"] == mech["id"]


def test_undo_unit_moved_restores_prior_position(campaign, pilot):
    m = maps.create_map(campaign["id"], "Field", width=6, height=6)
    mech = _mech(campaign["id"], pilot_id=pilot["id"])
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"])
    units.move_unit(unit["id"], q=4, r=5, facing_deg=90)

    events.undo_last_event(campaign["id"])
    after = units.get_unit(unit["id"])
    assert (after["q"], after["r"], after["facing_deg"]) == (0, 0, 0)
