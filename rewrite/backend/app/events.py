"""Persistent campaign history + generic undo (real user request: "el
registro debe guardar todo... TODO!!!" + "deshacer cualquier acción").
Supersedes the old BattleTech-attack-only combat_actions table (see
db.py's campaign_events schema comment) — every module that mutates
campaign state (pilots/mechs/maps/units/turns/combat) calls log_event()
from inside its own transaction, right before that transaction's
`with db.connect()` block ends.

Deliberately NOT a generic diff/snapshot engine — each event_type's
payload captures exactly what its own _undo_* needs, nothing more:
- "created X" events undo by deleting X.
- "deleted X" events undo by recreating X from a full snapshot taken
  right before the delete.
- "changed X's status/fields" events undo by restoring the prior values
  captured right before the change.

Local (function-body) imports of pilots/mechs/maps/units below are
deliberate, not sloppy — those modules import THIS module (to log their
own mutations), so importing them back at module load time here would
be a real cycle. Deferring to call time (only when an undo of that
specific type actually runs) breaks it, same spirit as
app/systems/battletech/__init__.py staying empty for its own cycle.
"""

import json

from . import db


class NotUndoable(ValueError):
    pass


def log_event(conn, campaign_id: int, event_type: str, summary: str, payload: dict, undoable: bool = True) -> None:
    conn.execute(
        "INSERT INTO campaign_events (campaign_id, event_type, summary, payload, undoable) VALUES (?, ?, ?, ?, ?)",
        (campaign_id, event_type, summary, json.dumps(payload), undoable),
    )


def list_events(campaign_id: int, limit: int = 200) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, campaign_id, event_type, summary, payload, undoable, undone, created_at
            FROM campaign_events WHERE campaign_id = ? ORDER BY id DESC LIMIT ?
            """,
            (campaign_id, limit),
        ).fetchall()
        return [
            {
                **dict(r),
                "payload": json.loads(r["payload"]),
                "undoable": bool(r["undoable"]),
                "undone": bool(r["undone"]),
            }
            for r in rows
        ]


def undo_last_event(campaign_id: int) -> dict | None:
    """None means nothing to undo (404 territory for the caller).
    Raises NotUndoable for a logged-but-not-reversible event type —
    the caller turns that into a 409 with a clear message, rather than
    silently skipping to an older, undoable event (see events.py's own
    module docstring / the plan this was built from: predictable
    "undo the LAST thing" semantics beat surprising ones)."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, event_type, summary, payload, undoable FROM campaign_events "
            "WHERE campaign_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1",
            (campaign_id,),
        ).fetchone()
        if not row:
            return None
        if not row["undoable"]:
            raise NotUndoable(f"{row['event_type']!r} events can't be undone automatically")
        payload = json.loads(row["payload"])
        _UNDO_HANDLERS[row["event_type"]](conn, campaign_id, payload)
        conn.execute("UPDATE campaign_events SET undone = 1 WHERE id = ?", (row["id"],))
        return {"event_id": row["id"], "event_type": row["event_type"], "summary": row["summary"]}


# ---- undo handlers, one per event_type ------------------------------------


def _undo_pilot_created(conn, campaign_id: int, payload: dict) -> None:
    from .systems.battletech import pilots

    pilots.delete_pilot(payload["pilot_id"], _log=False)


def _undo_pilot_deleted(conn, campaign_id: int, payload: dict) -> None:
    from .systems.battletech import pilots

    s = payload["snapshot"]
    pilots.create_pilot(
        campaign_id, s["name"], callsign=s["callsign"], gunnery=s["gunnery"], piloting=s["piloting"],
        faction=s["faction"], status=s["status"], owner_token=s["owner_token"], color=s["color"], _log=False,
    )


def _undo_pilot_reviewed(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE pilots SET status = ?, review_note = ? WHERE id = ?",
        (payload["prev_status"], payload["prev_review_note"], payload["pilot_id"]),
    )


