from app import campaigns, dice_resolution
from app.systems.battletech import pilots


def test_dice_mode_for_none_pilot_is_auto():
    assert dice_resolution._dice_mode_for(None) == "auto"


def test_dice_mode_for_player_pilot_uses_their_own_dice_mode(campaign):
    p = pilots.create_pilot(campaign["id"], "Widow", faction="player")
    pilots.update_pilot(p["id"], dice_mode="auto")
    assert dice_resolution._dice_mode_for(p["id"]) == "auto"


def test_dice_mode_for_enemy_pilot_ignores_its_own_dice_mode(campaign):
    # Real user correction: "lo del GM no tiene que ser por piloto...
    # O TODOS SUS PILOTOS TIRAN AUTOMATICO O TODOS TIRAN FISICO" — the
    # campaign's gm_dice_mode is the ONLY thing that matters for an
    # enemy/npc pilot, regardless of whatever their own dice_mode column
    # happens to hold.
    p = pilots.create_pilot(campaign["id"], "Hostile Lance Leader", faction="enemy")
    pilots.update_pilot(p["id"], dice_mode="auto")
    campaigns.set_gm_dice_mode(campaign["id"], "physical")
    assert dice_resolution._dice_mode_for(p["id"]) == "physical"


def test_dice_mode_for_npc_pilot_follows_gm_dice_mode(campaign):
    p = pilots.create_pilot(campaign["id"], "Bystander", faction="npc")
    campaigns.set_gm_dice_mode(campaign["id"], "auto")
    assert dice_resolution._dice_mode_for(p["id"]) == "auto"


def test_dice_mode_for_enemy_pilot_follows_gm_dice_mode_switching(campaign):
    p = pilots.create_pilot(campaign["id"], "Switcher", faction="enemy")
    campaigns.set_gm_dice_mode(campaign["id"], "auto")
    assert dice_resolution._dice_mode_for(p["id"]) == "auto"
    campaigns.set_gm_dice_mode(campaign["id"], "physical")
    assert dice_resolution._dice_mode_for(p["id"]) == "physical"
