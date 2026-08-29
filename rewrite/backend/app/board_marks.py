"""Things left lying on a map: severed limbs now, weapon craters and mech
footprints next.

Real user request: "las piezas se tienen que guardar en el servidor y
quedarse donde caen toda la partida, ahi tambien guardaremos luego los
crateres de impacto de las armas y las huellas que dejan los mechs."

So this is deliberately ONE table for all three rather than a table per
kind. They are the same fact — something happened at a point on a map and
the board should remember it — and they are written the same way (append
once, never edited), read the same way (everything for a map, on load) and
cleared the same way (when a map is reset). The parts that genuinely differ
are the payload, which lives in `data` as JSON.

Kept out of `campaign_events` on purpose. That table is the game's own
history, replayed and undone; this is scenery. A crater does not un-crater
because someone undid the shot that made it.
"""

import json

from . import db

#: The kinds this table is expected to hold. Not enforced by the schema —
#: adding footprints later should not need a migration — but listed so the
#: API can reject a typo instead of writing a mark nothing will ever read.
MARK_KINDS = {"limb", "crater", "footprint"}


def add_mark(
    map_id: int,
    kind: str,
    x: float,
    z: float,
    data: dict | None = None,
) -> dict:
    """Records one mark. Append-only: a mark is a thing that happened."""
    if kind not in MARK_KINDS:
        raise ValueError(f"Unknown board mark kind: {kind!r}")
    with db.connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO board_marks (map_id, kind, x, z, data)
            VALUES (?, ?, ?, ?, ?)
            """,
            (map_id, kind, x, z, json.dumps(data or {})),
        )
        row = conn.execute(
            "SELECT id, map_id, kind, x, z, data, created_at FROM board_marks WHERE id = ?",
            (cur.lastrowid,),
        ).fetchone()
        return _row_to_mark(row)


def marks_for_map(map_id: int, kind: str | None = None) -> list[dict]:
    """Everything a map is carrying, oldest first so the client rebuilds it
    in the order it happened."""
    with db.connect() as conn:
        if kind is None:
            rows = conn.execute(
                """
                SELECT id, map_id, kind, x, z, data, created_at
                FROM board_marks WHERE map_id = ? ORDER BY id
                """,
                (map_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, map_id, kind, x, z, data, created_at
                FROM board_marks WHERE map_id = ? AND kind = ? ORDER BY id
                """,
                (map_id, kind),
            ).fetchall()
        return [_row_to_mark(row) for row in rows]


def remove_mark(mark_id: int) -> bool:
    """Takes ONE mark off the board. Returns whether it was there.

    Append-only is the rule for things that happened, and a limb on the
    ground is one of those -- but a limb can also be put back. Real user
    report: "le he restaurado los miembros, y si le doy a perder miembros,
    simplemente desaparecen del modelo, no se despegan, no caen." An arm
    that is attached again is not wreckage any more, and leaving its mark
    behind is what stopped the next amputation from dropping anything: the
    client keys wreckage by unit and location, so the stale record made the
    new one look like a duplicate.
    """
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM board_marks WHERE id = ?", (mark_id,))
        return cur.rowcount > 0


def clear_marks(map_id: int, kind: str | None = None) -> int:
    """Wipes a map clean — for starting a fresh battle on the same terrain.
    Returns how many were removed."""
    with db.connect() as conn:
        if kind is None:
            cur = conn.execute("DELETE FROM board_marks WHERE map_id = ?", (map_id,))
        else:
            cur = conn.execute(
                "DELETE FROM board_marks WHERE map_id = ? AND kind = ?", (map_id, kind)
            )
        return cur.rowcount


def _row_to_mark(row) -> dict:
    mark = dict(row)
    try:
        mark["data"] = json.loads(mark["data"]) if mark["data"] else {}
    except (TypeError, ValueError):
        # A mark with unreadable payload is still a mark at a place. Losing
        # the whole board's scenery over one bad row would be the worse bug.
        mark["data"] = {}
    return mark
