from app import campaigns, db, events, maps


def test_update_tile_changes_elevation_and_blocks_los(campaign):
    m = maps.create_map(campaign["id"], "Test map", width=4, height=4)
    updated = maps.update_tile(m["id"], q=1, r=0, elevation=3, blocks_los=True)
    tile = next(t for t in updated["tiles"] if t["q"] == 1 and t["r"] == 0)
    assert tile["elevation"] == 3
    assert tile["blocks_los"] is True


def test_update_tile_partial_update_only_changes_given_field(campaign):
    m = maps.create_map(campaign["id"], "Test map", width=4, height=4, elevations={(0, 0): 2})
    updated = maps.update_tile(m["id"], q=0, r=0, blocks_los=True)
    tile = next(t for t in updated["tiles"] if t["q"] == 0 and t["r"] == 0)
    assert tile["elevation"] == 2  # untouched
    assert tile["blocks_los"] is True


def test_update_tile_unknown_hex_returns_none(campaign):
    m = maps.create_map(campaign["id"], "Test map", width=2, height=2)
    assert maps.update_tile(m["id"], q=99, r=99, elevation=1) is None


def test_set_active_map_persists_on_campaign(campaign):
    m = maps.create_map(campaign["id"], "Test map", width=2, height=2)
    campaigns.set_active_map(campaign["id"], m["id"])
    assert campaigns.get_campaign(campaign["id"])["active_map_id"] == m["id"]


def test_campaign_defaults_to_no_active_map(campaign):
    assert campaigns.get_campaign(campaign["id"])["active_map_id"] is None


def test_create_map_defaults_to_hex_for_battletech_campaign(campaign):
    m = maps.create_map(campaign["id"], "Test map", width=5, height=4)
    assert m["grid_type"] == "hex"
    assert len(m["tiles"]) == 5 * 4  # width x height rectangle, not a hexagon-of-hexes


def test_create_map_generates_square_grid_for_dnd5e_campaign():
    dnd_campaign = campaigns.create_campaign("Curse of Strahd", system="dnd5e")
    m = maps.create_map(dnd_campaign["id"], "Barovia", width=5, height=4)
    assert m["grid_type"] == "square"
    assert len(m["tiles"]) == 5 * 4
    coords = {(t["q"], t["r"]) for t in m["tiles"]}
    assert coords == {(x, y) for x in range(5) for y in range(4)}


def test_delete_map_removes_it(campaign):
    m = maps.create_map(campaign["id"], "Doomed map", width=3, height=3)
    assert maps.delete_map(m["id"]) is True
    assert maps.get_map(m["id"]) is None


def test_delete_map_returns_false_for_unknown_id(campaign):
    assert maps.delete_map(999999) is False


def test_delete_map_clears_active_map_id_if_it_was_active(campaign):
    m = maps.create_map(campaign["id"], "Active map", width=3, height=3)
    campaigns.set_active_map(campaign["id"], m["id"])
    maps.delete_map(m["id"])
    updated = campaigns.get_campaign(campaign["id"])
    assert updated["active_map_id"] is None


def test_delete_map_leaves_other_maps_and_active_map_untouched(campaign):
    keep = maps.create_map(campaign["id"], "Keep me", width=3, height=3)
    doomed = maps.create_map(campaign["id"], "Doomed map", width=3, height=3)
    campaigns.set_active_map(campaign["id"], keep["id"])
    maps.delete_map(doomed["id"])
    assert maps.get_map(keep["id"]) is not None
    updated = campaigns.get_campaign(campaign["id"])
    assert updated["active_map_id"] == keep["id"]


def test_undo_map_created_deletes_it(campaign):
    m = maps.create_map(campaign["id"], "Undo me", width=3, height=3)
    events.undo_last_event(campaign["id"])
    assert maps.get_map(m["id"]) is None


def test_undo_map_deleted_recreates_it_with_the_same_terrain(campaign):
    m = maps.create_map(campaign["id"], "Restore me", width=3, height=3)
    maps.update_tile(m["id"], q=0, r=0, terrain="forest", elevation=2, blocks_los=True)
    maps.delete_map(m["id"])
    events.undo_last_event(campaign["id"])

    remaining = maps.list_maps(campaign["id"])
    assert len(remaining) == 1
    assert remaining[0]["name"] == "Restore me"
    restored_tile = next(t for t in remaining[0]["tiles"] if t["q"] == 0 and t["r"] == 0)
    assert restored_tile["terrain"] == "forest"
    assert restored_tile["elevation"] == 2
    assert restored_tile["blocks_los"] is True


def test_undo_map_deleted_does_not_regrow_the_history(campaign):
    m = maps.create_map(campaign["id"], "Cycle me", width=2, height=2)
    maps.delete_map(m["id"])
    undone = 0
    for _ in range(10):
        if events.undo_last_event(campaign["id"]) is None:
            break
        undone += 1
    else:
        raise AssertionError("undo never drained the history")
    assert undone == 2  # map_deleted, then map_created


def test_undo_map_projected_restores_prior_active_map(campaign):
    # map_projected is logged at the main.py endpoint layer, not inside
    # campaigns.set_active_map itself (see that endpoint's own comment on
    # why) — this test logs it the same way that endpoint does, to
    # exercise events.py's own undo dispatch for the type in isolation.
    first = maps.create_map(campaign["id"], "First", width=2, height=2)
    second = maps.create_map(campaign["id"], "Second", width=2, height=2)
    campaigns.set_active_map(campaign["id"], first["id"])

    with db.connect() as conn:
        events.log_event(
            conn, campaign["id"], "map_projected", "Mapa proyectado: Second",
            {"prev_active_map_id": first["id"]},
        )
    campaigns.set_active_map(campaign["id"], second["id"])

    events.undo_last_event(campaign["id"])
    assert campaigns.get_campaign(campaign["id"])["active_map_id"] == first["id"]
