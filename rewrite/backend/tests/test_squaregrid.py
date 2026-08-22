from app.squaregrid import Cell, distance, has_los, line


def test_distance_same_cell_is_zero():
    assert distance(Cell(0, 0), Cell(0, 0)) == 0


def test_distance_orthogonal():
    assert distance(Cell(0, 0), Cell(3, 0)) == 3
    assert distance(Cell(0, 0), Cell(0, 3)) == 3


def test_distance_is_chebyshev_diagonal_counts_as_one():
    # Standard square-grid "grid distance" default: diagonal move costs 1,
    # same as orthogonal — this is a grid-math default, not a D&D 5e rule
    # (5e's variable diagonal cost is gameplay, out of scope for S0).
    assert distance(Cell(0, 0), Cell(3, 3)) == 3
    assert distance(Cell(-2, 1), Cell(2, -1)) == 4


def test_line_includes_both_endpoints():
    path = line(Cell(0, 0), Cell(3, 0))
    assert path[0] == Cell(0, 0)
    assert path[-1] == Cell(3, 0)
    assert len(path) == 4


def test_line_single_cell_when_same_point():
    assert line(Cell(2, 2), Cell(2, 2)) == [Cell(2, 2)]


def test_los_clear_on_flat_terrain():
    tiles = {(1, 0): {"elevation": 0, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Cell(0, 0), 0, Cell(3, 0), 0, tiles) is True


def test_los_blocked_by_taller_hill_between():
    tiles = {(1, 0): {"elevation": 3, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Cell(0, 0), 0, Cell(3, 0), 0, tiles) is False


def test_los_blocked_by_terrain_flag():
    tiles = {(1, 0): {"elevation": 0, "blocks_los": True}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Cell(0, 0), 0, Cell(3, 0), 0, tiles) is False


def test_los_sees_over_a_lower_hill():
    tiles = {(1, 0): {"elevation": 2, "blocks_los": False}, (2, 0): {"elevation": 0, "blocks_los": False}}
    assert has_los(Cell(0, 0), 3, Cell(3, 0), 3, tiles) is True


def test_los_blocked_by_three_points_of_woods():
    tiles = {
        (1, 0): {"elevation": 0, "blocks_los": False, "los_points": 2},
        (2, 0): {"elevation": 0, "blocks_los": False, "los_points": 1},
    }
    assert has_los(Cell(0, 0), 0, Cell(3, 0), 0, tiles) is False


def test_los_clear_under_the_three_point_woods_threshold():
    tiles = {(1, 0): {"elevation": 0, "blocks_los": False, "los_points": 2}}
    assert has_los(Cell(0, 0), 0, Cell(2, 0), 0, tiles) is True
