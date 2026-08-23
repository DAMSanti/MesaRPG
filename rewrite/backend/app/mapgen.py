"""Procedural map generation (ROADMAP.md S4 follow-up).

The first 7 biomes (grasslands, forest, city, river, ruins, desert,
mountains) were ported in spirit, not line-for-line, from the old
prototype's `admin/js/battletech-map-generator.js`. The other 4 (swamp,
lake, arctic, volcanic) were added after checking the actual game rather
than assuming the old prototype's list was complete — BattleTech's
BattleMech Manual terrain-modification rules include Swamp/Mud and
Ice/Snow, and the official map-sheet catalog has a real Lake/Water-Feature
theme (distinct from a river's thin line) and a Volcanic theme, none of
which the original 7 covered. All 11 share one small toolkit (fill /
cluster / scatter / near) instead of one function per biome duplicating
the logic. Rivers/roads are straight lines, not the original's meandering
path — a deliberate fidelity cut, not an oversight.
"""

import random

from . import campaigns, db, maps

# (elevation, blocks_los, los_points) — the mechanical meaning of each
# terrain label. Generators may override elevation per-tile (hills/
# mountains/desert dunes aren't a single fixed height); blocks_los/
# los_points always follow this table.
#
# blocks_los is a hard, single-hex block (hills/buildings/water — the
# Attack Modifiers Table's own wording: "one intervening hex blocks LOS"
# for each of those). los_points is instead the woods/jungle rule, which
# doesn't block on its own: "Three or more points of intervening woods/
# jungle block LOS. Light woods/jungle is worth 1 point, and heavy
# woods/jungle is worth 2 points" (see hexgrid.py's has_los for where
# these accumulate). `forest` keeps its existing DB key/meaning — it was
# always "the opaque one" (blocks_los=True) before this table had a
# points column at all, so it stays the HEAVY tier (2 points) rather than
# migrating every already-painted tile; `light_forest` is the new,
# additive light tier. `water` (Depth 1) is corrected here to actually
# block LOS per the rulebook ("intervening water blocks LOS unless both
# attacker and target are submerged" — this app doesn't model submersion,
# so it's simplified to "always blocks"); it did NOT block before this
# table had a reason to get it right. `water_deep` (Depth 2) is new,
# same hard block, deeper/costlier to enter — the further real-rule
# nuance of "a 'Mech standing IN Depth 2 water is blind and invisible
# itself" is NOT modeled (see app/combat.py's own out-of-scope list).
TERRAIN_DEFAULTS: dict[str, tuple[int, bool, int]] = {
    "plains": (0, False, 0),
    "hills": (2, False, 0),
    "forest": (0, False, 2),
    "light_forest": (0, False, 1),
    "water": (0, True, 0),
    "water_deep": (-1, True, 0),
    "road": (0, False, 0),
    "rough": (1, False, 0),
    "rubble": (0, False, 0),
    "hazards": (0, False, 0),
    "building": (2, True, 0),
    "swamp": (0, False, 0),
    "snow": (0, False, 0),
}

# MP cost to ENTER a hex of this terrain (app/systems/battletech/
# movement.py) — a simplified reading of Total Warfare's real movement-
# cost table: 1 for clear/easy terrain, 2 for anything that slows a
# 'Mech down. Roads are a flat 1 regardless of what's under them in this
# app's simplified model (the real rule reduces cost when an entire
# move stays on connected road, which this doesn't track); the real
# rule's terrain-specific costs above 2 (e.g. deep water) aren't
# modeled since none of these 11 types distinguish depth/density tiers.
TERRAIN_MOVE_COST: dict[str, int] = {
    "plains": 1,
    "hills": 1,
    "forest": 2,
    "light_forest": 2,
    "water": 2,
    # Deeper than Depth 1 — the manual's own "Common Misconceptions" section
    # confirms entering Depth 1 water from a Level 0 hex costs 3 MP total
    # (1 base + 1 for the level change + 1 for the water itself); this
    # app's movement-cost model doesn't track per-level deltas into water
    # (see movement.py's own documented simplification), so Depth 2 is
    # given a flat, costlier entry price instead of trying to derive it.
    "water_deep": 3,
    "road": 1,
    "rough": 2,
    "rubble": 2,
    "hazards": 2,
    "building": 2,
    "swamp": 2,
    "snow": 1,
}

