"""Mech + per-location armor/structure persistence.

Deliberately does NOT compute armor/structure from tonnage via the
BattleTech construction tables — that's rules-engine territory (Fase
R2), and those numbers need to come from a verified rulebook source,
not be guessed here. This layer just stores whatever values the caller
provides (in practice: transcribed from a real record sheet), the same
way `assets/markers`... er, the same way a GM would fill in a paper
sheet's boxes by hand.
"""

from ... import db, equipment, events
from ...critical_layout import generate_default_criticals
from ...db import MECH_LOCATIONS, REAR_ARMOR_LOCATIONS
from . import weapons

# Character sheet approval (ROADMAP.md Fase R3 — "suite jugable"), same
# trio as app/pilots.py — kept independent per module rather than shared,
# matching this project's existing convention (campaigns.py/pilots.py
# each own their status-like constants instead of a shared enum module).
STATUSES = {"pending", "approved", "rejected"}


class InvalidMechLocation(ValueError):
    pass


class UnknownStatus(ValueError):
    pass


class InvalidStatusTransition(ValueError):
    pass


def _check_status(status: str) -> None:
    if status not in STATUSES:
        raise UnknownStatus(f"Unknown status {status!r}, expected one of {sorted(STATUSES)}")


def create_mech(
    campaign_id: int,
    chassis: str,
    tonnage: int,
    walk_mp: int,
    run_mp: int,
    locations: list[dict],
    model: str | None = None,
    jump_mp: int = 0,
    pilot_id: int | None = None,
    heat_sinks: int = 10,
    status: str = "approved",
    owner_token: str | None = None,
    criticals: dict[str, list[str]] | None = None,
    _log: bool = True,
) -> dict:
    _validate_locations(locations)
    _check_status(status)

    with db.connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO mechs
                (campaign_id, pilot_id, chassis, model, tonnage, walk_mp, run_mp, jump_mp,
                 heat_sinks, status, owner_token, criticals_imported)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (campaign_id, pilot_id, chassis, model, tonnage, walk_mp, run_mp, jump_mp,
             heat_sinks, status, owner_token, bool(criticals)),
        )
        mech_id = cur.lastrowid

        for loc in locations:
            location = loc["location"]
            armor_max = loc["armor_max"]
            structure_max = loc["structure_max"]
            armor_rear_max = loc.get("armor_rear_max") if location in REAR_ARMOR_LOCATIONS else None
            conn.execute(
                """
                INSERT INTO mech_locations
                    (mech_id, location, armor_current, armor_max,
                     armor_rear_current, armor_rear_max,
                     structure_current, structure_max)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mech_id,
                    location,
                    armor_max,
                    armor_max,
                    armor_rear_max,
                    armor_rear_max,
                    structure_max,
                    structure_max,
                ),
            )

        if criticals:
            for location, items in criticals.items():
                for slot_index, item_name in enumerate(items):
                    conn.execute(
                        "INSERT INTO mech_criticals (mech_id, location, slot_index, item_name) VALUES (?, ?, ?, ?)",
                        (mech_id, location, slot_index, item_name),
                    )
        else:
            # No imported data — generate the fixed-component layout right
            # away (engine/gyro/cockpit/actuators are on every mech
            # regardless of loadout) instead of waiting for a first weapon
            # to be mounted. Without this, a freshly created, not-yet-armed
            # ficha's Critical Hit Table showed nothing at all.
            _write_generated_criticals(conn, mech_id, [])

        # _log=False only from events.py's own _undo_mech_deleted (this
        # IS the recreate step of undoing a delete) — see pilots.py's
        # create_pilot for why this guard has to exist at all.
        if _log:
            events.log_event(
                conn, campaign_id, "mech_created", f"Mech creado: {chassis} {model or ''}".strip(),
                {"mech_id": mech_id},
            )
        return _get(conn, mech_id)


def list_mechs(campaign_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id FROM mechs WHERE campaign_id = ? ORDER BY id", (campaign_id,)
        ).fetchall()
        mech_ids = [row["id"] for row in rows]
    for mech_id in mech_ids:
        ensure_default_criticals(mech_id)
    with db.connect() as conn:
        return [_get(conn, mech_id) for mech_id in mech_ids]


def get_mech(mech_id: int) -> dict | None:
    ensure_default_criticals(mech_id)
    with db.connect() as conn:
        return _get(conn, mech_id)


def ensure_default_criticals(mech_id: int) -> None:
    """Self-healing backfill for a mech whose critical table is still
    completely empty — either it predates app/critical_layout.py, or it
    currently has zero weapons mounted (a fresh, unarmed ficha should
    still show its fixed components, not nothing). Only fires from
    genuinely empty: a mech with ANY criticals rows already — imported or
    previously generated — is left untouched, since regenerating on top
    of existing rows would silently reset any critical already marked
    destroyed (see mechs.set_critical_hit)."""
    with db.connect() as conn:
        mech_row = conn.execute("SELECT criticals_imported FROM mechs WHERE id = ?", (mech_id,)).fetchone()
        if not mech_row or mech_row["criticals_imported"]:
            return
        has_any = conn.execute("SELECT 1 FROM mech_criticals WHERE mech_id = ? LIMIT 1", (mech_id,)).fetchone()
        if has_any:
            return
        weapon_rows = conn.execute(
            "SELECT weapon_name, location FROM mech_weapons WHERE mech_id = ? ORDER BY id", (mech_id,)
        ).fetchall()
        _write_generated_criticals(conn, mech_id, [dict(r) for r in weapon_rows])


def add_heat(mech_id: int, amount: int) -> dict:
    """A weapon firing adds its heat value (ROADMAP.md Fase R2 follow-up)."""
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET heat_current = heat_current + ? WHERE id = ?", (amount, mech_id))
        return _get(conn, mech_id)


def dissipate_heat(mech_id: int) -> dict:
    """Heat drops by the mech's own heat sink count, floored at zero."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE mechs SET heat_current = MAX(0, heat_current - heat_sinks) WHERE id = ?",
            (mech_id,),
        )
        return _get(conn, mech_id)


