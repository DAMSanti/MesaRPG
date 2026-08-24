import pytest

from app import campaigns
from app.systems.dnd5e import characters


def test_create_character_defaults(dnd_campaign):
    char = characters.create_character(dnd_campaign["id"], "Elowen")
    assert char["name"] == "Elowen"
    assert char["str"] == 10
    assert char["dex"] == 10
    assert char["con"] == 10
    assert char["int"] == 10
    assert char["wis"] == 10
    assert char["cha"] == 10
    assert char["ac"] == 10
    assert char["hp_current"] == 10
    assert char["hp_max"] == 10
    assert char["proficiency_bonus"] == 2


def test_create_character_with_real_ability_scores(dnd_campaign):
    char = characters.create_character(
        dnd_campaign["id"], "Thorn", str=16, dex=14, con=15, int=8, wis=12, cha=10,
        ac=16, hp_max=25, proficiency_bonus=3,
    )
    assert char["str"] == 16
    assert char["dex"] == 14
    assert char["hp_max"] == 25
    assert char["hp_current"] == 25  # starts full, not the default 10
    assert char["proficiency_bonus"] == 3


@pytest.mark.parametrize("score,expected_mod", [
    (1, -5), (8, -1), (9, -1), (10, 0), (11, 0), (12, 1), (14, 2), (16, 3), (20, 5),
])
def test_ability_modifier(score, expected_mod):
    assert characters.ability_modifier(score) == expected_mod


def test_get_character_round_trips(dnd_campaign):
    created = characters.create_character(dnd_campaign["id"], "Bram", dex=14)
    fetched = characters.get_character(created["id"])
    assert fetched == created


def test_get_unknown_character_is_none():
    assert characters.get_character(999999) is None


def test_list_characters_scoped_to_campaign(dnd_campaign):
    other = campaigns.create_campaign("Other D&D Campaign", "dnd5e")
    characters.create_character(dnd_campaign["id"], "Elowen")
    characters.create_character(dnd_campaign["id"], "Thorn")
    characters.create_character(other["id"], "Stranger")
    names = {c["name"] for c in characters.list_characters(dnd_campaign["id"])}
    assert names == {"Elowen", "Thorn"}


def test_update_hp_clamps_at_zero(dnd_campaign):
    char = characters.create_character(dnd_campaign["id"], "Elowen", hp_max=10)
    damaged = characters.update_hp(char["id"], -25)
    assert damaged["hp_current"] == 0


def test_update_hp_clamps_at_max(dnd_campaign):
    char = characters.create_character(dnd_campaign["id"], "Elowen", hp_max=10)
    characters.update_hp(char["id"], -5)
    healed = characters.update_hp(char["id"], 999)
    assert healed["hp_current"] == 10
