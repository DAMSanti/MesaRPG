"""Roll resolution: the server is the single source of truth for the result.

The frontend's physics animation is cosmetic (see rewrite/README.md) — it
does not decide the outcome, it just needs to visually settle on whatever
number this module already picked.
"""

import secrets

from . import db

DICE_SIDES = {
    "d4": 4,
    "d6": 6,
    "d8": 8,
    "d10": 10,
    "d12": 12,
    "d20": 20,
}


def resolve(die: str) -> int:
    sides = DICE_SIDES.get(die)
    if sides is None:
        raise ValueError(f"Unknown die type: {die!r}")
    return secrets.randbelow(sides) + 1


def insert_roll(
    campaign_id: int,
    die: str,
    result: int,
    pilot_id: int | None = None,
    label: str | None = None,
) -> dict:
    with db.connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO rolls (campaign_id, pilot_id, die, result, label)
            VALUES (?, ?, ?, ?, ?)
            """,
            (campaign_id, pilot_id, die, result, label),
        )
        row = conn.execute(
            """
            SELECT id, campaign_id, pilot_id, die, result, label, created_at
            FROM rolls WHERE id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
        return dict(row)


def recent_rolls(campaign_id: int, limit: int = 20) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, campaign_id, pilot_id, die, result, label, created_at
            FROM rolls WHERE campaign_id = ? ORDER BY id DESC LIMIT ?
            """,
            (campaign_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
