from app import mech_templates

ATLAS_PAYLOAD = {
    "walk_mp": 3, "run_mp": 5, "jump_mp": 0, "heat_sinks": 20,
    "locations": [{"location": "HD", "armor_max": 9, "structure_max": 3}],
    "weapons": [{"weapon_name": "AC/20", "location": "RT"}],
    "criticals": {"HD": ["Life Support", "Sensors", "Cockpit"]},
}


def test_get_template_returns_none_for_unknown_file():
    assert mech_templates.get_template("Nonexistent Mech.mtf") is None


def test_upsert_then_get_round_trips_the_full_payload():
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, ATLAS_PAYLOAD)
    result = mech_templates.get_template("Atlas AS7-D.mtf")
    assert result["chassis"] == "Atlas"
    assert result["model"] == "AS7-D"
    assert result["tonnage"] == 100
    assert result["weapons"] == ATLAS_PAYLOAD["weapons"]
    assert result["criticals"] == ATLAS_PAYLOAD["criticals"]


def test_upsert_is_idempotent_by_source_file():
    mech_templates.upsert_template("Locust LCT-1V.mtf", "Locust", "LCT-1V", 20, ATLAS_PAYLOAD)
    updated_payload = {**ATLAS_PAYLOAD, "walk_mp": 8}
    mech_templates.upsert_template("Locust LCT-1V.mtf", "Locust", "LCT-1V", 20, updated_payload)
    result = mech_templates.get_template("Locust LCT-1V.mtf")
    assert result["walk_mp"] == 8
    # Re-upserting the same source_file replaces, it doesn't duplicate.
    assert mech_templates.search_templates("Locust")[0]["file"] == "Locust LCT-1V.mtf"
    assert len(mech_templates.search_templates("Locust")) == 1


def test_search_matches_chassis_or_model_case_insensitively():
    mech_templates.upsert_template("Warhammer WHM-6R.mtf", "Warhammer", "WHM-6R", 70, ATLAS_PAYLOAD)
    by_chassis = mech_templates.search_templates("warhammer")
    assert any(r["file"] == "Warhammer WHM-6R.mtf" for r in by_chassis)
    by_model = mech_templates.search_templates("6R")
    assert any(r["file"] == "Warhammer WHM-6R.mtf" for r in by_model)


def test_search_with_empty_query_returns_nothing():
    assert mech_templates.search_templates("") == []
    assert mech_templates.search_templates("   ") == []


def test_search_result_name_combines_chassis_and_model():
    mech_templates.upsert_template("Marauder MAD-3R.mtf", "Marauder", "MAD-3R", 75, ATLAS_PAYLOAD)
    result = next(r for r in mech_templates.search_templates("Marauder") if r["file"] == "Marauder MAD-3R.mtf")
    assert result["name"] == "Marauder MAD-3R"


def test_template_count_reflects_stored_rows():
    before = mech_templates.template_count()
    mech_templates.upsert_template("Catapult CPLT-C1.mtf", "Catapult", "CPLT-C1", 65, ATLAS_PAYLOAD)
    assert mech_templates.template_count() == before + 1


def test_list_chassis_is_distinct_and_sorted():
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, ATLAS_PAYLOAD)
    mech_templates.upsert_template("Atlas AS7-K.mtf", "Atlas", "AS7-K", 100, ATLAS_PAYLOAD)
    mech_templates.upsert_template("Banshee BNC-3E.mtf", "Banshee", "BNC-3E", 95, ATLAS_PAYLOAD)
    assert mech_templates.list_chassis() == ["Atlas", "Banshee"]


def test_list_models_for_a_chassis():
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, ATLAS_PAYLOAD)
    mech_templates.upsert_template("Atlas AS7-D-DC.mtf", "Atlas", "AS7-D-DC", 100, ATLAS_PAYLOAD)
    mech_templates.upsert_template("Banshee BNC-3E.mtf", "Banshee", "BNC-3E", 95, ATLAS_PAYLOAD)

    models = mech_templates.list_models("Atlas")
    assert {m["model"] for m in models} == {"AS7-D", "AS7-D-DC"}
    assert all(m["file"].startswith("Atlas") for m in models)


def test_list_models_for_unknown_chassis_is_empty():
    assert mech_templates.list_models("Nonexistent Chassis") == []
