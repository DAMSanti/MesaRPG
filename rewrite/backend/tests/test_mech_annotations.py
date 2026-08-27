import pytest

from app import mech_annotations


def test_save_and_list_annotations():
    points = [
        {"kind": "weapon", "location": "RA", "x": 0.3, "y": 0.6, "z": 0.1},
        {"kind": "cockpit", "location": None, "x": 0.0, "y": 0.9, "z": 0.15},
    ]
    saved = mech_annotations.save_annotations("/models/mechs/atlas-as7-d.glb", points)
    assert len(saved) == 2
    assert {p["kind"] for p in saved} == {"weapon", "cockpit"}

    listed = mech_annotations.list_annotations()
    urls = {row["model_url"] for row in listed}
    assert "/models/mechs/atlas-as7-d.glb" in urls


def test_saving_again_replaces_instead_of_duplicating():
    url = "/models/mechs/locust-lct-1v.glb"
    mech_annotations.save_annotations(url, [{"kind": "weapon", "location": "RA", "x": 0.1, "y": 0.5, "z": 0.1}])
    replaced = mech_annotations.save_annotations(
        url, [{"kind": "weapon", "location": "LA", "x": -0.1, "y": 0.5, "z": 0.1}]
    )
    assert len(replaced) == 1
    assert replaced[0]["location"] == "LA", "the RA point from the first save is gone, not duplicated alongside"


def test_saving_an_empty_point_list_clears_existing_annotations():
    url = "/models/mechs/locust-lct-1v.glb"
    mech_annotations.save_annotations(url, [{"kind": "cockpit", "location": None, "x": 0, "y": 0.9, "z": 0.1}])
    cleared = mech_annotations.save_annotations(url, [])
    assert cleared == []


def test_rejects_unknown_kind():
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "propulsion", "location": None, "x": 0, "y": 0, "z": 0}]
        )


def test_rejects_unknown_location_for_a_weapon_point():
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "weapon", "location": "TAIL", "x": 0, "y": 0, "z": 0}]
        )


def test_rejects_a_location_on_a_cockpit_point():
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "cockpit", "location": "HD", "x": 0, "y": 0, "z": 0}]
        )


def test_save_and_list_a_limb_annotation():
    saved = mech_annotations.save_annotations(
        "/models/mechs/atlas-as7-d.glb",
        [{"kind": "limb", "location": "RA", "mesh_names": ["UpperArm_R", "Forearm_R", "Hand_R"]}],
    )
    assert len(saved) == 1
    assert saved[0]["mesh_names"] == ["UpperArm_R", "Forearm_R", "Hand_R"]


def test_limb_rejects_a_torso_or_head_location():
    # Real Total Warfare rule this app already follows elsewhere: losing
    # CT/HD is mech death, not a detachable part.
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "limb", "location": "CT", "mesh_names": ["Torso"]}]
        )


def test_limb_rejects_a_non_list_mesh_names():
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "limb", "location": "RA", "mesh_names": "UpperArm_R"}]
        )


def test_invalid_point_rejects_the_whole_save_before_writing_anything():
    # Real "fail before writing anything, not after" precedent this
    # codebase already follows elsewhere (pilots._check_pin, etc.).
    url = "/models/mechs/atlas-as7-d.glb"
    before = mech_annotations.save_annotations(url, [{"kind": "cockpit", "location": None, "x": 0, "y": 0.9, "z": 0.1}])
    assert len(before) == 1
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            url,
            [
                {"kind": "weapon", "location": "RA", "x": 0.3, "y": 0.6, "z": 0.1},
                {"kind": "weapon", "location": "NOWHERE", "x": 0, "y": 0, "z": 0},
            ],
        )
    still_there = [row for row in mech_annotations.list_annotations() if row["model_url"] == url]
    assert len(still_there) == 1, "the rejected save must not have touched the existing cockpit point"


def test_save_and_list_a_hit_annotation():
    saved = mech_annotations.save_annotations(
        "/models/mechs/atlas-as7-d.glb", [{"kind": "hit", "location": "CT", "x": 0, "y": 0.6, "z": 0.15}]
    )
    assert len(saved) == 1
    assert saved[0]["kind"] == "hit"
    assert saved[0]["location"] == "CT"


