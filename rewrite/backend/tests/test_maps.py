from app import campaigns, maps


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
