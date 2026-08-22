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
from app import mechs, pilots
from app.systems.battletech import turns
from tests.conftest import ATLAS_LOCATIONS


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


def test_starting_a_new_round_dissipates_heat_for_every_mech(campaign):
    m = mechs.create_mech(
        campaign_id=campaign["id"], chassis="Hot", tonnage=50, walk_mp=4, run_mp=6,
        locations=ATLAS_LOCATIONS, heat_sinks=10,
    )
    mechs.add_heat(m["id"], 15)
    turns.start_round(campaign["id"])
    assert mechs.get_mech(m["id"])["heat_current"] == 5  # 15 - 10 heat sinks


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
    assert result == {"pilot_id": p["id"], "pilot_name": "Solo", "color": "#ff00aa"}
    assert turns.get_round(campaign["id"])["rolls"] == []


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
    turns.start_round(campaign["id"])
    turns.report_pilot_initiative(campaign["id"], a["id"], 9)
    state = turns.report_pilot_initiative(campaign["id"], b["id"], 3)
    assert state["movement_order"] == [b["id"], a["id"]]
    assert state["moved_pilot_ids"] == []


def test_movement_order_in_team_mode_groups_by_side_total(campaign):
    a = pilots.create_pilot(campaign["id"], "A", faction="player")
    b = pilots.create_pilot(campaign["id"], "B", faction="player")
    pilots.create_pilot(campaign["id"], "C", faction="enemy")
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
    from app.systems.battletech import movement
    from app import maps, mechs, units as units_module
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


def test_ranged_target_pilot_ids_empty_without_ammo(campaign):
    from app import mechs as mechs_module

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
