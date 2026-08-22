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


def has_los(
    observer: Cell,
    observer_elevation: int,
    target: Cell,
    target_elevation: int,
    tiles: dict[tuple[int, int], dict],
) -> bool:
    """tiles maps (x, y) -> {"elevation": int, "blocks_los": bool}."""
    path = line(observer, target)
    for c in path[1:-1]:
        tile = tiles.get((c.x, c.y))
        if tile is None:
            continue
        if tile.get("blocks_los"):
            return False
        if tile["elevation"] > observer_elevation and tile["elevation"] > target_elevation:
            return False
    return True
