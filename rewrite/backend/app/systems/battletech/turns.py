"""Round/initiative tracking (ROADMAP.md S2) — a deliberately simplified
v1, not the full Total Warfare turn structure.

Researched before writing this (not improvised): a real round is
Initiative -> Movement -> Weapon Attack -> Physical Attack -> Heat, each
SIDE rolls 2d6 for initiative (not each unit or each player), and the
LOSER acts first in both the movement and weapon-attack phases (the
winner gets to react to where the opponent already committed). Within a
phase, units alternate activation one at a time — and when forces are
unequal, the larger side moves proportionally more per activation, e.g.
double the units moves 2-for-1 (Sarna's Total Warfare page has a section
titled "Unequal Numbers of Units" for exactly this). That whole alternating
per-unit structure is still out of scope for this v1 — see the acted-pilot
tracking below, which stays advisory/whole-round, not per-activation.

Two initiative MODES, GM-selectable per campaign (`campaigns.initiative_mode`):
- "team" — the real rule above: one 2d6 roll per side (player/enemy —
  NPCs are non-aggressive and never roll). With unequal side counts this
  is still just 2 rolls total, not one per pilot; that surprised the user
  enough to ask for research to confirm it, which is what's cited above.
  Rolled automatically the instant a round starts, same as always.
- "individual" — NOT from the rulebook. The user asked for this
  explicitly as a GM-selectable alternative: one 2d6 per combat pilot
  (5 players + 3 enemies = 8 rolls), sorted lowest-first (mirroring
  "loser acts first" extended to individuals). Rolled manually, one
  pilot at a time, via roll_pilot_initiative below — a round starting in
  this mode begins with zero rolls; each player rolls their own from
  their sheet, the GM rolls each enemy's from the map's mech menu.
  activeTurnPilotIds (src/rounds.ts) already treats "no roll yet" as
  "not this pilot's turn," so a partially-rolled round needs no special
  handling on the frontend beyond the roll UI itself.

Neither mode gates movement or attacks behind whose turn it is — "no es
tu turno" warns, it doesn't block (matches how the rest of this app is
server-authoritative on outcomes but permissive on order).

Starting a new round also dissipates heat for every mech in the
campaign (see app/mechs.py `dissipate_all_heat` and app/combat.py's
heat_penalty) — the closest mapping available to the real Heat Phase
without a full phase-by-phase turn structure.
"""

import json
import random

from ... import campaigns, db, events, units
from . import mechs, pilots, weapons

# NPCs are non-aggressive by definition (ROADMAP.md S2 follow-up) — they
# never participate in combat initiative, in either mode.
COMBAT_FACTIONS = ("player", "enemy")


class WrongInitiativeMode(ValueError):
    pass


class RoundNotStarted(ValueError):
    pass


class UnknownCombatPilot(ValueError):
    pass


def _roll_2d6() -> int:
    return random.randint(1, 6) + random.randint(1, 6)


def _initiative_modifiers(pilot: dict, mech: dict | None) -> list[dict]:
    """Bonuses added on top of the raw 2d6 roll — infrastructure only for
    now, no modifier is confirmed as an official Total Warfare rule yet.

    Researched directly on request: a "+1 per 5 tons under 100 tonnage"
    bonus is NOT in Total Warfare's core initiative rules (that book
    rolls a plain 2d6 per side, no modifiers). The only real-sounding
    match found is the HBS video game's "lighter 'Mechs act in an
    earlier phase" system — a completely different, phase-based
    initiative mechanic, not applicable to this app's 2d6 model. Add a
    real entry here (e.g. Tactical Genius) once a pilot special-ability/
    quirk system exists and a specific modifier is confirmed official."""
    return []


def _combat_pilots(campaign_id: int) -> list[dict]:
    return [p for p in pilots.list_pilots(campaign_id) if p["faction"] in COMBAT_FACTIONS]


