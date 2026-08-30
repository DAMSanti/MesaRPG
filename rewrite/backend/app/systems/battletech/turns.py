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

Heat dissipates for every mech in the campaign as part of resolve_heat_phase
below (see app/mechs.py's `dissipate_all_heat` and app/combat.py's
heat_penalty) — real user report: it used to happen silently at the START
of the NEXT round (before the Heat phase was even visible), which read as
"the Heat phase doesn't do anything" even though it correctly triggered
shutdown/ammo-explosion/pilot-damage checks. Moved so heat visibly drops
(steam clearing, thermometer animating) during THIS round's own Heat
phase, not invisibly carried into the next one.
"""

import json
import random

from ... import campaigns, db, dice_resolution, events, units
from ...dice_source import DiceSource
from . import criticals, mechs, pilots, weapons

# NPCs are non-aggressive by definition (ROADMAP.md S2 follow-up) — they
# never participate in combat initiative, in either mode.
COMBAT_FACTIONS = ("player", "enemy")


class WrongInitiativeMode(ValueError):
    pass


class RoundNotStarted(ValueError):
    pass


class UnknownCombatPilot(ValueError):
    pass


class PilotIsDestroyed(ValueError):
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


def _destroyed_pilot_ids(campaign_id: int) -> set[int]:
    """Pilots whose own mech is already destroyed (Fase D) — a destroyed
    mech can't move (movement.execute_move's own MechIncapacitated check),
    so leaving its pilot in movement_order would stall the movement phase
    forever waiting on a "turn" that can never resolve (nothing would ever
    add them to moved_pilot_ids). Standalone query rather than routing
    through mechs.get_mech per pilot — this only needs the one column,
    for every mech in the campaign at once. Also the set a destroyed
    pilot is checked against before being allowed to roll initiative at
    all (turns.py's own _validate_can_roll) — permanent, unlike shutdown
    below, so it's kept separate rather than folded into
    _incapacitated_pilot_ids (which is round-scoped and self-corrects the
    instant a mech restarts)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT pilot_id FROM mechs WHERE campaign_id = ? AND pilot_id IS NOT NULL AND destroyed_reason IS NOT NULL",
            (campaign_id,),
        ).fetchall()
        return {r["pilot_id"] for r in rows}


def _incapacitated_pilot_ids(campaign_id: int) -> set[int]:
    """Real user report: an overheated (shutdown) mech's pilot stayed
    stuck as "their turn" in the movement/ranged/melee phases forever —
    movement.execute_move/combat.py/melee.py already block a shutdown
    mech from actually moving or attacking (MechIncapacitated), but
    nothing ever removed that pilot from movement_order/the target-
    eligible lists, so nobody could ever mark them as moved/acted and the
    phase just stalled on them — the exact same class of bug Fase D's
    destroyed-mech exclusion fixed, just for a RECOVERABLE state instead
    of a permanent one. Deliberately does NOT include is_prone — a fallen
    mech can still use its movement action to try standing back up, so it
    must stay eligible to be offered a turn, unlike shutdown/destroyed
    which block BOTH movement and attacks outright. Superset of
    _destroyed_pilot_ids (every destroyed mech is also incapacitated) —
    callers that only care about "can't move/attack this round" should
    use this one; only the initiative-roll gate cares about destroyed
    specifically (see _destroyed_pilot_ids' own doc comment)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT pilot_id FROM mechs WHERE campaign_id = ? AND pilot_id IS NOT NULL "
            "AND (destroyed_reason IS NOT NULL OR is_shutdown = 1)",
            (campaign_id,),
        ).fetchall()
        return {r["pilot_id"] for r in rows}


def remove_participant(campaign_id: int, pilot_id: int) -> None:
    """Real user report: a pilot whose unit gets removed from the map
    mid-round ("quitar de la mesa") stayed stuck in THIS round's own
    bt_round_participants snapshot forever — nothing re-derives that
    snapshot mid-round (start_round is the only place that ever populates
    it), so movement_order kept waiting on a turn for a pilot with no
    unit left to give one to. Called from main.py's DELETE /api/units/
    {id} endpoint (the "Quitar del mapa" action) — a no-op if no round is
    in progress or this pilot was never a participant to begin with, so
    it's always safe to call unconditionally. Deliberately does NOT touch
    _combat_pilots/start_round's own broader "who rolls at all" set —
    plenty of existing tests/flows roll initiative for a pilot who never
    had a unit placed yet, and that's an intentional, unrelated case this
    function doesn't need to (and shouldn't) touch; this only removes a
    pilot from a round they were ALREADY snapshotted into once their unit
    disappears out from under them mid-round."""
    with db.connect() as conn:
        conn.execute(
            "DELETE FROM bt_round_participants WHERE campaign_id = ? AND pilot_id = ?",
            (campaign_id, pilot_id),
        )


def _round_participant_pilot_ids(campaign_id: int) -> set[int]:
    """Which combat pilots were actually part of THIS round — the
    bt_round_participants snapshot start_round takes, not a live re-scan
    of every combat pilot in the campaign right now. See
    bt_round_participants' own doc comment in db.py for the real user
    report this fixes (a mech added mid-round shouldn't get a turn until
    the NEXT round)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT pilot_id FROM bt_round_participants WHERE campaign_id = ?", (campaign_id,)
        ).fetchall()
        return {r["pilot_id"] for r in rows}


