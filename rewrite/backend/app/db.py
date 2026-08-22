"""SQLite persistence — multi-campaign schema (ROADMAP.md Fase R0/R4).

Still no ORM on purpose: the schema is small enough that raw SQL stays
readable, and it avoids committing to an ORM choice before a second real
game system exists to pressure-test the design.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "mesarpg.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pilots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    callsign TEXT,
    gunnery INTEGER NOT NULL DEFAULT 4,
    piloting INTEGER NOT NULL DEFAULT 5,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mechs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id INTEGER REFERENCES pilots(id) ON DELETE SET NULL,
    chassis TEXT NOT NULL,
    model TEXT,
    tonnage INTEGER NOT NULL,
    walk_mp INTEGER NOT NULL,
    run_mp INTEGER NOT NULL,
    jump_mp INTEGER NOT NULL DEFAULT 0,
    heat_sinks INTEGER NOT NULL DEFAULT 10,
    heat_current INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mech_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mech_id INTEGER NOT NULL REFERENCES mechs(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    armor_current INTEGER NOT NULL,
    armor_max INTEGER NOT NULL,
    armor_rear_current INTEGER,
    armor_rear_max INTEGER,
    structure_current INTEGER NOT NULL,
    structure_max INTEGER NOT NULL,
    UNIQUE (mech_id, location)
);

-- A mech's weapon loadout (ROADMAP.md Fase R2 follow-up — see
-- app/weapons.py for the stat catalog `weapon_name` looks up into).
-- `ammo_remaining` is NULL for weapons with no ammo (lasers, PPC).
CREATE TABLE IF NOT EXISTS mech_weapons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mech_id INTEGER NOT NULL REFERENCES mechs(id) ON DELETE CASCADE,
    weapon_name TEXT NOT NULL,
    location TEXT NOT NULL,
    ammo_remaining INTEGER
);

-- A mech's non-weapon equipment loadout (app/equipment.py's
-- EQUIPMENT_CATALOG) — same shape as mech_weapons above, minus
-- ammo_remaining (equipment doesn't consume ammo the way a mounted
-- weapon does).
CREATE TABLE IF NOT EXISTS mech_equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mech_id INTEGER NOT NULL REFERENCES mechs(id) ON DELETE CASCADE,
    equipment_name TEXT NOT NULL,
    location TEXT NOT NULL
);

-- Per-location critical slot list (up to 12 per location) — only
-- populated for mechs imported from the public MTF database (ROADMAP.md
-- Fase R3, "ficha interactiva"); hand-made mechs simply have none. Not
-- yet wired to an actual critical-hit resolution system (ROADMAP.md
-- Fase R2 follow-up) — this is the static reference list only, same as
-- what a paper record sheet prints before any dice are rolled.
CREATE TABLE IF NOT EXISTS mech_criticals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mech_id INTEGER NOT NULL REFERENCES mechs(id) ON DELETE CASCADE,
    location TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    UNIQUE (mech_id, location, slot_index)
);

-- Local, offline-first catalog of real mech chassis/models (VISION.md §3
-- — the table has to work without internet at the client's house). One
-- row per MTF source file, parsed once by scripts/sync_mech_catalog.py
-- from the public MegaMek unit database; app/mech_templates.py reads
-- this instead of the old live-fetch-per-search in app/mech_import.py.
-- `data` is the JSON-encoded {walk_mp, run_mp, jump_mp, heat_sinks,
-- locations, weapons, criticals} — see app/mech_import.py's parse_mtf,
-- whose output this stores verbatim (minus chassis/model/tonnage, which
-- get their own columns so search doesn't need to touch the JSON).
CREATE TABLE IF NOT EXISTS mech_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL UNIQUE,
    chassis TEXT NOT NULL,
    model TEXT NOT NULL,
    tonnage INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    radius INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hex_tiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    q INTEGER NOT NULL,
    r INTEGER NOT NULL,
    elevation INTEGER NOT NULL DEFAULT 0,
    blocks_los INTEGER NOT NULL DEFAULT 0,
    UNIQUE (map_id, q, r)
);

CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    map_id INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    mech_id INTEGER REFERENCES mechs(id) ON DELETE SET NULL,
    pilot_id INTEGER REFERENCES pilots(id) ON DELETE SET NULL,
    q INTEGER NOT NULL,
    r INTEGER NOT NULL,
    facing_deg INTEGER NOT NULL DEFAULT 0,
    is_ghost INTEGER NOT NULL DEFAULT 0,
    revealed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS combat_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id INTEGER REFERENCES pilots(id) ON DELETE SET NULL,
    die TEXT NOT NULL,
    result INTEGER NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ROADMAP.md S2 — simplified round/initiative tracking (one row per
-- campaign: the current round only, no history). See
-- app/systems/battletech/turns.py for what this simplifies away from the
-- full 5-phase Total Warfare turn. `initiative_roll` is vestigial (kept
-- for old-DB compatibility, same pattern as maps.radius) now that a round
-- can hold multiple rolls (team or individual mode) in bt_round_rolls.
CREATE TABLE IF NOT EXISTS bt_rounds (
    campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL DEFAULT 0,
    initiative_roll INTEGER
);

CREATE TABLE IF NOT EXISTS bt_round_acted (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, pilot_id)
);

-- One row per initiative roll made this round: either a whole faction
-- ("team" mode — the real rule) or one pilot ("individual" mode — a
-- GM-selectable alternative, not from the rulebook, requested directly).
-- pilot_id NULL means it's a faction-level roll.
CREATE TABLE IF NOT EXISTS bt_round_rolls (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    faction TEXT NOT NULL,
    pilot_id INTEGER REFERENCES pilots(id) ON DELETE CASCADE,
    roll INTEGER NOT NULL
);

-- One row per unit that has moved this round — the movement phase
-- (app/systems/battletech/movement.py). movement_type is 'walk'/'run'/
-- 'jump'; hexes_moved is the real path length, fed straight into
-- app/combat.py's target_movement_mod() when this unit gets attacked
-- later this round, instead of the GM guessing it.
CREATE TABLE IF NOT EXISTS bt_round_moves (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    pilot_id INTEGER NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    movement_type TEXT NOT NULL,
    hexes_moved INTEGER NOT NULL,
    mp_spent INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (campaign_id, pilot_id)
);

-- Single-row table: which campaign the physical table is playing right
-- now. There is only ever one game happening at this table (players
-- come and go, but never two campaigns at once), so a singleton instead
-- of a per-device concept — see app/table_session.py. Drives real-time
-- Hub activation across devices (ROADMAP.md, "suite jugable").
CREATE TABLE IF NOT EXISTS table_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# Standard BattleMech locations. Only torso locations carry rear armor.
MECH_LOCATIONS = ["HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"]
REAR_ARMOR_LOCATIONS = {"CT", "LT", "RT"}


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA foreign_keys = ON")
        _ensure_column(conn, "rolls", "campaign_id", "INTEGER")
        _ensure_column(conn, "rolls", "pilot_id", "INTEGER")
        _ensure_column(conn, "rolls", "label", "TEXT")
        _ensure_column(conn, "campaigns", "active_map_id", "INTEGER")
        _ensure_column(conn, "campaigns", "system", "TEXT NOT NULL DEFAULT 'battletech'")
        _ensure_column(conn, "maps", "grid_type", "TEXT NOT NULL DEFAULT 'hex'")
        _ensure_column(conn, "hex_tiles", "terrain", "TEXT NOT NULL DEFAULT 'plains'")
        # Woods/jungle LoS accumulation (app/hexgrid.py's has_los) — how many
        # of the "3+ points blocks LOS" total this tile contributes when
        # intervening, distinct from blocks_los (a hard, single-hex block).
        # Same "stored per-tile, defaulted from terrain, GM-overridable"
        # pattern blocks_los already uses.
        _ensure_column(conn, "hex_tiles", "los_points", "INTEGER NOT NULL DEFAULT 0")
        # Maps are now sized by width x height (a rectangle) instead of a
        # radius (a hexagon-of-hexes) — ROADMAP.md S1, requested directly by
        # the user. `radius` stays in the schema (SQLite can't cheaply drop
        # a NOT NULL column) but is never read again; maps.create_map still
        # writes a harmless derived value into it for old-DB compatibility.
        _ensure_column(conn, "maps", "width", "INTEGER NOT NULL DEFAULT 8")
        _ensure_column(conn, "maps", "height", "INTEGER NOT NULL DEFAULT 8")
        # Factions — player / enemy / non-aggressive NPC. Requested after S2
        # (round/initiative) surfaced that nothing in the data model tracked
        # sides at all; this is the foundation, not a redo of initiative —
        # team-based initiative using this field is a separate follow-up.
        _ensure_column(conn, "pilots", "faction", "TEXT NOT NULL DEFAULT 'player'")
        # GM-selectable initiative style — "team" (the real rule: one 2d6
        # per side) or "individual" (one 2d6 per combat pilot), requested
        # directly after the real rule was confirmed via research.
        _ensure_column(conn, "campaigns", "initiative_mode", "TEXT NOT NULL DEFAULT 'team'")
        # Heat (ROADMAP.md Fase R2 follow-up, now that weapons exist to
        # generate it) — see app/combat.py's heat_penalty() for the
        # verification caveat on the to-hit table.
        _ensure_column(conn, "mechs", "heat_sinks", "INTEGER NOT NULL DEFAULT 10")
        _ensure_column(conn, "mechs", "heat_current", "INTEGER NOT NULL DEFAULT 0")
        conn.execute("INSERT OR IGNORE INTO table_session (id, active_campaign_id) VALUES (1, NULL)")
        # Character sheet approval (ROADMAP.md Fase R3 — "suite jugable").
        # DEFAULT 'approved' means every pilot/mech created the old way (by
        # the GM, which is all of them before this) is already approved —
        # no data migration needed. owner_token is only set for
        # player-submitted sheets (NULL for GM-created ones), and is only
        # ever checked while a sheet is pending/rejected — never leaves
        # this process as JSON (see main.py's _sanitize_pilot/_sanitize_mech).
        _ensure_column(conn, "pilots", "status", "TEXT NOT NULL DEFAULT 'approved'")
        _ensure_column(conn, "pilots", "owner_token", "TEXT")
        _ensure_column(conn, "pilots", "review_note", "TEXT")
        _ensure_column(conn, "mechs", "status", "TEXT NOT NULL DEFAULT 'approved'")
        _ensure_column(conn, "mechs", "owner_token", "TEXT")
        _ensure_column(conn, "mechs", "review_note", "TEXT")
        # Pilot consciousness track (official record sheet, requested
        # directly — "ficha interactiva de Battletech oficial"). 0-5 hits;
        # the Consciousness Number per hit (3/5/7/10/11) lives in
        # app/pilots.py, not here — this column is just the counter.
        _ensure_column(conn, "pilots", "hits", "INTEGER NOT NULL DEFAULT 0")
        # Per-critical-slot destroyed state — mech_criticals previously only
        # listed what's installed (static reference), never whether it had
        # been hit. Same request as above: the sheet has to be able to mark
        # a crit destroyed and have that be real engine state, not a
        # decoration.
        _ensure_column(conn, "mech_criticals", "hit", "INTEGER NOT NULL DEFAULT 0")
        # True only for a mech imported from the public MTF database (real
        # per-slot data from app/mech_import.py) — gates whether
        # app/critical_layout.py is allowed to (re)generate a default
        # layout when weapons are mounted/removed, so it never overwrites
        # authoritative imported data.
        _ensure_column(conn, "mechs", "criticals_imported", "INTEGER NOT NULL DEFAULT 0")
        # Per-pilot dice color for the manual initiative-roll flow ("cada
        # jugador/enemigo tendrá un color de dados") — distinct from the
        # 3-bucket faction colors in src/factions.ts, which stay shared.
        # Defaults to the same neutral grey as NEUTRAL_UNIT_COLOR;
        # scripts/backfill_pilot_colors.py assigns real variety to
        # already-existing pilots still sitting on this default.
        _ensure_column(conn, "pilots", "color", "TEXT NOT NULL DEFAULT '#9aa4a2'")
        # Initiative modifier breakdown (requested directly — "todos los
        # bonificadores que haya que sumar por las reglas del juego") —
        # `roll` stays the raw 2d6 the physics dice actually landed on;
        # modifier_total is added on top for turn/movement order, and
        # modifiers_json keeps the itemized breakdown for the round log.
        # See turns.py's _initiative_modifiers — no modifier is active yet
        # (none confirmed as an official Total Warfare rule so far).
        _ensure_column(conn, "bt_round_rolls", "modifiers_json", "TEXT")
        _ensure_column(conn, "bt_round_rolls", "modifier_total", "INTEGER NOT NULL DEFAULT 0")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Light migration: add a column if an older dev DB predates it."""
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
