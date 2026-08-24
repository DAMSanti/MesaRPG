from . import campaigns, db, events


def _hex_rect(width: int, height: int) -> list[tuple[int, int]]:
    """Odd-r offset rectangle: row r's q range shifts left by r//2, so the
    result renders as a proper width x height rectangle (not a diamond)
    once laid out with the pointy-top hexToWorld the frontend uses."""
    coords = []
    for r in range(height):
        r_offset = r // 2
        for q in range(-r_offset, width - r_offset):
            coords.append((q, r))
    return coords


def _square_rect(width: int, height: int) -> list[tuple[int, int]]:
    return [(x, y) for x in range(width) for y in range(height)]


def create_map(
    campaign_id: int,
    name: str,
    width: int,
    height: int,
    elevations: dict[tuple[int, int], int] | None = None,
    blocked: set[tuple[int, int]] | None = None,
    _log: bool = True,
) -> dict:
    """Grid shape follows the campaign's game system (ROADMAP.md S0) —
    hex rectangle for Battletech, square for D&D 5e. Not caller-chosen, so a
    hex-system campaign can never accidentally end up with a square map."""
    elevations = elevations or {}
    blocked = blocked or set()
    campaign = campaigns.get_campaign(campaign_id)
    grid_type = campaign["grid_type"] if campaign else "hex"
    coords = _hex_rect(width, height) if grid_type == "hex" else _square_rect(width, height)

    with db.connect() as conn:
        cur = conn.execute(
            # `radius` has no real meaning anymore (maps are now width x
            # height) but the column is still NOT NULL on old DBs — see
            # db.py's migration note — so it gets a harmless derived value.
            "INSERT INTO maps (campaign_id, name, radius, width, height, grid_type) VALUES (?, ?, ?, ?, ?, ?)",
            (campaign_id, name, max(width, height), width, height, grid_type),
        )
        map_id = cur.lastrowid
        for q, r in coords:
            conn.execute(
                """
                INSERT INTO hex_tiles (map_id, q, r, elevation, blocks_los)
                VALUES (?, ?, ?, ?, ?)
                """,
                (map_id, q, r, elevations.get((q, r), 0), (q, r) in blocked),
            )
        # _log=False only from events.py's own _undo_map_deleted (this IS
        # the recreate step of undoing a delete) — see pilots.py's
        # create_pilot for why this guard has to exist at all.
        if _log:
            events.log_event(conn, campaign_id, "map_created", f"Mapa creado: {name}", {"map_id": map_id})
        return _get(conn, map_id)


def get_map(map_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, map_id)


def delete_map(map_id: int, _log: bool = True) -> bool:
    """hex_tiles/units both cascade on map_id (db.py's own FK
    declarations), so this alone cleans up everything on the map itself.
    campaigns.active_map_id has no FK constraint at all though (it
    predates that column existing as a real reference — db.py's own
    migration comment), so a campaign that had THIS map projected would
    otherwise keep pointing at a now-nonexistent id; cleared here rather
    than left dangling for whichever caller reads it next to discover.
    `_log=False` only from events.py's own _undo_map_created/
    _undo_map_generated — see create_map's matching comment."""
    with db.connect() as conn:
        snapshot = _get(conn, map_id)
        conn.execute("UPDATE campaigns SET active_map_id = NULL WHERE active_map_id = ?", (map_id,))
        cur = conn.execute("DELETE FROM maps WHERE id = ?", (map_id,))
        if _log and cur.rowcount and snapshot:
            events.log_event(
                conn, snapshot["campaign_id"], "map_deleted", f"Mapa borrado: {snapshot['name']}",
                {"snapshot": snapshot},
            )
        return cur.rowcount > 0


def list_maps(campaign_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id FROM maps WHERE campaign_id = ? ORDER BY id", (campaign_id,)
        ).fetchall()
        return [_get(conn, row["id"]) for row in rows]


def update_tile(
    map_id: int,
    q: int,
    r: int,
    elevation: int | None = None,
    blocks_los: bool | None = None,
    terrain: str | None = None,
    los_points: int | None = None,
) -> dict | None:
    """Editor de mapas (ROADMAP.md S1/S4): repintar una casilla ya existente."""
    fields = {
        k: v
        for k, v in {
            "elevation": elevation, "blocks_los": blocks_los, "terrain": terrain, "los_points": los_points,
        }.items()
        if v is not None
    }
    with db.connect() as conn:
        exists = conn.execute(
            "SELECT 1 FROM hex_tiles WHERE map_id = ? AND q = ? AND r = ?", (map_id, q, r)
        ).fetchone()
        if not exists:
            return None
        if fields:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE hex_tiles SET {set_clause} WHERE map_id = ? AND q = ? AND r = ?",
                (*fields.values(), map_id, q, r),
            )
        return _get(conn, map_id)


def tiles_lookup(map_id: int) -> dict[tuple[int, int], dict]:
    """(q, r) -> {"elevation": int, "blocks_los": bool, "los_points": int,
    "terrain": str} — what hexgrid/squaregrid has_los expects (the first
    three), plus terrain for callers (app/combat.py's resolve_attack) that
    also need to know what's actually underfoot, e.g. a to-hit terrain
    bonus — one lookup shared instead of a second query for the same
    tiles."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT q, r, elevation, blocks_los, los_points, terrain FROM hex_tiles WHERE map_id = ?",
            (map_id,),
        ).fetchall()
        return {
            (row["q"], row["r"]): {
                "elevation": row["elevation"],
                "blocks_los": bool(row["blocks_los"]),
                "los_points": row["los_points"],
                "terrain": row["terrain"],
            }
            for row in rows
        }


def _get(conn, map_id: int) -> dict | None:
    map_row = conn.execute(
        "SELECT id, campaign_id, name, width, height, grid_type, created_at FROM maps WHERE id = ?",
        (map_id,),
    ).fetchone()
    if not map_row:
        return None
    tile_rows = conn.execute(
        "SELECT q, r, elevation, blocks_los, los_points, terrain FROM hex_tiles WHERE map_id = ?",
        (map_id,),
    ).fetchall()
    result = dict(map_row)
    result["tiles"] = [{**dict(t), "blocks_los": bool(t["blocks_los"])} for t in tile_rows]
    return result
