import pytest

from app import equipment


def test_catalog_covers_the_common_equipment_the_mech_catalog_actually_uses():
    expected = {
        "Heat Sink", "Double Heat Sink", "Jump Jet", "Endo-Steel",
        "Ferro-Fibrous", "CASE", "Artemis IV FCS", "Guardian ECM Suite",
        "Beagle Active Probe", "TAG", "C3 Slave Unit", "Apollo FCS",
    }
    assert expected.issubset(equipment.EQUIPMENT_CATALOG)


def test_every_equipment_entry_has_complete_stats():
    required_keys = {"slots", "heat_dissipation", "jump_bonus"}
    for name, stats in equipment.EQUIPMENT_CATALOG.items():
        assert set(stats) == required_keys, name
        assert stats["slots"] > 0


def test_double_heat_sink_dissipates_twice_a_standard_heat_sink():
    assert equipment.get_equipment("Heat Sink")["heat_dissipation"] == 1
    assert equipment.get_equipment("Double Heat Sink")["heat_dissipation"] == 2


def test_only_heat_sinks_and_jump_jets_have_numeric_effects():
    # Everything else in the catalog is informational only (no simulated
    # mechanic yet) — same principle as WEAPON_CATALOG's unused `heat`
    # field before combat.py wired it up.
    for name, stats in equipment.EQUIPMENT_CATALOG.items():
        if name in ("Heat Sink", "Double Heat Sink"):
            assert stats["heat_dissipation"] is not None
        else:
            assert stats["heat_dissipation"] is None
        if name == "Jump Jet":
            assert stats["jump_bonus"] is not None
        else:
            assert stats["jump_bonus"] is None


def test_get_equipment_rejects_unknown_name():
    with pytest.raises(equipment.UnknownEquipment):
        equipment.get_equipment("Death Ray")


def test_equipment_from_criticals_matches_real_akuma_double_heat_sink_blocks():
    # The Akuma AKU-1X's real critical layout: 3 consecutive "Double Heat
    # Sink" slots each in CT and LA (the IS Double Heat Sink's real
    # 3-slot size, confirmed against this exact mech), plus scattered
    # single-slot Endo-Steel and two Jump Jets in a leg.
    criticals = {
        "CT": ["Engine", "Engine", "Engine", "Gyro", "Gyro", "Gyro", "Gyro",
               "Engine", "Engine", "Engine", "Double Heat Sink", "Double Heat Sink"],
        "LA": ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator",
               "Double Heat Sink", "Double Heat Sink", "Double Heat Sink",
               "Endo-Steel", "-Empty-", "-Empty-", "-Empty-", "-Empty-", "-Empty-"],
        "LL": ["Hip", "Upper Leg Actuator", "Jump Jet", "Jump Jet", "Endo-Steel", "Endo-Steel"],
    }
    result = equipment.equipment_from_criticals(criticals)
    by_key = [(e["equipment_name"], e["location"]) for e in result]

    # CT only has 2 of the 3 Double Heat Sink slots (the rest of that
    # mech's block sits elsewhere in the real file) — incomplete, dropped.
    assert by_key.count(("Double Heat Sink", "CT")) == 0
    # LA has the full 3-slot block on its own.
    assert by_key.count(("Double Heat Sink", "LA")) == 1
    assert by_key.count(("Jump Jet", "LL")) == 2
    assert by_key.count(("Endo-Steel", "LA")) == 1
    assert by_key.count(("Endo-Steel", "LL")) == 2


def test_equipment_from_criticals_ignores_unrecognized_and_incomplete_blocks():
    criticals = {
        "HD": ["Life Support", "Sensors", "Cockpit"],
        "LA": ["Double Heat Sink", "Double Heat Sink"],  # only 2 of 3 slots — incomplete
    }
    result = equipment.equipment_from_criticals(criticals)
    assert result == []