def dissipate_all_heat(campaign_id: int) -> None:
    """Called once per new round (see app/systems/battletech/turns.py) —
    the closest mapping this app has to the real Heat Phase without a
    full phase-by-phase turn structure."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE mechs SET heat_current = MAX(0, heat_current - heat_sinks) WHERE campaign_id = ?",
            (campaign_id,),
        )


def update_location(
    mech_id: int,
    location: str,
    armor_current: int | None = None,
    armor_rear_current: int | None = None,
    structure_current: int | None = None,
    armor_max: int | None = None,
    armor_rear_max: int | None = None,
    structure_max: int | None = None,
) -> dict | None:
    """Editable digital sheet (ROADMAP.md Fase R3): pencil-mark damage directly,
    same as a paper record sheet, without going through combat resolution."""
    fields = {
        k: v
        for k, v in {
            "armor_current": armor_current,
            "armor_rear_current": armor_rear_current,
            "structure_current": structure_current,
            "armor_max": armor_max,
            "armor_rear_max": armor_rear_max,
            "structure_max": structure_max,
        }.items()
        if v is not None
    }
    if not fields:
        return get_mech(mech_id)
    with db.connect() as conn:
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE mech_locations SET {set_clause} WHERE mech_id = ? AND location = ?",
            (*fields.values(), mech_id, location),
        )
        return _get(conn, mech_id)


def apply_damage(conn, mech_id: int, location: str, rear: bool, amount: int) -> dict:
    """Armor-then-structure damage application, shared by combat.py's
    resolve_attack, melee.py's resolve_melee_attack, and criticals.py's
    ammo-explosion handling (all three need the exact same "spill past
    armor into structure" math) — moved here from combat.py so none of
    them has to import another to reach it (criticals.py needs this same
    function for ammo explosions, and combat.py/melee.py need to trigger
    criticals.py's critical-hit roll right after calling this; keeping
    it in combat.py would make that a circular import either direction).
    Takes an open `conn` (not its own connection) since every caller
    already has one open for the rest of that same attack's bookkeeping.
    """
    row = conn.execute(
        """
        SELECT armor_current, armor_rear_current, structure_current
        FROM mech_locations WHERE mech_id = ? AND location = ?
        """,
        (mech_id, location),
    ).fetchone()
    before = dict(row)

    use_rear = rear and before["armor_rear_current"] is not None
    armor_field = "armor_rear_current" if use_rear else "armor_current"
    armor_before = before[armor_field]

    absorbed = min(amount, armor_before)
    armor_after = armor_before - absorbed
    remaining = amount - absorbed
    structure_after = max(0, before["structure_current"] - remaining)

    conn.execute(
        f"UPDATE mech_locations SET {armor_field} = ?, structure_current = ? "
        "WHERE mech_id = ? AND location = ?",
        (armor_after, structure_after, mech_id, location),
    )

    return {
        "mech_id": mech_id,
        "location": location,
        "armor_field": armor_field,
        "armor_before": armor_before,
        "armor_after": armor_after,
        "structure_before": before["structure_current"],
        "structure_after": structure_after,
        "destroyed": structure_after == 0,
        # True once this hit spilled past armor into internal structure —
        # criticals.py's callers roll for a critical hit exactly when this
        # is true (or on a natural 2 hit-location roll, tracked separately
        # by the caller — see combat.py's resolve_attack).
        "penetrated": remaining > 0,
    }


def set_critical_hit(mech_id: int, location: str, slot_index: int, hit: bool) -> dict | None:
    """Mark/unmark a single critical slot as destroyed — the real engine
    state behind the sheet's Critical Hit Table, not just the static
    "what's installed here" list mech_criticals held before this."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE mech_criticals SET hit = ? WHERE mech_id = ? AND location = ? AND slot_index = ?",
            (1 if hit else 0, mech_id, location, slot_index),
        )
        return _get(conn, mech_id)


