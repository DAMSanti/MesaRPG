import pytest

from app.systems.dnd5e import characters, combat


@pytest.fixture
def attacker(dnd_campaign):
    return characters.create_character(dnd_campaign["id"], "Thorn", str=16)  # +3 mod


@pytest.fixture
def target(dnd_campaign):
    return characters.create_character(dnd_campaign["id"], "Elowen", ac=12, hp_max=10)


def test_roll_d20_range():
    for _ in range(200):
        assert 1 <= combat.roll_d20() <= 20


@pytest.mark.parametrize("dice,rolls,expected", [
    ("1d8+3", [5], 8),
    ("2d6", [3, 4], 7),
    ("1d4+1", [1], 2),
    ("5", [], 5),
])
def test_roll_damage_with_forced_rolls(monkeypatch, dice, rolls, expected):
    it = iter(rolls)
    monkeypatch.setattr(combat, "_roll_die", lambda sides: next(it))
    assert combat.roll_damage(dice) == expected


def test_roll_damage_rejects_garbage_notation():
    with pytest.raises(combat.InvalidDiceNotation):
        combat.roll_damage("not dice")


def test_resolve_attack_hit_applies_damage(monkeypatch, attacker, target):
    # attacker's +3 STR mod + a forced 15 = 18, beats target's AC 12
    monkeypatch.setattr(combat, "_roll_die", lambda sides: 15 if sides == 20 else 4)
    result = combat.resolve_attack(attacker["id"], target["id"], attack_mod=3, damage_dice="1d8+3")
    assert result["hit"] is True
    assert result["roll"] == 15
    assert result["total"] == 18
    assert result["damage"] == 7
    updated = characters.get_character(target["id"])
    assert updated["hp_current"] == 3  # 10 - 7


def test_resolve_attack_miss_applies_no_damage(monkeypatch, attacker, target):
    # +3 mod + forced 2 = 5, misses target's AC 12
    monkeypatch.setattr(combat, "_roll_die", lambda sides: 2 if sides == 20 else 4)
    result = combat.resolve_attack(attacker["id"], target["id"], attack_mod=3, damage_dice="1d8+3")
    assert result["hit"] is False
    assert result["damage"] == 0
    updated = characters.get_character(target["id"])
    assert updated["hp_current"] == 10


def test_resolve_attack_natural_20_always_hits(monkeypatch, attacker, target):
    # target AC set absurdly high — a real attack roll could never reach
    # it on the modifier alone, only a natural 20 should still connect.
    from app import db
    with db.connect() as conn:
        conn.execute("UPDATE dnd_characters SET ac = 999 WHERE id = ?", (target["id"],))
    monkeypatch.setattr(combat, "_roll_die", lambda sides: 20 if sides == 20 else 4)
    result = combat.resolve_attack(attacker["id"], target["id"], attack_mod=0, damage_dice="1d4")
    assert result["hit"] is True


def test_resolve_attack_natural_1_always_misses(monkeypatch, attacker, target):
    monkeypatch.setattr(combat, "_roll_die", lambda sides: 1 if sides == 20 else 4)
    result = combat.resolve_attack(attacker["id"], target["id"], attack_mod=999, damage_dice="1d4")
    assert result["hit"] is False
