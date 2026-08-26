import pytest

from app.systems.battletech import mechs, pilots
from tests.conftest import ATLAS_LOCATIONS


def test_create_mech_rejects_missing_locations(campaign):
    with pytest.raises(mechs.InvalidMechLocation):
        mechs.create_mech(
            campaign_id=campaign["id"],
            chassis="Broken",
            tonnage=20,
            walk_mp=4,
            run_mp=6,
            locations=[{"location": "HD", "armor_max": 9, "structure_max": 3}],
        )


def test_create_mech_rejects_duplicate_location(campaign):
    locations = ATLAS_LOCATIONS + [{"location": "HD", "armor_max": 1, "structure_max": 1}]
    with pytest.raises(mechs.InvalidMechLocation):
        mechs.create_mech(
            campaign_id=campaign["id"], chassis="Broken", tonnage=20, walk_mp=4, run_mp=6, locations=locations
        )


def test_create_mech_rejects_unknown_location(campaign):
    locations = [loc for loc in ATLAS_LOCATIONS if loc["location"] != "HD"]
    locations.append({"location": "TAIL", "armor_max": 9, "structure_max": 3})
    with pytest.raises(mechs.InvalidMechLocation):
        mechs.create_mech(
            campaign_id=campaign["id"], chassis="Broken", tonnage=20, walk_mp=4, run_mp=6, locations=locations
        )


def test_non_torso_locations_ignore_rear_armor(campaign):
    locations = [dict(loc) for loc in ATLAS_LOCATIONS]
    for loc in locations:
        if loc["location"] == "LA":
            loc["armor_rear_max"] = 99  # should be silently dropped — arms have no rear facing
    mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Test", tonnage=100, walk_mp=3, run_mp=5, locations=locations
    )
    la = next(l for l in mech["locations"] if l["location"] == "LA")
    assert la["armor_rear_max"] is None


def test_update_location_only_changes_given_fields(atlas):
    updated = mechs.update_location(atlas["id"], "HD", armor_current=1)
    hd = next(l for l in updated["locations"] if l["location"] == "HD")
    assert hd["armor_current"] == 1
    assert hd["structure_current"] == 3  # untouched, still at max


def test_update_location_with_no_fields_is_a_noop(atlas):
    before = mechs.get_mech(atlas["id"])
    after = mechs.update_location(atlas["id"], "HD")
    assert before == after


def test_new_mech_has_no_weapons(atlas):
    assert atlas["weapons"] == []


def test_add_weapon_appears_on_the_mech(atlas):
    updated = mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    assert len(updated["weapons"]) == 1
    w = updated["weapons"][0]
    assert w["weapon_name"] == "Medium Laser"
    assert w["location"] == "RA"
    assert w["ammo_remaining"] is None  # energy weapon, no ammo


def test_add_ammo_weapon_initializes_ammo_from_the_catalog(atlas):
    updated = mechs.add_weapon(atlas["id"], "AC/20", "RT")
    w = updated["weapons"][0]
    assert w["ammo_remaining"] == 5  # AC/20: 5 rounds per ton


def test_add_weapon_rejects_unknown_weapon(atlas):
    with pytest.raises(mechs.weapons.UnknownWeapon):
        mechs.add_weapon(atlas["id"], "Death Ray", "RA")


def test_add_weapon_rejects_unknown_location(atlas):
    with pytest.raises(mechs.InvalidMechLocation):
        mechs.add_weapon(atlas["id"], "Medium Laser", "TAIL")


def test_remove_weapon(atlas):
    added = mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    weapon_id = added["weapons"][0]["id"]
    updated = mechs.remove_weapon(weapon_id)
    assert updated["weapons"] == []


def test_new_mech_has_no_equipment(atlas):
    assert atlas["equipment"] == []


def test_add_equipment_appears_on_the_mech(atlas):
    updated = mechs.add_equipment(atlas["id"], "Endo-Steel", "LT")
    assert len(updated["equipment"]) == 1
    e = updated["equipment"][0]
    assert e["equipment_name"] == "Endo-Steel"
    assert e["location"] == "LT"


def test_add_equipment_rejects_unknown_equipment(atlas):
    with pytest.raises(mechs.equipment.UnknownEquipment):
        mechs.add_equipment(atlas["id"], "Warp Drive", "LT")