Coord = tuple[int, int]


def _hex_neighbors(c: Coord) -> list[Coord]:
    q, r = c
    return [(q + 1, r), (q - 1, r), (q, r + 1), (q, r - 1), (q + 1, r - 1), (q - 1, r + 1)]


def _square_neighbors(c: Coord) -> list[Coord]:
    x, y = c
    return [(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0)]


def _hex_distance(a: Coord, b: Coord) -> int:
    aq, ar = a
    bq, br = b
    return max(abs(aq - bq), abs(ar - br), abs((-aq - ar) - (-bq - br)))


def _square_distance(a: Coord, b: Coord) -> int:
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def _cluster(rng, coords, grid, neighbors_fn, terrain, coverage, min_size, max_size, force_seed=None, protect=frozenset()):
    """`force_seed` starts the first blob there (e.g. a building block
    seeded next to a road, so it actually fronts a street) instead of a
    random cell. `protect` cells are never overwritten but still let the
    blob's frontier pass through them, so e.g. a road cuts a gap through a
    building cluster instead of blocking its growth outright."""
    target = int(len(coords) * coverage)
    placed = 0
    guard = 0
    first = True
    while placed < target and guard < target * 6 + 30:
        guard += 1
        seed = force_seed if (first and force_seed is not None) else rng.choice(coords)
        first = False
        size = rng.randint(min_size, max_size)
        frontier, visited, count = [seed], {seed}, 0
        while frontier and count < size:
            cell = frontier.pop(0)
            if cell not in protect and grid.get(cell) != terrain:
                grid[cell] = terrain
                count += 1
                placed += 1
            for n in neighbors_fn(cell):
                if n in grid and n not in visited:
                    visited.add(n)
                    frontier.append(n)


def _scatter(rng, coords, grid, terrain, density):
    for c in coords:
        if rng.random() < density:
            grid[c] = terrain


def _near(rng, coords, grid, neighbors_fn_or_distance, near_terrain, target_terrain, distance, density):
    distance_fn = neighbors_fn_or_distance
    near_coords = [c for c in coords if grid.get(c) == near_terrain]
    if not near_coords:
        return
    for c in coords:
        if grid.get(c) == near_terrain:
            continue
        if any(distance_fn(c, n) <= distance for n in near_coords) and rng.random() < density:
            grid[c] = target_terrain


def _cube_round(x: float, y: float, z: float) -> tuple[int, int, int]:
    """Standard hex cube-coordinate rounding (Red Blob Games). Rounding q
    and r independently can snap to a hex slightly off the true line at a
    direction change, and *two* such off-line hexes side by side is what
    made roads read as 2-wide blobs instead of a clean 1-wide path."""
    rx, ry, rz = round(x), round(y), round(z)
    dx, dy, dz = abs(rx - x), abs(ry - y), abs(rz - z)
    if dx > dy and dx > dz:
        rx = -ry - rz
    elif dy > dz:
        ry = -rx - rz
    else:
        rz = -rx - ry
    return rx, ry, rz


def _line(coords_set: set[Coord], a: Coord, b: Coord, hexy: bool) -> list[Coord]:
    if not hexy:
        n = _square_distance(a, b)
        if n == 0:
            return [a]
        pts = []
        for i in range(n + 1):
            t = i / n
            x = round(a[0] + (b[0] - a[0]) * t)
            y = round(a[1] + (b[1] - a[1]) * t)
            if (x, y) in coords_set:
                pts.append((x, y))
        return pts

    n = _hex_distance(a, b)
    if n == 0:
        return [a]
    az, bz = -a[0] - a[1], -b[0] - b[1]
    pts = []
    seen: set[Coord] = set()
    for i in range(n + 1):
        t = i / n
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        z = az + (bz - az) * t
        rq, rr, _ = _cube_round(x, y, z)
        if (rq, rr) in coords_set and (rq, rr) not in seen:
            seen.add((rq, rr))
            pts.append((rq, rr))
    return pts


