"""HTTP-layer tests: catch route-wiring/validation bugs that pure unit
tests of app/*.py modules can't see (e.g. a Pydantic model rejecting a
valid payload, or a route registered under the wrong path)."""

from fastapi.testclient import TestClient

from app.main import app


def client():
    return TestClient(app)


def test_health():
    with client() as c:
        assert c.get("/api/health").json() == {"status": "ok"}


def test_create_and_list_campaign():
    with client() as c:
        created = c.post("/api/campaigns", json={"name": "API Test"}).json()
        listed = c.get("/api/campaigns").json()
        assert any(camp["id"] == created["id"] for camp in listed)


def test_get_systems_lists_battletech_and_dnd5e():
    with client() as c:
        data = c.get("/api/systems").json()
        assert data["battletech"]["grid_type"] == "hex"
        assert data["dnd5e"]["grid_type"] == "square"


def test_create_campaign_with_system_sets_grid_type():
    with client() as c:
        created = c.post("/api/campaigns", json={"name": "Barovia", "system": "dnd5e"}).json()
        assert created["system"] == "dnd5e"
        assert created["grid_type"] == "square"


def test_create_campaign_with_unknown_system_422s():
    with client() as c:
        res = c.post("/api/campaigns", json={"name": "Broken", "system": "shadowrun"})
        assert res.status_code == 422


def test_mech_creation_rejects_incomplete_locations_with_422():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        res = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={
                "chassis": "Broken",
                "tonnage": 20,
                "walk_mp": 4,
                "run_mp": 6,
                "locations": [{"location": "HD", "armor_max": 9, "structure_max": 3}],
            },
        )
        assert res.status_code == 422


def test_attack_and_undo_round_trip_via_api():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        locations = [
            {"location": "HD", "armor_max": 9, "structure_max": 3},
            {"location": "CT", "armor_max": 47, "armor_rear_max": 12, "structure_max": 31},
            {"location": "LT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
            {"location": "RT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
            {"location": "LA", "armor_max": 34, "structure_max": 17},
            {"location": "RA", "armor_max": 34, "structure_max": 17},
            {"location": "LL", "armor_max": 41, "structure_max": 21},
            {"location": "RL", "armor_max": 41, "structure_max": 21},
        ]
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": locations},
        ).json()

        # gunnery 0 => target number 0, but a natural 2 is still an
        # automatic miss regardless (real BT rule) — ~1/36, retry rather
        # than assume the first roll hits.
        for _ in range(20):
            result = c.post(
                f"/api/campaigns/{camp['id']}/attack",
                json={"target_mech_id": mech["id"], "damage": 10, "gunnery": 0},
            ).json()
            if result["hit"]:
                break
        assert result["hit"] is True

        undo = c.post(f"/api/campaigns/{camp['id']}/undo")
        assert undo.status_code == 200

        second_undo = c.post(f"/api/campaigns/{camp['id']}/undo")
        assert second_undo.status_code == 404


def test_attack_against_unknown_campaign_404s():
    with client() as c:
        res = c.post("/api/campaigns/999999/attack", json={"target_mech_id": 1, "damage": 5, "gunnery": 0})
        assert res.status_code == 404


def _place_two_units_via_api(c, width=10, height=6):
    locations = [
        {"location": "HD", "armor_max": 9, "structure_max": 3},
        {"location": "CT", "armor_max": 47, "armor_rear_max": 12, "structure_max": 31},
        {"location": "LT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
        {"location": "RT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
        {"location": "LA", "armor_max": 34, "structure_max": 17},
        {"location": "RA", "armor_max": 34, "structure_max": 17},
        {"location": "LL", "armor_max": 41, "structure_max": 21},
        {"location": "RL", "armor_max": 41, "structure_max": 21},
    ]
    camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
    m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": width, "height": height}).json()
    c.post(f"/api/campaigns/{camp['id']}/active-map", json={"map_id": m["id"]})
    attacker_mech = c.post(
        f"/api/campaigns/{camp['id']}/mechs",
        json={"chassis": "Attacker", "tonnage": 50, "walk_mp": 4, "run_mp": 6, "locations": locations},
    ).json()
    target_mech = c.post(
        f"/api/campaigns/{camp['id']}/mechs",
        json={"chassis": "Target", "tonnage": 50, "walk_mp": 4, "run_mp": 6, "locations": locations},
    ).json()
    attacker_unit = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": attacker_mech["id"]}).json()
    target_unit = c.post(
        f"/api/maps/{m['id']}/units", json={"q": 2, "r": 0, "mech_id": target_mech["id"], "facing_deg": 180}
    ).json()
    return camp, m, attacker_mech, target_mech, attacker_unit, target_unit


def test_attack_with_real_units_but_no_los_422s():
    with client() as c:
        camp, m, _, _, attacker_unit, target_unit = _place_two_units_via_api(c)
        c.patch(f"/api/maps/{m['id']}/tiles/1/0", json={"terrain": "building", "blocks_los": True})

        res = c.post(
            f"/api/campaigns/{camp['id']}/attack",
            json={"damage": 5, "attacker_unit_id": attacker_unit["id"], "target_unit_id": target_unit["id"]},
        )
        assert res.status_code == 422


def test_attack_with_real_units_derives_gunnery_from_the_attackers_pilot():
    with client() as c:
        locations = [
            {"location": "HD", "armor_max": 9, "structure_max": 3},
            {"location": "CT", "armor_max": 47, "armor_rear_max": 12, "structure_max": 31},
            {"location": "LT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
            {"location": "RT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
            {"location": "LA", "armor_max": 34, "structure_max": 17},
            {"location": "RA", "armor_max": 34, "structure_max": 17},
            {"location": "LL", "armor_max": 41, "structure_max": 21},
            {"location": "RL", "armor_max": 41, "structure_max": 21},
        ]
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 10, "height": 6}).json()
        c.post(f"/api/campaigns/{camp['id']}/active-map", json={"map_id": m["id"]})
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Ace", "gunnery": 1}).json()
        attacker_mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Attacker", "tonnage": 50, "walk_mp": 4, "run_mp": 6, "locations": locations},
        ).json()
        target_mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Target", "tonnage": 50, "walk_mp": 4, "run_mp": 6, "locations": locations},
        ).json()
        attacker_unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": attacker_mech["id"], "pilot_id": pilot["id"]}
        ).json()
        target_unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 2, "r": 0, "mech_id": target_mech["id"], "facing_deg": 180}
        ).json()

        result = c.post(
            f"/api/campaigns/{camp['id']}/attack",
            json={"damage": 5, "attacker_unit_id": attacker_unit["id"], "target_unit_id": target_unit["id"]},
        ).json()
        # gunnery 1 (from the pilot, not passed explicitly), stationary,
        # no target movement, short range (distance 2) -> target_number 1.
        assert result["target_number"] == 1