def test_add_equipment_rejects_unknown_location(atlas):
    with pytest.raises(mechs.InvalidMechLocation):
        mechs.add_equipment(atlas["id"], "Endo-Steel", "TAIL")


def test_remove_equipment(atlas):
    added = mechs.add_equipment(atlas["id"], "Endo-Steel", "LT")
    equipment_id = added["equipment"][0]["id"]
    updated = mechs.remove_equipment(equipment_id)
    assert updated["equipment"] == []


def test_heat_sinks_untouched_with_no_heat_sink_equipment_mounted(atlas):
    # atlas fixture defaults to heat_sinks=10 (create_mech's own default,
    # not derived from anything) — mounting equipment that isn't a heat
    # sink must never reset or touch that manually-set value.
    assert atlas["heat_sinks"] == 10
    updated = mechs.add_equipment(atlas["id"], "Endo-Steel", "LT")
    assert updated["heat_sinks"] == 10


def test_heat_sinks_recomputed_from_mounted_heat_sink_equipment(atlas):
    # A standard fusion engine gives 10 heat sinks free — only ones beyond
    # that show up as critical-slot equipment, so the real total is
    # always 10 + what's explicitly mounted (app/mechs.py's
    # _FREE_ENGINE_HEAT_SINKS).
    mechs.add_equipment(atlas["id"], "Double Heat Sink", "LT")
    updated = mechs.add_equipment(atlas["id"], "Double Heat Sink", "RT")
    assert updated["heat_sinks"] == 24  # (2 mounted + 10 free) x 2 dissipation each


def test_heat_sinks_recomputed_again_after_removing_a_heat_sink(atlas):
    mechs.add_equipment(atlas["id"], "Double Heat Sink", "LT")
    added = mechs.add_equipment(atlas["id"], "Heat Sink", "RT")
    heat_sink_id = next(e["id"] for e in added["equipment"] if e["equipment_name"] == "Heat Sink")
    updated = mechs.remove_equipment(heat_sink_id)
    assert updated["heat_sinks"] == 22  # only the Double Heat Sink remains: (1 + 10 free) x 2


def test_heat_sinks_free_ten_matches_whichever_type_has_more_mounted(atlas):
    # Mixing Single/Double on one mech isn't a real design, but the
    # formula shouldn't crash on it: the free 10 go to whichever type has
    # the most criticals mounted (first inserted wins a tie), any other
    # type present is counted as pure extras with no free allotment.
    mechs.add_equipment(atlas["id"], "Double Heat Sink", "LT")
    updated = mechs.add_equipment(atlas["id"], "Heat Sink", "RT")
    assert updated["heat_sinks"] == 23  # (1 Double + 10 free) x 2, + 1 Single x 1


def test_use_ammo_decrements_remaining(atlas):
    added = mechs.add_weapon(atlas["id"], "AC/20", "RT")
    weapon_id = added["weapons"][0]["id"]
    updated = mechs.use_ammo(weapon_id)
    assert updated["ammo_remaining"] == 4


def test_use_ammo_on_an_energy_weapon_is_a_noop(atlas):
    added = mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    weapon_id = added["weapons"][0]["id"]
    updated = mechs.use_ammo(weapon_id)
    assert updated["ammo_remaining"] is None


def test_use_ammo_never_goes_below_zero(atlas):
    added = mechs.add_weapon(atlas["id"], "AC/20", "RT")
    weapon_id = added["weapons"][0]["id"]
    for _ in range(10):
        mechs.use_ammo(weapon_id)
    updated = mechs.get_mech_weapon(weapon_id)
    assert updated["ammo_remaining"] == 0


def test_mounting_a_weapon_populates_default_criticals(atlas):
    # `atlas` has no imported criticals (see conftest.py), so it already
    # got the fixed-component-only layout at creation (create_mech now
    # generates that immediately — see app/critical_layout.py). Mounting
    # a weapon should add it into the existing layout, not leave every
    # slot "-Empty-" forever.
    assert atlas["criticals"]["RA"][4]["item_name"] == "-Empty-"
    updated = mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    ra_names = [slot["item_name"] for slot in updated["criticals"]["RA"]]
    assert ra_names[:4] == ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator"]
    assert ra_names[4] == "Medium Laser"
    # Untouched locations still get the fixed-component layout, not just
    # the one location that got a weapon.
    assert updated["criticals"]["HD"][0]["item_name"] == "Life Support"