def set_shutdown(mech_id: int, value: bool) -> dict | None:
    """Heat Scale shutdown/restart (systems/battletech/turns.py's
    resolve_heat_phase) — an is_shutdown mech can't move/attack (see
    movement.py's execute_move / combat.py's resolve_attack / melee.py's
    resolve_melee_attack, which all check this)."""
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET is_shutdown = ? WHERE id = ?", (1 if value else 0, mech_id))
        return _get(conn, mech_id)


def set_prone(mech_id: int, value: bool) -> dict | None:
    """A fallen mech (psr.py's apply_fall) or one that's stood back up
    (psr.py's stand_up) — a prone mech can't move/attack either, same
    gate as is_shutdown, until it successfully stands."""
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET is_prone = ? WHERE id = ?", (1 if value else 0, mech_id))
        return _get(conn, mech_id)


def add_gyro_hit(mech_id: int) -> dict | None:
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET gyro_hits = gyro_hits + 1 WHERE id = ?", (mech_id,))
        return _get(conn, mech_id)


def add_engine_hit(mech_id: int) -> dict | None:
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET engine_hits = engine_hits + 1 WHERE id = ?", (mech_id,))
        return _get(conn, mech_id)


def add_sensor_hit(mech_id: int) -> dict | None:
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET sensor_hits = sensor_hits + 1 WHERE id = ?", (mech_id,))
        return _get(conn, mech_id)


def set_life_support_hit(mech_id: int) -> dict | None:
    """Unlike the counters above, life support only has one real critical
    slot's worth of effect (rulebook: "any critical hit knocks out this
    system permanently... the other critical slot can still take damage,
    but the hit has no additional effect") — a flag, not a counter."""
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET life_support_hit = 1 WHERE id = ?", (mech_id,))
        return _get(conn, mech_id)