def _round_mode(campaign_id: int) -> str:
    """The initiative mode actually GOVERNING right now — the round's own
    FROZEN mode (bt_rounds.mode, captured by start_round) while a round is
    in progress, or the campaign's live `initiative_mode` setting when
    none is (round_number == 0, nothing to freeze yet). Real user report:
    switching modes mid-round used to change how the round ALREADY in
    progress was interpreted immediately (an individual-mode round's
    per-pilot rolls suddenly read as a team-mode round's per-faction
    ones, or vice versa) — every reader of `mode` below now goes through
    this instead of re-deriving it fresh from the campaign each time, so
    a mid-round change is inert until the NEXT start_round call."""
    with db.connect() as conn:
        row = conn.execute(
            "SELECT round_number, mode FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)
        ).fetchone()
    if row and row["round_number"] > 0:
        return row["mode"]
    campaign = campaigns.get_campaign(campaign_id)
    return campaign["initiative_mode"] if campaign else "team"


def start_round(campaign_id: int, *, expected_round_number: int | None = None) -> dict:
    """Begin a new round: increments round_number, clears prior rolls and
    which pilots had acted. Team mode rolls initiative for both sides
    immediately, same as always. Individual mode rolls nothing here —
    the round starts with zero rolls, and each pilot's is submitted
    separately via roll_pilot_initiative (see module docstring).

    expected_round_number, when given, is the round the caller last saw —
    a no-op (current state returned unchanged) if the DB has already moved
    past it. Without this, GMView's auto-advance effect (fires whenever a
    round's phase lands on 'other') double-advances round_number when two
    GM tabs are open on the same campaign: both receive the same
    round_updated broadcast and both call this before either one's own
    response lands to move their local phase off 'other'. resolve_heat_phase
    avoids the equivalent race via bt_rounds.heat_resolved; nothing played
    that role for round advancement until now."""
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

    with db.connect() as conn:
        prev_round_row = conn.execute(
            "SELECT round_number FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)
        ).fetchone()
        prev_round_number = prev_round_row["round_number"] if prev_round_row else 0
        if expected_round_number is not None and prev_round_number != expected_round_number:
            return get_round(campaign_id)
        conn.execute(
            """
            INSERT INTO bt_rounds (campaign_id, round_number, heat_resolved, mode)
            VALUES (?, 1, 0, ?)
            ON CONFLICT(campaign_id) DO UPDATE SET round_number = round_number + 1, heat_resolved = 0, mode = ?
            """,
            (campaign_id, mode, mode),
        )
        conn.execute("DELETE FROM bt_round_acted WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_passed WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_rolls WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_moves WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM bt_round_participants WHERE campaign_id = ?", (campaign_id,))
        # Real user report: a pilot removed from the map ("quitar de la
        # mesa") stayed stuck as a required participant in every
        # SUBSEQUENT round too, not just the one they were removed
        # during — remove_participant (see its own doc comment) only
        # patches the round already in progress at the moment of
        # removal; start_round itself re-snapshots from _combat_pilots,
        # which has no notion of "has a unit" at all, so a start-round-
        # fresh pilot with no unit anywhere got re-included every time.
        # Only pilots with at least one REAL unit somewhere in the
        # campaign become participants — a pilot with nothing to move
        # can't meaningfully be asked to roll/act this round regardless
        # of why they have no unit (never placed, or removed earlier).
        pilots_with_units = {
            r["pilot_id"] for r in conn.execute(
                "SELECT DISTINCT pilot_id FROM units WHERE campaign_id = ? AND pilot_id IS NOT NULL",
                (campaign_id,),
            ).fetchall()
        }
        for p in combat_pilots:
            if p["id"] not in pilots_with_units:
                continue
            conn.execute(
                "INSERT INTO bt_round_participants (campaign_id, pilot_id) VALUES (?, ?)",
                (campaign_id, p["id"]),
            )
        for faction, pilot_id, roll in rolls:
            conn.execute(
                "INSERT INTO bt_round_rolls (campaign_id, faction, pilot_id, roll) VALUES (?, ?, ?, ?)",
                (campaign_id, faction, pilot_id, roll),
            )
        events.log_event(
            conn, campaign_id, "round_started", f"Ronda {prev_round_number + 1} iniciada",
            {"prev_round_number": prev_round_number},
        )

    # _get (via _movement_order/_combat_pilots_with_targets) reads
    # bt_round_participants back through its OWN fresh connection
    # (_round_participant_pilot_ids) — building the state from inside the
    # `with` block above, before this transaction commits, made those
    # just-inserted rows invisible to that second connection (a real bug
    # caught by test_movement_order_in_team_mode_groups_by_side_total:
    # team mode's movement_order came back empty). Reading AFTER the
    # block closes/commits avoids the cross-connection visibility gap.
    return get_round(campaign_id)