def _undo_pilot_resubmitted(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE pilots SET status = 'rejected', review_note = ? WHERE id = ?",
        (payload["prev_review_note"], payload["pilot_id"]),
    )


def _undo_pilot_updated(conn, campaign_id: int, payload: dict) -> None:
    before = payload["before"]
    conn.execute(
        "UPDATE pilots SET name = ?, callsign = ?, gunnery = ?, piloting = ?, faction = ?, color = ? WHERE id = ?",
        (before["name"], before["callsign"], before["gunnery"], before["piloting"], before["faction"],
         before["color"], payload["pilot_id"]),
    )


def _undo_mech_created(conn, campaign_id: int, payload: dict) -> None:
    from .systems.battletech import mechs

    mechs.delete_mech(payload["mech_id"], _log=False)


def _undo_mech_deleted(conn, campaign_id: int, payload: dict) -> None:
    from .systems.battletech import mechs

    s = payload["snapshot"]
    recreated = mechs.create_mech(
        campaign_id=campaign_id, chassis=s["chassis"], tonnage=s["tonnage"], walk_mp=s["walk_mp"],
        run_mp=s["run_mp"], locations=s["locations"], model=s["model"], jump_mp=s["jump_mp"],
        pilot_id=s["pilot_id"], heat_sinks=s["heat_sinks"], status=s["status"], owner_token=s["owner_token"],
        _log=False,
    )
    # create_mech always starts every location at full armor/structure —
    # restore the exact current values the deleted mech had (may be
    # mid-combat damage), and re-mount its weapons at their remaining
    # ammo rather than a fresh ton. Critical-slot `hit` flags are NOT
    # restored (an accepted gap — undoing the deletion of an
    # already-critically-damaged mech is a rare edge case within a rare
    # edge case).
    for loc in s["locations"]:
        mechs.update_location(
            recreated["id"], loc["location"],
            armor_current=loc["armor_current"], armor_rear_current=loc["armor_rear_current"],
            structure_current=loc["structure_current"],
        )
    for w in s["weapons"]:
        after_add = mechs.add_weapon(recreated["id"], w["weapon_name"], w["location"])
        new_weapon = after_add["weapons"][-1]
        if new_weapon["ammo_remaining"] != w["ammo_remaining"]:
            conn.execute(
                "UPDATE mech_weapons SET ammo_remaining = ? WHERE id = ?",
                (w["ammo_remaining"], new_weapon["id"]),
            )
    for eq in s["equipment"]:
        mechs.add_equipment(recreated["id"], eq["equipment_name"], eq["location"])
    if s["heat_current"]:
        mechs.add_heat(recreated["id"], s["heat_current"])


def _undo_mech_reviewed(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE mechs SET status = ?, review_note = ? WHERE id = ?",
        (payload["prev_status"], payload["prev_review_note"], payload["mech_id"]),
    )


def _undo_mech_resubmitted(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE mechs SET status = 'rejected', review_note = ? WHERE id = ?",
        (payload["prev_review_note"], payload["mech_id"]),
    )


def _undo_mech_updated(conn, campaign_id: int, payload: dict) -> None:
    before = payload["before"]
    conn.execute(
        "UPDATE mechs SET chassis = ?, model = ?, tonnage = ?, walk_mp = ?, run_mp = ?, "
        "jump_mp = ?, heat_sinks = ?, pilot_id = ? WHERE id = ?",
        (before["chassis"], before["model"], before["tonnage"], before["walk_mp"], before["run_mp"],
         before["jump_mp"], before["heat_sinks"], before["pilot_id"], payload["mech_id"]),
    )


def _undo_map_created(conn, campaign_id: int, payload: dict) -> None:
    from . import maps

    maps.delete_map(payload["map_id"], _log=False)