def remove_heat_sink(mech_id: int) -> dict | None:
    """A destroyed heat sink critical (criticals.py's apply_critical_
    effects) permanently reduces dissipation by 1. Simplification: this
    directly decrements the stored heat_sinks count rather than tracking
    "N destroyed" separately — if the GM edits this mech's equipment
    loadout afterward, _recompute_heat_sinks_from_equipment could reset
    the count back to full, silently undoing the critical. Accepted as a
    rare edge case (editing loadout mid-combat isn't a normal flow) not
    worth a second counter for."""
    with db.connect() as conn:
        conn.execute("UPDATE mechs SET heat_sinks = MAX(0, heat_sinks - 1) WHERE id = ?", (mech_id,))
        return _get(conn, mech_id)


def update_mech(
    mech_id: int,
    chassis: str | None = None,
    model: str | None = None,
    tonnage: int | None = None,
    walk_mp: int | None = None,
    run_mp: int | None = None,
    jump_mp: int | None = None,
    heat_sinks: int | None = None,
    pilot_id: int | None = None,
) -> dict | None:
    """Edit a mech's core stats (chassis/tonnage/movement/pilot) — until
    now only per-location armor/structure and weapons were editable.
    Needed so a player can fix a sheet the GM rejected without deleting
    and recreating it (see review_mech/resubmit_mech)."""
    fields = {
        k: v
        for k, v in {
            "chassis": chassis, "model": model, "tonnage": tonnage,
            "walk_mp": walk_mp, "run_mp": run_mp, "jump_mp": jump_mp,
            "heat_sinks": heat_sinks, "pilot_id": pilot_id,
        }.items()
        if v is not None
    }
    if not fields:
        return get_mech(mech_id)
    with db.connect() as conn:
        prev = conn.execute(
            "SELECT campaign_id, chassis, model, tonnage, walk_mp, run_mp, jump_mp, heat_sinks, pilot_id "
            "FROM mechs WHERE id = ?",
            (mech_id,),
        ).fetchone()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE mechs SET {set_clause} WHERE id = ?", (*fields.values(), mech_id))
        if prev:
            events.log_event(
                conn, prev["campaign_id"], "mech_updated", f"Mech editado: {prev['chassis']} {prev['model'] or ''}".strip(),
                {"mech_id": mech_id, "before": dict(prev)},
            )
        return _get(conn, mech_id)


def delete_mech(mech_id: int, _log: bool = True) -> bool:
    """GM-initiated removal. `mech_locations`/`mech_weapons`/
    `mech_equipment`/`mech_criticals` are `ON DELETE CASCADE` (db.py), so those clean up
    on their own — but `units.mech_id` is only `ON DELETE SET NULL`,
    which would leave an orphaned token sitting on the map with no mech
    behind it (HexMap.tsx falls back to a generic cone marker for a
    unit with no mech_id, which reads as a bug here, not "no mech" by
    design). Look the affected units up before deleting the mech (their
    mech_id is about to be nulled by the FK, so this query has to run
    first), then remove those tokens outright. `_log=False` only from
    events.py's own _undo_mech_created — see create_mech's matching
    comment on why undo mustn't log itself."""
    with db.connect() as conn:
        snapshot = _get(conn, mech_id)
        unit_ids = [r["id"] for r in conn.execute("SELECT id FROM units WHERE mech_id = ?", (mech_id,)).fetchall()]
        cur = conn.execute("DELETE FROM mechs WHERE id = ?", (mech_id,))
        for unit_id in unit_ids:
            conn.execute("DELETE FROM units WHERE id = ?", (unit_id,))
        if _log and cur.rowcount and snapshot:
            events.log_event(
                conn, snapshot["campaign_id"], "mech_deleted",
                f"Mech borrado: {snapshot['chassis']} {snapshot['model'] or ''}".strip(),
                {"snapshot": snapshot},
            )
        return cur.rowcount > 0


