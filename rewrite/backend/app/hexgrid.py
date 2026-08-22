"""Axial hex-grid math: distance and line-of-sight tracing.

Simplified LoS on purpose (ROADMAP.md Fase R1): a hex blocks sight if it's
flagged `blocks_los` (dense terrain), OR its elevation is higher than
BOTH the observer's and the target's elevation (a hill in between blocks
the view). Official Total Warfare LoS has more nuance (partial cover,
intervening elevation exactly at eye level, etc.) — this is the testable
core, not the final word; revisit once Fase R2 rules research is done.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Hex:
    q: int
    r: int


def _to_cube(h: Hex) -> tuple[int, int, int]:
    x, z = h.q, h.r
    y = -x - z
    return x, y, z


def distance(a: Hex, b: Hex) -> int:
    ax, ay, az = _to_cube(a)
    bx, by, bz = _to_cube(b)
    return max(abs(ax - bx), abs(ay - by), abs(az - bz))


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _cube_round(x: float, y: float, z: float) -> tuple[int, int, int]:
    rx, ry, rz = round(x), round(y), round(z)
    dx, dy, dz = abs(rx - x), abs(ry - y), abs(rz - z)
    if dx > dy and dx > dz:
        rx = -ry - rz
    elif dy > dz:
        ry = -rx - rz
    else:
        rz = -rx - ry
    return int(rx), int(ry), int(rz)


def line(a: Hex, b: Hex) -> list[Hex]:
    """All hexes on the straight line from a to b, inclusive of both ends."""
    n = distance(a, b)
    if n == 0:
        return [a]
    ax, ay, az = _to_cube(a)
    bx, by, bz = _to_cube(b)
    hexes = []
    for i in range(n + 1):
        t = i / n
        x, y, z = _cube_round(_lerp(ax, bx, t), _lerp(ay, by, t), _lerp(az, bz, t))
        hexes.append(Hex(q=x, r=z))
    return hexes


def has_los(
    observer: Hex,
    observer_elevation: int,
    target: Hex,
    target_elevation: int,
    tiles: dict[tuple[int, int], dict],
) -> bool:
    """tiles maps (q, r) -> {"elevation": int, "blocks_los": bool}."""
    path = line(observer, target)
    for h in path[1:-1]:  # endpoints never block their own sightline
        tile = tiles.get((h.q, h.r))
        if tile is None:
            continue
        if tile.get("blocks_los"):
            return False
        if tile["elevation"] > observer_elevation and tile["elevation"] > target_elevation:
            return False
    return True
