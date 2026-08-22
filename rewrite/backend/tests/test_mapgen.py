from app import mapgen


def test_terrain_defaults_cover_every_known_terrain():
    for terrain in (
        "plains", "hills", "forest", "water", "road", "rough", "rubble",
        "hazards", "building", "swamp", "snow",
    ):
        assert terrain in mapgen.TERRAIN_DEFAULTS


def test_all_eleven_biomes_are_registered():
    # Original 7 (grasslands/forest/river/city/ruins/desert/mountains, ported
    # from the old prototype) plus 4 more grounded in official BattleTech
    # terrain rules that weren't covered yet: Swamp/Mud (BattleMech Manual
    # terrain modifications), a real Lake/Water-Feature map-sheet theme
    # (distinct from a river's thin line), Ice/Snow (BattleMech Manual
    # terrain modifications + "Glacier" map-sheet theme), and Volcanic (an
    # official map-sheet theme, built from the existing hazards/rough
    # vocabulary rather than a new terrain type).
    assert set(mapgen.BIOMES) == {
        "grasslands", "forest", "river", "city", "ruins", "desert", "mountains",
        "swamp", "lake", "arctic", "volcanic",
    }


def test_generate_map_has_width_times_height_tiles(campaign):
    m = mapgen.generate_map(campaign["id"], "Grasslands Test", width=8, height=6, biome="grasslands")
    assert len(m["tiles"]) == 8 * 6


def test_generate_grasslands_map_is_plains_dominant(campaign):
    m = mapgen.generate_map(campaign["id"], "unused", width=10, height=8, biome="grasslands")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert set(terrains) <= {"plains", "hills", "forest", "road"}
    assert terrains.count("plains") > len(terrains) / 2


def test_generate_forest_map_is_forest_dominant(campaign):
    m = mapgen.generate_map(campaign["id"], "Forest Test", width=10, height=8, biome="forest")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert terrains.count("forest") > len(terrains) / 2


def test_generate_river_map_has_water(campaign):
    m = mapgen.generate_map(campaign["id"], "River Test", width=10, height=8, biome="river")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert "water" in terrains


def test_generate_city_map_has_buildings(campaign):
    m = mapgen.generate_map(campaign["id"], "City Test", width=10, height=8, biome="city")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert "building" in terrains


def test_generate_city_map_has_roads(campaign):
    m = mapgen.generate_map(campaign["id"], "City Roads Test", width=10, height=8, biome="city")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert "road" in terrains


def test_generate_city_map_buildings_are_reachable_by_road(campaign):
    # A cluster of buildings with no road touching it isn't a city, it's a
    # block nobody can get to — regression for the original all-building
    # generator that never placed roads at all.
    m = mapgen.generate_map(campaign["id"], "City Reachable Test", width=10, height=8, biome="city")
    by_coord = {(t["q"], t["r"]): t["terrain"] for t in m["tiles"]}
    road_coords = {c for c, terrain in by_coord.items() if terrain == "road"}
    building_coords = [c for c, terrain in by_coord.items() if terrain == "building"]
    assert building_coords and road_coords
    assert any(any(n in road_coords for n in mapgen._hex_neighbors(c)) for c in building_coords)


def test_generate_ruins_map_is_rubble_heavy(campaign):
    m = mapgen.generate_map(campaign["id"], "Ruins Test", width=10, height=8, biome="ruins")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert terrains.count("rubble") > 0


def test_generate_desert_map_has_an_oasis(campaign):
    m = mapgen.generate_map(campaign["id"], "Desert Test", width=10, height=8, biome="desert")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert "water" in terrains  # the oasis
    assert terrains.count("rough") > len(terrains) / 2  # sand/rock-dominant


def test_generate_mountains_map_has_high_elevation_peaks(campaign):
    m = mapgen.generate_map(campaign["id"], "Mountains Test", width=10, height=8, biome="mountains")
    elevations = [t["elevation"] for t in m["tiles"]]
    assert max(elevations) >= 3


def test_generate_swamp_map_is_swamp_dominant_with_water_pools(campaign):
    m = mapgen.generate_map(campaign["id"], "Swamp Test", width=10, height=8, biome="swamp")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert terrains.count("swamp") > len(terrains) / 2
    assert "water" in terrains


def test_generate_lake_map_is_mostly_water(campaign):
    m = mapgen.generate_map(campaign["id"], "Lake Test", width=10, height=8, biome="lake")
    terrains = [t["terrain"] for t in m["tiles"]]
    # A lake map-sheet theme is a real body of water, not a thin river line —
    # should dwarf river's "just a line of water tiles" by a wide margin.
    assert terrains.count("water") > len(terrains) / 3


def test_generate_arctic_map_is_snow_dominant(campaign):
    m = mapgen.generate_map(campaign["id"], "Arctic Test", width=10, height=8, biome="arctic")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert terrains.count("snow") > len(terrains) / 2


def test_generate_volcanic_map_has_lava_hazards(campaign):
    m = mapgen.generate_map(campaign["id"], "Volcanic Test", width=10, height=8, biome="volcanic")
    terrains = [t["terrain"] for t in m["tiles"]]
    assert terrains.count("hazards") > 0


def test_generate_unknown_biome_raises(campaign):
    import pytest

    with pytest.raises(ValueError):
        mapgen.generate_map(campaign["id"], "Broken", width=4, height=4, biome="moon")


def test_generated_tiles_have_terrain_consistent_blocks_los(campaign):
    m = mapgen.generate_map(campaign["id"], "Consistency Test", width=8, height=6, biome="forest")
    for tile in m["tiles"]:
        _, expected_blocks = mapgen.TERRAIN_DEFAULTS[tile["terrain"]]
        assert tile["blocks_los"] == expected_blocks


def test_generate_map_respects_campaign_grid_type():
    from app import campaigns

    dnd_campaign = campaigns.create_campaign("Square biome test", system="dnd5e")
    m = mapgen.generate_map(dnd_campaign["id"], "Square Grasslands", width=5, height=4, biome="grasslands")
    assert m["grid_type"] == "square"
    assert len(m["tiles"]) == 5 * 4
