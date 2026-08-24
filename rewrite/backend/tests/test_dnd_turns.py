import pytest

from app.systems.dnd5e import characters, turns


@pytest.fixture
def party(dnd_campaign):
    return [
        characters.create_character(dnd_campaign["id"], "Elowen", dex=18),  # +4
        characters.create_character(dnd_campaign["id"], "Thorn", dex=10),   # +0
        characters.create_character(dnd_campaign["id"], "Bram", dex=14),    # +2
    ]


def test_get_round_before_start_is_zero(dnd_campaign):
    state = turns.get_round(dnd_campaign["id"])
    assert state["round_number"] == 0
    assert state["rolls"] == []
    assert state["acted_character_ids"] == []


def test_start_round_rolls_initiative_for_every_character(monkeypatch, dnd_campaign, party):
    monkeypatch.setattr(turns, "_roll_d20", lambda: 10)
    state = turns.start_round(dnd_campaign["id"])
    assert state["round_number"] == 1
    assert len(state["rolls"]) == 3
    ids_rolled = {r["character_id"] for r in state["rolls"]}
    assert ids_rolled == {c["id"] for c in party}


def test_start_round_orders_descending_by_total(monkeypatch, dnd_campaign, party):
    # same forced d20 (10) for everyone — order should come purely from
    # each character's own DEX modifier: Elowen (+4) > Bram (+2) > Thorn (+0)
    monkeypatch.setattr(turns, "_roll_d20", lambda: 10)
    state = turns.start_round(dnd_campaign["id"])
    ordered_names = [
        next(c["name"] for c in party if c["id"] == r["character_id"])
        for r in state["rolls"]
    ]
    assert ordered_names == ["Elowen", "Bram", "Thorn"]


def test_initiative_ties_broken_by_character_id_ascending(monkeypatch, dnd_campaign):
    a = characters.create_character(dnd_campaign["id"], "A", dex=10)
    b = characters.create_character(dnd_campaign["id"], "B", dex=10)
    monkeypatch.setattr(turns, "_roll_d20", lambda: 10)
    state = turns.start_round(dnd_campaign["id"])
    assert [r["character_id"] for r in state["rolls"]] == [a["id"], b["id"]]


def test_starting_a_new_round_clears_prior_rolls_and_acted(monkeypatch, dnd_campaign, party):
    monkeypatch.setattr(turns, "_roll_d20", lambda: 10)
    state = turns.start_round(dnd_campaign["id"])
    turns.mark_acted(dnd_campaign["id"], party[0]["id"])
    assert turns.get_round(dnd_campaign["id"])["acted_character_ids"] == [party[0]["id"]]

    state2 = turns.start_round(dnd_campaign["id"])
    assert state2["round_number"] == 2
    assert state2["acted_character_ids"] == []
    assert len(state2["rolls"]) == 3


def test_mark_acted_is_idempotent(monkeypatch, dnd_campaign, party):
    monkeypatch.setattr(turns, "_roll_d20", lambda: 10)
    turns.start_round(dnd_campaign["id"])
    turns.mark_acted(dnd_campaign["id"], party[0]["id"])
    turns.mark_acted(dnd_campaign["id"], party[0]["id"])
    assert turns.get_round(dnd_campaign["id"])["acted_character_ids"] == [party[0]["id"]]
