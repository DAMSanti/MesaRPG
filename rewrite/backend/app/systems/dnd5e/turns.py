"""D&D 5e initiative/round tracking (ROADMAP.md Fase R4 — slice mínimo).

Deliberately much simpler than app/systems/battletech/turns.py: no
faction/team concept (the approved D&D v1 scope has no notion of
"sides" anywhere), no phase gating, no heat/movement side-effects — one
d20+DEX-modifier roll per character, ordered descending (highest acts
first, standard 5e), ties broken by character_id ascending for a
deterministic order. Whole-round acted tracking only (advisory, like
BattleTech's own — "no es tu turno" would warn, not block, if this ever
grows a frontend check for it), not per-activation turn structure.

Same single-row-per-campaign shape as bt_rounds (no round history) —
starting a new round overwrites the previous one's rolls/acted rows.
"""

import random

from ... import db
from . import characters


def _roll_d20() -> int:
    return random.randint(1, 20)


def get_round(campaign_id: int) -> dict:
    with db.connect() as conn:
        return _get(conn, campaign_id)


def start_round(campaign_id: int) -> dict:
    with db.connect() as conn:
        conn.execute("DELETE FROM dnd_round_rolls WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM dnd_round_acted WHERE campaign_id = ?", (campaign_id,))
        row = conn.execute("SELECT round_number FROM dnd_rounds WHERE campaign_id = ?", (campaign_id,)).fetchone()
        next_round = (row["round_number"] if row else 0) + 1
        conn.execute(
            """
            INSERT INTO dnd_rounds (campaign_id, round_number) VALUES (?, ?)
            ON CONFLICT (campaign_id) DO UPDATE SET round_number = excluded.round_number
            """,
            (campaign_id, next_round),
        )
        chars = conn.execute(
            "SELECT id, dex FROM dnd_characters WHERE campaign_id = ? ORDER BY id", (campaign_id,)
        ).fetchall()
        for c in chars:
            roll = _roll_d20() + characters.ability_modifier(c["dex"])
            conn.execute(
                "INSERT INTO dnd_round_rolls (campaign_id, character_id, roll) VALUES (?, ?, ?)",
                (campaign_id, c["id"], roll),
            )
        return _get(conn, campaign_id)


def mark_acted(campaign_id: int, character_id: int) -> dict:
    with db.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO dnd_round_acted (campaign_id, character_id) VALUES (?, ?)",
            (campaign_id, character_id),
        )
        return _get(conn, campaign_id)


def _get(conn, campaign_id: int) -> dict:
    round_row = conn.execute(
        "SELECT round_number FROM dnd_rounds WHERE campaign_id = ?", (campaign_id,)
    ).fetchone()
    rolls = conn.execute(
        """
        SELECT rr.character_id, rr.roll, c.name
        FROM dnd_round_rolls rr JOIN dnd_characters c ON c.id = rr.character_id
        WHERE rr.campaign_id = ?
        ORDER BY rr.roll DESC, rr.character_id ASC
        """,
        (campaign_id,),
    ).fetchall()
    acted = conn.execute(
        "SELECT character_id FROM dnd_round_acted WHERE campaign_id = ? ORDER BY character_id",
        (campaign_id,),
    ).fetchall()
    return {
        "campaign_id": campaign_id,
        "round_number": round_row["round_number"] if round_row else 0,
        "rolls": [dict(r) for r in rolls],
        "acted_character_ids": [r["character_id"] for r in acted],
    }
