"""D&D 5e character sheets (ROADMAP.md Fase R4 — slice mínimo).

Deliberately NOT a full 5e character: no class/subclass, no spells, no
feats, no conditions, no saving throws. Six ability scores, AC, HP
current/max, and a proficiency bonus — enough for `combat.resolve_attack`
and `turns` (initiative) to work end to end, which is the actual goal of
this slice (validating the plugin boundary, not building a rules engine).

No approval workflow either (unlike BattleTech's pilots/mechs, which
gained `status`/`owner_token` in a later phase once the product needed
it) — the GM creates a character directly, the same way BattleTech
itself worked before that phase existed. Add one if D&D ever needs it.
"""

from ... import db

ABILITIES = ("str", "dex", "con", "int", "wis", "cha")


def ability_modifier(score: int) -> int:
    """Standard 5e formula: floor((score - 10) / 2)."""
    return (score - 10) // 2


def create_character(
    campaign_id: int,
    name: str,
    str: int = 10,  # noqa: A002 - matches the DB column / D&D's own ability name
    dex: int = 10,
    con: int = 10,
    int: int = 10,  # noqa: A002 - matches the DB column / D&D's own ability name
    wis: int = 10,
    cha: int = 10,
    ac: int = 10,
    hp_max: int = 10,
    proficiency_bonus: int = 2,
) -> dict:
    with db.connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO dnd_characters
                (campaign_id, name, str, dex, con, int, wis, cha, ac, hp_current, hp_max, proficiency_bonus)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (campaign_id, name, str, dex, con, int, wis, cha, ac, hp_max, hp_max, proficiency_bonus),
        )
        return _get(conn, cur.lastrowid)


def list_characters(campaign_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, campaign_id, name, str, dex, con, int, wis, cha,
                   ac, hp_current, hp_max, proficiency_bonus, created_at
            FROM dnd_characters WHERE campaign_id = ? ORDER BY id
            """,
            (campaign_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_character(character_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, character_id)


def update_hp(character_id: int, delta: int) -> dict | None:
    """Applies `delta` (negative for damage, positive for healing) to
    hp_current, clamped to [0, hp_max] — no death/dying rules (out of
    scope for this slice, see this module's own doc comment)."""
    with db.connect() as conn:
        row = conn.execute("SELECT hp_current, hp_max FROM dnd_characters WHERE id = ?", (character_id,)).fetchone()
        if row is None:
            return None
        new_hp = max(0, min(row["hp_max"], row["hp_current"] + delta))
        conn.execute("UPDATE dnd_characters SET hp_current = ? WHERE id = ?", (new_hp, character_id))
        return _get(conn, character_id)


def _get(conn, character_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT id, campaign_id, name, str, dex, con, int, wis, cha,
               ac, hp_current, hp_max, proficiency_bonus, created_at
        FROM dnd_characters WHERE id = ?
        """,
        (character_id,),
    ).fetchone()
    return dict(row) if row else None