def test_hit_allows_head_and_torso_unlike_limb():
    # Real distinction from 'limb': a hit point marks where an attack's VFX
    # visually lands, which applies to every location including HD/CT (mech
    # death there doesn't mean it can't be shown taking a hit first).
    saved = mech_annotations.save_annotations(
        "/models/mechs/atlas-as7-d.glb", [{"kind": "hit", "location": "HD", "x": 0, "y": 0.95, "z": 0.1}]
    )
    assert saved[0]["location"] == "HD"


def test_hit_rejects_unknown_location():
    with pytest.raises(mech_annotations.InvalidAnnotation):
        mech_annotations.save_annotations(
            "/models/mechs/atlas-as7-d.glb", [{"kind": "hit", "location": "TAIL", "x": 0, "y": 0, "z": 0}]
        )


def test_set_and_list_review_status():
    url = "/models/mechs/atlas-as7-d.glb"
    row = mech_annotations.set_review_status(url, "weapons", "done")
    assert row == {"model_url": url, "track": "weapons", "status": "done", "updated_at": row["updated_at"]}

    listed = mech_annotations.list_review()
    assert {"model_url": url, "track": "weapons", "status": "done", "updated_at": row["updated_at"]} in listed


def test_setting_review_status_again_updates_instead_of_duplicating():
    url = "/models/mechs/locust-lct-1v.glb"
    mech_annotations.set_review_status(url, "rig", "done")
    mech_annotations.set_review_status(url, "rig", "accepted")

    matches = [row for row in mech_annotations.list_review() if row["model_url"] == url and row["track"] == "rig"]
    assert len(matches) == 1
    assert matches[0]["status"] == "accepted"


def test_review_status_rejects_unknown_track():
    with pytest.raises(mech_annotations.InvalidReview):
        mech_annotations.set_review_status("/models/mechs/atlas-as7-d.glb", "paintjob", "done")


def test_review_status_rejects_unknown_status():
    with pytest.raises(mech_annotations.InvalidReview):
        mech_annotations.set_review_status("/models/mechs/atlas-as7-d.glb", "weapons", "in_progress")


def test_texture_is_a_valid_review_track():
    # MechLabView's 4th tab (Textura) — "quiero poder guardarlo... como lo
    # demas, 3 estados y un marcador en el desplegable".
    url = "/models/mechs/atlas-as7-d.glb"
    row = mech_annotations.set_review_status(url, "texture", "accepted")
    assert row["track"] == "texture"
    assert row["status"] == "accepted"


PBR_SETTINGS = {
    "repeat": 8.0,
    "normal_scale": 0.6,
    "roughness": 0.6,
    "metalness": 0.24,
    "color_boost": 1.7,
    "ao_intensity": 0.6,
}


def test_save_and_list_pbr_settings():
    url = "/models/mechs/jenner-jr7-f.glb"
    saved = mech_annotations.save_pbr_settings(url, PBR_SETTINGS)
    assert saved["model_url"] == url
    for field, value in PBR_SETTINGS.items():
        assert saved[field] == value

    listed = mech_annotations.list_pbr_settings()
    assert any(row["model_url"] == url for row in listed)


def test_saving_pbr_settings_again_replaces_instead_of_duplicating():
    url = "/models/mechs/locust-lct-1v.glb"
    mech_annotations.save_pbr_settings(url, PBR_SETTINGS)
    changed = {**PBR_SETTINGS, "metalness": 0.9}
    saved = mech_annotations.save_pbr_settings(url, changed)
    assert saved["metalness"] == 0.9

    matches = [row for row in mech_annotations.list_pbr_settings() if row["model_url"] == url]
    assert len(matches) == 1
    assert matches[0]["metalness"] == 0.9


def test_pbr_settings_rejects_a_non_numeric_field():
    with pytest.raises(mech_annotations.InvalidPbrSettings):
        mech_annotations.save_pbr_settings(
            "/models/mechs/atlas-as7-d.glb", {**PBR_SETTINGS, "roughness": "very rough"}
        )


def test_pbr_settings_rejects_a_missing_field():
    incomplete = {k: v for k, v in PBR_SETTINGS.items() if k != "metalness"}
    with pytest.raises(mech_annotations.InvalidPbrSettings):
        mech_annotations.save_pbr_settings("/models/mechs/atlas-as7-d.glb", incomplete)