def test_mounting_a_second_weapon_regenerates_the_whole_layout(atlas):
    mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    updated = mechs.add_weapon(atlas["id"], "Machine Gun", "RA")
    ra_names = [slot["item_name"] for slot in updated["criticals"]["RA"]]
    assert ra_names[4:6] == ["Medium Laser", "Machine Gun"]


def test_removing_the_last_weapon_clears_it_from_the_layout(atlas):
    added = mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    weapon_id = added["weapons"][0]["id"]
    updated = mechs.remove_weapon(weapon_id)
    ra_names = [slot["item_name"] for slot in updated["criticals"]["RA"]]
    assert "Medium Laser" not in ra_names
    assert ra_names[0] == "Shoulder"  # fixed components stay


def test_imported_criticals_are_never_overwritten_by_mounting_a_weapon(campaign):
    criticals = {"RA": ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "Heat Sink"] + ["-Empty-"] * 7}
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Imported", tonnage=100, walk_mp=3, run_mp=5,
        locations=ATLAS_LOCATIONS, criticals=criticals,
    )
    updated = mechs.add_weapon(m["id"], "Medium Laser", "RA")
    ra_names = [slot["item_name"] for slot in updated["criticals"]["RA"]]
    # The real imported layout (with its "Heat Sink" at index 4) must
    # survive untouched — a newly-mounted weapon doesn't even appear,
    # since real MTF data is authoritative and the app doesn't try to
    # reconcile "where would this weapon's crits actually go" against it.
    assert ra_names[4] == "Heat Sink"
    assert "Medium Laser" not in ra_names


def test_get_mech_backfills_a_stale_mech_with_weapons_but_no_criticals(atlas):
    # Simulates a real mech from before app/critical_layout.py existed:
    # weapons mounted the old way (no regeneration happened), criticals
    # table left empty. get_mech() should notice and fix it on read,
    # not leave the sheet showing nothing forever.
    from app import db

    mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    with db.connect() as conn:
        conn.execute("DELETE FROM mech_criticals WHERE mech_id = ?", (atlas["id"],))
        # Confirms the simulated stale state via a raw query — calling
        # get_mech() here would already trigger the backfill under test.
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM mech_criticals WHERE mech_id = ?", (atlas["id"],)
        ).fetchone()
        assert remaining["n"] == 0

    backfilled = mechs.get_mech(atlas["id"])
    ra_names = [slot["item_name"] for slot in backfilled["criticals"]["RA"]]
    assert "Medium Laser" in ra_names
    assert backfilled["criticals"]["HD"][0]["item_name"] == "Life Support"


def test_ensure_default_criticals_never_touches_an_already_populated_mech(atlas):
    # Must not silently reset a hit already marked on an auto-generated
    # slot just because the mech gets fetched again.
    mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    mechs.set_critical_hit(atlas["id"], "RA", 4, True)  # index 4 is the Medium Laser slot

    refetched = mechs.get_mech(atlas["id"])
    assert refetched["criticals"]["RA"][4]["hit"] is True


def test_list_mechs_also_backfills_stale_criticals(campaign, pilot):
    from app import db

    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Stale", tonnage=100, walk_mp=3, run_mp=5,
        pilot_id=pilot["id"], locations=ATLAS_LOCATIONS,
    )
    mechs.add_weapon(m["id"], "AC/20", "RA")
    with db.connect() as conn:
        conn.execute("DELETE FROM mech_criticals WHERE mech_id = ?", (m["id"],))

    listed = mechs.list_mechs(campaign["id"])
    found = next(x for x in listed if x["id"] == m["id"])
    assert found["criticals"]["CT"][0]["item_name"] == "Engine"


def test_new_mech_defaults_to_ten_heat_sinks_and_zero_heat(atlas):
    assert atlas["heat_sinks"] == 10
    assert atlas["heat_current"] == 0


def test_create_mech_accepts_custom_heat_sinks(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Custom", tonnage=100, walk_mp=3, run_mp=5,
        locations=ATLAS_LOCATIONS, heat_sinks=20,
    )
    assert m["heat_sinks"] == 20


def test_add_heat_increments_current_heat(atlas):
    updated = mechs.add_heat(atlas["id"], 5)
    assert updated["heat_current"] == 5
    updated = mechs.add_heat(atlas["id"], 3)
    assert updated["heat_current"] == 8