class InvalidRollValue(ValueError):
    pass


def _validate_can_roll(campaign_id: int, pilot_id: int) -> tuple[str, dict]:
    """Shared guard for both halves of the manual-roll flow below —
    "individual" mode only, round already started, pilot is a real
    combat pilot (player/enemy, never npc) of this campaign. Returns
    (mode, pilot) so callers don't have to re-fetch either."""
    mode = _round_mode(campaign_id)
    if mode != "individual":
        raise WrongInitiativeMode(f"Initiative is rolled per-pilot only in 'individual' mode, campaign is {mode!r}")

    pilot = pilots.get_pilot(pilot_id)
    if not pilot or pilot["campaign_id"] != campaign_id or pilot["faction"] not in COMBAT_FACTIONS:
        raise UnknownCombatPilot(f"Pilot {pilot_id} is not a combat pilot ({COMBAT_FACTIONS}) in campaign {campaign_id}")
    # Fase D real user request: "los muertos no deberían tirar
    # iniciativas" — a destroyed mech's pilot is already excluded from
    # movement_order/target lists (turns.py's own _destroyed_pilot_ids);
    # this is the same exclusion applied to the manual roll endpoint
    # itself, as defense in depth behind the frontend's own gating.
    if pilot_id in _destroyed_pilot_ids(campaign_id):
        raise PilotIsDestroyed(f"Pilot {pilot_id}'s mech is destroyed and can't roll initiative")

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


