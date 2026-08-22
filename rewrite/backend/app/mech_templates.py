"""Local, offline-first catalog of real mech chassis/models (VISION.md §3
— the table has to work without internet at a client's house, so mech
creation can't depend on a live fetch at request time). One row per MTF
source file, populated once by scripts/sync_mech_catalog.py from the
public MegaMek unit database that app/mech_import.py's parse_mtf already
knows how to read — this module only ever reads what that script wrote.
"""

import json

from . import db


def upsert_template(source_file: str, chassis: str, model: str, tonnage: int, payload: dict) -> None:
    """`payload` is parse_mtf()'s output minus chassis/model/tonnage
    (those get their own columns so search/listing don't need to touch
    the JSON blob)."""
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO mech_templates (source_file, chassis, model, tonnage, data, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(source_file) DO UPDATE SET
                chassis = excluded.chassis, model = excluded.model, tonnage = excluded.tonnage,
                data = excluded.data, updated_at = excluded.updated_at
            """,
            (source_file, chassis, model, tonnage, json.dumps(payload)),
        )


def search_templates(query: str, limit: int = 20) -> list[dict]:
    """Same {"name", "file"} shape the old live search returned — the
    frontend's MechImportSelector never had to change for this."""
    q = query.strip()
    if not q:
        return []
    like = f"%{q}%"
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT source_file, chassis, model FROM mech_templates
            WHERE chassis LIKE ? OR model LIKE ? OR (chassis || ' ' || model) LIKE ?
            ORDER BY chassis, model
            LIMIT ?
            """,
            (like, like, like, limit),
        ).fetchall()
    return [{"name": f"{r['chassis']} {r['model']}".strip(), "file": r["source_file"]} for r in rows]


def get_template(source_file: str) -> dict | None:
    """Same shape parse_mtf() used to return directly to the API layer —
    chassis/model/tonnage merged back in from their own columns."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT chassis, model, tonnage, data FROM mech_templates WHERE source_file = ?",
            (source_file,),
        ).fetchone()
    if not row:
        return None
    payload = json.loads(row["data"])
    return {"chassis": row["chassis"], "model": row["model"], "tonnage": row["tonnage"], **payload}


def template_count() -> int:
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM mech_templates").fetchone()["n"]


def list_chassis() -> list[str]:
    """Distinct chassis names — the first of the GM's two cascading
    dropdowns (ROADMAP.md Fase R3 follow-up, requested directly: pick a
    real chassis/model instead of typing armor/structure by hand)."""
    with db.connect() as conn:
        rows = conn.execute("SELECT DISTINCT chassis FROM mech_templates ORDER BY chassis").fetchall()
    return [r["chassis"] for r in rows]


def list_models(chassis: str) -> list[dict]:
    """Every model/variant on file for one chassis — the second dropdown,
    populated once the first one picks a chassis. Same {"name", "file"}
    shape as search_templates so the frontend can reuse one type."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT source_file, chassis, model FROM mech_templates WHERE chassis = ? ORDER BY model",
            (chassis,),
        ).fetchall()
    return [{"name": f"{r['chassis']} {r['model']}".strip(), "file": r["source_file"], "model": r["model"]} for r in rows]
