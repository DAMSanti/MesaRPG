import pytest

from app import pilots


def test_create_pilot_defaults_to_player_faction(campaign):
    p = pilots.create_pilot(campaign["id"], "Miriam Voss")
    assert p["faction"] == "player"


def test_create_pilot_accepts_enemy_and_npc_factions(campaign):
    enemy = pilots.create_pilot(campaign["id"], "Hostile Lance Leader", faction="enemy")
    npc = pilots.create_pilot(campaign["id"], "Merchant Baron", faction="npc")
    assert enemy["faction"] == "enemy"
    assert npc["faction"] == "npc"


def test_create_pilot_rejects_unknown_faction(campaign):
    with pytest.raises(pilots.UnknownFaction):
        pilots.create_pilot(campaign["id"], "Confused Pilot", faction="villain")


def test_update_pilot_can_change_faction(campaign):
    p = pilots.create_pilot(campaign["id"], "Turncoat")
    updated = pilots.update_pilot(p["id"], faction="enemy")
    assert updated["faction"] == "enemy"


def test_update_pilot_rejects_unknown_faction(campaign):
    p = pilots.create_pilot(campaign["id"], "Turncoat")
    with pytest.raises(pilots.UnknownFaction):
        pilots.update_pilot(p["id"], faction="villain")


def test_create_pilot_starts_with_zero_hits(campaign):
    p = pilots.create_pilot(campaign["id"], "Fresh Recruit")
    assert p["hits"] == 0


def test_update_pilot_can_mark_hits(campaign):
    p = pilots.create_pilot(campaign["id"], "Taking a Beating")
    updated = pilots.update_pilot(p["id"], hits=3)
    assert updated["hits"] == 3


def test_list_pilots_includes_faction(campaign):
    pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    listed = pilots.list_pilots(campaign["id"])
    assert listed[0]["faction"] == "enemy"


def test_create_pilot_defaults_to_neutral_grey_dice_color(campaign):
    p = pilots.create_pilot(campaign["id"], "Colorless")
    assert p["color"] == "#9aa4a2"


def test_create_pilot_accepts_a_custom_color(campaign):
    p = pilots.create_pilot(campaign["id"], "Vivid", color="#ff00aa")
    assert p["color"] == "#ff00aa"


def test_update_pilot_can_change_color(campaign):
    p = pilots.create_pilot(campaign["id"], "Rebrand")
    updated = pilots.update_pilot(p["id"], color="#00ff88")
    assert updated["color"] == "#00ff88"


def test_create_pilot_defaults_to_approved_status(campaign):
    p = pilots.create_pilot(campaign["id"], "GM-made")
    assert p["status"] == "approved"
    assert p["owner_token"] is None
    assert p["review_note"] is None


def test_create_pilot_can_start_pending_with_owner_token(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", status="pending", owner_token="tok-1")
    assert p["status"] == "pending"
    assert p["owner_token"] == "tok-1"


def test_create_pilot_rejects_unknown_status(campaign):
    with pytest.raises(pilots.UnknownStatus):
        pilots.create_pilot(campaign["id"], "Confused", status="approved-ish")


def test_review_pilot_approve_clears_any_note(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", status="pending", owner_token="tok-1")
    pilots.review_pilot(p["id"], "rejected", note="fix gunnery")
    approved = pilots.review_pilot(p["id"], "approved")
    assert approved["status"] == "approved"
    assert approved["review_note"] is None


def test_review_pilot_reject_sets_note(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", status="pending", owner_token="tok-1")
    rejected = pilots.review_pilot(p["id"], "rejected", note="fix gunnery")
    assert rejected["status"] == "rejected"
    assert rejected["review_note"] == "fix gunnery"


def test_review_pilot_rejects_unknown_decision(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", status="pending", owner_token="tok-1")
    with pytest.raises(pilots.UnknownStatus):
        pilots.review_pilot(p["id"], "maybe")


def test_resubmit_pilot_from_rejected_goes_back_to_pending(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", status="pending", owner_token="tok-1")
    pilots.review_pilot(p["id"], "rejected", note="fix gunnery")
    resubmitted = pilots.resubmit_pilot(p["id"])
    assert resubmitted["status"] == "pending"
    assert resubmitted["review_note"] is None


def test_resubmit_pilot_requires_rejected_status(campaign):
    p = pilots.create_pilot(campaign["id"], "GM-made")  # defaults to approved
    with pytest.raises(pilots.InvalidStatusTransition):
        pilots.resubmit_pilot(p["id"])


def test_delete_pilot_removes_it(campaign):
    p = pilots.create_pilot(campaign["id"], "Doomed")
    assert pilots.delete_pilot(p["id"]) is True
    assert pilots.get_pilot(p["id"]) is None


def test_delete_pilot_returns_false_for_unknown_id(campaign):
    assert pilots.delete_pilot(999999) is False


def test_delete_pilot_unpilots_but_does_not_delete_their_mech(campaign):
    from app import mechs
    from tests.conftest import ATLAS_LOCATIONS

    p = pilots.create_pilot(campaign["id"], "Soon Gone")
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", tonnage=20, walk_mp=8, run_mp=12,
        locations=ATLAS_LOCATIONS, pilot_id=p["id"],
    )
    pilots.delete_pilot(p["id"])
    survivor = mechs.get_mech(m["id"])
    assert survivor is not None
    assert survivor["pilot_id"] is None
