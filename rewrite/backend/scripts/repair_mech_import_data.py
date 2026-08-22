"""One-time repair for mechs created before three mech_import.py/
app/equipment.py fixes:

1. `_parse_criticals` used to store critical-slot item names raw
   ("ISHeavyPPC", "ISDouble Heat Sink") instead of running them through
   the same cleanup already applied to the Weapons: section. Fixed now,
   but the fix only affects *future* parses — this re-normalizes every
   existing `mech_criticals.item_name` in place.

2. Weapons are mounted after mech creation via one `POST
   /api/mechs/{id}/weapons` call per weapon (GMView.tsx's submitMech),
   which silently drops any weapon not yet in app/weapons.py's
   WEAPON_CATALOG at the time (logged, not surfaced to the DB). Any
   mech created while its weapons were missing from the catalog (e.g.
   before a later catalog expansion) ended up with zero mech_weapons
   rows even though its imported criticals correctly list them. For
   any mech with an empty mech_weapons table, this reconstructs its
   weapons from its own (now-normalized) criticals: a weapon occupies
   N consecutive-count slots at one location (N = WEAPON_CATALOG's
   "slots" for that name), so grouping criticals by (location, name)
   and dividing the count by N recovers exactly the weapons the
   original import would have mounted.

3. app/equipment.py (mech_equipment table) didn't exist at all until
   now — every mech ever created, including ones that already got their
   weapons backfilled above, has zero equipment rows. Same
   criticals-derived reconstruction as (2), via
   equipment.equipment_from_criticals, for every mech regardless of its
   weapon state. Wherever that adds a Heat Sink/Double Heat Sink,
   mechs._recompute_heat_sinks_from_equipment corrects heat_sinks (the
   MTF "Heat Sinks:N" header field this app used to rely on doesn't
   distinguish Single from Double).

Run from rewrite/backend:  python -m scripts.repair_mech_import_data
"""

from collections import Counter

from app import db, equipment, mechs, weapons
from app.mech_import import _normalize_mtf_item_name


def main() -> None:
    db.init_db()  # creates mech_equipment if this DB predates it
    with db.connect() as conn:
        crit_rows = conn.execute("SELECT id, mech_id, location, item_name FROM mech_criticals").fetchall()
        renamed = 0
        for row in crit_rows:
            cleaned = _normalize_mtf_item_name(row["item_name"])
            if cleaned != row["item_name"]:
                conn.execute("UPDATE mech_criticals SET item_name = ? WHERE id = ?", (cleaned, row["id"]))
                renamed += 1
        print(f"{renamed} of {len(crit_rows)} critical-slot rows renormalized.")

        mech_ids = [r["id"] for r in conn.execute("SELECT id FROM mechs").fetchall()]
        backfilled_weapon_mechs = 0
        backfilled_weapons = 0
        backfilled_equipment_mechs = 0
        backfilled_equipment = 0

        for mech_id in mech_ids:
            crit_by_loc: dict[str, list[str]] = {}
            for r in conn.execute(
                "SELECT location, item_name FROM mech_criticals WHERE mech_id = ? ORDER BY location, slot_index",
                (mech_id,),
            ).fetchall():
                crit_by_loc.setdefault(r["location"], []).append(r["item_name"])
            if not crit_by_loc:
                continue

            has_weapons = conn.execute(
                "SELECT 1 FROM mech_weapons WHERE mech_id = ? LIMIT 1", (mech_id,)
            ).fetchone()
            if not has_weapons:
                counts: Counter[tuple[str, str]] = Counter(
                    (loc, name) for loc, names in crit_by_loc.items() for name in names
                )
                mech_changed = False
                for (location, item_name), count in counts.items():
                    try:
                        stats = weapons.get_weapon(item_name)
                    except weapons.UnknownWeapon:
                        continue
                    slots = stats["slots"]
                    if slots <= 0 or count % slots != 0:
                        continue
                    for _ in range(count // slots):
                        conn.execute(
                            "INSERT INTO mech_weapons (mech_id, weapon_name, location, ammo_remaining) VALUES (?, ?, ?, ?)",
                            (mech_id, item_name, location, stats["ammo_per_ton"]),
                        )
                        backfilled_weapons += 1
                        mech_changed = True
                if mech_changed:
                    backfilled_weapon_mechs += 1

            has_equipment = conn.execute(
                "SELECT 1 FROM mech_equipment WHERE mech_id = ? LIMIT 1", (mech_id,)
            ).fetchone()
            if not has_equipment:
                derived = equipment.equipment_from_criticals(crit_by_loc)
                if derived:
                    for item in derived:
                        conn.execute(
                            "INSERT INTO mech_equipment (mech_id, equipment_name, location) VALUES (?, ?, ?)",
                            (mech_id, item["equipment_name"], item["location"]),
                        )
                        backfilled_equipment += 1
                    backfilled_equipment_mechs += 1

            # Always recompute, not just on a fresh backfill above — makes
            # this script safe to re-run after a formula fix (like the
            # "+10 free engine heat sinks" one) without needing yet another
            # one-off script. A no-op for mechs with no heat sink equipment.
            mechs._recompute_heat_sinks_from_equipment(conn, mech_id)

        print(f"{backfilled_weapons} weapons backfilled across {backfilled_weapon_mechs} mechs.")
        print(f"{backfilled_equipment} equipment items backfilled across {backfilled_equipment_mechs} mechs.")


if __name__ == "__main__":
    main()