def review_mech(mech_id: int, decision: str, note: str | None = None) -> dict | None:
    if decision not in ("approved", "rejected"):
        raise UnknownStatus(f"Unknown review decision {decision!r}, expected 'approved' or 'rejected'")
    with db.connect() as conn:
        prev = conn.execute("SELECT campaign_id, chassis, model, status, review_note FROM mechs WHERE id = ?", (mech_id,)).fetchone()
        conn.execute(
            "UPDATE mechs SET status = ?, review_note = ? WHERE id = ?",
            (decision, note if decision == "rejected" else None, mech_id),
        )
        if prev:
            verb = "aprobado" if decision == "approved" else "rechazado"
            events.log_event(
                conn, prev["campaign_id"], "mech_reviewed", f"Mech {verb}: {prev['chassis']} {prev['model'] or ''}".strip(),
                {"mech_id": mech_id, "prev_status": prev["status"], "prev_review_note": prev["review_note"]},
            )
        return _get(conn, mech_id)


def resubmit_mech(mech_id: int) -> dict | None:
    mech = get_mech(mech_id)
    if not mech or mech["status"] != "rejected":
        raise InvalidStatusTransition("Only a rejected mech can be resubmitted")
    with db.connect() as conn:
        conn.execute(
            "UPDATE mechs SET status = 'pending', review_note = NULL WHERE id = ?",
            (mech_id,),
        )
        events.log_event(
            conn, mech["campaign_id"], "mech_resubmitted", f"Mech reenviado: {mech['chassis']} {mech['model'] or ''}".strip(),
            {"mech_id": mech_id, "prev_review_note": mech["review_note"]},
        )
        return _get(conn, mech_id)


def add_weapon(mech_id: int, weapon_name: str, location: str) -> dict:
    """Mount a weapon on a mech (ROADMAP.md Fase R2 follow-up). Ammo
    weapons start with one ton's worth, per the catalog — see
    app/weapons.py for where that number comes from."""
    stats = weapons.get_weapon(weapon_name)  # raises UnknownWeapon
    if location not in MECH_LOCATIONS:
        raise InvalidMechLocation(f"Unknown location {location!r}, expected one of {MECH_LOCATIONS}")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO mech_weapons (mech_id, weapon_name, location, ammo_remaining) VALUES (?, ?, ?, ?)",
            (mech_id, weapon_name, location, stats["ammo_per_ton"]),
        )
        _regenerate_default_criticals_if_not_imported(conn, mech_id)
        return _get(conn, mech_id)


def remove_weapon(mech_weapon_id: int) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT mech_id FROM mech_weapons WHERE id = ?", (mech_weapon_id,)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM mech_weapons WHERE id = ?", (mech_weapon_id,))
        _regenerate_default_criticals_if_not_imported(conn, row["mech_id"])
        return _get(conn, row["mech_id"])


def add_equipment(mech_id: int, equipment_name: str, location: str) -> dict:
    """Mount a piece of non-weapon equipment (app/equipment.py's
    EQUIPMENT_CATALOG) — same shape as add_weapon above, minus ammo and
    minus critical-layout regeneration (critical_layout.py's generator
    only knows about weapons; equipment on a hand-built mech simply
    doesn't show up in its generated crit table yet, a documented gap,
    not a silent one)."""
    equipment.get_equipment(equipment_name)  # raises UnknownEquipment
    if location not in MECH_LOCATIONS:
        raise InvalidMechLocation(f"Unknown location {location!r}, expected one of {MECH_LOCATIONS}")
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO mech_equipment (mech_id, equipment_name, location) VALUES (?, ?, ?)",
            (mech_id, equipment_name, location),
        )
        _recompute_heat_sinks_from_equipment(conn, mech_id)
        return _get(conn, mech_id)