def _snap(coords: list[Coord], target: tuple[float, float]) -> Coord:
    return min(coords, key=lambda c: abs(c[0] - target[0]) + abs(c[1] - target[1]))


def _diagonals(coords: list[Coord]) -> tuple[tuple[Coord, Coord], tuple[Coord, Coord]]:
    """The coordinate set's two bounding-box diagonals, each corner snapped
    to the nearest real coordinate (a hex-rectangle's actual corners aren't
    always exactly the bbox corners). Two roads/rivers drawn along the
    SAME diagonal run near-parallel for a long stretch and read as one wide
    blob instead of two 1-wide lines crossing — callers that need a second,
    genuinely crossing line should use the other diagonal, not re-roll."""
    qs = [c[0] for c in coords]
    rs = [c[1] for c in coords]
    min_q, max_q, min_r, max_r = min(qs), max(qs), min(rs), max(rs)
    diag_a = (_snap(coords, (min_q, min_r)), _snap(coords, (max_q, max_r)))
    diag_b = (_snap(coords, (max_q, min_r)), _snap(coords, (min_q, max_r)))
    return diag_a, diag_b


def _span_endpoints(rng, coords: list[Coord]) -> tuple[Coord, Coord]:
    """Two coords roughly spanning the map, for drawing a single road/river
    across it — either bounding-box diagonal, picked at random. Works for
    any width x height shape, not just one centered on the origin —
    replaced an earlier radius-from-(0,0) assumption that broke once maps
    stopped being a hexagon-of-hexes."""
    return rng.choice(_diagonals(coords))


def _branch(rng, coords_set: set[Coord], grid: dict, neighbors_fn, start: Coord, min_len: int, max_len: int) -> list[Coord]:
    """A short straight side-street branching off `start` along ONE pure
    hex/square direction (repeating the same neighbor offset every step —
    never a diagonal "staircase"). Two independently-drawn diagonal lines
    crossing on a hex grid interlock into a several-tile-wide blob right
    where they meet (their staircase teeth end up mutually adjacent, not
    just touching at one point); a straight branch off an existing road
    sidesteps that, PROVIDED every new tile touches road in exactly one
    place — the tile that led to it. Near a bend in the main road, a
    direction that isn't literally road yet can still land adjacent to
    *several* main-road tiles at once (the bend's other nearby points), so
    each candidate direction and every step along it is checked for that,
    not just "is this tile already road"."""

    def touches_at_most_one_road(c: Coord) -> bool:
        return sum(1 for n in neighbors_fn(c) if grid.get(n) == "road") <= 1

    candidates = [n for n in neighbors_fn(start) if grid.get(n) != "road"]
    rng.shuffle(candidates)
    for first in candidates:
        if not touches_at_most_one_road(first):
            continue
        dq, dr = first[0] - start[0], first[1] - start[1]
        length = rng.randint(min_len, max_len)
        path = []
        cur = first
        for _ in range(length):
            if cur not in coords_set or grid.get(cur) == "road" or not touches_at_most_one_road(cur):
                break
            path.append(cur)
            cur = (cur[0] + dq, cur[1] + dr)
        if path:
            return path
    return []


# ---- biomes ---------------------------------------------------------------