def start_round(campaign_id: int) -> dict:
    """Begin a new round: increments round_number, clears prior rolls and
    which pilots had acted. Team mode rolls initiative for both sides
    immediately, same as always. Individual mode rolls nothing here —
    the round starts with zero rolls, and each pilot's is submitted
    separately via roll_pilot_initiative (see module docstring)."""
    campaign = campaigns.get_campaign(campaign_id)
    mode = campaign["initiative_mode"] if campaign else "team"
    combat_pilots = _combat_pilots(campaign_id)

    if mode == "individual":
        rolls: list[tuple[str, int | None, int]] = []
    else:
        factions_present = sorted({p["faction"] for p in combat_pilots})
        faction_rolls = {f: _roll_2d6() for f in factions_present}
        if len(factions_present) == 2:
            # Real rule: ties are re-rolled. Individual-mode ties (far more
            # likely with many pilots) are left as-is and broken by
            # pilot_id order instead — re-rolling every N-way tie among
            # many pilots isn't worth the complexity for a GM-alternative
            # mode that isn't from the rulebook to begin with.
            a, b = factions_present
            while faction_rolls[a] == faction_rolls[b]:
                faction_rolls = {f: _roll_2d6() for f in factions_present}
        rolls = [(f, None, roll) for f, roll in faction_rolls.items()]

    # Snapshot every mech's heat BEFORE dissipate_all_heat below floors
    # it at zero — undoing "empezar ronda" needs the exact prior value
    # (real user request: undo covers round starts too), which can't be
    # recovered afterward if a mech's heat had already dropped to 0.
    heat_before = {m["id"]: m["heat_current"] for m in mechs.list_mechs(campaign_id)}

    with db.connect() as conn:
        prev_round_row = conn.execute(
            "SELECT round_number FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)
        ).fetchone()
        prev_round_number = prev_round_row["round_number"] if prev_round_row else 0
        conn.execute(
            """
            INSERT INTO bt_rounds (campaign_id, round_number)
            VALUES (?, 1)
            ON CONFLICT(campaign_id) DO UPDATE SET round_number = round_number + 1
            """,
            (campaign_id,),
        )
        conn.execute("DELETE FROM bt_round_acted WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_rolls WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_moves WHERE campaign_id = ?", (campaign_id,))
        for faction, pilot_id, roll in rolls:
            conn.execute(
                "INSERT INTO bt_round_rolls (campaign_id, faction, pilot_id, roll) VALUES (?, ?, ?, ?)",
                (campaign_id, faction, pilot_id, roll),
            )
        events.log_event(
            conn, campaign_id, "round_started", f"Ronda {prev_round_number + 1} iniciada",
            {"prev_round_number": prev_round_number, "heat_before": heat_before},
        )
        state = _get(conn, campaign_id, mode)

    # Closest mapping this app has to the real Heat Phase without a full
    # phase-by-phase turn (ROADMAP.md Fase R2 follow-up) — heat drops by
    # each mech's own heat sink count once per new round.
    mechs.dissipate_all_heat(campaign_id)
    return state


class InvalidRollValue(ValueError):
    pass


def _validate_can_roll(campaign_id: int, pilot_id: int) -> tuple[str, dict]:
    """Shared guard for both halves of the manual-roll flow below —
    "individual" mode only, round already started, pilot is a real
    combat pilot (player/enemy, never npc) of this campaign. Returns
    (mode, pilot) so callers don't have to re-fetch either."""
    campaign = campaigns.get_campaign(campaign_id)
    mode = campaign["initiative_mode"] if campaign else "team"
    if mode != "individual":
        raise WrongInitiativeMode(f"Initiative is rolled per-pilot only in 'individual' mode, campaign is {mode!r}")

    pilot = pilots.get_pilot(pilot_id)
    if not pilot or pilot["campaign_id"] != campaign_id or pilot["faction"] not in COMBAT_FACTIONS:
        raise UnknownCombatPilot(f"Pilot {pilot_id} is not a combat pilot ({COMBAT_FACTIONS}) in campaign {campaign_id}")

    with db.connect() as conn:
        round_row = conn.execute(
            "SELECT round_number FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)
        ).fetchone()
    if not round_row or round_row["round_number"] == 0:
        raise RoundNotStarted(f"No round has been started for campaign {campaign_id}")

    return mode, pilot


