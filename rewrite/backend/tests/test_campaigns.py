import pytest

from app import campaigns, dice_styles, systems
from app.systems.battletech import mechs, pilots
from tests.conftest import ATLAS_LOCATIONS


def test_new_campaign_defaults_to_battletech():
    c = campaigns.create_campaign("No system specified")
    assert c["system"] == "battletech"
    assert c["grid_type"] == "hex"


def test_create_campaign_with_dnd5e_system():
    c = campaigns.create_campaign("Curse of Strahd", system="dnd5e")
    assert c["system"] == "dnd5e"
    assert c["grid_type"] == "square"


def test_create_campaign_rejects_unknown_system():
    with pytest.raises(systems.UnknownGameSystem):
        campaigns.create_campaign("Broken", system="shadowrun")


def test_list_campaigns_includes_pilot_and_mech_counts(campaign):
    pilots.create_pilot(campaign["id"], "Pilot A")
    p2 = pilots.create_pilot(campaign["id"], "Pilot B")
    mechs.create_mech(
        campaign_id=campaign["id"],
        chassis="Locust",
        tonnage=20,
        walk_mp=8,
        run_mp=12,
        pilot_id=p2["id"],
        locations=ATLAS_LOCATIONS,
    )

    listed = campaigns.list_campaigns()
    entry = next(c for c in listed if c["id"] == campaign["id"])
    assert entry["pilot_count"] == 2
    assert entry["mech_count"] == 1


def test_list_campaigns_zero_counts_for_empty_campaign(campaign):
    listed = campaigns.list_campaigns()
    entry = next(c for c in listed if c["id"] == campaign["id"])
    assert entry["pilot_count"] == 0
    assert entry["mech_count"] == 0


def test_new_campaign_defaults_to_team_initiative_mode(campaign):
    assert campaign["initiative_mode"] == "team"


def test_set_initiative_mode_to_individual(campaign):
    updated = campaigns.set_initiative_mode(campaign["id"], "individual")
    assert updated["initiative_mode"] == "individual"


def test_set_initiative_mode_rejects_unknown_mode(campaign):
    with pytest.raises(campaigns.UnknownInitiativeMode):
        campaigns.set_initiative_mode(campaign["id"], "chaotic")


def test_new_campaign_defaults_to_no_gm_die_style(campaign):
    assert campaign["gm_die_style"] is None


def test_new_campaign_defaults_to_enemy_reveal_cinematic_enabled(campaign):
    assert campaign["enemy_reveal_cinematic"] is True


def test_set_enemy_reveal_cinematic_can_disable_and_reenable(campaign):
    disabled = campaigns.set_enemy_reveal_cinematic(campaign["id"], False)
    assert disabled["enemy_reveal_cinematic"] is False
    reenabled = campaigns.set_enemy_reveal_cinematic(campaign["id"], True)
    assert reenabled["enemy_reveal_cinematic"] is True


def test_new_campaign_defaults_to_physical_gm_dice_mode(campaign):
    assert campaign["gm_dice_mode"] == "physical"


def test_set_gm_dice_mode_to_auto_and_back(campaign):
    updated = campaigns.set_gm_dice_mode(campaign["id"], "auto")
    assert updated["gm_dice_mode"] == "auto"
    back = campaigns.set_gm_dice_mode(campaign["id"], "physical")
    assert back["gm_dice_mode"] == "physical"


def test_set_gm_dice_mode_rejects_unknown_mode(campaign):
    with pytest.raises(pilots.UnknownDiceMode):
        campaigns.set_gm_dice_mode(campaign["id"], "telepathic")


def test_set_gm_die_style_sets_and_clears(campaign):
    updated = campaigns.set_gm_die_style(campaign["id"], "chrome-metallic")
    assert updated["gm_die_style"] == "chrome-metallic"
    cleared = campaigns.set_gm_die_style(campaign["id"], None)
    assert cleared["gm_die_style"] is None


def test_set_gm_die_style_rejects_unknown_style(campaign):
    with pytest.raises(dice_styles.UnknownDieStyle):
        campaigns.set_gm_die_style(campaign["id"], "not-a-real-style")


def test_set_gm_die_style_rejects_style_taken_by_a_pilot(campaign):
    p = pilots.create_pilot(campaign["id"], "First Claim")
    pilots.set_pilot_die_style(p["id"], "opal-pearl")
    with pytest.raises(dice_styles.DieStyleTaken):
        campaigns.set_gm_die_style(campaign["id"], "opal-pearl")