def _grasslands(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid: dict[Coord, str] = {c: "plains" for c in coords}
    elev: dict[Coord, int] = {}
    for _ in range(rng.randint(2, 3)):
        _cluster(rng, coords, grid, neighbors_fn, "forest", 0.06, 2, 5)

    # Hills as a handful of gently-sloped mounds — peak/distance falloff
    # around each seed, same idea as _mountains' own peaks below but
    # radius-capped to a few tiles instead of spanning the whole map (a
    # mound, not a mountain range). Replaces the old approach, which
    # scattered independent single hex tiles and gave each one its own
    # random 1-3 elevation with zero relation to its (elevation-0)
    # neighbors — "1 solo tile muy alto con respecto a los alrededores",
    # a one-tile cliff instead of a hill.
    #
    # peak_elev=3 (not 2) — real user feedback after seeing peak=2 in
    # practice: "no quiero hacer las colinas tapered... quiero que entre
    # el tile de colina y el tile contiguo haya un tile de la mitad de
    # altura" (an explicit rejection of a cosmetic geometry fix in favor
    # of the actual elevation DATA stepping down over more real tiles).
    # peak=2 only ever had ONE intermediate ring (2→1→flat); peak=3 adds
    # a second (3→2→1→flat), so the step at every single tile boundary
    # is still exactly 1 elevation unit — same minimum granularity this
    # integer-elevation system can represent — but now spread over 3
    # rings of real tiles instead of 2, and each individual boundary is
    # proportionally a smaller fraction of the hill's own total height.
    # (peak_elev=1 was tried and rejected in an earlier pass: the falloff
    # ring at distance 1 lands on elevation 0 — same as the surrounding
    # plains — so that "hill" was a single tile no matter what; every
    # peak below the current value has that same failure mode as its own
    # outermost ring, which is exactly why the ring below peak is never
    # the boundary that matters here.)
    #
    # A hex disk grows fast (1/7/19/37 tiles at radius 0/1/2/3), so this
    # only runs at all above HILL_MIN_MAP_TILES — below that, even one
    # radius-3 mound (37 tiles) can swallow most of a small/medium map.
    # Above it, capped at 1 hill until the map is big enough that two
    # can't realistically overlap into one oversized blob. Simulated at
    # 6x6, 8x6, 10x8, 12x10, 16x12 and 20x16 (300 generations each) with
    # these thresholds: zero plains-dominance failures at every size ≥
    # HILL_MIN_MAP_TILES (see test_generate_grasslands_map_is_plains_
    # dominant and test_grasslands_hills_are_multi_tile_mounds_with_a_
    # progressive_slope).
    HILL_MIN_MAP_TILES = 90
    HILL_TWO_HILL_MAP_TILES = 220
    if len(coords) >= HILL_MIN_MAP_TILES:
        n_hills = 1 if len(coords) < HILL_TWO_HILL_MAP_TILES else rng.choices([1, 2], weights=[3, 1])[0]
        for seed in rng.sample(coords, k=min(n_hills, len(coords))):
            peak_elev = 3
            for c in coords:
                d = distance_fn(c, seed)
                if d > peak_elev:
                    continue
                e = peak_elev - d
                if e > 0 and e > elev.get(c, 0):
                    elev[c] = e
                    grid[c] = "hills"

    if rng.random() < 0.6:
        edge_a, edge_b = _span_endpoints(rng, coords)
        for c in _line(coords_set, edge_a, edge_b, hexy):
            grid[c] = "road"
    return grid, elev


def _forest(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "forest" for c in coords}
    elev: dict[Coord, int] = {}
    for _ in range(rng.randint(1, 2)):
        _cluster(rng, coords, grid, neighbors_fn, "plains", 0.05, 2, 4)
    _scatter(rng, coords, grid, "rough", 0.03)
    return grid, elev


def _river(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "plains" for c in coords}
    elev: dict[Coord, int] = {}
    edge_a, edge_b = _span_endpoints(rng, coords)
    for c in _line(coords_set, edge_a, edge_b, hexy):
        grid[c] = "water"
    _near(rng, coords, grid, distance_fn, "water", "forest", 2, 0.45)
    _cluster(rng, coords, grid, neighbors_fn, "hills", 0.05, 2, 4)
    return grid, elev


def _city(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "plains" for c in coords}
    elev: dict[Coord, int] = {}

    # Streets first — a main road across the map plus 1-2 short side
    # streets branching off it, so every building block seeded below has
    # something to front onto. A cluster of buildings with no road
    # touching it isn't a city.
    edge_a, edge_b = _span_endpoints(rng, coords)
    main_road = _line(coords_set, edge_a, edge_b, hexy)
    for c in main_road:
        grid[c] = "road"
    if len(main_road) > 4:
        for _ in range(rng.randint(1, 2)):
            if rng.random() < 0.7:
                start = rng.choice(main_road[1:-1])
                for c in _branch(rng, coords_set, grid, neighbors_fn, start, 3, 7):
                    grid[c] = "road"

    road_coords = [c for c in coords if grid.get(c) == "road"]

    # Total built-up coverage across ALL clusters combined, not per cluster —
    # dividing by n_clusters keeps the sum near this target regardless of
    # how many blocks it's split into, leaving gaps (streets) between them.
    total_coverage = 0.4 + rng.random() * 0.2
    n_clusters = rng.randint(4, 7)
    protect = set(road_coords)
    for _ in range(n_clusters):
        force_seed = None
        if road_coords:
            frontage = [n for n in neighbors_fn(rng.choice(road_coords)) if n in grid and n not in protect]
            if frontage:
                force_seed = rng.choice(frontage)
        _cluster(
            rng, coords, grid, neighbors_fn, "building", total_coverage / n_clusters, 2, 4,
            force_seed=force_seed, protect=protect,
        )
    # Rubble only spreads near buildings, and never eats a protected street —
    # `_near` doesn't know about `protect` itself, so filter its own output.
    before = dict(grid)
    _near(rng, coords, grid, distance_fn, "building", "rubble", 1, 0.2)
    for c in protect:
        grid[c] = before[c]
    if rng.random() < 0.5:
        _cluster(rng, coords, grid, neighbors_fn, "forest", 0.04, 2, 4, protect=protect)
    return grid, elev


def _ruins(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "plains" for c in coords}
    elev: dict[Coord, int] = {}
    _cluster(rng, coords, grid, neighbors_fn, "rubble", 0.35, 2, 6)
    _scatter(rng, coords, grid, "rubble", 0.1)
    _scatter(rng, coords, grid, "hazards", 0.05)
    _scatter(rng, coords, grid, "building", 0.05)
    _cluster(rng, coords, grid, neighbors_fn, "forest", 0.05, 2, 3)
    return grid, elev


def _desert(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "rough" for c in coords}
    elev = {c: rng.randint(0, 1) for c in coords}
    for _ in range(rng.randint(2, 4)):
        _cluster(rng, coords, grid, neighbors_fn, "rough", 0.08, 2, 5)
    for c in coords:
        if grid.get(c) == "rough" and rng.random() < 0.15:
            elev[c] = rng.randint(2, 4)
    oasis = rng.choice(coords)
    grid[oasis] = "water"
    for n in neighbors_fn(oasis):
        if n in grid:
            grid[n] = "forest"
    return grid, elev


def _mountains(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    grid = {c: "rough" for c in coords}
    peaks = rng.sample(coords, k=min(3, len(coords)))
    elev = {}
    for c in coords:
        d = min(distance_fn(c, p) for p in peaks)
        elev[c] = max(0, 4 - d)
    for c in coords:
        if 1 <= elev.get(c, 0) <= 2 and rng.random() < 0.25:
            grid[c] = "forest"
            elev[c] = min(elev[c], 1)
    return grid, elev


def _swamp(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    # Mud/Swamp is an official BattleMech Manual terrain modification —
    # mechanically like `rough` (no LOS block, movement penalty) but kept
    # as its own terrain label so it reads as wetland, not desert scrub.
    grid = {c: "swamp" for c in coords}
    elev: dict[Coord, int] = {}
    for _ in range(rng.randint(2, 3)):
        _cluster(rng, coords, grid, neighbors_fn, "water", 0.05, 2, 3)
    _scatter(rng, coords, grid, "forest", 0.08)
    _near(rng, coords, grid, distance_fn, "water", "forest", 1, 0.2)
    return grid, elev


def _lake(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    # A real body of water (official "Lakes/Water Features" map-sheet
    # theme) — deliberately NOT the same shape as `river`'s thin line.
    grid = {c: "plains" for c in coords}
    elev: dict[Coord, int] = {}
    _cluster(rng, coords, grid, neighbors_fn, "water", 0.4 + rng.random() * 0.15, 6, 14)
    water_coords = [c for c in coords if grid.get(c) == "water"]
    for _ in range(rng.randint(1, 3)):
        if not water_coords:
            break
        shore = [n for n in neighbors_fn(rng.choice(water_coords)) if grid.get(n) == "plains"]
        if shore:
            _cluster(rng, coords, grid, neighbors_fn, "forest", 0.03, 2, 4, force_seed=rng.choice(shore))
    _near(rng, coords, grid, distance_fn, "water", "forest", 1, 0.35)
    return grid, elev


def _arctic(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    # Ice/Snow are official BattleMech Manual terrain modifications, and
    # "Glacier" is one of the official map-sheet themes.
    grid = {c: "snow" for c in coords}
    elev = {c: 0 for c in coords}
    for _ in range(rng.randint(2, 3)):
        _cluster(rng, coords, grid, neighbors_fn, "water", 0.05, 3, 6)  # frozen lakes/leads
    for _ in range(rng.randint(1, 2)):
        _cluster(rng, coords, grid, neighbors_fn, "rough", 0.05, 2, 5)  # icy rock outcrops
    for c in coords:
        if grid.get(c) == "rough" and rng.random() < 0.3:
            elev[c] = rng.randint(1, 3)
    return grid, elev


def _volcanic(rng, coords, coords_set, neighbors_fn, distance_fn, hexy):
    # Volcanic is an official map-sheet theme. Built from the existing
    # hazards/rough/rubble vocabulary (lava fields / bare rock / ash) rather
    # than inventing a new "lava" terrain type.
    grid = {c: "rough" for c in coords}
    elev = {c: rng.randint(0, 1) for c in coords}
    _cluster(rng, coords, grid, neighbors_fn, "hazards", 0.18, 3, 6)
    _scatter(rng, coords, grid, "rubble", 0.12)
    for c in coords:
        if grid.get(c) == "hazards":
            elev[c] = 0
        elif rng.random() < 0.2:
            elev[c] = rng.randint(1, 4)
    return grid, elev


BIOMES = {
    "grasslands": _grasslands,
    "forest": _forest,
    "river": _river,
    "city": _city,
    "ruins": _ruins,
    "desert": _desert,
    "mountains": _mountains,
    "swamp": _swamp,
    "lake": _lake,
    "arctic": _arctic,
    "volcanic": _volcanic,
}


def generate_map(campaign_id: int, name: str, width: int, height: int, biome: str) -> dict:
    if biome not in BIOMES:
        raise ValueError(f"Unknown biome {biome!r}, expected one of {list(BIOMES)}")

    campaign = campaigns.get_campaign(campaign_id)
    grid_type = campaign["grid_type"] if campaign else "hex"
    hexy = grid_type == "hex"
    coords = maps._hex_rect(width, height) if hexy else maps._square_rect(width, height)
    coords_set = set(coords)
    neighbors_fn = _hex_neighbors if hexy else _square_neighbors
    distance_fn = _hex_distance if hexy else _square_distance

    rng = random.Random()
    terrain_grid, elevation_overrides = BIOMES[biome](rng, coords, coords_set, neighbors_fn, distance_fn, hexy)

    with db.connect() as conn:
        cur = conn.execute(
            # `radius` is vestigial (see db.py's migration note) — kept
            # NOT NULL-satisfied for old DBs, never read back.
            "INSERT INTO maps (campaign_id, name, radius, width, height, grid_type) VALUES (?, ?, ?, ?, ?, ?)",
            (campaign_id, name, max(width, height), width, height, grid_type),
        )
        map_id = cur.lastrowid
        for c in coords:
            terrain = terrain_grid.get(c, "plains")
            # Every biome generator above only ever paints the single
            # "forest" key (predating the light/heavy split) — rather than
            # touching each of the ~10 biome functions individually, a
            # fraction of those tiles downgrade to the light tier right
            # here, so new maps get a mix of both without the generators
            # needing to know the split exists at all.
            if terrain == "forest" and rng.random() < 0.4:
                terrain = "light_forest"
            default_elev, blocks_los, los_points = TERRAIN_DEFAULTS[terrain]
            elevation = elevation_overrides.get(c, default_elev)
            conn.execute(
                """
                INSERT INTO hex_tiles (map_id, q, r, elevation, blocks_los, los_points, terrain)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (map_id, c[0], c[1], elevation, blocks_los, los_points, terrain),
            )
        return maps._get(conn, map_id)