def test_attack_broadcasts_visibility_update_and_round_updated():
    with client() as c:
        camp, m, _, _, attacker_unit, target_unit = _place_two_units_via_api(c)
        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            c.post(
                f"/api/campaigns/{camp['id']}/attack",
                json={"gunnery": 0, "damage": 5, "attacker_unit_id": attacker_unit["id"], "target_unit_id": target_unit["id"]},
            )
            types = {ws.receive_json()["type"] for _ in range(3)}
            assert types == {"attack_result", "visibility_update", "round_updated"}


def test_pilot_patch_updates_only_given_field():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Test Pilot", "gunnery": 4}).json()
        patched = c.patch(f"/api/pilots/{p['id']}", json={"gunnery": 1}).json()
        assert patched["gunnery"] == 1
        assert patched["name"] == "Test Pilot"


def test_create_pilot_with_enemy_faction():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Hostile Lance Leader", "faction": "enemy"},
        ).json()
        assert p["faction"] == "enemy"


def test_create_pilot_with_custom_color_round_trips():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Colorful", "color": "#ff00aa"},
        ).json()
        assert p["color"] == "#ff00aa"
        listed = c.get(f"/api/campaigns/{camp['id']}/pilots").json()
        assert listed[0]["color"] == "#ff00aa"
        patched = c.patch(f"/api/pilots/{p['id']}", json={"color": "#00ff88"}).json()
        assert patched["color"] == "#00ff88"


def test_create_pilot_with_unknown_faction_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        res = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Confused", "faction": "villain"},
        )
        assert res.status_code == 422


def test_create_pilot_without_status_defaults_to_approved():
    # No-regression: every existing caller (GMView) creates pilots without
    # ever sending `status`, and must keep getting an already-approved
    # pilot back, exactly like before this feature existed.
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "GM-made"}).json()
        assert p["status"] == "approved"
        assert "owner_token" not in p
        assert p["is_own"] is False


def test_create_pilot_pending_with_owner_token_hides_token_but_flags_is_own():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Player-made", "status": "pending", "owner_token": "tok-1"},
        ).json()
        assert p["status"] == "pending"
        assert "owner_token" not in p

        listed_without_header = c.get(f"/api/campaigns/{camp['id']}/pilots").json()
        assert listed_without_header[0]["is_own"] is False
        assert "owner_token" not in listed_without_header[0]

        listed_with_header = c.get(
            f"/api/campaigns/{camp['id']}/pilots", headers={"X-Device-Token": "tok-1"}
        ).json()
        assert listed_with_header[0]["is_own"] is True


def test_create_pilot_with_pin_never_leaks_it_but_flags_has_pin():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Player-made", "pin": "4242"}).json()
        assert p["has_pin"] is True
        assert "pin" not in p
        assert "pin_hash" not in p

        listed = c.get(f"/api/campaigns/{camp['id']}/pilots").json()
        assert listed[0]["has_pin"] is True
        assert "pin" not in listed[0]


def test_create_pilot_with_invalid_pin_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        res = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Sloppy", "pin": "12"})
        assert res.status_code == 422


def test_create_pilot_without_pin_has_pin_false():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "GM-made"}).json()
        assert p["has_pin"] is False


def test_create_pilot_with_duplicate_owner_token_409s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "First", "owner_token": "dup-tok"},
        )
        res = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Second", "owner_token": "dup-tok"},
        )
        assert res.status_code == 409


def test_verify_pin_endpoint_accepts_correct_pin_and_rejects_wrong_one():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Player-made", "pin": "1357"}).json()

        wrong = c.post(f"/api/pilots/{p['id']}/verify-pin", json={"pin": "0000"})
        assert wrong.status_code == 403

        right = c.post(f"/api/pilots/{p['id']}/verify-pin", json={"pin": "1357"})
        assert right.status_code == 200
        assert right.json() == {"ok": True}


