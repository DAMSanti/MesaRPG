from pathlib import Path

import pytest

from app import mech_import

FIXTURE = (Path(__file__).parent / "fixtures" / "atlas_as7d.mtf").read_text()


def test_parse_mtf_extracts_chassis_and_model():
    parsed = mech_import.parse_mtf(FIXTURE)
    assert parsed["chassis"] == "Atlas"
    assert parsed["model"] == "AS7-D"


def test_parse_mtf_extracts_movement_and_tonnage():
    parsed = mech_import.parse_mtf(FIXTURE)
    assert parsed["tonnage"] == 100
    assert parsed["walk_mp"] == 3
    assert parsed["run_mp"] == 5  # ceil(3 * 1.5), MTF has no explicit run field
    assert parsed["jump_mp"] == 0
    assert parsed["heat_sinks"] == 20


def test_parse_mtf_extracts_armor_and_derived_structure_per_location():
    parsed = mech_import.parse_mtf(FIXTURE)
    locations = {loc["location"]: loc for loc in parsed["locations"]}

    assert locations["HD"]["armor_max"] == 9
    assert locations["HD"]["structure_max"] == 3

    assert locations["CT"]["armor_max"] == 47
    assert locations["CT"]["structure_max"] == 31
    assert locations["CT"]["armor_rear_max"] == 14

    assert locations["LT"]["armor_max"] == 32
    assert locations["LT"]["armor_rear_max"] == 10
    assert locations["RT"]["armor_max"] == 32
    assert locations["RT"]["armor_rear_max"] == 10

    assert locations["LA"]["armor_max"] == 34
    assert locations["LA"]["structure_max"] == 17
    assert locations["LA"].get("armor_rear_max") is None

    assert locations["LL"]["armor_max"] == 41
    assert locations["LL"]["structure_max"] == 21


def test_parse_mtf_extracts_weapons_with_known_catalog_names():
    parsed = mech_import.parse_mtf(FIXTURE)
    names = sorted(w["weapon_name"] for w in parsed["weapons"])
    assert names.count("Medium Laser") == 4
    assert "AC/20" in names
    assert "LRM 20" in names
    assert "SRM 6" in names


def test_parse_mtf_extracts_critical_slots_per_location():
    parsed = mech_import.parse_mtf(FIXTURE)
    crits = parsed["criticals"]
    assert crits["LA"][:6] == [
        "Shoulder", "Upper Arm Actuator", "Lower Arm Actuator",
        "Hand Actuator", "Heat Sink", "Medium Laser",
    ]
    assert crits["LA"][6:] == ["-Empty-"] * 6
    assert crits["HD"][:3] == ["Life Support", "Sensors", "Cockpit"]
    assert crits["CT"][:3] == ["Fusion Engine", "Fusion Engine", "Fusion Engine"]
    assert len(crits["RT"]) == 12


def test_parse_mtf_extracts_equipment_from_criticals():
    # atlas_as7d.mtf's Left/Right Arm each carry one lone "Heat Sink"
    # critical slot (a single, 1-slot Heat Sink — not the Double the
    # Akuma test elsewhere covers) alongside the arm's Medium Laser.
    parsed = mech_import.parse_mtf(FIXTURE)
    by_key = [(e["equipment_name"], e["location"]) for e in parsed["equipment"]]
    assert ("Heat Sink", "LA") in by_key
    assert ("Heat Sink", "RA") in by_key


def test_parse_mtf_weapon_locations_use_our_short_codes():
    parsed = mech_import.parse_mtf(FIXTURE)
    ac20 = next(w for w in parsed["weapons"] if w["weapon_name"] == "AC/20")
    assert ac20["location"] == "RT"
    lrm20 = next(w for w in parsed["weapons"] if w["weapon_name"] == "LRM 20")
    assert lrm20["location"] == "LT"


def test_structure_for_tonnage_matches_atlas_fixture_conftest():
    from tests.conftest import ATLAS_LOCATIONS

    by_loc = {loc["location"]: loc["structure_max"] for loc in ATLAS_LOCATIONS}
    for loc, expected in by_loc.items():
        assert mech_import.structure_for_tonnage(100, loc) == expected


def test_parse_mtf_rejects_a_quad():
    # Our whole data model (MECH_LOCATIONS, the fixed critical-slot
    # template) assumes 8 biped locations — a Quad's MTF uses different
    # location names this parser was never taught, so it must refuse
    # rather than silently produce wrong armor/criticals.
    quad_text = FIXTURE.replace("Config:Biped", "Config:Quad")
    with pytest.raises(mech_import.NotBiped):
        mech_import.parse_mtf(quad_text)


def test_parse_mtf_rejects_missing_config_line():
    no_config_text = FIXTURE.replace("Config:Biped\n", "")
    with pytest.raises(mech_import.NotBiped):
        mech_import.parse_mtf(no_config_text)


def test_structure_for_tonnage_rejects_unknown_tonnage():
    import pytest

    with pytest.raises(mech_import.UnknownTonnage):
        mech_import.structure_for_tonnage(37, "CT")