def request_pilot_initiative(campaign_id: int, pilot_id: int) -> dict:
    """Validates a pilot is allowed to roll right now and returns just
    enough (name/color) for the caller to broadcast "please physically
    throw dice for this pilot" — see main.py's roll-initiative endpoint.
    Deliberately does NOT touch bt_round_rolls: the dice themselves are
    the source of the result now (no server-side random.randint stand-in
    — "vamos a hacer que los dados sean el valor real"), and only get
    recorded once the shared board reports what they actually landed on
    (report_pilot_initiative below). If a pilot already has a roll this
    round, this is a no-op from the caller's perspective — the frontend
    only shows the button when needsInitiative is true, so re-requesting
    an already-rolled pilot shouldn't normally happen, but nothing here
    would corrupt state if it did (report_pilot_initiative is the one
    with the real idempotency guard)."""
    _, pilot = _validate_can_roll(campaign_id, pilot_id)
    # A GM-controlled pilot (enemy/npc — no device of their own) falls
    # back to the GM's own die-style pick when it hasn't set one of its
    # own (real user request: "el GM selecciona dados... para sus
    # tiradas de mechs enemigos"). A player pilot's own pick always wins
    # regardless of faction, and an explicit per-pilot pick on an enemy
    # (unusual, but the field allows it) still takes priority too.
    die_style = pilot["die_style"]
    if die_style is None and pilot["faction"] in ("enemy", "npc"):
        campaign = campaigns.get_campaign(campaign_id)
        die_style = campaign["gm_die_style"] if campaign else None
    return {
        "pilot_id": pilot["id"], "pilot_name": pilot["name"], "color": pilot["color"],
        "die_style": die_style,
    }


