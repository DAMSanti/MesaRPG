"""One-time (or periodic, whenever you're back online) sync of the whole
public MegaMek mech database into our own local mech_templates table
(VISION.md §3 — the table has to work fully offline at a client's house,
so mech creation can't depend on a live fetch at request time). Run from
rewrite/backend:

    python -m scripts.sync_mech_catalog [--force] [--workers N] [--limit N]

Resumable by default: a unit already present in the local catalog is
skipped, so an interrupted run (network hiccup, Ctrl-C) just continues
where it left off next time. --force re-fetches and re-parses everything.

Only Biped mechs are stored — see app/mech_import.py's NotBiped for why
Quad/Tripod/LAM designs are skipped rather than half-imported. Units with
a non-standard tonnage (outside the 20-100t/5-ton-step Internal Structure
Table) are skipped too, same reasoning: better to leave a unit out of the
catalog than store armor/structure numbers this app can't actually back
up with a rule.
"""

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from app import db, mech_import, mech_templates


def _existing_source_files() -> set[str]:
    with db.connect() as conn:
        return {row["source_file"] for row in conn.execute("SELECT source_file FROM mech_templates")}


def _sync_one(unit: dict) -> tuple[str, str]:
    """Returns (source_file, outcome) — outcome is "ok", "skip:<reason>",
    or "error:<reason>". Never raises: one bad unit must not abort the
    whole batch, same principle as app/critical_layout.py dropping a
    weapon that doesn't fit instead of crashing."""
    filename = unit["file"]
    try:
        parsed = mech_import.import_mech(filename)
    except mech_import.NotBiped:
        return filename, "skip:not_biped"
    except mech_import.UnknownTonnage as exc:
        return filename, f"skip:tonnage ({exc})"
    except mech_import.MechImportError as exc:
        return filename, f"error:fetch ({exc})"
    except Exception as exc:  # noqa: BLE001 — malformed/unexpected MTF shape; log and move on
        return filename, f"error:parse ({exc})"

    chassis = parsed.pop("chassis")
    model = parsed.pop("model")
    tonnage = parsed["tonnage"]
    mech_templates.upsert_template(filename, chassis, model, tonnage, parsed)
    return filename, "ok"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="Re-sync units already in the local catalog")
    parser.add_argument("--workers", type=int, default=12, help="Concurrent fetches (default 12)")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N units (for testing)")
    args = parser.parse_args()

    db.init_db()

    print("Fetching the full unit index...")
    units = mech_import.list_all_units()
    print(f"{len(units)} units listed.")

    if not args.force:
        existing = _existing_source_files()
        before = len(units)
        units = [u for u in units if u["file"] not in existing]
        print(f"{before - len(units)} already in the local catalog, skipping those.")

    if args.limit:
        units = units[: args.limit]

    total = len(units)
    if total == 0:
        print("Nothing to do.")
        return

    print(f"Syncing {total} units with {args.workers} workers...")
    counts: dict[str, int] = {}
    started = time.monotonic()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_sync_one, u): u for u in units}
        done = 0
        for future in as_completed(futures):
            filename, outcome = future.result()
            bucket = outcome.split(":", 1)[0]
            counts[bucket] = counts.get(bucket, 0) + 1
            if bucket == "error":
                print(f"  {outcome}: {filename}")
            done += 1
            if done % 200 == 0 or done == total:
                elapsed = time.monotonic() - started
                print(f"[{done}/{total}] elapsed {elapsed:.0f}s — {counts}")

    elapsed = time.monotonic() - started
    print(f"Done in {elapsed:.0f}s. {counts}")
    print(f"Local catalog now has {mech_templates.template_count()} mechs.")


if __name__ == "__main__":
    main()
