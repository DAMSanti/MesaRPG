"""One-time backfill: pilots.color (app/db.py) is a new column, defaulted
to a neutral grey ("#9aa4a2") for every pilot that already existed before
it — the manual initiative-roll flow needs each pilot's dice to actually
look different, not all render in the same grey. Assigns each
still-default pilot a color from a small fixed palette, rotating by id
so consecutive pilots don't collide.

Run from rewrite/backend:  python -m scripts.backfill_pilot_colors
"""

from app import db

DEFAULT_COLOR = "#9aa4a2"

# Chosen for visual distinctness against each other and against the
# ghost-unit red (#e35d5d) and the amber "needs to roll" highlight
# (#f5c542) already used elsewhere on the map — not the same 3 colors as
# FACTION_COLORS (src/factions.ts), since those are shared per-faction
# buckets and this is deliberately per-pilot instead.
PALETTE = [
    "#4dc9ff",  # sky blue
    "#ff6b6b",  # coral
    "#8ed081",  # green
    "#c792ea",  # violet
    "#ffb454",  # orange
    "#5ad1c9",  # teal
    "#f27ab0",  # pink
    "#d4c96b",  # olive
    "#7a9cff",  # periwinkle
    "#e8875c",  # terracotta
]


def main() -> None:
    db.init_db()
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id FROM pilots WHERE color = ? ORDER BY id", (DEFAULT_COLOR,)
        ).fetchall()
        for i, row in enumerate(rows):
            color = PALETTE[i % len(PALETTE)]
            conn.execute("UPDATE pilots SET color = ? WHERE id = ?", (color, row["id"]))
        print(f"{len(rows)} pilots assigned a color from the palette.")


if __name__ == "__main__":
    main()