def current_round_number(campaign_id: int) -> int:
    """0 if the campaign has never started a round. combat.py/melee.py
    stamp this into every attack/melee event's payload so a "turn_acted"
    undo (below) knows exactly which prior events belong to the turn it's
    reverting — see _undo_turn_acted in events.py."""
    with db.connect() as conn:
        row = conn.execute("SELECT round_number FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)).fetchone()
    return row["round_number"] if row else 0


def mark_acted(campaign_id: int, pilot_id: int) -> dict:
    """Record that a pilot has taken their activation this round — a REAL
    attack (ranged or melee), which blocks BOTH phases for them this
    round (the "can't punch with an arm that fired" simplification).

    Logs its own undoable "turn_acted" event (real user request: undoing
    a mech's completed turn should revert EVERY shot it fired this
    activation, not just the last one) — its own undo handler
    (events.py's _undo_turn_acted) cascades back through every attack/
    melee event this pilot logged this round, not just this one row."""
    mode = _round_mode(campaign_id)
    round_number = current_round_number(campaign_id)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO bt_round_acted (campaign_id, pilot_id) VALUES (?, ?)",
            (campaign_id, pilot_id),
        )
        if cur.rowcount:  # already-acted (idempotent re-call) logs nothing new
            pilot = pilots.get_pilot(pilot_id)
            events.log_event(
                conn, campaign_id, "turn_acted",
                f"Turno de {pilot['name'] if pilot else pilot_id} completado",
                {"pilot_id": pilot_id, "round_number": round_number},
            )
        return _get(conn, campaign_id, mode)


class InvalidPassPhase(ValueError):
    pass


def pass_phase(campaign_id: int, pilot_id: int, phase: str) -> dict:
    """Record an explicit "Pasar turno" for ONE phase only (real user
    request/report — see bt_round_passed's own doc comment for why this
    is deliberately separate from mark_acted above: a pilot who simply
    had nothing to shoot shouldn't lose their real melee opportunity
    against an adjacent enemy just because they passed on ranged)."""
    if phase not in ("ranged", "melee"):
        raise InvalidPassPhase(f"phase must be 'ranged' or 'melee', got {phase!r}")
    mode = _round_mode(campaign_id)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO bt_round_passed (campaign_id, pilot_id, phase) VALUES (?, ?, ?)",
            (campaign_id, pilot_id, phase),
        )
        if cur.rowcount:
            pilot = pilots.get_pilot(pilot_id)
            events.log_event(
                conn, campaign_id, "phase_passed",
                f"{pilot['name'] if pilot else pilot_id} pasó turno ({phase})",
                {"pilot_id": pilot_id, "phase": phase},
            )
        return _get(conn, campaign_id, mode)


def get_round(campaign_id: int) -> dict:
    mode = _round_mode(campaign_id)
    with db.connect() as conn:
        return _get(conn, campaign_id, mode)


def _movement_order(campaign_id: int, mode: str, rolls: list[dict]) -> list[int]:
    """Everyone who moves this round, lowest-total-first (the real rule:
    the initiative loser moves first) — empty until everyone who's going
    to roll this round actually has. Team mode assigns every combat
    pilot their own side's total (a documented simplification of the
    real "unequal numbers" proportional-alternation rule — see the
    module docstring); individual mode uses each pilot's own roll."""
    participant_ids = _round_participant_pilot_ids(campaign_id)
    incapacitated_ids = _incapacitated_pilot_ids(campaign_id)
    combat_pilots = [
        p for p in _combat_pilots(campaign_id)
        if p["id"] in participant_ids and p["id"] not in incapacitated_ids
    ]
    if not combat_pilots:
        return []
    if mode == "individual":
        total_by_pilot = {r["pilot_id"]: r["total"] for r in rolls if r["pilot_id"] is not None}
        # Subset, not exact-equality: a pilot destroyed in an EARLIER
        # round is still excluded from combat_pilots above but nothing
        # stops them from still rolling initiative this round (their own
        # roll just goes nowhere) — total_by_pilot can legitimately hold
        # more ids than combat_pilots now. Requiring exact equality here
        # would permanently return [] the instant any mech in the
        # campaign was ever destroyed, since that pilot's own still-
        # present roll would never match the now-smaller combat_pilots set.
        if not {p["id"] for p in combat_pilots} <= set(total_by_pilot):
            return []
        return [p["id"] for p in sorted(combat_pilots, key=lambda p: (total_by_pilot[p["id"]], p["id"]))]
    total_by_faction = {r["faction"]: r["total"] for r in rolls}
    if set(total_by_faction) != {p["faction"] for p in combat_pilots}:
        return []
    return [p["id"] for p in sorted(combat_pilots, key=lambda p: (total_by_faction[p["faction"]], p["id"]))]