def test_dissipate_heat_reduces_by_heat_sinks_floored_at_zero(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Custom", tonnage=100, walk_mp=3, run_mp=5,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    mechs.add_heat(m["id"], 6)
    updated = mechs.dissipate_heat(m["id"])
    assert updated["heat_current"] == 0  # 6 - 10, floored


def test_dissipate_all_heat_covers_every_mech_in_the_campaign(campaign):
    a = mechs.create_mech(
        campaign_id=campaign["id"], chassis="A", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    b = mechs.create_mech(
        campaign_id=campaign["id"], chassis="B", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    mechs.add_heat(a["id"], 15)
    mechs.add_heat(b["id"], 3)
    mechs.dissipate_all_heat(campaign["id"])
    assert mechs.get_mech(a["id"])["heat_current"] == 5
    assert mechs.get_mech(b["id"])["heat_current"] == 0


def test_create_mech_defaults_to_approved_status(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="GM-made", tonnage=50, walk_mp=4, run_mp=6, locations=ATLAS_LOCATIONS,
    )
    assert m["status"] == "approved"
    assert m["owner_token"] is None
    assert m["review_note"] is None


def test_create_mech_can_start_pending_with_owner_token(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Player-made", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, status="pending", owner_token="tok-1",
    )
    assert m["status"] == "pending"
    assert m["owner_token"] == "tok-1"


def test_create_mech_rejects_unknown_status(campaign):
    with pytest.raises(mechs.UnknownStatus):
        mechs.create_mech(
            campaign_id=campaign["id"], chassis="Confused", tonnage=50, walk_mp=4, run_mp=6,
            locations=ATLAS_LOCATIONS, status="approved-ish",
        )


def test_review_mech_approve_clears_any_note(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Player-made", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, status="pending", owner_token="tok-1",
    )
    mechs.review_mech(m["id"], "rejected", note="tonnage doesn't match armor")
    approved = mechs.review_mech(m["id"], "approved")
    assert approved["status"] == "approved"
    assert approved["review_note"] is None


def test_review_mech_reject_sets_note(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Player-made", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, status="pending", owner_token="tok-1",
    )
    rejected = mechs.review_mech(m["id"], "rejected", note="tonnage doesn't match armor")
    assert rejected["status"] == "rejected"
    assert rejected["review_note"] == "tonnage doesn't match armor"


def test_review_mech_rejects_unknown_decision(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Player-made", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, status="pending", owner_token="tok-1",
    )
    with pytest.raises(mechs.UnknownStatus):
        mechs.review_mech(m["id"], "maybe")


def test_resubmit_mech_from_rejected_goes_back_to_pending(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Player-made", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, status="pending", owner_token="tok-1",
    )
    mechs.review_mech(m["id"], "rejected", note="tonnage doesn't match armor")
    resubmitted = mechs.resubmit_mech(m["id"])
    assert resubmitted["status"] == "pending"
    assert resubmitted["review_note"] is None


def test_resubmit_mech_requires_rejected_status(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="GM-made", tonnage=50, walk_mp=4, run_mp=6, locations=ATLAS_LOCATIONS,
    )
    with pytest.raises(mechs.InvalidStatusTransition):
        mechs.resubmit_mech(m["id"])


def test_update_mech_changes_given_fields_only(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Old", model="X1", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    updated = mechs.update_mech(m["id"], chassis="New", tonnage=55)
    assert updated["chassis"] == "New"
    assert updated["tonnage"] == 55
    assert updated["model"] == "X1"  # untouched
    assert updated["walk_mp"] == 4  # untouched


def test_update_mech_with_no_fields_is_a_no_op(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Same", tonnage=50, walk_mp=4, run_mp=6, locations=ATLAS_LOCATIONS,
    )
    assert mechs.update_mech(m["id"]) == mechs.get_mech(m["id"])


def test_claim_mech_assigns_an_unassigned_mech(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Loose", tonnage=50, walk_mp=4, run_mp=6, locations=ATLAS_LOCATIONS,
    )
    assert m["pilot_id"] is None
    claimed = mechs.claim_mech(m["id"], pilot["id"])
    assert claimed["pilot_id"] == pilot["id"]


def test_claim_mech_rejects_a_mech_already_taken_by_a_different_pilot(campaign, pilot):
    other_pilot = pilots.create_pilot(campaign["id"], "Rival")
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Taken", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=other_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    with pytest.raises(mechs.MechAlreadyClaimed):
        mechs.claim_mech(m["id"], pilot["id"])
    assert mechs.get_mech(m["id"])["pilot_id"] == other_pilot["id"], "the original claim survives the rejected one"


def test_claim_mech_by_the_same_pilot_twice_is_a_no_op(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="MineAlready", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=pilot["id"], locations=ATLAS_LOCATIONS,
    )
    claimed = mechs.claim_mech(m["id"], pilot["id"])
    assert claimed["pilot_id"] == pilot["id"]


def test_claim_mech_unknown_mech_returns_none(campaign, pilot):
    assert mechs.claim_mech(999999, pilot["id"]) is None


def test_create_mech_without_criticals_gets_the_default_fixed_layout(campaign):
    # A hand-made mech (no imported criticals) starts with zero weapons,
    # but its fixed components (engine/gyro/cockpit/actuators) are on
    # every mech regardless of loadout — the Critical Hit Table shouldn't
    # be empty just because nothing's been mounted yet.
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hand-made", tonnage=50, walk_mp=4, run_mp=6, locations=ATLAS_LOCATIONS,
    )
    assert m["criticals"]["HD"][0]["item_name"] == "Life Support"
    assert m["criticals"]["CT"][0]["item_name"] == "Engine"
    assert all(slot["item_name"] == "-Empty-" for slot in m["criticals"]["LA"][4:])


def test_create_mech_with_criticals_stores_them_per_location(campaign):
    criticals = {
        "LA": ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "Heat Sink",
               "Medium Laser", "-Empty-", "-Empty-", "-Empty-", "-Empty-", "-Empty-", "-Empty-"],
        "HD": ["Life Support", "Sensors", "Cockpit", "Heat Sink", "Sensors", "Life Support",
               "-Empty-", "-Empty-", "-Empty-", "-Empty-", "-Empty-", "-Empty-"],
    }
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Imported", tonnage=100, walk_mp=3, run_mp=5,
        locations=ATLAS_LOCATIONS, criticals=criticals,
    )
    la_names = [slot["item_name"] for slot in m["criticals"]["LA"][:6]]
    assert la_names == ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "Heat Sink", "Medium Laser"]
    assert len(m["criticals"]["LA"]) == 12
    assert m["criticals"]["HD"][2]["item_name"] == "Cockpit"
    # Freshly created slots start undamaged — "hit" is real engine state
    # from here on, not just the static installed-equipment list.
    assert all(slot["hit"] is False for slot in m["criticals"]["LA"])
    # Untouched locations simply have no entry, not an error.
    assert "CT" not in m["criticals"]


