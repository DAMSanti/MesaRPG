from app.hexgrid import Hex, distance, has_los, line


def test_distance_same_hex_is_zero():
    assert distance(Hex(0, 0), Hex(0, 0)) == 0


def test_distance_along_q_axis():
    assert distance(Hex(0, 0), Hex(3, 0)) == 3


def test_distance_along_r_axis():
    assert distance(Hex(0, 0), Hex(0, 3)) == 3


def test_distance_diagonal():
    assert distance(Hex(-2, 1), Hex(2, -1)) == 4


def test_line_includes_both_endpoints():
    path = line(Hex(0, 0), Hex(3, 0))
    assert path[0] == Hex(0, 0)
    assert path[-1] == Hex(3, 0)
    assert len(path) == 4


def test_line_single_hex_when_same_point():
    assert line(Hex(1, 1), Hex(1, 1)) == [Hex(1, 1)]


def test_los_clear_on_flat_terrain():
    tiles = {(1, 0): {"elevation": 0, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Hex(0, 0), 0, Hex(3, 0), 0, tiles) is True


def test_los_blocked_by_taller_hill_between():
    tiles = {(1, 0): {"elevation": 3, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Hex(0, 0), 0, Hex(3, 0), 0, tiles) is False


def test_los_blocked_by_terrain_flag_regardless_of_elevation():
    tiles = {(1, 0): {"elevation": 0, "blocks_los": True}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Hex(0, 0), 0, Hex(3, 0), 0, tiles) is False


def test_los_sees_over_a_hill_lower_than_both_observer_and_target():
    tiles = {(1, 0): {"elevation": 2, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Hex(0, 0), 3, Hex(3, 0), 3, tiles) is True


def test_los_missing_tile_data_does_not_block():
    # An untracked hex (outside the map, e.g.) shouldn't silently block sight.
    assert has_los(Hex(0, 0), 0, Hex(5, 0), 0, tiles={}) is True