# ---- ranged/melee phase gating ("se activa sola... solo si algún mech
# tiene alcance y en LoS algún mech al que pueda atacar") -----------------


def _combat_pilots_with_targets(
    campaign_id: int, map_id: int | None, target_check, require_facing: bool = True,
) -> list[int]:
    """Every combat pilot with a live unit+mech on the given map whose
    mech currently has at least one enemy satisfying target_check(mech,
    enemies) — enemies is units.visible_enemies_from_unit's own result
    (LOS + real distance, plus facing-cone unless require_facing=False —
    already built for the 1st-person HUD), reused here rather than
    re-deriving the same geometry. None/no active map -> nobody has
    anything (mirrors movement.py's own "no map, nothing reachable"
    handling)."""
    if map_id is None:
        return []
    # Real user report: "si se mete un nuevo mech en mitad de un combate,
    # debe poder tirar iniciativa y empezar a actuar en el SIGUIENTE
    # turno" — a pilot who joined after this round's start_round hasn't
    # been snapshotted into bt_round_participants yet, so they're not
    # eligible to attack THIS round either, same reasoning as
    # _movement_order's own participant filter.
    participant_ids = _round_participant_pilot_ids(campaign_id)
    result = []
    for u in units.list_units(map_id):
        if u["pilot_id"] is None or u["mech_id"] is None or u["pilot_id"] not in participant_ids:
            continue
        mech = mechs.get_mech(u["mech_id"])
        # Real user report: a shutdown mech's pilot stayed stuck as
        # eligible-to-attack forever — combat.py/melee.py already refuse
        # to actually fire for one, but nothing excluded them from this
        # target scan, so the phase never had a way to mark them past it.
        if mech is None or mech["destroyed_reason"] is not None or mech["is_shutdown"]:
            continue
        enemies = units.visible_enemies_from_unit(u["id"], require_facing=require_facing) or []
        if target_check(mech, enemies):
            result.append(u["pilot_id"])
    return result


def _pilots_with_ranged_targets(campaign_id: int, map_id: int | None) -> list[int]:
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

    return _combat_pilots_with_targets(campaign_id, map_id, check)


def _pilots_with_melee_targets(campaign_id: int, map_id: int | None) -> list[int]:
    """A pilot "has a melee target" if some enemy is standing adjacent
    (distance 1) and in LOS — physical attacks need no weapon/ammo/range
    check, just proximity. require_facing=False: melee.py's
    resolve_melee_attack itself never checks facing, only adjacency+LOS
    (a physical attack doesn't need "spotting" the way aiming a weapon
    does) — gating the phase's existence on the stricter facing-cone
    check used to hide the melee phase even when an actual attack would
    have been legal (real user report)."""
    return _combat_pilots_with_targets(
        campaign_id, map_id, lambda mech, enemies: any(e["distance"] <= 1 for e in enemies), require_facing=False,
    )


# ---- Heat Phase (CAT3500D rulebook pp. 37-42 — verified directly against
# the PDF this session) ----------------------------------------------------

# Heat -> shutdown Avoid Target Number (2D6, meet or beat to avoid),
# checked high to low. None at 30 means unavoidable — not "no check".
_SHUTDOWN_AVOID_TN = [(30, None), (26, 10), (22, 8), (18, 6), (14, 4)]

# Heat -> ammo-explosion Avoid Target Number, same checked-high-to-low shape.
_AMMO_EXPLOSION_AVOID_TN = [(28, 8), (23, 6), (19, 4)]


def _highest_bracket(heat: int, brackets: list[tuple[int, int | None]]):
    for min_heat, avoid_tn in brackets:
        if heat >= min_heat:
            return True, avoid_tn
    return False, None