def test_verify_pin_endpoint_404s_for_unknown_pilot():
    with client() as c:
        res = c.post("/api/pilots/999999/verify-pin", json={"pin": "1234"})
        assert res.status_code == 404


def test_review_and_resubmit_pilot_round_trip():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Player-made", "status": "pending", "owner_token": "tok-1"},
        ).json()

        rejected = c.post(f"/api/pilots/{p['id']}/review", json={"decision": "rejected", "note": "fix gunnery"}).json()
        assert rejected["status"] == "rejected"
        assert rejected["review_note"] == "fix gunnery"

        wrong_token = c.post(f"/api/pilots/{p['id']}/resubmit", headers={"X-Device-Token": "wrong"})
        assert wrong_token.status_code == 403

        resubmitted = c.post(f"/api/pilots/{p['id']}/resubmit", headers={"X-Device-Token": "tok-1"}).json()
        assert resubmitted["status"] == "pending"
        assert resubmitted["review_note"] is None

        approved = c.post(f"/api/pilots/{p['id']}/review", json={"decision": "approved"}).json()
        assert approved["status"] == "approved"


def test_patch_pilot_requires_owner_token_while_pending_but_not_once_approved():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(
            f"/api/campaigns/{camp['id']}/pilots",
            json={"name": "Player-made", "status": "pending", "owner_token": "tok-1"},
        ).json()

        wrong = c.patch(f"/api/pilots/{p['id']}", json={"name": "Hijacked"}, headers={"X-Device-Token": "wrong"})
        assert wrong.status_code == 403

        right = c.patch(f"/api/pilots/{p['id']}", json={"name": "Fixed"}, headers={"X-Device-Token": "tok-1"})
        assert right.status_code == 200

        c.post(f"/api/pilots/{p['id']}/review", json={"decision": "approved"})
        # No-regression: once approved, editing is open again exactly like
        # every pilot in the app before this feature existed.
        now_open = c.patch(f"/api/pilots/{p['id']}", json={"name": "Anyone Can Edit"})
        assert now_open.status_code == 200


def _atlas_body(**overrides) -> dict:
    body = {"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS}
    body.update(overrides)
    return body


def test_create_mech_without_status_defaults_to_approved():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/mechs", json=_atlas_body()).json()
        assert m["status"] == "approved"
        assert "owner_token" not in m


def test_review_and_resubmit_mech_round_trip():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        body = _atlas_body(status="pending", owner_token="tok-1")
        m = c.post(f"/api/campaigns/{camp['id']}/mechs", json=body).json()

        rejected = c.post(f"/api/mechs/{m['id']}/review", json={"decision": "rejected", "note": "bad loadout"}).json()
        assert rejected["status"] == "rejected"

        wrong = c.post(f"/api/mechs/{m['id']}/resubmit", headers={"X-Device-Token": "wrong"})
        assert wrong.status_code == 403

        resubmitted = c.post(f"/api/mechs/{m['id']}/resubmit", headers={"X-Device-Token": "tok-1"}).json()
        assert resubmitted["status"] == "pending"


def test_patch_mech_core_fields_and_ownership_guard():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        body = _atlas_body(status="pending", owner_token="tok-1")
        m = c.post(f"/api/campaigns/{camp['id']}/mechs", json=body).json()

        wrong = c.patch(f"/api/mechs/{m['id']}", json={"tonnage": 99}, headers={"X-Device-Token": "wrong"})
        assert wrong.status_code == 403

        right = c.patch(f"/api/mechs/{m['id']}", json={"tonnage": 99}, headers={"X-Device-Token": "tok-1"})
        assert right.status_code == 200
        assert right.json()["tonnage"] == 99


def test_patch_mech_critical_marks_slot_hit_and_guards_ownership():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        body = _atlas_body(status="pending", owner_token="tok-1", criticals={"LA": ["Shoulder"] + ["-Empty-"] * 11})
        m = c.post(f"/api/campaigns/{camp['id']}/mechs", json=body).json()

        wrong = c.patch(f"/api/mechs/{m['id']}/criticals/LA/0", json={"hit": True}, headers={"X-Device-Token": "wrong"})
        assert wrong.status_code == 403

        right = c.patch(f"/api/mechs/{m['id']}/criticals/LA/0", json={"hit": True}, headers={"X-Device-Token": "tok-1"})
        assert right.status_code == 200
        slot = next(s for s in right.json()["criticals"]["LA"] if s["slot_index"] == 0)
        assert slot["hit"] is True

        bad_location = c.patch(f"/api/mechs/{m['id']}/criticals/XX/0", json={"hit": True}, headers={"X-Device-Token": "tok-1"})
        assert bad_location.status_code == 422


def test_mech_weapon_endpoints_require_owner_token_while_pending():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        body = {
            "chassis": "Locust", "tonnage": 20, "walk_mp": 8, "run_mp": 12,
            "locations": [
                {"location": loc, "armor_max": 5, "structure_max": 3} for loc in
                ["HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"]
            ],
            "status": "pending", "owner_token": "tok-1",
        }
        m = c.post(f"/api/campaigns/{camp['id']}/mechs", json=body).json()

        wrong = c.post(
            f"/api/mechs/{m['id']}/weapons", json={"weapon_name": "Medium Laser", "location": "RA"},
            headers={"X-Device-Token": "wrong"},
        )
        assert wrong.status_code == 403

        right = c.post(
            f"/api/mechs/{m['id']}/weapons", json={"weapon_name": "Medium Laser", "location": "RA"},
            headers={"X-Device-Token": "tok-1"},
        )
        assert right.status_code == 200
        assert len(right.json()["weapons"]) == 1


def test_search_mech_import_reads_the_local_catalog_not_the_network():
    # /api/mech-import now reads app/mech_templates.py's local table
    # (VISION.md §3 offline-first) — no more live network call or
    # mech_import mocking needed, just seed the (test-isolated) local DB.
    from app import mech_templates

    mech_templates.upsert_template(
        "Atlas AS7-D.mtf", "Atlas", "AS7-D", 100,
        {"walk_mp": 3, "run_mp": 5, "jump_mp": 0, "heat_sinks": 20, "locations": [], "weapons": [], "criticals": {}},
    )
    with client() as c:
        res = c.get("/api/mech-import/search", params={"q": "atlas"})
        assert res.status_code == 200
        assert res.json() == [{"name": "Atlas AS7-D", "file": "Atlas AS7-D.mtf"}]


def test_get_mech_import_returns_the_stored_template():
    from app import mech_templates

    payload = {"walk_mp": 3, "run_mp": 5, "jump_mp": 0, "heat_sinks": 20, "locations": [], "weapons": [], "criticals": {}}
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, payload)
    with client() as c:
        res = c.get("/api/mech-import/Atlas AS7-D.mtf")
        assert res.status_code == 200
        assert res.json() == {"chassis": "Atlas", "model": "AS7-D", "tonnage": 100, **payload}