def remove_equipment(mech_equipment_id: int) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT mech_id FROM mech_equipment WHERE id = ?", (mech_equipment_id,)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM mech_equipment WHERE id = ?", (mech_equipment_id,))
        _recompute_heat_sinks_from_equipment(conn, row["mech_id"])
        return _get(conn, row["mech_id"])


# A standard fusion engine supports 10 heat sinks (of whatever type the
# design uses) at no extra critical-slot cost — only heat sinks beyond
# those 10 show up as critical-slot entries at all, so a mech's real
# total is always 10 more than what's actually mounted as equipment.
# This app doesn't model XL/Light/Compact engines differently (a
# simplification already made elsewhere), so this assumes every mech
# gets the standard engine's free 10.
_FREE_ENGINE_HEAT_SINKS = 10


def _recompute_heat_sinks_from_equipment(conn, mech_id: int) -> None:
    """The MTF "Heat Sinks:N" header field this app used to rely on
    doesn't distinguish Single from Double (a real bug found against a
    live import: "Heat Sinks:13 Double" stored heat_sinks=13, half its
    real 26-point dissipation) — once any Heat Sink/Double Heat Sink is
    actually mounted as equipment, that becomes the authoritative source
    instead: the engine's free 10 are assumed to match whichever type
    has the most criticals mounted (the standard design convention —
    mixing Single/Double on one mech isn't a thing in practice), plus
    every explicitly-mounted heat sink of every type counted at its own
    dissipation. A mech with none mounted (hand-built, or an import that
    hasn't gone through equipment backfill) keeps whatever heat_sinks
    value it already has — never reset to 0."""
    rows = conn.execute(
        "SELECT equipment_name FROM mech_equipment WHERE mech_id = ?", (mech_id,)
    ).fetchall()
    counts: dict[str, int] = {}
    for r in rows:
        name = r["equipment_name"]
        stats = equipment.EQUIPMENT_CATALOG.get(name)
        if stats and stats["heat_dissipation"]:
            counts[name] = counts.get(name, 0) + 1
    if not counts:
        return
    primary_type = max(counts, key=lambda name: counts[name])
    total = 0
    for name, count in counts.items():
        units = count + _FREE_ENGINE_HEAT_SINKS if name == primary_type else count
        total += units * equipment.EQUIPMENT_CATALOG[name]["heat_dissipation"]
    conn.execute("UPDATE mechs SET heat_sinks = ? WHERE id = ?", (total, mech_id))


def _regenerate_default_criticals_if_not_imported(conn, mech_id: int) -> None:
    """Recompute the whole critical layout from the mech's current weapon
    loadout (app/critical_layout.py) — skipped entirely for a mech with
    real imported data (criticals_imported), which this must never
    overwrite. Full recompute-from-scratch on every add/remove is simplest
    and correct since layout isn't order-dependent beyond mount order;
    the cost is that a previously toggled `hit` flag on an
    auto-generated slot resets when the loadout changes — acceptable for
    a loadout edit, which isn't a mid-combat action."""
    imported = conn.execute("SELECT criticals_imported FROM mechs WHERE id = ?", (mech_id,)).fetchone()
    if not imported or imported["criticals_imported"]:
        return
    weapon_rows = conn.execute(
        "SELECT weapon_name, location FROM mech_weapons WHERE mech_id = ? ORDER BY id", (mech_id,)
    ).fetchall()
    _write_generated_criticals(conn, mech_id, [dict(r) for r in weapon_rows])


def _write_generated_criticals(conn, mech_id: int, weapon_rows: list[dict]) -> None:
    """Compute app/critical_layout.py's default layout for `weapon_rows`
    and replace mech_id's whole mech_criticals table with it. Shared by
    create_mech (empty weapon list — just the fixed components), the
    add/remove-weapon regeneration above, and ensure_default_criticals'
    backfill below; callers are responsible for the criticals_imported
    gate, this just writes."""
    layout = generate_default_criticals(weapon_rows)
    conn.execute("DELETE FROM mech_criticals WHERE mech_id = ?", (mech_id,))
    for location, items in layout.items():
        for slot_index, item_name in enumerate(items):
            conn.execute(
                "INSERT INTO mech_criticals (mech_id, location, slot_index, item_name) VALUES (?, ?, ?, ?)",
                (mech_id, location, slot_index, item_name),
            )


