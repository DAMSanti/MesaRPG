from ... import db

# player = a player's own character; enemy = GM-controlled hostile;
# npc = non-aggressive (merchants, quest contacts, etc.) — Battletech only
# needs these three, no finer-grained faction system.
FACTIONS = {"player", "enemy", "npc"}

# Character sheet approval (ROADMAP.md Fase R3 — "suite jugable"). A
# sheet created by the GM starts approved (nothing to review); one
# submitted by a player starts pending and needs the GM's decision.
STATUSES = {"pending", "approved", "rejected"}


class UnknownFaction(ValueError):
    pass


class UnknownStatus(ValueError):
    pass


class InvalidStatusTransition(ValueError):
    pass


def _check_faction(faction: str) -> None:
    if faction not in FACTIONS:
        raise UnknownFaction(f"Unknown faction {faction!r}, expected one of {sorted(FACTIONS)}")


def _check_status(status: str) -> None:
    if status not in STATUSES:
        raise UnknownStatus(f"Unknown status {status!r}, expected one of {sorted(STATUSES)}")


def create_pilot(
    campaign_id: int,
    name: str,
    callsign: str | None = None,
    gunnery: int = 4,
    piloting: int = 5,
    faction: str = "player",
    status: str = "approved",
    owner_token: str | None = None,
    color: str | None = None,
) -> dict:
    _check_faction(faction)
    _check_status(status)
    with db.connect() as conn:
        if color is not None:
            cur = conn.execute(
                """
                INSERT INTO pilots (campaign_id, name, callsign, gunnery, piloting, faction, status, owner_token, color)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (campaign_id, name, callsign, gunnery, piloting, faction, status, owner_token, color),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO pilots (campaign_id, name, callsign, gunnery, piloting, faction, status, owner_token)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (campaign_id, name, callsign, gunnery, piloting, faction, status, owner_token),
            )
        return _get(conn, cur.lastrowid)


def list_pilots(campaign_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, campaign_id, name, callsign, gunnery, piloting, faction,
                   hits, status, owner_token, review_note, color, created_at
            FROM pilots WHERE campaign_id = ? ORDER BY id
            """,
            (campaign_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def review_pilot(pilot_id: int, decision: str, note: str | None = None) -> dict | None:
    if decision not in ("approved", "rejected"):
        raise UnknownStatus(f"Unknown review decision {decision!r}, expected 'approved' or 'rejected'")
    with db.connect() as conn:
        conn.execute(
            "UPDATE pilots SET status = ?, review_note = ? WHERE id = ?",
            (decision, note if decision == "rejected" else None, pilot_id),
        )
        return _get(conn, pilot_id)


def resubmit_pilot(pilot_id: int) -> dict | None:
    pilot = get_pilot(pilot_id)
    if not pilot or pilot["status"] != "rejected":
        raise InvalidStatusTransition("Only a rejected pilot can be resubmitted")
    with db.connect() as conn:
        conn.execute(
            "UPDATE pilots SET status = 'pending', review_note = NULL WHERE id = ?",
            (pilot_id,),
        )
        return _get(conn, pilot_id)


def update_pilot(
    pilot_id: int,
    name: str | None = None,
    callsign: str | None = None,
    gunnery: int | None = None,
    piloting: int | None = None,
    faction: str | None = None,
    hits: int | None = None,
    color: str | None = None,
) -> dict | None:
    if faction is not None:
        _check_faction(faction)
    fields = {
        k: v
        for k, v in {
            "name": name, "callsign": callsign, "gunnery": gunnery,
            "piloting": piloting, "faction": faction, "hits": hits, "color": color,
        }.items()
        if v is not None
    }
    if not fields:
        return get_pilot(pilot_id)
    with db.connect() as conn:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE pilots SET {set_clause} WHERE id = ?", (*fields.values(), pilot_id))
        return _get(conn, pilot_id)


def delete_pilot(pilot_id: int) -> bool:
    """GM-initiated removal. `mechs.pilot_id` and `units.pilot_id` are
    `ON DELETE SET NULL` (db.py) — any mech/unit that had this pilot
    survives, just unpiloted, rather than cascading further deletes."""
    with db.connect() as conn:
        cur = conn.execute("DELETE FROM pilots WHERE id = ?", (pilot_id,))
        return cur.rowcount > 0


def get_pilot(pilot_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, pilot_id)


def _get(conn, pilot_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT id, campaign_id, name, callsign, gunnery, piloting, faction,
               hits, status, owner_token, review_note, color, created_at
        FROM pilots WHERE id = ?
        """,
        (pilot_id,),
    ).fetchone()
    return dict(row) if row else None
