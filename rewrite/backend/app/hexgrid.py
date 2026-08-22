"""Axial hex-grid math: distance and line-of-sight tracing.

Simplified LoS on purpose (ROADMAP.md Fase R1): a hex blocks sight if it's
flagged `blocks_los` (dense terrain — hills, buildings, water), OR its
elevation is higher than BOTH the observer's and the target's elevation (a
hill in between blocks the view). Official Total Warfare LoS has more
nuance (partial cover, intervening elevation exactly at eye level, etc.) —
this is the testable core, not the final word.

Woods/jungle are the one terrain that does NOT hard-block on a single hex —
verified against the manual's own text: "Three or more points of
intervening woods/jungle block LOS. Light woods/jungle is worth 1 point,
and heavy woods/jungle is worth 2 points." So `los_points` accumulates
across every intervening hex (same exclusion of both endpoints as
`blocks_los`) and LoS is blocked once the total reaches 3, regardless of
how many hexes that took — one heavy + one light (2+1=3) blocks exactly
like two heavy (2+2=4) or three light (1+1+1=3). A tile with no
`los_points` key (every non-woods terrain, and every existing test
fixture written before this existed) contributes 0.
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


_LOS_BLOCK_POINTS = 3


def has_los(
    observer: Hex,
    observer_elevation: int,
    target: Hex,
    target_elevation: int,
    tiles: dict[tuple[int, int], dict],
) -> bool:
    """tiles maps (q, r) -> {"elevation": int, "blocks_los": bool,
    "los_points": int}. `los_points` is optional (defaults to 0) so tiles
    dicts built before woods-accumulation existed keep working unchanged."""
    path = line(observer, target)
    woods_points = 0
    for h in path[1:-1]:  # endpoints never block their own sightline
        tile = tiles.get((h.q, h.r))
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