def report_pilot_initiative(campaign_id: int, pilot_id: int, roll: int) -> dict:
    """The shared table (TableView) calls this once its two physics dice
    have actually come to rest, reporting the real value they landed on
    — this is now the only way an individual-mode roll gets recorded.
    Idempotent: a pilot who already has a roll this round keeps it
    unchanged rather than being overwritten by a second report (e.g. a
    duplicate throw from a double-clicked request), same INSERT-OR-
    IGNORE-style guard as mark_acted below."""
    if not (2 <= roll <= 12):
        raise InvalidRollValue(f"A 2d6 roll must be 2-12, got {roll!r}")
    mode, pilot = _validate_can_roll(campaign_id, pilot_id)

    with db.connect() as conn:
        already = conn.execute(
            "SELECT 1 FROM bt_round_rolls WHERE campaign_id = ? AND pilot_id = ?",
            (campaign_id, pilot_id),
        ).fetchone()
        if not already:
            mech = next((m for m in mechs.list_mechs(campaign_id) if m["pilot_id"] == pilot_id), None)
            modifiers = _initiative_modifiers(pilot, mech)
            modifier_total = sum(m["value"] for m in modifiers)
            conn.execute(
                """
                INSERT INTO bt_round_rolls (campaign_id, faction, pilot_id, roll, modifiers_json, modifier_total)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (campaign_id, pilot["faction"], pilot_id, roll, json.dumps(modifiers), modifier_total),
            )
            events.log_event(
                conn, campaign_id, "initiative_rolled", f"Iniciativa de {pilot['name']}: {roll}",
                {"pilot_id": pilot_id},
            )
        return _get(conn, campaign_id, mode)


def mark_acted(campaign_id: int, pilot_id: int) -> dict:
    """Record that a pilot has taken their activation this round."""
    campaign = campaigns.get_campaign(campaign_id)
    mode = campaign["initiative_mode"] if campaign else "team"
    with db.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO bt_round_acted (campaign_id, pilot_id) VALUES (?, ?)",
            (campaign_id, pilot_id),
        )
        return _get(conn, campaign_id, mode)


def get_round(campaign_id: int) -> dict:
    campaign = campaigns.get_campaign(campaign_id)
    mode = campaign["initiative_mode"] if campaign else "team"
    with db.connect() as conn:
        return _get(conn, campaign_id, mode)


def _movement_order(campaign_id: int, mode: str, rolls: list[dict]) -> list[int]:
    """Everyone who moves this round, lowest-total-first (the real rule:
    the initiative loser moves first) — empty until everyone who's going
    to roll this round actually has. Team mode assigns every combat
    pilot their own side's total (a documented simplification of the
    real "unequal numbers" proportional-alternation rule — see the
    module docstring); individual mode uses each pilot's own roll."""
    combat_pilots = _combat_pilots(campaign_id)
    if not combat_pilots:
        return []
    if mode == "individual":
        total_by_pilot = {r["pilot_id"]: r["total"] for r in rolls if r["pilot_id"] is not None}
        if set(total_by_pilot) != {p["id"] for p in combat_pilots}:
            return []
        return [p["id"] for p in sorted(combat_pilots, key=lambda p: (total_by_pilot[p["id"]], p["id"]))]
    total_by_faction = {r["faction"]: r["total"] for r in rolls}
    if set(total_by_faction) != {p["faction"] for p in combat_pilots}:
        return []
    return [p["id"] for p in sorted(combat_pilots, key=lambda p: (total_by_faction[p["faction"]], p["id"]))]


# ---- ranged/melee phase gating ("se activa sola... solo si algún mech
# tiene alcance y en LoS algún mech al que pueda atacar") -----------------


def _combat_pilots_with_targets(map_id: int | None, target_check) -> list[int]:
    """Every combat pilot with a live unit+mech on the given map whose
    mech currently has at least one enemy satisfying target_check(mech,
    enemies) — enemies is units.visible_enemies_from_unit's own result
    (facing-cone + LOS + real distance, already built for the 1st-person
    HUD), reused here rather than re-deriving the same geometry. None/no
    active map -> nobody has anything (mirrors movement.py's own "no map,
    nothing reachable" handling)."""
    if map_id is None:
        return []
    result = []
    for u in units.list_units(map_id):
        if u["pilot_id"] is None or u["mech_id"] is None:
            continue
        mech = mechs.get_mech(u["mech_id"])
        if mech is None:
            continue
        enemies = units.visible_enemies_from_unit(u["id"]) or []
        if target_check(mech, enemies):
            result.append(u["pilot_id"])
    return result


def _pilots_with_ranged_targets(map_id: int | None) -> list[int]:
    """A pilot "has a ranged target" if some mounted weapon that still has
    ammo (or never needed any — ammo_remaining is None for energy
    weapons) could reach some visible enemy within its own long-range
    bracket. Only weapon ranges matter here, not to-hit odds — this gates
    whether the phase exists at all, not whether a shot would land."""
    def check(mech: dict, enemies: list[dict]) -> bool:
        long_ranges = [
            weapons.get_weapon(w["weapon_name"])["long"]
            for w in mech["weapons"]
            if w["ammo_remaining"] != 0
        ]
        if not long_ranges:
            return False
        max_range = max(long_ranges)
        return any(e["distance"] <= max_range for e in enemies)

    return _combat_pilots_with_targets(map_id, check)


def _pilots_with_melee_targets(map_id: int | None) -> list[int]:
    """A pilot "has a melee target" if some enemy is standing adjacent
    (distance 1) — physical attacks need no weapon/ammo/range check, just
    proximity (and enemies is already filtered by facing-cone/LOS, both
    trivially satisfied at distance 1)."""
    return _combat_pilots_with_targets(map_id, lambda mech, enemies: any(e["distance"] <= 1 for e in enemies))