def _undo_map_deleted(conn, campaign_id: int, payload: dict) -> None:
    from . import maps

    s = payload["snapshot"]
    recreated = maps.create_map(campaign_id, s["name"], s["width"], s["height"], _log=False)
    for t in s["tiles"]:
        maps.update_tile(
            recreated["id"], t["q"], t["r"],
            elevation=t["elevation"], blocks_los=t["blocks_los"], terrain=t["terrain"], los_points=t["los_points"],
        )


def _undo_map_projected(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE campaigns SET active_map_id = ? WHERE id = ?", (payload["prev_active_map_id"], campaign_id)
    )


def _undo_round_started(conn, campaign_id: int, payload: dict) -> None:
    # No heat to restore here anymore — dissipation moved to
    # resolve_heat_phase (real user report: it needs to happen visibly
    # DURING the Heat phase, not silently at the next round's start), so
    # starting a round no longer touches any mech's heat_current itself.
    conn.execute("UPDATE bt_rounds SET round_number = ? WHERE campaign_id = ?", (payload["prev_round_number"], campaign_id))


def _undo_initiative_rolled(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "DELETE FROM bt_round_rolls WHERE campaign_id = ? AND pilot_id = ?",
        (campaign_id, payload["pilot_id"]),
    )


def _undo_unit_placed(conn, campaign_id: int, payload: dict) -> None:
    conn.execute("DELETE FROM units WHERE id = ?", (payload["unit_id"],))


def _undo_unit_removed(conn, campaign_id: int, payload: dict) -> None:
    s = payload["snapshot"]
    conn.execute(
        """
        INSERT INTO units (campaign_id, map_id, mech_id, pilot_id, q, r, facing_deg, is_ghost, revealed, dnd_character_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (campaign_id, s["map_id"], s["mech_id"], s["pilot_id"], s["q"], s["r"], s["facing_deg"],
         s["is_ghost"], s["revealed"], s["dnd_character_id"]),
    )


def _undo_unit_moved(conn, campaign_id: int, payload: dict) -> None:
    conn.execute(
        "UPDATE units SET q = ?, r = ?, facing_deg = ? WHERE id = ?",
        (payload["prev_q"], payload["prev_r"], payload["prev_facing_deg"], payload["unit_id"]),
    )


def _undo_attack(conn, campaign_id: int, payload: dict) -> None:
    before = payload.get("before")
    if before:
        conn.execute(
            f"UPDATE mech_locations SET {before['armor_field']} = ?, structure_current = ? "
            "WHERE mech_id = ? AND location = ?",
            (before["armor_before"], before["structure_before"], before["mech_id"], before["location"]),
        )
    weapon = payload.get("weapon")
    if weapon:
        conn.execute(
            "UPDATE mech_weapons SET ammo_remaining = ? WHERE id = ?",
            (weapon["ammo_before"], weapon["mech_weapon_id"]),
        )
        conn.execute(
            "UPDATE mechs SET heat_current = ? WHERE id = ?",
            (weapon["heat_before"], weapon["attacker_mech_id"]),
        )


_UNDO_HANDLERS = {
    "pilot_created": _undo_pilot_created,
    "pilot_deleted": _undo_pilot_deleted,
    "pilot_reviewed": _undo_pilot_reviewed,
    "pilot_resubmitted": _undo_pilot_resubmitted,
    "pilot_updated": _undo_pilot_updated,
    "mech_created": _undo_mech_created,
    "mech_deleted": _undo_mech_deleted,
    "mech_reviewed": _undo_mech_reviewed,
    "mech_resubmitted": _undo_mech_resubmitted,
    "mech_updated": _undo_mech_updated,
    "map_created": _undo_map_created,
    "map_generated": _undo_map_created,
    "map_deleted": _undo_map_deleted,
    "map_projected": _undo_map_projected,
    "round_started": _undo_round_started,
    "initiative_rolled": _undo_initiative_rolled,
    "unit_placed": _undo_unit_placed,
    "unit_removed": _undo_unit_removed,
    "unit_moved": _undo_unit_moved,
    "attack": _undo_attack,
}