def _pick_ammo_bin(mech: dict) -> dict | None:
    """Most destructive ammo per shot explodes first (rulebook); ties
    broken by most shots remaining, per module docstring's own citation —
    a further tie is broken by mech_weapons id order (deterministic, not
    truly random, an accepted simplification for an edge case this
    unlikely)."""
    candidates = [w for w in mech["weapons"] if w["ammo_remaining"]]
    if not candidates:
        return None

    def damage_value(w):
        return weapons.get_weapon(w["weapon_name"])["damage"]

    return max(candidates, key=lambda w: (damage_value(w), w["ammo_remaining"]))


def _prepare_heat_phase(campaign_id: int) -> dict | None:
    """None means already resolved this round (idempotency guard) — the
    caller returns the same {"already_resolved": True} shape this always
    had. Otherwise dissipates heat (unconditional, no dice — same
    ordering the rulebook specifies: dissipate, then check thresholds)
    and returns ctx: just the ordered list of mech ids to process, since
    each mech's own shutdown/restart-avoid and ammo-explosion-avoid
    rolls (the step functions below) can tell on their own, from that
    mech's CURRENT state, whether they need a roll at all — no separate
    dynamic step list to compute up front (unlike melee's grouped
    damage), which is what keeps this simple enough to be fully
    physical-dice-aware, not a documented scope limit like charge/DFA."""
    with db.connect() as conn:
        round_row = conn.execute("SELECT heat_resolved FROM bt_rounds WHERE campaign_id = ?", (campaign_id,)).fetchone()
        if round_row and round_row["heat_resolved"]:
            return None
        conn.execute("UPDATE bt_rounds SET heat_resolved = 1 WHERE campaign_id = ?", (campaign_id,))
    mechs.dissipate_all_heat(campaign_id)
    mech_ids = [m["id"] for m in mechs.list_mechs(campaign_id)]
    return {"campaign_id": campaign_id, "mech_ids": mech_ids}


def _step_mech_shutdown(mech_id: int, dice: DiceSource) -> dict:
    """Handles BOTH the shutdown-avoid roll (mech not yet shut down, heat
    crossed a shutdown threshold) and the restart roll (mech already
    shut down, heat now below 30) — identical logic to what this module
    always ran per mech, just re-reading fresh mech state (dissipation
    already happened in _prepare_heat_phase; nothing else mutates this
    mech before this step runs) instead of a snapshot captured earlier
    in a shared loop. A no-op (`{}`, no dice consumed) when neither
    applies — most mechs most rounds."""
    mech = mechs.get_mech(mech_id)
    if mech["destroyed_reason"] is not None:
        return {}  # a wreck has nothing left to shut down or restart
    heat = mech["heat_current"]
    pilot_id = mech["pilot_id"]
    shutdown_triggered, shutdown_avoid_tn = _highest_bracket(heat, _SHUTDOWN_AVOID_TN)
    if mech["is_shutdown"]:
        if heat < 14:
            mechs.set_shutdown(mech_id, False)
            return {"restarted": True}
        if heat < 30:
            _, _, roll = dice.next_2d6("heat_restart", pilot_id)
            restarted = shutdown_avoid_tn is not None and roll >= shutdown_avoid_tn
            if restarted:
                mechs.set_shutdown(mech_id, False)
            return {"restarted": restarted}
        # heat >= 30: "heat must be below 30 before a restart can occur"
        # — stays shut down, no roll.
        return {"restarted": None}
    if shutdown_triggered:
        if shutdown_avoid_tn is None:
            mechs.set_shutdown(mech_id, True)
            return {"shutdown": True}
        _, _, roll = dice.next_2d6("heat_shutdown", pilot_id)
        avoided = roll >= shutdown_avoid_tn
        if not avoided:
            mechs.set_shutdown(mech_id, True)
        return {"shutdown": not avoided}
    return {}


