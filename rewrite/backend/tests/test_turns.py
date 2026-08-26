"""ROADMAP.md S2 — simplified round/initiative tracking, not the full
5-phase Total Warfare turn (movement/weapon/physical/heat phases are
explicitly out of scope for v1, see the module docstring in
app/systems/battletech/turns.py for why).

Two initiative modes as of the follow-up: "team" (the real rule — one
2d6 per side) and "individual" (GM-selectable alternative — one 2d6 per
combat pilot), per campaign via campaigns.initiative_mode.
"""

from unittest.mock import patch

import pytest

from app import campaigns as campaigns_module
from app import events, maps
from app import units as units_module
from app.dice_source import RandomDice
from app.systems.battletech import mechs, pilots, turns
from tests.conftest import ATLAS_LOCATIONS


def _place(campaign_id: int, pilot_id: int, q: int = 0, r: int = 0) -> dict:
    """Real user report: a combat pilot with no real unit anywhere in the
    campaign is no longer snapshotted as a round participant (start_round
    itself now requires one — see its own doc comment on why: a pilot
    removed from the map, this round or an earlier one, kept coming back
    every subsequent start_round otherwise). Every movement_order test
    below needs each pilot to have at least a bare, mechless unit placed
    somewhere for that reason — this is the shared one-liner for it."""
    m = maps.create_map(campaign_id, f"Test Map {pilot_id}", width=6, height=6)
    return units_module.create_unit(campaign_id, m["id"], q=q, r=r, pilot_id=pilot_id)


def test_no_round_started_yet_reports_round_zero(campaign):
    state = turns.get_round(campaign["id"])
    assert state["round_number"] == 0
    assert state["rolls"] == []
    assert state["acted_pilot_ids"] == []


def test_starting_a_round_increments_round_number(campaign):
    state = turns.start_round(campaign["id"])
    assert state["round_number"] == 1
    second = turns.start_round(campaign["id"])
    assert second["round_number"] == 2


def test_starting_a_new_round_does_not_dissipate_heat(campaign):
    # Real user report: dissipation used to happen silently at the NEXT
    # round's start_round, before the Heat phase was even visible — moved
    # to resolve_heat_phase (see its own test below) so it happens
    # visibly DURING this round's own Heat phase instead.
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    mechs.add_heat(m["id"], 15)
    turns.start_round(campaign["id"])
    assert mechs.get_mech(m["id"])["heat_current"] == 15


def test_undo_round_started_restores_round_number(campaign):
    turns.start_round(campaign["id"])
    events.undo_last_event(campaign["id"])
    assert turns.get_round(campaign["id"])["round_number"] == 0


def test_undo_round_started_after_two_rounds_restores_the_second(campaign):
    turns.start_round(campaign["id"])
    turns.start_round(campaign["id"])
    assert turns.get_round(campaign["id"])["round_number"] == 2
    events.undo_last_event(campaign["id"])
    assert turns.get_round(campaign["id"])["round_number"] == 1


def test_undo_initiative_rolled_removes_only_that_pilot(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p1 = pilots.create_pilot(campaign["id"], "One", faction="player")
    p2 = pilots.create_pilot(campaign["id"], "Two", faction="enemy")
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], p1["id"], 7)
    turns.report_pilot_initiative(campaign["id"], p2["id"], 9)

    events.undo_last_event(campaign["id"])
    state = turns.get_round(campaign["id"])
    remaining_pilot_ids = {r["pilot_id"] for r in state["rolls"]}
    assert remaining_pilot_ids == {p1["id"]}


def test_team_mode_rolls_once_per_faction_present(campaign, pilot):
    # `pilot` fixture defaults to faction "player" — only one side present,
    # so only one roll, not a fixed two.
    state = turns.start_round(campaign["id"])
    assert state["mode"] == "team"
    assert len(state["rolls"]) == 1
    assert state["rolls"][0]["faction"] == "player"
    assert state["rolls"][0]["kind"] == "faction"
    assert 2 <= state["rolls"][0]["roll"] <= 12


def test_team_mode_rolls_once_per_side_with_both_factions_present(campaign, pilot):
    pilots.create_pilot(campaign["id"], "Hostile Leader", faction="enemy")
    state = turns.start_round(campaign["id"])
    assert len(state["rolls"]) == 2
    assert {r["faction"] for r in state["rolls"]} == {"player", "enemy"}


def test_npc_pilots_never_roll_initiative(campaign, pilot):
    pilots.create_pilot(campaign["id"], "Merchant", faction="npc")
    state = turns.start_round(campaign["id"])
    assert len(state["rolls"]) == 1  # only the player-faction roll, npc excluded
    assert all(r["faction"] != "npc" for r in state["rolls"])


def test_team_mode_ties_are_rerolled(campaign, pilot, monkeypatch):
    pilots.create_pilot(campaign["id"], "Hostile Leader", faction="enemy")
    scripted = iter([7, 7, 3, 9])  # first pair ties, second pair doesn't
    monkeypatch.setattr(turns, "_roll_2d6", lambda: next(scripted))
    state = turns.start_round(campaign["id"])
    rolls = {r["faction"]: r["roll"] for r in state["rolls"]}
    assert rolls != {"player": 7, "enemy": 7}
    assert set(rolls.values()) == {3, 9}