def _get(conn, campaign_id: int, mode: str) -> dict:
    round_row = conn.execute(
        "SELECT round_number FROM bt_rounds WHERE campaign_id = ?",
        (campaign_id,),
    ).fetchone()

    roll_rows = conn.execute(
        """
        SELECT r.faction, r.pilot_id, r.roll, r.modifiers_json, r.modifier_total, p.name AS pilot_name
        FROM bt_round_rolls r
        LEFT JOIN pilots p ON p.id = r.pilot_id
        WHERE r.campaign_id = ?
        """,
        (campaign_id,),
    ).fetchall()
    rolls = [
        {
            "kind": "pilot" if r["pilot_id"] is not None else "faction",
            "faction": r["faction"],
            "pilot_id": r["pilot_id"],
            "pilot_name": r["pilot_name"],
            "roll": r["roll"],
            "modifiers": json.loads(r["modifiers_json"]) if r["modifiers_json"] else [],
            "modifier_total": r["modifier_total"],
            "total": r["roll"] + r["modifier_total"],
        }
        for r in roll_rows
    ]
    rolls.sort(key=lambda r: (r["total"], r["pilot_id"] or 0))

    acted_rows = conn.execute(
        "SELECT pilot_id FROM bt_round_acted WHERE campaign_id = ? ORDER BY pilot_id",
        (campaign_id,),
    ).fetchall()

    move_rows = conn.execute(
        "SELECT pilot_id, unit_id, movement_type, hexes_moved FROM bt_round_moves WHERE campaign_id = ? ORDER BY pilot_id",
        (campaign_id,),
    ).fetchall()
    moves = [dict(r) for r in move_rows]
    movement_order = _movement_order(campaign_id, mode, rolls)
    moved_pilot_ids = [m["pilot_id"] for m in moves]

    # Ranged/melee target scans (real LOS/range/adjacency, see
    # _pilots_with_ranged_targets/_pilots_with_melee_targets above) only
    # run once movement has actually finished — cheap insurance against
    # doing per-pilot LOS work on every round-state fetch during a phase
    # where the answer can't matter yet, and it also means these two
    # lists start truthfully empty (never "ranged phase" before there's
    # even a real movement_order).
    movement_done = len(movement_order) > 0 and all(pid in moved_pilot_ids for pid in movement_order)
    ranged_target_pilot_ids: list[int] = []
    melee_target_pilot_ids: list[int] = []
    if movement_done:
        campaign = campaigns.get_campaign(campaign_id)
        active_map_id = campaign["active_map_id"] if campaign else None
        ranged_target_pilot_ids = _pilots_with_ranged_targets(active_map_id)
        melee_target_pilot_ids = _pilots_with_melee_targets(active_map_id)

    return {
        "campaign_id": campaign_id,
        "round_number": round_row["round_number"] if round_row else 0,
        "mode": mode,
        "rolls": rolls,
        "acted_pilot_ids": [r["pilot_id"] for r in acted_rows],
        "movement_order": movement_order,
        "moved_pilot_ids": moved_pilot_ids,
        # Real recorded movement per pilot this round — AttackPanel reads
        # this to pre-fill attacker_movement/target_hexes_moved instead
        # of the GM guessing them (see app/combat.py's
        # ATTACKER_MOVEMENT_MOD/target_movement_mod).
        "moves": moves,
        # Live (recomputed every fetch, not "as of when movement ended" —
        # mechs move/die during these phases too) — see rounds.ts's
        # currentPhase for how these two decide 'ranged'/'melee'/'other'.
        "ranged_target_pilot_ids": ranged_target_pilot_ids,
        "melee_target_pilot_ids": melee_target_pilot_ids,
    }