def test_get_mech_import_404s_for_a_filename_not_in_the_local_catalog():
    with client() as c:
        res = c.get("/api/mech-import/Missing.mtf")
        assert res.status_code == 404


def test_list_mech_chassis_endpoint():
    from app import mech_templates

    payload = {"walk_mp": 3, "run_mp": 5, "jump_mp": 0, "heat_sinks": 20, "locations": [], "weapons": [], "criticals": {}}
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, payload)
    mech_templates.upsert_template("Banshee BNC-3E.mtf", "Banshee", "BNC-3E", 95, payload)
    with client() as c:
        res = c.get("/api/mech-catalog/chassis")
        assert res.status_code == 200
        assert res.json() == ["Atlas", "Banshee"]


def test_list_mech_models_endpoint_is_not_shadowed_by_the_filename_route():
    # /api/mech-catalog/chassis/{chassis}/models must resolve to its own
    # handler, not get swallowed by /api/mech-import/{filename} treating
    # "chassis" as a literal filename.
    from app import mech_templates

    payload = {"walk_mp": 3, "run_mp": 5, "jump_mp": 0, "heat_sinks": 20, "locations": [], "weapons": [], "criticals": {}}
    mech_templates.upsert_template("Atlas AS7-D.mtf", "Atlas", "AS7-D", 100, payload)
    mech_templates.upsert_template("Atlas AS7-D-DC.mtf", "Atlas", "AS7-D-DC", 100, payload)
    with client() as c:
        res = c.get("/api/mech-catalog/chassis/Atlas/models")
        assert res.status_code == 200
        models = {m["model"] for m in res.json()}
        assert models == {"AS7-D", "AS7-D-DC"}


def test_setting_active_map_broadcasts_to_table_over_websocket():
    # Regression: the table view (`/`) only ever read active_map_id once on
    # mount, so projecting a different/newly-generated map from the GM's
    # map editor never reached an already-open table screen — it needed a
    # manual page reload. The fix is this broadcast; this test is what
    # would have caught it.
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "Map A", "width": 3, "height": 3}).json()

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            res = c.post(f"/api/campaigns/{camp['id']}/active-map", json={"map_id": m["id"]})
            assert res.status_code == 200

            message = ws.receive_json()
            assert message == {"type": "active_map_changed", "map_id": m["id"]}


def test_table_session_defaults_to_no_active_campaign():
    with client() as c:
        res = c.get("/api/table-session").json()
        assert res == {"active_campaign_id": None}


def test_activating_table_session_broadcasts_over_hub_websocket():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()

        with c.websocket_connect("/ws/hub") as ws:
            res = c.post("/api/table-session/activate", json={"campaign_id": camp["id"]})
            assert res.status_code == 200
            assert res.json() == {"active_campaign_id": camp["id"]}

            message = ws.receive_json()
            assert message == {"type": "active_campaign_changed", "campaign_id": camp["id"]}

        assert c.get("/api/table-session").json() == {"active_campaign_id": camp["id"]}


def test_hub_broadcast_does_not_leak_into_per_campaign_channel():
    # Regression guard: the hub channel is deliberately separate from
    # ConnectionManager's per-campaign rooms — a client listening on a
    # specific campaign's room must never see hub-level broadcasts.
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        other = c.post("/api/campaigns", json={"name": "Other"}).json()

        with c.websocket_connect(f"/ws/{other['id']}") as campaign_ws:
            c.post("/api/table-session/activate", json={"campaign_id": camp["id"]})

            # Nothing from the hub broadcast should arrive here. Prove the
            # socket is otherwise alive by triggering a real per-campaign
            # broadcast and confirming that one *does* arrive.
            m = c.post(f"/api/campaigns/{other['id']}/maps", json={"name": "M", "width": 3, "height": 3}).json()
            c.post(f"/api/campaigns/{other['id']}/active-map", json={"map_id": m["id"]})
            message = campaign_ws.receive_json()
            assert message == {"type": "active_map_changed", "map_id": m["id"]}