def get_mech_weapon(mech_weapon_id: int) -> dict | None:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT id, mech_id, weapon_name, location, ammo_remaining FROM mech_weapons WHERE id = ?",
            (mech_weapon_id,),
        ).fetchone()
        return dict(row) if row else None


def use_ammo(mech_weapon_id: int) -> dict | None:
    """Decrement ammo by one shot; a no-op for weapons with no ammo
    (lasers, PPC — `ammo_remaining` stays NULL), floored at zero."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE mech_weapons SET ammo_remaining = MAX(0, ammo_remaining - 1) "
            "WHERE id = ? AND ammo_remaining IS NOT NULL",
            (mech_weapon_id,),
        )
        row = conn.execute(
            "SELECT id, mech_id, weapon_name, location, ammo_remaining FROM mech_weapons WHERE id = ?",
            (mech_weapon_id,),
        ).fetchone()
        return dict(row) if row else None


def _validate_locations(locations: list[dict]) -> None:
    seen = set()
    for loc in locations:
        location = loc.get("location")
        if location not in MECH_LOCATIONS:
            raise InvalidMechLocation(
                f"Unknown location {location!r}, expected one of {MECH_LOCATIONS}"
            )
        if location in seen:
            raise InvalidMechLocation(f"Duplicate location {location!r}")
        seen.add(location)
    missing = set(MECH_LOCATIONS) - seen
    if missing:
        raise InvalidMechLocation(f"Missing locations: {sorted(missing)}")


def _get(conn, mech_id: int) -> dict | None:
    mech_row = conn.execute(
        """
        SELECT id, campaign_id, pilot_id, chassis, model, tonnage,
               walk_mp, run_mp, jump_mp, heat_sinks, heat_current,
               is_shutdown, is_prone, gyro_hits, engine_hits, sensor_hits, life_support_hit,
               status, owner_token, review_note, created_at
        FROM mechs WHERE id = ?
        """,
        (mech_id,),
    ).fetchone()
    if not mech_row:
        return None

    location_rows = conn.execute(
        """
        SELECT location, armor_current, armor_max, armor_rear_current,
               armor_rear_max, structure_current, structure_max
        FROM mech_locations WHERE mech_id = ?
        """,
        (mech_id,),
    ).fetchall()

    weapon_rows = conn.execute(
        "SELECT id, weapon_name, location, ammo_remaining FROM mech_weapons WHERE mech_id = ? ORDER BY id",
        (mech_id,),
    ).fetchall()

    equipment_rows = conn.execute(
        "SELECT id, equipment_name, location FROM mech_equipment WHERE mech_id = ? ORDER BY id",
        (mech_id,),
    ).fetchall()

    critical_rows = conn.execute(
        "SELECT location, slot_index, item_name, hit FROM mech_criticals WHERE mech_id = ? ORDER BY location, slot_index",
        (mech_id,),
    ).fetchall()
    criticals: dict[str, list[dict]] = {}
    for row in critical_rows:
        criticals.setdefault(row["location"], []).append(
            {"slot_index": row["slot_index"], "item_name": row["item_name"], "hit": bool(row["hit"])}
        )

    mech = dict(mech_row)
    mech["is_shutdown"] = bool(mech["is_shutdown"])
    mech["is_prone"] = bool(mech["is_prone"])
    mech["life_support_hit"] = bool(mech["life_support_hit"])
    mech["locations"] = [dict(r) for r in location_rows]
    mech["weapons"] = [dict(r) for r in weapon_rows]
    mech["equipment"] = [dict(r) for r in equipment_rows]
    mech["criticals"] = criticals
    return mech
