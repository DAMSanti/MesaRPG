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

-- Persistent campaign history + generic undo (real user request: "el
-- registro debe guardar todo... TODO!!!" + "deshacer cualquier acción").
-- Supersedes the old BattleTech-only combat_actions table (same shape,
-- just generalized) — event_type covers every module (pilots/mechs/
-- maps/units/turns/combat), not just attacks. See app/events.py.
CREATE TABLE IF NOT EXISTS campaign_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    undoable INTEGER NOT NULL DEFAULT 1,
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

-- D&D 5e (ROADMAP.md Fase R4 — segundo sistema, slice mínimo de
-- validación de la arquitectura de plugins). Sin flujo de aprobación
-- (a diferencia de pilots/mechs) — el GM crea la ficha directamente,
-- como BattleTech antes de que existiera esa fase. Sin clases, conjuros,
-- dotes ni condiciones a propósito — ver app/systems/dnd5e/ para el
-- alcance exacto.
CREATE TABLE IF NOT EXISTS dnd_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    str INTEGER NOT NULL DEFAULT 10,
    dex INTEGER NOT NULL DEFAULT 10,
    con INTEGER NOT NULL DEFAULT 10,
    int INTEGER NOT NULL DEFAULT 10,
    wis INTEGER NOT NULL DEFAULT 10,
    cha INTEGER NOT NULL DEFAULT 10,
    ac INTEGER NOT NULL DEFAULT 10,
    hp_current INTEGER NOT NULL DEFAULT 10,
    hp_max INTEGER NOT NULL DEFAULT 10,
    proficiency_bonus INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Iniciativa D&D — mismo espíritu que bt_rounds/bt_round_rolls/
-- bt_round_acted (una fila = la ronda actual, sin historial), pero sin
-- ningún concepto de facción/equipo: v1 es una tirada individual por
-- personaje (d20+DEX), no por bando.
CREATE TABLE IF NOT EXISTS dnd_rounds (
    campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dnd_round_rolls (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES dnd_characters(id) ON DELETE CASCADE,
    roll INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, character_id)
);

CREATE TABLE IF NOT EXISTS dnd_round_acted (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    character_id INTEGER NOT NULL REFERENCES dnd_characters(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, character_id)
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
        # D&D 5e (Fase R4) — additive, mirrors mech_id/pilot_id above but
        # for a single-character system instead of a mech+pilot pair. A
        # unit has exactly one of mech_id or dnd_character_id set,
        # depending on the owning campaign's system.
        _ensure_column(conn, "units", "dnd_character_id", "INTEGER REFERENCES dnd_characters(id) ON DELETE SET NULL")
        # Pilot PIN (requested directly — "el jugador escoge su personaje
        # de una lista compartida, le pedirá un PIN de 4 dígitos"). Hashed
        # with a per-pilot random salt (app/systems/battletech/pilots.py's
        # _hash_pin) — sha256, not bcrypt: a 4-digit PIN only has 10,000
        # possibilities regardless of the hash function, so the goal here
        # is "don't store it in plain text where a casual DB browse reveals
        # it," not real password-grade security, and this needs no new
        # dependency. NULL/NULL means no PIN set — a pilot created before
        # this feature (or by the GM directly, which doesn't prompt for a
        # PIN) stays freely selectable, same as today.
        _ensure_column(conn, "pilots", "pin_hash", "TEXT")
        _ensure_column(conn, "pilots", "pin_salt", "TEXT")
        # NULL = no style picked yet — exempt from the die-style exclusivity
        # pool (see app/dice_styles.py), renders with the classic plain-box/
        # pilot-color look, same as every pilot before this feature existed.
        _ensure_column(conn, "pilots", "die_style", "TEXT")
        _ensure_column(conn, "campaigns", "gm_die_style", "TEXT")
        # Melee/heat-phase/critical-hit state (ROADMAP.md follow-up —
        # "fase de melee... fase de heat... shutdown... sistema PSR/
        # caída/prono... daño a componentes por crítico"). Gyro/engine/
        # sensor/life-support hits are counted separately from the
        # generic mech_criticals.hit flag because their effects are
        # cumulative per number of hits (1st vs 2nd engine/gyro/sensor
        # hit differ), not a simple destroyed/not-destroyed switch —
        # simpler to read a counter than re-scan mech_criticals for
        # "how many of this component's slots are hit" every time.
        _ensure_column(conn, "mechs", "is_shutdown", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "mechs", "is_prone", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "mechs", "gyro_hits", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "mechs", "engine_hits", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "mechs", "sensor_hits", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "mechs", "life_support_hit", "INTEGER NOT NULL DEFAULT 0")
        # Idempotency guard for turns.py's resolve_heat_phase — the
        # frontend calls that endpoint the instant it observes the round
        # has nothing left to act on, and it must be a safe no-op if
        # called twice (two GM tabs open, a retried request, etc).
        _ensure_column(conn, "bt_rounds", "heat_resolved", "INTEGER NOT NULL DEFAULT 0")


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