def test_deactivating_table_session_broadcasts_and_clears_state():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post("/api/table-session/activate", json={"campaign_id": camp["id"]})

        with c.websocket_connect("/ws/hub") as ws:
            res = c.post("/api/table-session/deactivate")
            assert res.status_code == 200
            assert res.json() == {"active_campaign_id": None}

            message = ws.receive_json()
            assert message == {"type": "active_campaign_changed", "campaign_id": None}

        assert c.get("/api/table-session").json() == {"active_campaign_id": None}


def test_activating_table_session_for_unknown_campaign_404s():
    with client() as c:
        res = c.post("/api/table-session/activate", json={"campaign_id": 999999})
        assert res.status_code == 404


def test_round_endpoints_start_act_and_broadcast():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Test Pilot"}).json()

        initial = c.get(f"/api/campaigns/{camp['id']}/round").json()
        assert initial == {
            "campaign_id": camp["id"], "round_number": 0, "mode": "team", "rolls": [], "acted_pilot_ids": [],
            "movement_order": [], "moved_pilot_ids": [], "moves": [],
            "ranged_target_pilot_ids": [], "melee_target_pilot_ids": [],
        }

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            started = c.post(f"/api/campaigns/{camp['id']}/round/start").json()
            assert started["round_number"] == 1
            assert len(started["rolls"]) == 1  # only "player" faction present
            assert started["rolls"][0]["faction"] == "player"
            assert ws.receive_json()["type"] == "round_started"

            acted = c.post(f"/api/campaigns/{camp['id']}/round/act", json={"pilot_id": pilot["id"]}).json()
            assert acted["acted_pilot_ids"] == [pilot["id"]]
            assert ws.receive_json()["type"] == "round_updated"


def test_set_initiative_mode_to_individual_via_api():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        updated = c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "individual"}).json()
        assert updated["initiative_mode"] == "individual"

        for i in range(2):
            c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": f"Player {i}"})
        c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Foe", "faction": "enemy"})

        # Individual mode no longer auto-rolls on start — each pilot rolls
        # their own via /round/roll-initiative (see test below).
        started = c.post(f"/api/campaigns/{camp['id']}/round/start").json()
        assert started["mode"] == "individual"
        assert started["rolls"] == []


def test_request_initiative_endpoint_broadcasts_without_touching_rolls():
    # No server-side random 2d6 anymore — requesting just validates and
    # broadcasts "please throw dice for this pilot" (see
    # test_report_initiative_endpoint_and_broadcast for the half that
    # actually records a result, called by the shared table once its
    # physics dice land).
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "individual"})
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo", "color": "#ff00aa"}).json()

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            c.post(f"/api/campaigns/{camp['id']}/round/start")
            ws.receive_json()  # round_started

            requested = c.post(
                f"/api/campaigns/{camp['id']}/round/roll-initiative", json={"pilot_id": p["id"]}
            ).json()
            assert requested == {"pilot_id": p["id"], "pilot_name": "Solo", "color": "#ff00aa"}
            broadcast = ws.receive_json()
            assert broadcast["type"] == "initiative_roll_requested"
            assert broadcast["pilot_id"] == p["id"]

            state = c.get(f"/api/campaigns/{camp['id']}/round").json()
            assert state["rolls"] == []


def test_report_initiative_endpoint_and_broadcast():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "individual"})
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            c.post(f"/api/campaigns/{camp['id']}/round/start")
            ws.receive_json()  # round_started

            reported = c.post(
                f"/api/campaigns/{camp['id']}/round/report-initiative", json={"pilot_id": p["id"], "roll": 9}
            ).json()
            assert len(reported["rolls"]) == 1
            assert reported["rolls"][0] == {
                "kind": "pilot", "faction": "player", "pilot_id": p["id"], "pilot_name": "Solo", "roll": 9,
                "modifiers": [], "modifier_total": 0, "total": 9,
            }
            assert ws.receive_json()["type"] == "round_updated"

            # Idempotent: reporting again for the same pilot doesn't overwrite.
            again = c.post(
                f"/api/campaigns/{camp['id']}/round/report-initiative", json={"pilot_id": p["id"], "roll": 2}
            ).json()
            assert again["rolls"] == reported["rolls"]


def test_report_initiative_logs_each_individual_die_for_the_fairness_check():
    # "quiero que se guarden todas las tiradas de dados para comprobar
    # como de reales son" — each individual d6 face the physics dice
    # landed on gets logged into the same `rolls` history table the
    # generic dice tray already uses, not just the 2d6 sum.
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "individual"})
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        c.post(f"/api/campaigns/{camp['id']}/round/start")

        c.post(
            f"/api/campaigns/{camp['id']}/round/report-initiative",
            json={"pilot_id": p["id"], "roll": 9, "dice": [3, 6]},
        )
        logged = c.get(f"/api/campaigns/{camp['id']}/rolls").json()
        assert len(logged) == 2
        assert {r["result"] for r in logged} == {3, 6}
        assert all(r["die"] == "d6" and r["label"] == "iniciativa" and r["pilot_id"] == p["id"] for r in logged)