def test_set_critical_hit_marks_a_slot_destroyed(campaign):
    criticals = {"LA": ["Shoulder", "Upper Arm Actuator"] + ["-Empty-"] * 10}
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Imported", tonnage=100, walk_mp=3, run_mp=5,
        locations=ATLAS_LOCATIONS, criticals=criticals,
    )
    updated = mechs.set_critical_hit(m["id"], "LA", 1, True)
    slots = {slot["slot_index"]: slot["hit"] for slot in updated["criticals"]["LA"]}
    assert slots[1] is True
    assert slots[0] is False

    restored = mechs.set_critical_hit(m["id"], "LA", 1, False)
    slots = {slot["slot_index"]: slot["hit"] for slot in restored["criticals"]["LA"]}
    assert slots[1] is False


def test_delete_mech_removes_it(atlas):
    assert mechs.delete_mech(atlas["id"]) is True
    assert mechs.get_mech(atlas["id"]) is None


def test_delete_mech_returns_false_for_unknown_id(campaign):
    assert mechs.delete_mech(999999) is False


def test_delete_mech_removes_its_map_token_too(campaign, atlas):
    # units.mech_id is only ON DELETE SET NULL at the DB layer — left
    # alone, the token would survive on the map with no mech behind it
    # (HexMap.tsx falls back to a generic cone marker, which reads as a
    # bug here, not as "riderless" by design). delete_mech has to clean
    # this up itself.
    from app import maps, units

    m = maps.create_map(campaign["id"], "Test Map", 4, 4)
    unit = units.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=atlas["id"])

    mechs.delete_mech(atlas["id"])

    assert units.get_unit(unit["id"]) is None
    assert units.list_units(m["id"]) == []
