"""Square-grid math: distance and line-of-sight tracing (ROADMAP.md S0).

Mirrors hexgrid.py's public shape (distance/line/has_los) so callers can
be grid-agnostic once dispatch exists — deliberately not wired into
units.py's fog-of-war yet (no square-grid campaign has real units to
exercise it against). Distance is Chebyshev (diagonal costs the same as
orthogonal) — the simplest grid-math default, not D&D 5e's variable
diagonal-cost rule, which is gameplay and out of scope for S0.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Cell:
    x: int
    y: int


def distance(a: Cell, b: Cell) -> int:
    return max(abs(a.x - b.x), abs(a.y - b.y))


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def line(a: Cell, b: Cell) -> list[Cell]:
    """All cells on the straight line from a to b, inclusive of both ends."""
    n = distance(a, b)
    if n == 0:
        return [a]
    cells = []
    for i in range(n + 1):
        t = i / n
        cells.append(Cell(x=round(_lerp(a.x, b.x, t)), y=round(_lerp(a.y, b.y, t))))
    return cells


_LOS_BLOCK_POINTS = 3


def has_los(
    observer: Cell,
    observer_elevation: int,
    target: Cell,
    target_elevation: int,
    tiles: dict[tuple[int, int], dict],
) -> bool:
    """tiles maps (x, y) -> {"elevation": int, "blocks_los": bool,
    "los_points": int}. Mirrors hexgrid.py's has_los — see its own doc
    comment for the woods-accumulation rule (3+ points blocks)."""
    path = line(observer, target)
    woods_points = 0
    for c in path[1:-1]:
        tile = tiles.get((c.x, c.y))
        if tile is None:
            continue
        if tile.get("blocks_los"):
            return False
        if tile["elevation"] > observer_elevation and tile["elevation"] > target_elevation:
            return False
        woods_points += tile.get("los_points", 0)
        if woods_points >= _LOS_BLOCK_POINTS:
            return False
    return True