def test_report_initiative_rejects_out_of_range_roll_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "individual"})
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        c.post(f"/api/campaigns/{camp['id']}/round/start")
        res = c.post(
            f"/api/campaigns/{camp['id']}/round/report-initiative", json={"pilot_id": p["id"], "roll": 13}
        )
        assert res.status_code == 422


def test_roll_initiative_rejects_team_mode_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        p = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        c.post(f"/api/campaigns/{camp['id']}/round/start")
        res = c.post(f"/api/campaigns/{camp['id']}/round/roll-initiative", json={"pilot_id": p["id"]})
        assert res.status_code == 422
        res2 = c.post(
            f"/api/campaigns/{camp['id']}/round/report-initiative", json={"pilot_id": p["id"], "roll": 7}
        )
        assert res2.status_code == 422


def test_set_initiative_mode_with_unknown_mode_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        res = c.post(f"/api/campaigns/{camp['id']}/initiative-mode", json={"mode": "chaotic"})
        assert res.status_code == 422


_ATLAS_LOCATIONS = [
    {"location": "HD", "armor_max": 9, "structure_max": 3},
    {"location": "CT", "armor_max": 47, "armor_rear_max": 12, "structure_max": 31},
    {"location": "LT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
    {"location": "RT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
    {"location": "LA", "armor_max": 34, "structure_max": 17},
    {"location": "RA", "armor_max": 34, "structure_max": 17},
    {"location": "LL", "armor_max": 41, "structure_max": 21},
    {"location": "RL", "armor_max": 41, "structure_max": 21},
]


def test_get_weapon_catalog():
    with client() as c:
        catalog = c.get("/api/weapons").json()
        assert catalog["Medium Laser"] == {
            "damage": 5, "heat": 3, "min_range": 0, "short": 3, "medium": 6, "long": 9, "ammo_per_ton": None, "slots": 1,
        }


def test_add_and_remove_mech_weapon():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()

        added = c.post(f"/api/mechs/{mech['id']}/weapons", json={"weapon_name": "AC/20", "location": "RT"}).json()
        assert len(added["weapons"]) == 1
        weapon_id = added["weapons"][0]["id"]
        assert added["weapons"][0]["ammo_remaining"] == 5

        removed = c.delete(f"/api/mechs/{mech['id']}/weapons/{weapon_id}").json()
        assert removed["weapons"] == []


def test_delete_mech_endpoint_removes_it():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()

        resp = c.delete(f"/api/mechs/{mech['id']}")
        assert resp.status_code == 200
        assert resp.json() == {"deleted": True}
        assert c.get(f"/api/mechs/{mech['id']}").status_code == 404


def test_delete_mech_endpoint_404s_for_unknown_id():
    with client() as c:
        assert c.delete("/api/mechs/999999").status_code == 404


def test_delete_pilot_endpoint_removes_it():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Doomed"}).json()

        resp = c.delete(f"/api/pilots/{pilot['id']}")
        assert resp.status_code == 200
        assert resp.json() == {"deleted": True}

        remaining = c.get(f"/api/campaigns/{camp['id']}/pilots").json()
        assert remaining == []


def test_delete_pilot_endpoint_404s_for_unknown_id():
    with client() as c:
        assert c.delete("/api/pilots/999999").status_code == 404


def test_get_equipment_catalog():
    with client() as c:
        catalog = c.get("/api/equipment").json()
        assert catalog["Double Heat Sink"] == {"slots": 3, "heat_dissipation": 2, "jump_bonus": None}


def test_add_and_remove_mech_equipment():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()

        added = c.post(f"/api/mechs/{mech['id']}/equipment", json={"equipment_name": "Double Heat Sink", "location": "RT"}).json()
        assert len(added["equipment"]) == 1
        equipment_id = added["equipment"][0]["id"]
        assert added["heat_sinks"] == 22  # (1 mounted + 10 free engine sinks) x 2 dissipation

        removed = c.delete(f"/api/mechs/{mech['id']}/equipment/{equipment_id}").json()
        assert removed["equipment"] == []


def test_add_unknown_equipment_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()
        res = c.post(f"/api/mechs/{mech['id']}/equipment", json={"equipment_name": "Warp Drive", "location": "RT"})
        assert res.status_code == 422


def test_add_unknown_weapon_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()
        res = c.post(f"/api/mechs/{mech['id']}/weapons", json={"weapon_name": "Death Ray", "location": "RT"})
        assert res.status_code == 422


def test_attack_with_weapon_id_via_api():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        attacker = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Attacker", "tonnage": 50, "walk_mp": 4, "run_mp": 6, "locations": _ATLAS_LOCATIONS},
        ).json()
        target = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Target", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()
        loaded = c.post(f"/api/mechs/{attacker['id']}/weapons", json={"weapon_name": "AC/20", "location": "RT"}).json()
        weapon_id = loaded["weapons"][0]["id"]

        for _ in range(20):
            result = c.post(
                f"/api/campaigns/{camp['id']}/attack",
                json={"target_mech_id": target["id"], "weapon_id": weapon_id, "gunnery": 0},
            ).json()
            if result["hit"]:
                break
        assert result["hit"] is True
        assert result["weapon_name"] == "AC/20"


def test_attack_without_damage_or_weapon_id_422s():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        target = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Target", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()
        res = c.post(
            f"/api/campaigns/{camp['id']}/attack",
            json={"target_mech_id": target["id"], "gunnery": 0},
        )
        assert res.status_code == 422


def test_visible_enemies_endpoint_reports_a_detected_enemy():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 4, "height": 4}).json()
        enemy_mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Atlas", "tonnage": 100, "walk_mp": 3, "run_mp": 5, "locations": _ATLAS_LOCATIONS},
        ).json()
        observer = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "facing_deg": 0}).json()
        target = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 1, "r": 0, "mech_id": enemy_mech["id"]}
        ).json()

        res = c.get(f"/api/units/{observer['id']}/visible-enemies")
        assert res.status_code == 200
        assert res.json() == [
            {"unit_id": target["id"], "mech_id": enemy_mech["id"], "chassis": "Atlas", "model": None, "q": 1, "r": 0, "distance": 1}
        ]


