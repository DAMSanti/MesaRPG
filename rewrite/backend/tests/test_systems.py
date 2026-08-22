import pytest

from app import systems


def test_battletech_is_hex():
    assert systems.grid_type_for("battletech") == "hex"


def test_dnd5e_is_square():
    assert systems.grid_type_for("dnd5e") == "square"


def test_unknown_system_raises():
    with pytest.raises(systems.UnknownGameSystem):
        systems.grid_type_for("shadowrun")


def test_registry_has_no_rules_content_yet():
    # S0 is deliberately rules-free — only grid_type should exist per system.
    for system_id, config in systems.GAME_SYSTEMS.items():
        assert set(config.keys()) == {"name", "grid_type"}, system_id
