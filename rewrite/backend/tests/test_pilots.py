import pytest

from app import campaigns, dice_styles
from app.systems.battletech import pilots


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


def test_create_pilot_defaults_to_physical_dice_mode(campaign):
    p = pilots.create_pilot(campaign["id"], "Traditionalist")
    assert p["dice_mode"] == "physical"


def test_update_pilot_can_switch_to_auto_dice_mode(campaign):
    p = pilots.create_pilot(campaign["id"], "Speedrunner")
    updated = pilots.update_pilot(p["id"], dice_mode="auto")
    assert updated["dice_mode"] == "auto"


def test_update_pilot_rejects_unknown_dice_mode(campaign):
    p = pilots.create_pilot(campaign["id"], "Confused")
    with pytest.raises(pilots.UnknownDiceMode):
        pilots.update_pilot(p["id"], dice_mode="telepathic")


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
    from app.systems.battletech import mechs
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


# ---- PIN (jugador escoge su propio personaje de una lista compartida) --

def test_create_pilot_without_pin_has_no_pin(campaign):
    p = pilots.create_pilot(campaign["id"], "GM-made")
    assert p["has_pin"] is False
    assert "pin" not in p
    assert "pin_hash" not in p
    assert "pin_salt" not in p


def test_create_pilot_with_pin_sets_has_pin(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", pin="1234")
    assert p["has_pin"] is True
    assert "pin" not in p
    assert "pin_hash" not in p


def test_create_pilot_rejects_a_non_4_digit_pin(campaign):
    with pytest.raises(pilots.InvalidPin):
        pilots.create_pilot(campaign["id"], "Sloppy", pin="123")
    with pytest.raises(pilots.InvalidPin):
        pilots.create_pilot(campaign["id"], "Sloppy", pin="12a4")
    with pytest.raises(pilots.InvalidPin):
        pilots.create_pilot(campaign["id"], "Sloppy", pin="123456")


def test_verify_pin_accepts_the_right_pin(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", pin="4242")
    assert pilots.verify_pin(p["id"], "4242") is True


def test_verify_pin_rejects_the_wrong_pin(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", pin="4242")
    assert pilots.verify_pin(p["id"], "0000") is False


def test_verify_pin_is_false_for_a_pilot_without_one(campaign):
    p = pilots.create_pilot(campaign["id"], "GM-made")
    assert pilots.verify_pin(p["id"], "0000") is False


def test_verify_pin_is_false_for_an_unknown_pilot():
    assert pilots.verify_pin(999999, "1234") is False


def test_list_pilots_includes_has_pin_and_never_the_hash(campaign):
    pilots.create_pilot(campaign["id"], "Player-made", pin="4242")
    listed = pilots.list_pilots(campaign["id"])
    assert listed[0]["has_pin"] is True
    assert "pin" not in listed[0]
    assert "pin_hash" not in listed[0]
    assert "pin_salt" not in listed[0]


def test_create_pilot_rejects_a_second_pilot_for_the_same_owner_token(campaign):
    pilots.create_pilot(campaign["id"], "First Try", owner_token="device-1")
    with pytest.raises(pilots.DuplicateOwnerPilot):
        pilots.create_pilot(campaign["id"], "Second Try", owner_token="device-1")


def test_create_pilot_allows_different_owner_tokens(campaign):
    a = pilots.create_pilot(campaign["id"], "Device A", owner_token="device-a")
    b = pilots.create_pilot(campaign["id"], "Device B", owner_token="device-b")
    assert a["id"] != b["id"]


def test_create_pilot_without_owner_token_is_never_deduped(campaign):
    # GM-created pilots never pass owner_token — must stay unrestricted.
    a = pilots.create_pilot(campaign["id"], "GM Pilot One")
    b = pilots.create_pilot(campaign["id"], "GM Pilot Two")
    assert a["id"] != b["id"]


def test_create_pilot_allows_same_owner_token_in_different_campaigns(campaign):
    other = campaigns.create_campaign("Other Campaign")
    a = pilots.create_pilot(campaign["id"], "Same Device", owner_token="device-x")
    b = pilots.create_pilot(other["id"], "Same Device", owner_token="device-x")
    assert a["id"] != b["id"]


def test_claim_pilot_assigns_an_unclaimed_pilot(campaign):
    p = pilots.create_pilot(campaign["id"], "GM Pilot")
    claimed = pilots.claim_pilot(p["id"], "device-1")
    assert claimed["owner_token"] == "device-1"


def test_claim_pilot_rejects_a_pilot_already_claimed_by_a_different_device(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", owner_token="device-1")
    with pytest.raises(pilots.PilotAlreadyClaimed):
        pilots.claim_pilot(p["id"], "device-2")


def test_claim_pilot_by_the_same_device_twice_is_a_no_op(campaign):
    p = pilots.create_pilot(campaign["id"], "Player-made", owner_token="device-1")
    claimed = pilots.claim_pilot(p["id"], "device-1")
    assert claimed["owner_token"] == "device-1"


def test_claim_pilot_unknown_pilot_returns_none(campaign):
    assert pilots.claim_pilot(999999, "device-1") is None


def test_pilot_die_style_defaults_to_none(campaign):
    p = pilots.create_pilot(campaign["id"], "Unstyled")
    assert p["die_style"] is None


def test_set_pilot_die_style_sets_and_clears(campaign):
    p = pilots.create_pilot(campaign["id"], "Styled")
    updated = pilots.set_pilot_die_style(p["id"], "chrome-metallic")
    assert updated["die_style"] == "chrome-metallic"
    cleared = pilots.set_pilot_die_style(p["id"], None)
    assert cleared["die_style"] is None


def test_set_pilot_die_style_rejects_unknown_style(campaign):
    p = pilots.create_pilot(campaign["id"], "Confused")
    with pytest.raises(dice_styles.UnknownDieStyle):
        pilots.set_pilot_die_style(p["id"], "not-a-real-style")


def test_set_pilot_die_style_rejects_style_taken_by_another_pilot(campaign):
    a = pilots.create_pilot(campaign["id"], "First")
    b = pilots.create_pilot(campaign["id"], "Second")
    pilots.set_pilot_die_style(a["id"], "opal-pearl")
    with pytest.raises(dice_styles.DieStyleTaken):
        pilots.set_pilot_die_style(b["id"], "opal-pearl")


def test_set_pilot_die_style_allows_repicking_your_own_style(campaign):
    p = pilots.create_pilot(campaign["id"], "Consistent")
    pilots.set_pilot_die_style(p["id"], "opal-pearl")
    updated = pilots.set_pilot_die_style(p["id"], "opal-pearl")
    assert updated["die_style"] == "opal-pearl"


def test_set_pilot_die_style_allows_same_style_in_different_campaigns(campaign):
    other = campaigns.create_campaign("Other Campaign")
    a = pilots.create_pilot(campaign["id"], "Here")
    b = pilots.create_pilot(other["id"], "There")
    pilots.set_pilot_die_style(a["id"], "opal-pearl")
    updated = pilots.set_pilot_die_style(b["id"], "opal-pearl")
    assert updated["die_style"] == "opal-pearl"


def test_set_pilot_die_style_rejects_style_taken_by_the_gm(campaign):
    p = pilots.create_pilot(campaign["id"], "Outranked")
    campaigns.set_gm_die_style(campaign["id"], "opal-pearl")
    with pytest.raises(dice_styles.DieStyleTaken):
        pilots.set_pilot_die_style(p["id"], "opal-pearl")