def _step_mech_ammo(mech_id: int, dice: DiceSource) -> dict:
    mech = mechs.get_mech(mech_id)
    if mech["destroyed_reason"] is not None:
        return {"ammo_explosion": None}  # a wreck's ammo already cooked off (or never will)
    heat = mech["heat_current"]
    _, ammo_avoid_tn = _highest_bracket(heat, _AMMO_EXPLOSION_AVOID_TN)
    if ammo_avoid_tn is None:
        return {"ammo_explosion": None}
    _, _, roll = dice.next_2d6("heat_ammo_explosion", mech["pilot_id"])
    if roll < ammo_avoid_tn:
        ammo_bin = _pick_ammo_bin(mech)
        if ammo_bin:
            return {"ammo_explosion": criticals.explode_ammo_by_weapon(mech_id, ammo_bin["id"])}
    return {"ammo_explosion": None}


def _run_heat_step_fn(step: str, dice: DiceSource):
    kind, mech_id_str = step.split("_", 1)
    mech_id = int(mech_id_str)
    if kind == "shutdown":
        return _step_mech_shutdown(mech_id, dice)
    if kind == "ammo":
        return _step_mech_ammo(mech_id, dice)
    raise ValueError(step)


def _finalize_heat_phase(ctx: dict, committed: dict) -> dict:
    results = []
    for mech_id in ctx["mech_ids"]:
        mech = mechs.get_mech(mech_id)
        heat = mech["heat_current"]
        shutdown_result = committed.get(f"shutdown_{mech_id}", {})
        ammo_result = committed.get(f"ammo_{mech_id}", {})
        mech_result = {
            "mech_id": mech_id, "heat_current": heat,
            # The actual resulting state (mech["is_shutdown"], already
            # fresh — every _step_mech_shutdown mutation for this mech
            # already ran above), not just the transition flags below —
            # real user report: the frontend's own instant-patch effect
            # (GMView.tsx/TableView.tsx, applied the moment this broadcast
            # arrives, without waiting for a slower full mechs refetch)
            # had no unambiguous "is it shut down NOW" signal to read,
            # since shutdown=True/restarted=None/etc. only describe what
            # HAPPENED this phase, not the resulting boolean — so the
            # overheat tint stayed stale until some later, unrelated
            # refetch caught up.
            "is_shutdown": mech["is_shutdown"],
            # Same reasoning as is_shutdown above, for the OTHER way this
            # phase can kill a mech outright — an ammo-explosion severe
            # enough to zero CT/HD structure (mechs.apply_damage already
            # marks this by the time this function runs). Without it, a
            # heat-phase kill's explosion VFX (HexMap's own
            # MechExplosionOnce) waited on whatever LATER, unrelated
            # refetch happened to patch destroyed_reason in — sometimes
            # much later, reading as "no explosion at all".
            "destroyed_reason": mech["destroyed_reason"],
            "shutdown": shutdown_result.get("shutdown"), "restarted": shutdown_result.get("restarted"),
            "ammo_explosion": ammo_result.get("ammo_explosion"), "pilot_wound": None,
        }
        if mech["life_support_hit"] and mech["pilot_id"] is not None:
            wound_count = 2 if heat >= 26 else 1 if heat >= 15 else 0
            if wound_count:
                pilots.add_pilot_hits(mech["pilot_id"], wound_count)
                mech_result["pilot_wound"] = wound_count
        results.append(mech_result)
    return {"campaign_id": ctx["campaign_id"], "results": results}