def test_visible_enemies_endpoint_404s_for_unknown_unit():
    with client() as c:
        res = c.get("/api/units/999999/visible-enemies")
        assert res.status_code == 404


def test_reachable_hexes_endpoint_returns_walkable_hexes():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Locust", "tonnage": 20, "walk_mp": 2, "run_mp": 3, "locations": _ATLAS_LOCATIONS},
        ).json()
        unit = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"]}).json()

        res = c.get(f"/api/units/{unit['id']}/reachable-hexes", params={"movement_type": "walk"})
        assert res.status_code == 200
        hexes = {(h["q"], h["r"]) for h in res.json()}
        assert (2, 0) in hexes
        assert (3, 0) not in hexes


def test_reachable_hexes_endpoint_404s_for_unknown_unit():
    with client() as c:
        res = c.get("/api/units/999999/reachable-hexes", params={"movement_type": "walk"})
        assert res.status_code == 404


def test_reachable_hexes_endpoint_422s_for_unknown_movement_type():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 4, "height": 4}).json()
        unit = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0}).json()
        res = c.get(f"/api/units/{unit['id']}/reachable-hexes", params={"movement_type": "fly"})
        assert res.status_code == 422


def test_create_unit_endpoint_422s_for_a_pending_mech():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 4, "height": 4}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={
                "chassis": "Locust", "tonnage": 20, "walk_mp": 8, "run_mp": 12,
                "locations": _ATLAS_LOCATIONS, "status": "pending",
            },
        ).json()
        res = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"]})
        assert res.status_code == 422


def test_move_with_mp_endpoint_moves_a_unit_within_range():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Locust", "tonnage": 20, "walk_mp": 2, "run_mp": 3, "locations": _ATLAS_LOCATIONS},
        ).json()
        unit = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"]}).json()

        res = c.post(f"/api/units/{unit['id']}/move-with-mp", json={"q": 2, "r": 0, "movement_type": "walk"})
        assert res.status_code == 200
        assert res.json()["q"] == 2
        assert res.json()["r"] == 0


def test_move_with_mp_endpoint_422s_for_an_unreachable_destination():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Locust", "tonnage": 20, "walk_mp": 1, "run_mp": 2, "locations": _ATLAS_LOCATIONS},
        ).json()
        unit = c.post(f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"]}).json()

        res = c.post(f"/api/units/{unit['id']}/move-with-mp", json={"q": 5, "r": 0, "movement_type": "walk"})
        assert res.status_code == 422


def test_move_with_mp_endpoint_404s_for_unknown_unit():
    with client() as c:
        res = c.post("/api/units/999999/move-with-mp", json={"q": 0, "r": 0, "movement_type": "walk"})
        assert res.status_code == 404


def test_free_move_endpoint_still_advances_the_movement_phase():
    # A GM dragging a unit (or clicking the unrestricted "Mover" button)
    # instead of Caminar/Correr/Saltar must still count as that pilot's
    # move for the round — otherwise activeMoverPilotId never advances
    # past them and the movement phase gets stuck on that pilot forever.
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Locust", "tonnage": 20, "walk_mp": 2, "run_mp": 3, "locations": _ATLAS_LOCATIONS},
        ).json()
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"], "pilot_id": pilot["id"]}
        ).json()
        c.post(f"/api/campaigns/{camp['id']}/round/start")  # team mode auto-rolls, movement_order populates

        res = c.post(f"/api/units/{unit['id']}/move", json={"q": 5, "r": 0})
        assert res.status_code == 200
        assert res.json()["q"] == 5

        state = c.get(f"/api/campaigns/{camp['id']}/round").json()
        assert state["moved_pilot_ids"] == [pilot["id"]]
        assert state["moves"][0]["hexes_moved"] == 5


def test_free_move_endpoint_does_not_record_movement_before_a_round_starts():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "pilot_id": pilot["id"]}
        ).json()

        res = c.post(f"/api/units/{unit['id']}/move", json={"q": 1, "r": 0})
        assert res.status_code == 200

        state = c.get(f"/api/campaigns/{camp['id']}/round").json()
        assert state["moved_pilot_ids"] == []


