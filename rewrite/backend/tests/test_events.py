import pytest

from app import events
from app.systems.battletech import mechs, pilots
from tests.conftest import ATLAS_LOCATIONS


def test_log_event_and_list_events_round_trip(campaign):
    from app import db

    with db.connect() as conn:
        events.log_event(conn, campaign["id"], "pilot_created", "Piloto creado: Test", {"pilot_id": 999})
    listed = events.list_events(campaign["id"])
    assert len(listed) == 1
    assert listed[0]["event_type"] == "pilot_created"
    assert listed[0]["summary"] == "Piloto creado: Test"
    assert listed[0]["payload"] == {"pilot_id": 999}
    assert listed[0]["undoable"] is True
    assert listed[0]["undone"] is False


def test_list_events_most_recent_first(campaign):
    pilots.create_pilot(campaign["id"], "First")
    pilots.create_pilot(campaign["id"], "Second")
    listed = events.list_events(campaign["id"])
    assert [e["summary"] for e in listed] == ["Piloto creado: Second", "Piloto creado: First"]


def test_list_events_respects_limit(campaign):
    for i in range(5):
        pilots.create_pilot(campaign["id"], f"Pilot {i}")
    assert len(events.list_events(campaign["id"], limit=3)) == 3


def test_list_events_only_returns_this_campaigns_events(campaign):
    from app import campaigns as campaigns_module

    other = campaigns_module.create_campaign("Other")
    pilots.create_pilot(campaign["id"], "Mine")
    pilots.create_pilot(other["id"], "Theirs")
    listed = events.list_events(campaign["id"])
    assert len(listed) == 1
    assert listed[0]["summary"] == "Piloto creado: Mine"


def test_undo_last_event_with_nothing_to_undo_returns_none(campaign):
    assert events.undo_last_event(campaign["id"]) is None


def test_undo_pilot_created_deletes_the_pilot(campaign):
    p = pilots.create_pilot(campaign["id"], "Undo Me")
    result = events.undo_last_event(campaign["id"])
    assert result["event_type"] == "pilot_created"
    assert pilots.get_pilot(p["id"]) is None


def test_undo_pilot_deleted_recreates_the_pilot(campaign):
    p = pilots.create_pilot(campaign["id"], "Restore Me", callsign="Ghost", gunnery=2, piloting=3)
    pilots.delete_pilot(p["id"])
    events.undo_last_event(campaign["id"])
    remaining = pilots.list_pilots(campaign["id"])
    assert len(remaining) == 1
    assert remaining[0]["name"] == "Restore Me"
    assert remaining[0]["callsign"] == "Ghost"
    assert remaining[0]["gunnery"] == 2


def test_undo_history_fully_drains_without_regrowing(campaign):
    # The real bug this guards against: an undo handler that calls back
    # into an instrumented create/delete function would log a fresh
    # event on every undo, so the history would never empty out.
    pilots.create_pilot(campaign["id"], "A")
    p = pilots.create_pilot(campaign["id"], "B")
    pilots.delete_pilot(p["id"])

    undone = 0
    for _ in range(10):
        if events.undo_last_event(campaign["id"]) is None:
            break
        undone += 1
    else:
        raise AssertionError("undo never drained the history")
    assert undone == 3  # pilot_deleted, then both pilot_created events


def test_undo_pilot_reviewed_restores_prior_status(campaign):
    p = pilots.create_pilot(campaign["id"], "Reviewed", status="pending")
    pilots.review_pilot(p["id"], "approved")
    events.undo_last_event(campaign["id"])
    assert pilots.get_pilot(p["id"])["status"] == "pending"


def test_undo_pilot_resubmitted_restores_rejected_with_note(campaign):
    p = pilots.create_pilot(campaign["id"], "Resubmitted", status="pending")
    pilots.review_pilot(p["id"], "rejected", "fix your gunnery")
    pilots.resubmit_pilot(p["id"])
    events.undo_last_event(campaign["id"])
    after = pilots.get_pilot(p["id"])
    assert after["status"] == "rejected"
    assert after["review_note"] == "fix your gunnery"


def test_undo_pilot_updated_restores_prior_fields(campaign):
    p = pilots.create_pilot(campaign["id"], "Original Name", gunnery=4)
    pilots.update_pilot(p["id"], name="Changed Name", gunnery=1)
    events.undo_last_event(campaign["id"])
    after = pilots.get_pilot(p["id"])
    assert after["name"] == "Original Name"
    assert after["gunnery"] == 4


def test_pilot_updated_not_logged_for_hits_only_change(campaign, pilot):
    before = len(events.list_events(campaign["id"]))
    pilots.update_pilot(pilot["id"], hits=1)
    after = len(events.list_events(campaign["id"]))
    assert after == before


def test_undo_mech_created_deletes_the_mech(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", tonnage=20, walk_mp=8, run_mp=12,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"],
    )
    events.undo_last_event(campaign["id"])
    assert mechs.get_mech(m["id"]) is None


def test_undo_mech_deleted_recreates_with_current_damage_and_weapon(campaign, pilot, atlas):
    mechs.update_location(atlas["id"], "CT", armor_current=5, structure_current=20)
    loaded = mechs.add_weapon(atlas["id"], "AC/5", "RT")
    weapon_id = loaded["weapons"][0]["id"]
    mechs.use_ammo(weapon_id)  # 19 remaining

    mechs.delete_mech(atlas["id"])
    events.undo_last_event(campaign["id"])

    recreated = [m for m in mechs.list_mechs(campaign["id"]) if m["chassis"] == "Atlas"]
    assert len(recreated) == 1
    ct = next(l for l in recreated[0]["locations"] if l["location"] == "CT")
    assert ct["armor_current"] == 5
    assert ct["structure_current"] == 20
    assert recreated[0]["weapons"][0]["ammo_remaining"] == 19


def test_undo_mech_reviewed_restores_prior_status(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", tonnage=20, walk_mp=8, run_mp=12,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], status="pending",
    )
    mechs.review_mech(m["id"], "rejected", "too fast")
    events.undo_last_event(campaign["id"])
    after = mechs.get_mech(m["id"])
    assert after["status"] == "pending"
    assert after["review_note"] is None


def test_undo_mech_updated_restores_prior_fields(campaign, atlas):
    mechs.update_mech(atlas["id"], chassis="Renamed", tonnage=50)
    events.undo_last_event(campaign["id"])
    after = mechs.get_mech(atlas["id"])
    assert after["chassis"] == "Atlas"
    assert after["tonnage"] == 100


def test_undo_of_not_undoable_event_raises(campaign):
    from app import db

    with db.connect() as conn:
        events.log_event(conn, campaign["id"], "table_session_activated", "Mesa activada", {}, undoable=False)
    with pytest.raises(events.NotUndoable):
        events.undo_last_event(campaign["id"])