# Newer/advanced-tech MTF files (e.g. the real Akuma AKU-2X pulled from
# the sync source) spell every weapon line as
# "<count> <ISprefix><Name>, <Location>[, Ammo:N]" instead of the plain
# "Name, Location" the atlas_as7d.mtf fixture above uses — this used to
# both mis-parse the name and, for any line with a third comma-separated
# field, silently drop the weapon entirely (location lookup failed on
# "Right Torso, Ammo:20" as a whole string).
AKUMA_WEAPONS_SECTION = """Weapons:5
1 ISC3SlaveUnit, Center Torso
1 ISLBXAC10, Right Torso, Ammo:20
1 ISMRM40, Left Torso, Ammo:18
1 ISHeavyPPC, Left Arm
1 ISMediumLaser, Left Arm
"""


def _fixture_with_weapons_section(new_section: str) -> str:
    before, _, after = FIXTURE.partition("Weapons:7\n")
    _, _, rest = after.partition("\n\n")
    return before + new_section + "\n" + rest


def test_parse_mtf_does_not_drop_weapon_lines_with_a_trailing_ammo_field():
    parsed = mech_import.parse_mtf(_fixture_with_weapons_section(AKUMA_WEAPONS_SECTION))
    assert len(parsed["weapons"]) == 5
    by_location = [(w["weapon_name"], w["location"]) for w in parsed["weapons"]]
    assert ("LB 10-X AC", "RT") in by_location
    assert ("MRM 40", "LT") in by_location


def test_parse_mtf_normalizes_quantity_and_tech_base_prefixed_names():
    parsed = mech_import.parse_mtf(_fixture_with_weapons_section(AKUMA_WEAPONS_SECTION))
    names = {w["weapon_name"] for w in parsed["weapons"]}
    # Known to our catalog once the "1 " count and "IS" tech-base prefix
    # are stripped and matched against MTF_WEAPON_ALIASES.
    assert "Medium Laser" in names
    # Not in app/weapons.py's WEAPON_CATALOG (C3 gear is electronics, out
    # of scope for the weapons pass) — left as a cleaned-up name rather
    # than the raw "1 ISC3SlaveUnit" so at least it reads sanely wherever
    # it's surfaced as "unsupported". Aliased to "C3 Slave Unit" (not the
    # generic CamelSplit's "C 3 Slave Unit") so it matches
    # app/equipment.py's EQUIPMENT_CATALOG key exactly.
    assert "C3 Slave Unit" in names
    # Heavy PPC *is* now modeled (2026-08-21 catalog expansion).
    assert "Heavy PPC" in names


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # All-caps runs with no internal lowercase have no CamelCase
        # boundary to split on — needs a literal alias.
        ("1 ISERPPC", "ER PPC"),
        # Concatenated family names that don't decompose into their
        # Sarna-style spelling mechanically (word order/symbol changes).
        ("1 ISRotaryAC5", "Rotary AC/5"),
        ("1 ISUltraAC10", "Ultra AC/10"),
        ("1 ISLBXAC10", "LB 10-X AC"),
        ("1 ISHAG20", "HAG/20"),
        # CamelSplit can't tell "X-Pulse" keeps its hyphen — both the
        # concatenated and the already-hyphenated spaced form must land
        # on the same canonical name.
        ("1 ISMediumXPulseLaser", "Medium X-Pulse Laser"),
        ("Medium X-Pulse Laser", "Medium X-Pulse Laser"),
        # A "Prototype"/"Improved" wrapper doesn't change stats in this
        # app's scope, whether it's a separate word or glued on.
        ("1 Improved Heavy Gauss Rifle", "Heavy Gauss Rifle"),
        ("1 ISImprovedHeavyGaussRifle", "Heavy Gauss Rifle"),
        ("1 ISMediumPulseLaserPrototype", "Medium Pulse Laser"),
        ("1 SRM 6 (OS)", "SRM 6"),
    ],
)
def test_normalize_weapon_name_handles_real_catalog_variants(raw, expected):
    assert mech_import._normalize_mtf_item_name(raw) == expected


def test_criticals_get_the_same_name_cleanup_as_weapons():
    # The exact Akuma AKU-2X critical lines that used to show up raw in
    # the record sheet's Tabla de Críticos ("ISHeavyPPC" instead of
    # "Heavy PPC") even though the same weapon was already correctly
    # recognized in the Weapons: section above it.
    text = (
        FIXTURE.split("Left Arm:")[0]
        + "Left Arm:\n"
        + "Shoulder\n"
        + "ISDouble Heat Sink\n"
        + "ISHeavyPPC\n"
        + "ISMediumPulseLaser\n"
        + "Endo-Steel\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "-Empty-\n"
        + "\n"
    )
    parsed = mech_import.parse_mtf(text)
    la = parsed["criticals"]["LA"]
    assert "Heavy PPC" in la
    assert "Medium Pulse Laser" in la
    assert "Double Heat Sink" in la
    assert "Endo-Steel" in la
    assert "-Empty-" in la
    assert "ISHeavyPPC" not in la
