import pytest

from app.systems.battletech import weapons


def test_catalog_has_the_standard_inner_sphere_loadout():
    expected = {
        "Small Laser", "Medium Laser", "Large Laser", "PPC", "Machine Gun",
        "AC/2", "AC/5", "AC/10", "AC/20",
        "SRM 2", "SRM 4", "SRM 6", "LRM 5", "LRM 10", "LRM 15", "LRM 20",
    }
    assert expected.issubset(weapons.WEAPON_CATALOG)


def test_catalog_covers_the_advanced_tech_weapons_the_mech_catalog_actually_uses():
    # Added 2026-08-21 once the local mech_templates catalog (2840 real
    # 'Mechs) showed these were the highest-frequency weapon mounts the
    # original Introductory-tech-only 16 entries couldn't match. A
    # representative spot check, not the full ~60-entry addition.
    expected = {
        "ER Medium Laser", "ER PPC", "Gauss Rifle", "Streak SRM 6",
        "LB 10-X AC", "Ultra AC/5", "Snub-Nose PPC", "Heavy PPC",
        "Plasma Rifle", "MML 5", "ATM 6", "HAG/20", "MRM 20",
    }
    assert expected.issubset(weapons.WEAPON_CATALOG)


def test_every_weapon_has_complete_stats():
    required_keys = {"damage", "heat", "min_range", "short", "medium", "long", "ammo_per_ton", "slots"}
    for name, stats in weapons.WEAPON_CATALOG.items():
        assert set(stats) == required_keys, name
        assert stats["damage"] > 0
        assert stats["short"] < stats["medium"] < stats["long"]
        assert stats["slots"] > 0


def test_missile_weapon_damage_is_missile_count_times_per_missile_damage():
    # SRM missiles do 2 damage each, LRM missiles do 1 each — the flat
    # "damage" field is the max volley total, not a cluster-table average.
    assert weapons.get_weapon("SRM 6")["damage"] == 12
    assert weapons.get_weapon("LRM 20")["damage"] == 20


def test_get_weapon_rejects_unknown_name():
    with pytest.raises(weapons.UnknownWeapon):
        weapons.get_weapon("Death Ray")


def test_advanced_weapon_stats_match_sarna_spot_check_2026_08_21():
    # Values fetched directly from Sarna.net (BattleTechWiki) on
    # 2026-08-21 while building the expanded catalog — pinned here so a
    # future edit can't silently drift from the source.
    assert weapons.get_weapon("Snub-Nose PPC")["heat"] == 10
    assert weapons.get_weapon("Heavy PPC") == {
        "damage": 15, "heat": 15, "min_range": 3, "short": 6, "medium": 12,
        "long": 18, "ammo_per_ton": None, "slots": 4,
    }
    assert weapons.get_weapon("Gauss Rifle") == {
        "damage": 15, "heat": 1, "min_range": 2, "short": 7, "medium": 15,
        "long": 22, "ammo_per_ton": 8, "slots": 7,
    }
    assert weapons.get_weapon("Plasma Rifle") == {
        "damage": 10, "heat": 10, "min_range": 0, "short": 5, "medium": 10,
        "long": 15, "ammo_per_ton": 10, "slots": 2,
    }
    assert weapons.get_weapon("MRM 20") == {
        "damage": 20, "heat": 6, "min_range": 0, "short": 3, "medium": 8,
        "long": 15, "ammo_per_ton": 12, "slots": 3,
    }
