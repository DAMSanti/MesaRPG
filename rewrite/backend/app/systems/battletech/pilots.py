import hashlib
import secrets

from ... import db, dice_styles, events

# player = a player's own character; enemy = GM-controlled hostile;
# npc = non-aggressive (merchants, quest contacts, etc.) — Battletech only
# needs these three, no finer-grained faction system.
FACTIONS = {"player", "enemy", "npc"}

# Character sheet approval (ROADMAP.md Fase R3 — "suite jugable"). A
# sheet created by the GM starts approved (nothing to review); one
# submitted by a player starts pending and needs the GM's decision.
STATUSES = {"pending", "approved", "rejected"}

# Real user request: "Cada jugador puede escoger en opciones si quiere
# dados físicos siempre o tiradas automáticas" — only meaningful for
# individual-mode initiative (the one roll that's ever physical in this
# app; team mode already auto-rolls both sides server-side). 'physical'
# is the default so nothing changes for a pilot who never touches this
# setting — main.py's /round/roll-initiative branches on it (see
# turns.report_pilot_initiative's own docstring for the physical-dice
# flow this bypasses in 'auto' mode).
DICE_MODES = {"physical", "auto"}


class UnknownFaction(ValueError):
    pass


class UnknownStatus(ValueError):
    pass


class UnknownDiceMode(ValueError):
    pass


class InvalidStatusTransition(ValueError):
    pass


class InvalidPin(ValueError):
    pass


class DuplicateOwnerPilot(ValueError):
    pass


def _check_faction(faction: str) -> None:
    if faction not in FACTIONS:
        raise UnknownFaction(f"Unknown faction {faction!r}, expected one of {sorted(FACTIONS)}")


def _check_status(status: str) -> None:
    if status not in STATUSES:
        raise UnknownStatus(f"Unknown status {status!r}, expected one of {sorted(STATUSES)}")


def _check_dice_mode(dice_mode: str) -> None:
    if dice_mode not in DICE_MODES:
        raise UnknownDiceMode(f"Unknown dice_mode {dice_mode!r}, expected one of {sorted(DICE_MODES)}")


def _check_pin(pin: str) -> None:
    if len(pin) != 4 or not pin.isdigit():
        raise InvalidPin(f"PIN must be exactly 4 digits, got {pin!r}")


def _hash_pin(pin: str, salt: str) -> str:
    # sha256 + a per-pilot random salt, not bcrypt — see db.py's own
    # comment on the pin_hash/pin_salt columns for why a heavier
    # password-hashing scheme isn't worth it for a 4-digit PIN.
    return hashlib.sha256((salt + pin).encode()).hexdigest()


def set_pin(pilot_id: int, pin: str) -> None:
    _check_pin(pin)
    salt = secrets.token_hex(8)
    with db.connect() as conn:
        conn.execute(
            "UPDATE pilots SET pin_hash = ?, pin_salt = ? WHERE id = ?",
            (_hash_pin(pin, salt), salt, pilot_id),
        )


def verify_pin(pilot_id: int, pin: str) -> bool:
    """False for a wrong PIN, an unknown pilot, AND a pilot with no PIN
    set at all — callers that want to know "does this pilot even need a
    PIN" should check `has_pin` from get_pilot/list_pilots instead of
    inferring it from a verify_pin(..., "") failure."""
    with db.connect() as conn:
        row = conn.execute("SELECT pin_hash, pin_salt FROM pilots WHERE id = ?", (pilot_id,)).fetchone()
    if not row or not row["pin_hash"]:
        return False
    return row["pin_hash"] == _hash_pin(pin, row["pin_salt"])


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
    pin: str | None = None,
    _log: bool = True,
) -> dict:
    _check_faction(faction)
    _check_status(status)
    if pin is not None:
        _check_pin(pin)  # fail before writing anything, not after
    with db.connect() as conn:
        # One pilot per device per campaign (real user request) — a
        # device's owner_token is how PlayerView's self-serve join flow
        # identifies "this player", so a second pilot with the same
        # token would just be a duplicate character for the same
        # person, not a second player. GM-created pilots pass no
        # owner_token at all, so they're never subject to this.
        if owner_token is not None:
            existing = conn.execute(
                "SELECT id FROM pilots WHERE campaign_id = ? AND owner_token = ?",
                (campaign_id, owner_token),
            ).fetchone()
            if existing:
                raise DuplicateOwnerPilot(
                    f"This device already has a pilot in campaign {campaign_id} (#{existing['id']})"
                )
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
        pilot_id = cur.lastrowid
        # _log=False only from events.py's own _undo_pilot_deleted (this
        # IS the recreate step of undoing a delete) — without it, undoing
        # a delete would log its own fresh "pilot_created" event, and undo
        # would never run out of history to revert (infinite regrowth).
        if _log:
            events.log_event(conn, campaign_id, "pilot_created", f"Piloto creado: {name}", {"pilot_id": pilot_id})
    if pin is not None:
        set_pin(pilot_id, pin)
    with db.connect() as conn:
        return _get(conn, pilot_id)