def test_request_movement_broadcasts_movement_started_over_websocket():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "M", "width": 6, "height": 6}).json()
        mech = c.post(
            f"/api/campaigns/{camp['id']}/mechs",
            json={"chassis": "Locust", "tonnage": 20, "walk_mp": 2, "run_mp": 3, "locations": _ATLAS_LOCATIONS},
        ).json()
        pilot = c.post(f"/api/campaigns/{camp['id']}/pilots", json={"name": "Solo"}).json()
        unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 0, "r": 0, "mech_id": mech["id"], "pilot_id": pilot["id"]}
        ).json()

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            res = c.post(f"/api/units/{unit['id']}/request-movement", json={"movement_type": "walk"})
            assert res.status_code == 200
            message = ws.receive_json()
            assert message["type"] == "movement_started"
            assert message["pilot_id"] == pilot["id"]
            assert message["unit_id"] == unit["id"]
            assert message["movement_type"] == "walk"
            assert len(message["hexes"]) > 0


# ---- D&D 5e (ROADMAP.md Fase R4 — segundo sistema, slice mínimo) --------


def _dnd_campaign(c):
    return c.post("/api/campaigns", json={"name": "D&D API Test", "system": "dnd5e"}).json()


def test_dnd_endpoints_422_on_a_battletech_campaign():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "BT Test"}).json()
        assert c.post(f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Elowen"}).status_code == 422
        assert c.get(f"/api/campaigns/{camp['id']}/dnd/characters").status_code == 422
        assert c.get(f"/api/campaigns/{camp['id']}/dnd/round").status_code == 422
        assert c.post(f"/api/campaigns/{camp['id']}/dnd/round/start").status_code == 422


def test_create_and_list_dnd_character():
    with client() as c:
        camp = _dnd_campaign(c)
        created = c.post(
            f"/api/campaigns/{camp['id']}/dnd/characters",
            json={"name": "Elowen", "dex": 16, "ac": 14, "hp_max": 18},
        ).json()
        assert created["dex"] == 16
        assert created["hp_current"] == 18

        listed = c.get(f"/api/campaigns/{camp['id']}/dnd/characters").json()
        assert any(ch["id"] == created["id"] for ch in listed)


def test_place_dnd_character_as_a_unit_on_a_square_map():
    with client() as c:
        camp = _dnd_campaign(c)
        char = c.post(f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Thorn"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "Tavern", "width": 6, "height": 6}).json()
        unit = c.post(
            f"/api/maps/{m['id']}/units", json={"q": 1, "r": 1, "dnd_character_id": char["id"]}
        ).json()
        assert unit["dnd_character_id"] == char["id"]
        assert unit["dnd_name"] == "Thorn"
        assert unit["mech_id"] is None


def test_dnd_attack_endpoint_broadcasts_and_applies_damage(monkeypatch):
    from app.systems.dnd5e import combat as dnd_combat_module
    with client() as c:
        camp = _dnd_campaign(c)
        attacker = c.post(f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Thorn"}).json()
        target = c.post(
            f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Elowen", "ac": 10, "hp_max": 10}
        ).json()
        monkeypatch.setattr(dnd_combat_module, "_roll_die", lambda sides: 15 if sides == 20 else 4)

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            res = c.post(
                f"/api/campaigns/{camp['id']}/dnd/attack",
                json={
                    "attacker_id": attacker["id"], "target_id": target["id"],
                    "attack_mod": 0, "damage_dice": "1d6",
                },
            )
            assert res.status_code == 200
            body = res.json()
            assert body["hit"] is True
            assert body["damage"] == 4
            message = ws.receive_json()
            assert message["type"] == "dnd_attack_result"
            assert message["damage"] == 4

        updated = c.get(f"/api/campaigns/{camp['id']}/dnd/characters").json()
        assert next(ch for ch in updated if ch["id"] == target["id"])["hp_current"] == 6


def test_dnd_round_lifecycle_via_api(monkeypatch):
    from app.systems.dnd5e import turns as dnd_turns_module
    with client() as c:
        camp = _dnd_campaign(c)
        a = c.post(f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Elowen", "dex": 18}).json()
        b = c.post(f"/api/campaigns/{camp['id']}/dnd/characters", json={"name": "Thorn", "dex": 10}).json()
        monkeypatch.setattr(dnd_turns_module, "_roll_d20", lambda: 10)

        with c.websocket_connect(f"/ws/{camp['id']}") as ws:
            res = c.post(f"/api/campaigns/{camp['id']}/dnd/round/start")
            assert res.status_code == 200
            state = res.json()
            assert state["round_number"] == 1
            assert [r["character_id"] for r in state["rolls"]] == [a["id"], b["id"]]
            started_msg = ws.receive_json()
            assert started_msg["type"] == "dnd_round_started"

            res = c.post(f"/api/campaigns/{camp['id']}/dnd/round/act", json={"character_id": a["id"]})
            assert res.status_code == 200
            assert res.json()["acted_character_ids"] == [a["id"]]
            updated_msg = ws.receive_json()
            assert updated_msg["type"] == "dnd_round_updated"

        fetched = c.get(f"/api/campaigns/{camp['id']}/dnd/round").json()
        assert fetched["acted_character_ids"] == [a["id"]]


def test_delete_map_endpoint_removes_it_and_404s_after():
    with client() as c:
        camp = c.post("/api/campaigns", json={"name": "API Test"}).json()
        m = c.post(f"/api/campaigns/{camp['id']}/maps", json={"name": "Doomed", "width": 3, "height": 3}).json()

        assert c.delete(f"/api/maps/{m['id']}").json() == {"ok": True}
        assert c.get(f"/api/maps/{m['id']}").status_code == 404


def test_delete_map_endpoint_404s_for_unknown_map():
    with client() as c:
        assert c.delete("/api/maps/999999").status_code == 404