def run_heat_phase(
    campaign_id: int, *, ctx: dict | None = None, committed: dict | None = None,
    collected: list | None = None, force_auto: bool = False,
) -> dict:
    """The Fase B driver — same shape as combat.py's run_attack/melee.py's
    run_melee_attack/psr.py's run_stand_up. Dissipates every mech's heat,
    then the Heat Scale's shutdown/restart, ammo-explosion, and life-
    support pilot-damage checks against the result — same order the
    rulebook specifies. Idempotent per round via bt_rounds.heat_resolved.
    Raises dice_resolution.PendingRoll if a step needs a real physical
    die — each mech's own pilot governs whether THEIR shutdown/ammo rolls
    pause, independent of every other mech's.

    Movement/to-hit penalties from heat (Heat Scale's other columns) are
    already live via movement.py's _heat_mp_penalty/combat.py's
    heat_penalty, reading heat_current directly — nothing to do here for
    those."""
    if ctx is None:
        prepared = _prepare_heat_phase(campaign_id)
        if prepared is None:
            return {"campaign_id": campaign_id, "results": [], "already_resolved": True}
        ctx = prepared
        committed = {}
        collected = []

    first = True
    for mech_id in ctx["mech_ids"]:
        for kind in ("shutdown", "ammo"):
            step = f"{kind}_{mech_id}"
            if step in committed:
                continue
            this_step_collected = collected if first else []
            first = False
            result = dice_resolution.run_step(
                lambda dice, _step=step: _run_heat_step_fn(_step, dice), this_step_collected,
                campaign_id=campaign_id, kind="heat_phase", step=step, ctx=ctx, committed=committed,
                force_auto=force_auto,
            )
            committed[step] = result

    return _finalize_heat_phase(ctx, committed)


def resolve_heat_phase(campaign_id: int) -> dict:
    """Old, fully synchronous entrypoint — ALWAYS instant (force_auto),
    kept 100% behavior-identical to before Fase B. See run_heat_phase for
    the physical-dice-aware entrypoint."""
    return run_heat_phase(campaign_id, force_auto=True)


def _get(conn, campaign_id: int, mode: str) -> dict:
    round_row = conn.execute(
        "SELECT round_number, heat_resolved FROM bt_rounds WHERE campaign_id = ?",
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
    passed_rows = conn.execute(
        "SELECT pilot_id, phase FROM bt_round_passed WHERE campaign_id = ? ORDER BY pilot_id",
        (campaign_id,),
    ).fetchall()
    ranged_passed_pilot_ids = [r["pilot_id"] for r in passed_rows if r["phase"] == "ranged"]
    melee_passed_pilot_ids = [r["pilot_id"] for r in passed_rows if r["phase"] == "melee"]

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
        ranged_target_pilot_ids = _pilots_with_ranged_targets(campaign_id, active_map_id)
        melee_target_pilot_ids = _pilots_with_melee_targets(campaign_id, active_map_id)

    return {
        "campaign_id": campaign_id,
        "round_number": round_row["round_number"] if round_row else 0,
        "mode": mode,
        "rolls": rolls,
        "acted_pilot_ids": [r["pilot_id"] for r in acted_rows],
        # Explicit "Pasar turno" per phase (real user request/report:
        # passing a target-less ranged turn was silently burning the SAME
        # pilot's melee turn too, since both used to share the one flat
        # acted_pilot_ids set above). A real attack still writes to
        # acted_pilot_ids (blocking both phases, the existing "can't
        # punch with an arm that fired" simplification) — these two are
        # ONLY for an explicit no-op pass, phase-scoped on purpose.
        "ranged_passed_pilot_ids": ranged_passed_pilot_ids,
        "melee_passed_pilot_ids": melee_passed_pilot_ids,
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
        # Whether resolve_heat_phase has already run for this round — the
        # frontend (GMView) calls that endpoint itself the instant it sees
        # ranged/melee both empty (rounds.ts's currentPhase reaching
        # 'other') and this is False, so a real shutdown/ammo-explosion/
        # heat-damage pass actually happens instead of the phase being
        # purely cosmetic. False for a round that hasn't started at all.
        "heat_resolved": bool(round_row["heat_resolved"]) if round_row else False,
        # Real user report: a mech added mid-round correctly never got
        # asked to move/attack (see _round_participant_pilot_ids), but the
        # frontend's own "needs initiative" red-tile check had no way to
        # know that and kept flagging them as missing a roll they were
        # never going to be allowed to use this round anyway. Exposed so
        # the frontend can exclude non-participants the same way it
        # already excludes destroyed pilots (rounds.ts's
        # pilotsNeedingInitiative).
        "participant_pilot_ids": sorted(_round_participant_pilot_ids(campaign_id)) if round_row and round_row["round_number"] > 0 else [],
    }