def list_pilots(campaign_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, campaign_id, name, callsign, gunnery, piloting, faction,
                   hits, status, owner_token, review_note, color, die_style, dice_mode, created_at,
                   (pin_hash IS NOT NULL) AS has_pin
            FROM pilots WHERE campaign_id = ? ORDER BY id
            """,
            (campaign_id,),
        ).fetchall()
        return [{**dict(r), "has_pin": bool(r["has_pin"])} for r in rows]


def review_pilot(pilot_id: int, decision: str, note: str | None = None) -> dict | None:
    if decision not in ("approved", "rejected"):
        raise UnknownStatus(f"Unknown review decision {decision!r}, expected 'approved' or 'rejected'")
    with db.connect() as conn:
        prev = conn.execute("SELECT campaign_id, name, status, review_note FROM pilots WHERE id = ?", (pilot_id,)).fetchone()
        conn.execute(
            "UPDATE pilots SET status = ?, review_note = ? WHERE id = ?",
            (decision, note if decision == "rejected" else None, pilot_id),
        )
        if prev:
            verb = "aprobado" if decision == "approved" else "rechazado"
            events.log_event(
                conn, prev["campaign_id"], "pilot_reviewed", f"Piloto {verb}: {prev['name']}",
                {"pilot_id": pilot_id, "prev_status": prev["status"], "prev_review_note": prev["review_note"]},
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
        events.log_event(
            conn, pilot["campaign_id"], "pilot_resubmitted", f"Piloto reenviado: {pilot['name']}",
            {"pilot_id": pilot_id, "prev_review_note": pilot["review_note"]},
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
    dice_mode: str | None = None,
) -> dict | None:
    if faction is not None:
        _check_faction(faction)
    if dice_mode is not None:
        _check_dice_mode(dice_mode)
    fields = {
        k: v
        for k, v in {
            "name": name, "callsign": callsign, "gunnery": gunnery,
            "piloting": piloting, "faction": faction, "hits": hits, "color": color,
            "dice_mode": dice_mode,
        }.items()
        if v is not None
    }
    if not fields:
        return get_pilot(pilot_id)
    with db.connect() as conn:
        prev = conn.execute(
            "SELECT campaign_id, name, callsign, gunnery, piloting, faction, color FROM pilots WHERE id = ?",
            (pilot_id,),
        ).fetchone()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE pilots SET {set_clause} WHERE id = ?", (*fields.values(), pilot_id))
        # `hits` alone is live combat bookkeeping (wound-track clicks
        # during play, from both GMView and PlayerView), not a "ficha
        # edited" event — logging every click would flood the history.
        # An edit touching any OTHER field (the GM's "Editar" modal)
        # still logs, hits included if it was part of that same call.
        if prev and set(fields) - {"hits"}:
            events.log_event(
                conn, prev["campaign_id"], "pilot_updated", f"Piloto editado: {prev['name']}",
                {"pilot_id": pilot_id, "before": dict(prev)},
            )
        return _get(conn, pilot_id)


def add_pilot_hits(pilot_id: int, n: int) -> dict | None:
    """Programmatic wound-track increment — ammo explosions (2 wounds,
    unconditional) and life-support heat damage (1-2 wounds/Heat Phase)
    both call this instead of the GM/player clicking wound boxes by hand
    on the sheet, which is what update_pilot's own `hits` param is for.
    Clamped at 6 (the sheet's own fatal box — CONSCIOUSNESS_TARGETS has 5
    entries, WOUND_BOX_COUNT = 6, see MechRecordSheet.tsx), never lower
    than the pilot's current hits (n is always additive here, no caller
    needs to reduce it programmatically)."""
    pilot = get_pilot(pilot_id)
    if pilot is None:
        return None
    new_hits = min(6, pilot["hits"] + n)
    return update_pilot(pilot_id, hits=new_hits)


def set_pilot_die_style(pilot_id: int, style: str | None) -> dict | None:
    """A dedicated setter (not folded into update_pilot's generic
    `fields` dict) because that dict treats any None it receives as
    "leave unchanged" — exactly wrong for this field's required
    toggle-off-to-NULL semantics (clicking your own held style clears
    it back to unset). style=None here always means "clear it", not
    "don't touch it". `style` is validated + checked for exclusivity
    only when non-None; clearing is always allowed."""
    with db.connect() as conn:
        pilot = conn.execute("SELECT campaign_id FROM pilots WHERE id = ?", (pilot_id,)).fetchone()
        if not pilot:
            return None
        if style is not None:
            dice_styles.check_style_id(style)
            dice_styles.check_available(conn, pilot["campaign_id"], style, exclude_pilot_id=pilot_id)
        conn.execute("UPDATE pilots SET die_style = ? WHERE id = ?", (style, pilot_id))
        return _get(conn, pilot_id)


def delete_pilot(pilot_id: int, _log: bool = True) -> bool:
    """GM-initiated removal. `mechs.pilot_id` and `units.pilot_id` are
    `ON DELETE SET NULL` (db.py) — any mech/unit that had this pilot
    survives, just unpiloted, rather than cascading further deletes.
    `_log=False` only from events.py's own _undo_pilot_created — see
    create_pilot's matching comment on why undo mustn't log itself."""
    with db.connect() as conn:
        snapshot = _get(conn, pilot_id)
        cur = conn.execute("DELETE FROM pilots WHERE id = ?", (pilot_id,))
        if _log and cur.rowcount and snapshot:
            events.log_event(
                conn, snapshot["campaign_id"], "pilot_deleted", f"Piloto borrado: {snapshot['name']}",
                {"snapshot": snapshot},
            )
        return cur.rowcount > 0


def get_pilot(pilot_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, pilot_id)


def _get(conn, pilot_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT id, campaign_id, name, callsign, gunnery, piloting, faction,
               hits, status, owner_token, review_note, color, die_style, dice_mode, created_at,
               (pin_hash IS NOT NULL) AS has_pin
        FROM pilots WHERE id = ?
        """,
        (pilot_id,),
    ).fetchone()
    if not row:
        return None
    return {**dict(row), "has_pin": bool(row["has_pin"])}