def test_individual_mode_starts_a_round_with_no_rolls_yet(campaign):
    # Team mode auto-rolls both sides the instant a round starts;
    # individual mode is manual now — each pilot's own physical dice
    # throw on the shared table reports its own via
    # report_pilot_initiative, so start_round itself yields nothing.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    for i in range(5):
        pilots.create_pilot(campaign["id"], f"Player {i}", faction="player")
    for i in range(3):
        pilots.create_pilot(campaign["id"], f"Enemy {i}", faction="enemy")
    pilots.create_pilot(campaign["id"], "Bystander", faction="npc")

    state = turns.start_round(campaign["id"])
    assert state["mode"] == "individual"
    assert state["round_number"] == 1
    assert state["rolls"] == []


def test_request_pilot_initiative_does_not_touch_rolls(campaign):
    # No server-side random number stand-in anymore — requesting just
    # validates and hands back what the caller needs to broadcast
    # "please physically throw dice for this pilot."
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player", color="#ff00aa")
    turns.start_round(campaign["id"])
    result = turns.request_pilot_initiative(campaign["id"], p["id"])
    assert result == {"pilot_id": p["id"], "pilot_name": "Solo", "color": "#ff00aa", "die_style": None}
    assert turns.get_round(campaign["id"])["rolls"] == []


def test_request_pilot_initiative_falls_back_to_gm_die_style_for_enemy_pilots(campaign):
    # Real user request: an enemy pilot has no device of its own to pick
    # a style from — the GM's own pick (set via campaigns.set_gm_die_style)
    # applies to enemy/npc rolls that haven't set one themselves.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    campaigns_module.set_gm_die_style(campaign["id"], "opal-pearl")
    enemy = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    turns.start_round(campaign["id"])
    result = turns.request_pilot_initiative(campaign["id"], enemy["id"])
    assert result["die_style"] == "opal-pearl"


