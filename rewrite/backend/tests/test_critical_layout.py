from app.critical_layout import EMPTY, generate_default_criticals


def test_empty_loadout_is_all_fixed_components_and_empty_slots():
    layout = generate_default_criticals([])
    assert layout["HD"] == ["Life Support", "Sensors", "Cockpit", EMPTY, "Sensors", "Life Support"]
    assert layout["CT"][:10] == ["Engine", "Engine", "Engine", "Gyro", "Gyro", "Gyro", "Gyro", "Engine", "Engine", "Engine"]
    assert layout["CT"][10:] == [EMPTY, EMPTY]
    assert layout["LT"] == [EMPTY] * 12
    assert layout["LA"][:4] == ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator"]
    assert layout["LA"][4:] == [EMPTY] * 8
    assert layout["LL"] == ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", EMPTY, EMPTY]
    for location in ("HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"):
        assert location in layout


def test_small_weapon_fits_without_removing_actuators():
    layout = generate_default_criticals([{"weapon_name": "Medium Laser", "location": "RA"}])
    assert layout["RA"][:4] == ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator"]
    assert layout["RA"][4] == "Medium Laser"
    assert layout["RA"][5:] == [EMPTY] * 7


def test_multi_slot_weapon_repeats_its_name_across_consecutive_slots():
    layout = generate_default_criticals([{"weapon_name": "PPC", "location": "RT"}])
    assert layout["RT"][:3] == ["PPC", "PPC", "PPC"]
    assert layout["RT"][3:] == [EMPTY] * 9


def test_ac20_in_an_arm_removes_both_actuators_to_fit():
    # Same real-world shape as the Atlas AS7-D's arm-mounted AC/20 — 10
    # critical slots need both the hand and lower arm actuators gone to
    # fit in a 12-slot arm alongside the fixed shoulder + upper arm.
    layout = generate_default_criticals([{"weapon_name": "AC/20", "location": "RA"}])
    assert layout["RA"][0] == "Shoulder"
    assert layout["RA"][1] == "Upper Arm Actuator"
    assert "Lower Arm Actuator" not in layout["RA"]
    assert "Hand Actuator" not in layout["RA"]
    assert layout["RA"].count("AC/20") == 10


def test_two_weapons_in_the_same_location_place_in_mount_order():
    layout = generate_default_criticals([
        {"weapon_name": "Medium Laser", "location": "LT"},
        {"weapon_name": "Large Laser", "location": "LT"},
    ])
    assert layout["LT"][0] == "Medium Laser"
    assert layout["LT"][1:3] == ["Large Laser", "Large Laser"]
    assert layout["LT"][3:] == [EMPTY] * 9


def test_weapon_that_cannot_fit_is_dropped_not_crashed():
    # A center torso only has 2 free slots (the rest are engine/gyro) — an
    # AC/20 (10 slots) can never fit there. Nothing should raise; the
    # weapon is simply absent from the generated layout (crit-capacity
    # validation at mount time is a separate, not-yet-built concern).
    layout = generate_default_criticals([{"weapon_name": "AC/20", "location": "CT"}])
    assert "AC/20" not in layout["CT"]
    assert layout["CT"][10:] == [EMPTY, EMPTY]


def test_unknown_weapon_name_is_ignored_not_crashed():
    layout = generate_default_criticals([{"weapon_name": "Death Ray", "location": "RA"}])
    assert layout["RA"][4:] == [EMPTY] * 8