def test_request_pilot_initiative_prefers_a_player_pilots_own_style_over_gm(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    campaigns_module.set_gm_die_style(campaign["id"], "opal-pearl")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    pilots.set_pilot_die_style(p["id"], "chrome-metallic")
    turns.start_round(campaign["id"])
    result = turns.request_pilot_initiative(campaign["id"], p["id"])
    assert result["die_style"] == "chrome-metallic"


def test_request_pilot_initiative_prefers_an_enemy_pilots_own_style_over_gm(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    campaigns_module.set_gm_die_style(campaign["id"], "opal-pearl")
    enemy = pilots.create_pilot(campaign["id"], "Hostile", faction="enemy")
    pilots.set_pilot_die_style(enemy["id"], "chrome-metallic")
    turns.start_round(campaign["id"])
    result = turns.request_pilot_initiative(campaign["id"], enemy["id"])
    assert result["die_style"] == "chrome-metallic"


def test_report_pilot_initiative_adds_one_pilot_roll(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    turns.start_round(campaign["id"])
    state = turns.report_pilot_initiative(campaign["id"], p["id"], 9)
    assert len(state["rolls"]) == 1
    assert state["rolls"][0]["pilot_id"] == p["id"]
    assert state["rolls"][0]["kind"] == "pilot"
    assert state["rolls"][0]["roll"] == 9


def test_report_pilot_initiative_is_idempotent(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    turns.start_round(campaign["id"])
    first = turns.report_pilot_initiative(campaign["id"], p["id"], 5)
    second = turns.report_pilot_initiative(campaign["id"], p["id"], 11)  # must not overwrite
    assert first["rolls"] == second["rolls"]
    assert len(second["rolls"]) == 1
    assert second["rolls"][0]["roll"] == 5


def test_report_pilot_initiative_rejects_out_of_range_roll(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    turns.start_round(campaign["id"])
    with pytest.raises(turns.InvalidRollValue):
        turns.report_pilot_initiative(campaign["id"], p["id"], 13)
    with pytest.raises(turns.InvalidRollValue):
        turns.report_pilot_initiative(campaign["id"], p["id"], 1)


def test_request_and_report_pilot_initiative_reject_npc_pilot(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    npc = pilots.create_pilot(campaign["id"], "Merchant", faction="npc")
    turns.start_round(campaign["id"])
    with pytest.raises(turns.UnknownCombatPilot):
        turns.request_pilot_initiative(campaign["id"], npc["id"])
    with pytest.raises(turns.UnknownCombatPilot):
        turns.report_pilot_initiative(campaign["id"], npc["id"], 7)


def test_request_and_report_pilot_initiative_reject_team_mode(campaign, pilot):
    turns.start_round(campaign["id"])  # default mode is "team"
    with pytest.raises(turns.WrongInitiativeMode):
        turns.request_pilot_initiative(campaign["id"], pilot["id"])
    with pytest.raises(turns.WrongInitiativeMode):
        turns.report_pilot_initiative(campaign["id"], pilot["id"], 7)


def test_request_and_report_pilot_initiative_reject_before_round_started(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    with pytest.raises(turns.RoundNotStarted):
        turns.request_pilot_initiative(campaign["id"], p["id"])
    with pytest.raises(turns.RoundNotStarted):
        turns.report_pilot_initiative(campaign["id"], p["id"], 7)


def test_individual_mode_rolls_are_sorted_lowest_first(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert [r["roll"] for r in state["rolls"]] == [3, 9]


def test_marking_a_pilot_acted_is_reflected_in_round_state(campaign, pilot):
    turns.start_round(campaign["id"])
    state = turns.mark_acted(campaign["id"], pilot["id"])
    assert state["acted_pilot_ids"] == [pilot["id"]]


def test_marking_the_same_pilot_acted_twice_does_not_duplicate(campaign, pilot):
    turns.start_round(campaign["id"])
    turns.mark_acted(campaign["id"], pilot["id"])
    state = turns.mark_acted(campaign["id"], pilot["id"])
    assert state["acted_pilot_ids"] == [pilot["id"]]


def test_starting_a_new_round_clears_who_has_acted_and_prior_rolls(campaign, pilot):
    turns.start_round(campaign["id"])
    turns.mark_acted(campaign["id"], pilot["id"])
    state = turns.start_round(campaign["id"])
    assert state["acted_pilot_ids"] == []
    assert len(state["rolls"]) == 1  # fresh roll for this round, not stacked


def test_pass_phase_is_reflected_in_round_state_and_scoped_to_that_phase(campaign, pilot):
    turns.start_round(campaign["id"])
    state = turns.pass_phase(campaign["id"], pilot["id"], "ranged")
    assert state["ranged_passed_pilot_ids"] == [pilot["id"]]
    assert state["melee_passed_pilot_ids"] == []
    assert state["acted_pilot_ids"] == [], "an explicit pass is NOT a real attack"


def test_pass_phase_the_same_pilot_twice_does_not_duplicate(campaign, pilot):
    turns.start_round(campaign["id"])
    turns.pass_phase(campaign["id"], pilot["id"], "ranged")
    state = turns.pass_phase(campaign["id"], pilot["id"], "ranged")
    assert state["ranged_passed_pilot_ids"] == [pilot["id"]]


def test_undo_pass_phase_removes_only_that_pilots_pass(campaign, pilot):
    p2 = pilots.create_pilot(campaign["id"], "Other", faction="player")
    turns.start_round(campaign["id"])
    turns.pass_phase(campaign["id"], pilot["id"], "ranged")
    turns.pass_phase(campaign["id"], p2["id"], "ranged")

    undone = events.undo_last_event(campaign["id"])
    assert undone["event_type"] == "phase_passed"
    state = turns.get_round(campaign["id"])
    assert state["ranged_passed_pilot_ids"] == [pilot["id"]]


def test_undo_mark_acted_with_no_attacks_logged_just_clears_the_turn_state(campaign, pilot):
    # mark_acted can be called with zero prior attack/melee events (e.g. a
    # narrative "count this pilot as having acted" from the GM) — its own
    # undo shouldn't error just because there's nothing to cascade over.
    turns.start_round(campaign["id"])
    turns.mark_acted(campaign["id"], pilot["id"])
    assert pilot["id"] in turns.get_round(campaign["id"])["acted_pilot_ids"]

    undone = events.undo_last_event(campaign["id"])
    assert undone["event_type"] == "turn_acted"
    assert pilot["id"] not in turns.get_round(campaign["id"])["acted_pilot_ids"]


def test_pass_phase_rejects_an_unknown_phase(campaign, pilot):
    turns.start_round(campaign["id"])
    with pytest.raises(turns.InvalidPassPhase):
        turns.pass_phase(campaign["id"], pilot["id"], "movement")


def test_starting_a_new_round_clears_prior_passes(campaign, pilot):
    turns.start_round(campaign["id"])
    turns.pass_phase(campaign["id"], pilot["id"], "ranged")
    state = turns.start_round(campaign["id"])
    assert state["ranged_passed_pilot_ids"] == []


def test_round_state_is_scoped_per_campaign(campaign, pilot):
    other_campaign = campaigns_module.create_campaign("Other Campaign")
    turns.start_round(campaign["id"])
    turns.mark_acted(campaign["id"], pilot["id"])
    other_state = turns.get_round(other_campaign["id"])
    assert other_state["round_number"] == 0
    assert other_state["rolls"] == []
    assert other_state["acted_pilot_ids"] == []


def test_report_pilot_initiative_has_no_active_modifiers_yet(campaign):
    # No initiative modifier is confirmed as an official Total Warfare
    # rule yet (see turns.py's _initiative_modifiers docstring) — the
    # breakdown infrastructure exists, but every roll's modifier_total is
    # 0 and total equals the raw physics roll until a real one is added.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    p = pilots.create_pilot(campaign["id"], "Solo", faction="player")
    turns.start_round(campaign["id"])
    state = turns.report_pilot_initiative(campaign["id"], p["id"], 7)
    roll = state["rolls"][0]
    assert roll["modifiers"] == []
    assert roll["modifier_total"] == 0
    assert roll["total"] == 7


def test_rolls_are_ordered_by_total_not_raw_roll(campaign, monkeypatch):
    # With a modifier active, ordering must follow the modified total —
    # this pins that behavior down even though no real modifier ships
    # yet, so a future one can't silently break turn order.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    turns.start_round(campaign["id"])
    monkeypatch.setattr(
        turns, "_initiative_modifiers",
        lambda pilot, mech: [{"label": "Test", "value": 5}] if pilot["id"] == a["id"] else [],
    )
    turns.report_pilot_initiative(campaign["id"], a["id"], 3)  # total 8 (3 + 5)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 4)  # total 4, no modifier
    assert [r["pilot_id"] for r in state["rolls"]] == [b["id"], a["id"]]


def test_movement_order_is_empty_until_everyone_who_will_roll_has_rolled(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    pilots.create_pilot(campaign["id"], "B", faction="enemy")
    turns.start_round(campaign["id"])
    state = turns.report_pilot_initiative(campaign["id"], a["id"], 7)
    assert state["movement_order"] == []


def test_movement_order_starts_once_everyone_has_rolled_lowest_total_first(campaign):
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    _place(campaign["id"], a["id"])
    _place(campaign["id"], b["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert state["movement_order"] == [b["id"], a["id"]]
    assert state["moved_pilot_ids"] == []


def test_changing_initiative_mode_mid_round_does_not_affect_that_round(campaign):
    # Real user report: switching team<->individual mid-round changed how
    # the ALREADY-IN-PROGRESS round's rolls were interpreted immediately.
    # start_round freezes the mode into bt_rounds; a change afterward must
    # only take effect on the NEXT start_round.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    _place(campaign["id"], a["id"])
    _place(campaign["id"], b["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)

    # GM flips the campaign setting to team mode mid-round.
    campaigns_module.set_initiative_mode(campaign["id"], "team")

    # This round must still behave as individual — b can still roll their
    # own initiative (would raise WrongInitiativeMode if the live 'team'
    # setting leaked in), and the state still reports 'individual'.
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert state["mode"] == "individual"
    assert state["movement_order"] == [b["id"], a["id"]]

    # Only the NEXT round actually switches to team mode.
    next_state = turns.start_round(campaign["id"])
    assert next_state["mode"] == "team"


def test_pilot_added_mid_round_cannot_act_until_the_next_round(campaign):
    # Real user report: "si se mete un nuevo mech en mitad de un combate,
    # debe poder tirar iniciativa y empezar a actuar en el SIGUIENTE
    # turno" — a pilot created AFTER start_round wasn't snapshotted into
    # bt_round_participants, so they must stay out of THIS round's
    # movement_order entirely (team mode: without this fix they'd become
    # eligible immediately; individual mode: they'd never have a roll,
    # permanently blanking movement_order for everyone else too).
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    _place(campaign["id"], a["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 7)
    mid_round_state = turns.get_round(campaign["id"])
    assert mid_round_state["movement_order"] == [a["id"]]

    # A new pilot joins (pilot AND a real unit both created) after the
    # round already started.
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    _place(campaign["id"], b["id"])
    still_mid_round_state = turns.get_round(campaign["id"])
    assert still_mid_round_state["movement_order"] == [a["id"]]

    # Only the NEXT round includes B.
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    final_state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert final_state["movement_order"] == [b["id"], a["id"]]


def test_removing_a_pilots_unit_mid_round_unblocks_movement_order(campaign):
    # Real user report: "se queda la ronda bloqueada esperando iniciativas
    # de mechs que he quitado de la partida 'quitar de la mesa'" — a pilot
    # removed from the map mid-round (main.py's DELETE /api/units/{id})
    # stayed stuck in this round's own bt_round_participants snapshot
    # forever, blocking movement_order on a turn nobody could ever give.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    _place(campaign["id"], a["id"])
    unit_b = _place(campaign["id"], b["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert state["movement_order"] == [b["id"], a["id"]]

    # B's unit is removed from the map mid-round — main.py's endpoint
    # would call units.delete_unit then this, in that order.
    units_module.delete_unit(unit_b["id"])
    turns.remove_participant(campaign["id"], b["id"])
    after = turns.get_round(campaign["id"])
    assert after["movement_order"] == [a["id"]]


def test_movement_order_excludes_a_pilot_whose_mech_is_already_destroyed(campaign):
    # Fase D: a destroyed mech can't move (movement.execute_move's own
    # MechIncapacitated) — if its pilot stayed in movement_order, the
    # phase would stall forever waiting on a turn that can never resolve.
    # B rolls VALIDLY while still alive, then is destroyed afterward
    # (simulating dying later the same round — a real ranged/melee kill
    # doesn't happen until after movement, but round state can be
    # recomputed/re-fetched at any point after that) — this is also the
    # regression test for the subset-vs-exact-equality fix movement_order
    # needed: requiring every combat pilot's CURRENT roll set to exactly
    # match movement_order's own (now smaller, post-death) pilot set
    # would incorrectly blank movement_order out to [] the instant B died,
    # even though A's own turn was already valid and complete.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    mech_b = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Wreck", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=b["id"], locations=ATLAS_LOCATIONS,
    )
    _place(campaign["id"], a["id"])
    _place(campaign["id"], b["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    mechs.mark_destroyed(mech_b["id"], "structural")
    state = turns.get_round(campaign["id"])
    assert state["movement_order"] == [a["id"]]
    assert state["moved_pilot_ids"] == []


def test_destroyed_pilot_cannot_roll_initiative(campaign):
    # Real user report: "los muertos no deberían tirar iniciativas" — a
    # destroyed mech's pilot has nothing left to roll for, ever again.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="enemy")
    mech_a = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Wreck", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=a["id"], locations=ATLAS_LOCATIONS,
    )
    mechs.mark_destroyed(mech_a["id"], "structural")
    turns.start_round(campaign["id"])
    with pytest.raises(turns.PilotIsDestroyed):
        turns.report_pilot_initiative(campaign["id"], a["id"], 7)
    with pytest.raises(turns.PilotIsDestroyed):
        turns.request_pilot_initiative(campaign["id"], a["id"])


def test_movement_order_excludes_a_pilot_whose_mech_is_shutdown(campaign):
    # Real user report: "los mechs sobrecalentados pasan automaticamente
    # su turno de movimiento" — a shutdown mech can't move
    # (movement.execute_move's own MechIncapacitated), so it needs the
    # exact same movement_order exclusion as a destroyed mech (Fase D),
    # just for a recoverable state instead of a permanent one — restarting
    # next Heat Phase makes them reappear here on their own, no special
    # handling needed.
    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="enemy")
    mech_b = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Overheated", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=b["id"], locations=ATLAS_LOCATIONS,
    )
    mechs.set_shutdown(mech_b["id"], True)
    _place(campaign["id"], a["id"])
    _place(campaign["id"], b["id"])
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert state["movement_order"] == [a["id"]]


def test_movement_order_in_team_mode_groups_by_side_total(campaign):
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="player")
    c = pilots.create_pilot(campaign["id"], "C", faction="enemy")
    _place(campaign["id"], a["id"])
    _place(campaign["id"], b["id"])
    _place(campaign["id"], c["id"])
    # factions_present is alphabetically sorted ("enemy" before "player"),
    # so _roll_2d6 is called for enemy first, then player.
    with patch.object(turns, "_roll_2d6", side_effect=[2, 10]):
        state = turns.start_round(campaign["id"])
    # player side rolled higher (10) than enemy (2) — enemy pilots move
    # first, but there's only one; player pilots follow, ordered by
    # pilot_id (same tie-break individual mode already uses).
    assert state["movement_order"][0] not in (a["id"], b["id"])
    assert state["movement_order"][1:] == [a["id"], b["id"]]


def test_starting_a_new_round_clears_prior_movement(campaign, pilot, monkeypatch):
    from app.systems.battletech import mechs, movement
    from app import maps, units as units_module
    from tests.conftest import ATLAS_LOCATIONS

    m = maps.create_map(campaign["id"], "Flat", width=6, height=6)
    mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Locust", tonnage=20, walk_mp=4, run_mp=6,
        pilot_id=pilot["id"], locations=ATLAS_LOCATIONS,
    )
    unit = units_module.create_unit(campaign["id"], m["id"], q=0, r=0, mech_id=mech["id"], pilot_id=pilot["id"])
    turns.start_round(campaign["id"])
    movement.execute_move(campaign["id"], unit["id"], 2, 0, "walk")
    assert turns.get_round(campaign["id"])["moved_pilot_ids"] == [pilot["id"]]

    state = turns.start_round(campaign["id"])
    assert state["moved_pilot_ids"] == []
    assert state["moves"] == []


def test_marking_a_pilot_from_a_different_campaign_acted_is_independent(campaign, pilot):
    other_campaign = campaigns_module.create_campaign("Other Campaign")
    other_pilot = pilots.create_pilot(other_campaign["id"], "Someone Else")
    turns.start_round(campaign["id"])
    turns.start_round(other_campaign["id"])
    turns.mark_acted(campaign["id"], pilot["id"])
    turns.mark_acted(other_campaign["id"], other_pilot["id"])
    assert turns.get_round(campaign["id"])["acted_pilot_ids"] == [pilot["id"]]
    assert turns.get_round(other_campaign["id"])["acted_pilot_ids"] == [other_pilot["id"]]


# ---- ranged/melee target gating ("se activa sola... solo si algún mech
# tiene alcance y en LoS algún mech al que pueda atacar") -----------------


def _two_mechs_movement_complete(campaign, distance_apart, weapon=None):
    """Individual-mode round, both pilots rolled and moved (so
    movement_order is fully covered — the precondition for
    ranged_target_pilot_ids/melee_target_pilot_ids to compute at all) —
    two mechs `distance_apart` hexes apart on a flat, empty map, attacker
    optionally carrying one weapon."""
    from app import campaigns as campaigns_module, maps, units as units_module
    from app.systems.battletech import movement

    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    attacker_pilot = pilots.create_pilot(campaign["id"], "Attacker", faction="player")
    target_pilot = pilots.create_pilot(campaign["id"], "Target", faction="enemy")
    m = maps.create_map(campaign["id"], "Range Test", width=20, height=6)
    campaigns_module.set_active_map(campaign["id"], m["id"])
    attacker_mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=attacker_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    target_mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Target", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=target_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    if weapon:
        mechs.add_weapon(attacker_mech["id"], weapon, "RT")
    attacker_unit = units_module.create_unit(
        campaign["id"], m["id"], q=0, r=0, mech_id=attacker_mech["id"], pilot_id=attacker_pilot["id"],
    )
    units_module.create_unit(
        campaign["id"], m["id"], q=distance_apart, r=0, mech_id=target_mech["id"], pilot_id=target_pilot["id"],
        facing_deg=180,
    )

    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], attacker_pilot["id"], 5)
    turns.report_pilot_initiative(campaign["id"], target_pilot["id"], 8)
    # Both pilots must show up in moved_pilot_ids for movement_order to be
    # considered fully covered — a 0-hex "move" (turn in place) still
    # counts as this pilot's move for the round.
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "walk")
    movement.execute_move(
        campaign["id"], next(u for u in units_module.list_units(m["id"]) if u["pilot_id"] == target_pilot["id"])["id"],
        distance_apart, 0, "walk",
    )
    return attacker_pilot, target_pilot


def test_ranged_target_pilot_ids_empty_before_movement_finishes(campaign):
    from app import campaigns as campaigns_module, maps, units as units_module

    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    pilots.create_pilot(campaign["id"], "B", faction="enemy")
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 5)
    # B hasn't rolled yet -> movement_order is still empty.
    state = turns.get_round(campaign["id"])
    assert state["ranged_target_pilot_ids"] == []
    assert state["melee_target_pilot_ids"] == []


def test_ranged_target_pilot_ids_empty_when_no_weapon_in_range(campaign):
    _two_mechs_movement_complete(campaign, distance_apart=10, weapon="Small Laser")  # long range 3
    state = turns.get_round(campaign["id"])
    assert state["ranged_target_pilot_ids"] == []


def test_ranged_target_pilot_ids_populated_when_a_weapon_is_in_range(campaign):
    attacker_pilot, _ = _two_mechs_movement_complete(campaign, distance_apart=5, weapon="Medium Laser")  # long range 9
    state = turns.get_round(campaign["id"])
    assert state["ranged_target_pilot_ids"] == [attacker_pilot["id"]]


def test_ranged_target_pilot_ids_excludes_a_shutdown_attacker(campaign):
    # Real user report: "los mechs sobrecalentados... pasan
    # automaticamente su turno... de ataques" — combat.py already refuses
    # to fire for a shutdown mech, this is the matching exclusion so the
    # ranged phase doesn't stall waiting for them to act.
    attacker_pilot, _ = _two_mechs_movement_complete(campaign, distance_apart=5, weapon="Medium Laser")
    attacker_mech = next(m for m in mechs.list_mechs(campaign["id"]) if m["pilot_id"] == attacker_pilot["id"])
    mechs.set_shutdown(attacker_mech["id"], True)
    state = turns.get_round(campaign["id"])
    assert state["ranged_target_pilot_ids"] == []


def test_ranged_target_pilot_ids_empty_without_ammo(campaign):
    from app.systems.battletech import mechs as mechs_module

    attacker_pilot, _ = _two_mechs_movement_complete(campaign, distance_apart=2, weapon="AC/20")
    mech = mechs_module.get_mech(next(
        m for m in mechs_module.list_mechs(campaign["id"]) if m["pilot_id"] == attacker_pilot["id"]
    )["id"])
    mechs_module.use_ammo(mech["weapons"][0]["id"])
    for _ in range(4):
        mechs_module.use_ammo(mech["weapons"][0]["id"])
    state = turns.get_round(campaign["id"])
    assert state["ranged_target_pilot_ids"] == []


def test_melee_target_pilot_ids_empty_when_not_adjacent(campaign):
    _two_mechs_movement_complete(campaign, distance_apart=2)
    state = turns.get_round(campaign["id"])
    assert state["melee_target_pilot_ids"] == []


def test_melee_target_pilot_ids_populated_when_adjacent(campaign):
    attacker_pilot, target_pilot = _two_mechs_movement_complete(campaign, distance_apart=1)
    state = turns.get_round(campaign["id"])
    assert set(state["melee_target_pilot_ids"]) == {attacker_pilot["id"], target_pilot["id"]}


def test_melee_target_pilot_ids_populated_even_when_target_is_outside_facing_arc(campaign):
    # Real user report: the melee phase was skipped even with an enemy
    # standing right next to the mech, whenever that enemy happened to be
    # outside the attacker's 180° facing cone. melee.py's
    # resolve_melee_attack itself never checks facing — only adjacency +
    # LOS — so the phase-gating check must match that, not the stricter
    # facing-cone rule visible_enemies_from_unit applies by default for
    # the FPV "what do I see" HUD.
    from app import campaigns as campaigns_module, maps, units as units_module
    from app.systems.battletech import movement

    campaigns_module.set_initiative_mode(campaign["id"], "individual")
    attacker_pilot = pilots.create_pilot(campaign["id"], "Attacker", faction="player")
    target_pilot = pilots.create_pilot(campaign["id"], "Target", faction="enemy")
    m = maps.create_map(campaign["id"], "Facing Test", width=6, height=6)
    campaigns_module.set_active_map(campaign["id"], m["id"])
    attacker_mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Attacker", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=attacker_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    target_mech = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Target", tonnage=50, walk_mp=4, run_mp=6,
        pilot_id=target_pilot["id"], locations=ATLAS_LOCATIONS,
    )
    # Attacker faces AWAY from the target (target sits at +q, attacker
    # faces toward -q) — squarely behind, outside any 180° front cone.
    attacker_unit = units_module.create_unit(
        campaign["id"], m["id"], q=0, r=0, mech_id=attacker_mech["id"], pilot_id=attacker_pilot["id"],
        facing_deg=180,
    )
    target_unit = units_module.create_unit(
        campaign["id"], m["id"], q=1, r=0, mech_id=target_mech["id"], pilot_id=target_pilot["id"],
    )

    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], attacker_pilot["id"], 5)
    turns.report_pilot_initiative(campaign["id"], target_pilot["id"], 8)
    movement.execute_move(campaign["id"], attacker_unit["id"], 0, 0, "walk")
    movement.execute_move(campaign["id"], target_unit["id"], 1, 0, "walk")

    state = turns.get_round(campaign["id"])
    assert set(state["melee_target_pilot_ids"]) == {attacker_pilot["id"], target_pilot["id"]}


# ---- Heat Phase -----------------------------------------------------------


def test_resolve_heat_phase_is_idempotent(campaign):
    turns.start_round(campaign["id"])
    first = turns.resolve_heat_phase(campaign["id"])
    assert first.get("already_resolved") is not True
    second = turns.resolve_heat_phase(campaign["id"])
    assert second["already_resolved"] is True
    assert second["results"] == []


def test_resolve_heat_phase_reflects_in_round_state(campaign):
    turns.start_round(campaign["id"])
    assert turns.get_round(campaign["id"])["heat_resolved"] is False
    turns.resolve_heat_phase(campaign["id"])
    assert turns.get_round(campaign["id"])["heat_resolved"] is True


def test_starting_a_new_round_resets_heat_resolved(campaign):
    turns.start_round(campaign["id"])
    turns.resolve_heat_phase(campaign["id"])
    turns.start_round(campaign["id"])
    assert turns.get_round(campaign["id"])["heat_resolved"] is False


def test_resolve_heat_phase_dissipates_heat_for_every_mech(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    mechs.add_heat(m["id"], 15)
    turns.start_round(campaign["id"])
    result = turns.resolve_heat_phase(campaign["id"])
    assert mechs.get_mech(m["id"])["heat_current"] == 5  # 15 - 10 heat sinks
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["heat_current"] == 5, "result payload reflects the POST-dissipation value"


def test_resolve_heat_phase_shuts_down_at_30_with_no_roll_needed(campaign):
    # heat_sinks=0 so this test's exact heat value isn't muddied by
    # resolve_heat_phase's own dissipation (see the dedicated
    # dissipation test above) — this one is purely about threshold
    # behavior at a known heat value.
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Overheated", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=0,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 30)
    result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["shutdown"] is True
    assert mechs.get_mech(m["id"])["is_shutdown"] is True
    # Real user report: the frontend's own instant-patch effect had no
    # unambiguous "is it shut down NOW" signal before this field existed
    # (shutdown=True only describes the transition, not the resulting
    # state) — the overheat tint stayed stale until some later refetch.
    assert mech_result["is_shutdown"] is True


def test_resolve_heat_phase_below_14_never_shuts_down(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Cool", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 13)
    result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["shutdown"] is None
    assert mechs.get_mech(m["id"])["is_shutdown"] is False


def test_resolve_heat_phase_restarts_automatically_below_14(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Cooling", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS,
    )
    mechs.set_shutdown(m["id"], True)
    turns.start_round(campaign["id"])  # heat_current stays 0, well below 14
    result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["restarted"] is True
    assert mechs.get_mech(m["id"])["is_shutdown"] is False


def test_resolve_heat_phase_shutdown_avoid_roll_uses_the_highest_threshold_crossed(campaign):
    # Heat 26 crosses both the 14 and 26 shutdown brackets in one go — the
    # rulebook rolls once against the HIGHEST (avoid on 10+), not the 14
    # bracket's easier avoid-on-4+. A rigged roll of 9 avoids the 14
    # bracket's TN but must still fail the real (10+) check.
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="VeryHot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=0,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 26)
    with patch.object(RandomDice, "next_2d6", return_value=(4, 5, 9)):
        result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["shutdown"] is True
    assert mechs.get_mech(m["id"])["is_shutdown"] is True


def test_resolve_heat_phase_shutdown_avoided_on_a_successful_roll(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Lucky", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=0,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 14)  # avoid on 4+
    with patch.object(RandomDice, "next_2d6", return_value=(2, 2, 4)):
        result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["shutdown"] is False
    assert mechs.get_mech(m["id"])["is_shutdown"] is False


def test_resolve_heat_phase_ammo_explosion_wounds_pilot_and_zeroes_ammo(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Loaded", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], heat_sinks=0,
    )
    mechs.add_weapon(m["id"], "SRM 6", "RT")
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 19)  # ammo-explosion bracket only (avoid on 4+), below the 22 shutdown bracket
    with patch.object(RandomDice, "next_2d6", return_value=(1, 1, 2)):  # fails every avoid roll
        result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["ammo_explosion"] is not None
    assert pilots.get_pilot(pilot["id"])["hits"] == 2
    assert mechs.get_mech(m["id"])["weapons"][0]["ammo_remaining"] == 0


def test_resolve_heat_phase_ammo_explosion_avoided_deals_no_damage(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Loaded", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], heat_sinks=0,
    )
    mechs.add_weapon(m["id"], "SRM 6", "RT")
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 19)
    with patch.object(RandomDice, "next_2d6", return_value=(6, 6, 12)):  # comfortably beats the avoid-4+ TN
        result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["ammo_explosion"] is None
    assert pilots.get_pilot(pilot["id"])["hits"] == 0


def test_resolve_heat_phase_life_support_damage_scales_with_heat(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Cooked", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], heat_sinks=0,
    )
    from app.systems.battletech import criticals
    criticals.apply_critical_effects(m["id"], [{"location": "HD", "slot_index": 0, "item_name": "Life Support"}])
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 16)  # in the 15-25 bracket (1 wound), not 26+
    with patch.object(RandomDice, "next_2d6", return_value=(6, 6, 12)):  # avoid every shutdown/ammo roll cleanly
        result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["pilot_wound"] == 1
    assert pilots.get_pilot(pilot["id"])["hits"] == 1


def test_resolve_heat_phase_no_pilot_wound_without_life_support_hit(campaign, pilot):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot But Intact", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"],
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 30)
    result = turns.resolve_heat_phase(campaign["id"])
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["pilot_wound"] is None
    assert pilots.get_pilot(pilot["id"])["hits"] == 0


def test_run_heat_phase_never_pauses_for_an_auto_mode_pilot(campaign, pilot):
    pilots.update_pilot(pilot["id"], dice_mode="auto")
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], heat_sinks=0,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 18)  # in the shutdown-avoid bracket
    result = turns.run_heat_phase(campaign["id"])
    assert result["results"]  # proves it fully resolved, no PendingRoll


def test_run_heat_phase_pauses_for_a_physical_pilot_and_resumes_to_a_full_result(campaign, pilot):
    # dice_mode defaults to 'physical' — the pilot fixture never overrides
    # it. Heat 18 needs a real shutdown-avoid roll (TN 6) and, since this
    # mech has no ammo weapon, no ammo-explosion roll — one pause only.
    from app import dice_resolution

    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, pilot_id=pilot["id"], heat_sinks=0,
    )
    turns.start_round(campaign["id"])
    mechs.add_heat(m["id"], 18)

    ctx = committed = collected = None
    result = None
    purposes_seen = []
    for _ in range(10):
        try:
            result = (
                turns.run_heat_phase(campaign["id"]) if ctx is None
                else turns.run_heat_phase(campaign["id"], ctx=ctx, committed=committed, collected=collected)
            )
            break
        except dice_resolution.PendingRoll as exc:
            purposes_seen.append(exc.purpose)
            assert exc.pilot_id == pilot["id"]
            pending = dice_resolution.get_pending(exc.pending_roll_id)
            dice_resolution.delete_pending(exc.pending_roll_id)
            ctx, committed = pending["ctx"], pending["committed"]
            collected = pending["collected"] + [(pending["next_purpose"], [1, 1])]  # guaranteed fail (TN 6)

    assert result is not None
    assert purposes_seen == ["heat_shutdown"]
    mech_result = next(r for r in result["results"] if r["mech_id"] == m["id"])
    assert mech_result["shutdown"] is True
    assert mechs.get_mech(m["id"])["is_shutdown"] is True


def test_run_heat_phase_short_circuits_when_already_resolved_this_round(campaign):
    turns.start_round(campaign["id"])
    turns.run_heat_phase(campaign["id"])
    result = turns.run_heat_phase(campaign["id"])
    assert result == {"campaign_id": campaign["id"], "results": [], "already_resolved": True}
