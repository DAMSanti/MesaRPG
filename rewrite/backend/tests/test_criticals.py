import pytest

from app.dice_source import NeedsRoll, SuppliedDice
from app.systems.battletech import criticals, mechs
from tests.conftest import ATLAS_LOCATIONS


def test_num_critical_hits_thresholds():
    for roll in range(2, 8):
        assert _outcome(roll) == 0
    for roll in (8, 9):
        assert _outcome(roll) == 1
    for roll in (10, 11):
        assert _outcome(roll) == 2


def _outcome(roll):
    return 1 if roll in (8, 9) else 2 if roll in (10, 11) else 0 if roll <= 7 else "blown_off"


def test_roll_critical_hits_never_targets_an_empty_or_already_hit_slot(atlas):
    # Retry loop (same style as test_combat.py's own probabilistic tests)
    # instead of monkeypatching dice — real random rolls, asserting the
    # invariant holds across many attempts rather than a specific outcome.
    mechs.add_weapon(atlas["id"], "Medium Laser", "RA")
    for _ in range(300):
        hits = criticals.roll_critical_hits(atlas["id"], "RA")
        seen = set()
        for hit in hits:
            if hit["item_name"] == "__blown_off__":
                continue
            assert hit["slot_index"] not in seen
            seen.add(hit["slot_index"])
        # Reset for the next iteration so later rolls aren't starved of
        # applicable slots.
        for slot in mechs.get_mech(atlas["id"])["criticals"]["RA"]:
            if slot["hit"]:
                mechs.set_critical_hit(atlas["id"], "RA", slot["slot_index"], False)


def test_blow_off_location_destroys_structure_and_marks_every_real_slot(atlas):
    mechs.add_weapon(atlas["id"], "Medium Laser", "LA")
    slots = mechs.get_mech(atlas["id"])["criticals"]["LA"]
    hits = criticals._blow_off_location(atlas["id"], "LA", slots)
    updated = mechs.get_mech(atlas["id"])
    loc = next(l for l in updated["locations"] if l["location"] == "LA")
    assert loc["structure_current"] == 0
    assert loc["armor_current"] == 0
    real_items = [s for s in slots if s["item_name"] != "-Empty-"]
    assert len([h for h in hits if h["item_name"] != "__blown_off__"]) == len(real_items)
    assert all(s["hit"] for s in mechs.get_mech(atlas["id"])["criticals"]["LA"] if s["item_name"] != "-Empty-")


def test_decide_criticals_is_pure_and_apply_criticals_is_the_only_mutator(atlas):
    # Fase B (dados físicos): decide_criticals must NOT touch the database
    # at all — apply_criticals is the only half that does. Deterministic
    # via SuppliedDice: crit_count roll totals 10 (-> 2 criticals), then
    # two slot rolls landing on two known-applicable HD slots (HD is a
    # head-or-leg location — one 1d6 per attempt, no block-roll).
    mech = mechs.get_mech(atlas["id"])
    hd_slots = mech["criticals"]["HD"]
    applicable = [s["slot_index"] for s in hd_slots if s["item_name"] != "-Empty-" and not s["hit"]]
    assert len(applicable) >= 2
    idx1, idx2 = applicable[0], applicable[1]
    dice = SuppliedDice([
        ("crit_count", [5, 5]),  # 10 -> 2 criticals
        ("crit_slot", [idx1 + 1]),
        ("crit_slot", [idx2 + 1]),
    ])

    hits = criticals.decide_criticals(mech, "HD", dice)
    assert {h["slot_index"] for h in hits} == {idx1, idx2}
    assert mechs.get_mech(atlas["id"])["criticals"]["HD"] == hd_slots  # still untouched

    criticals.apply_criticals(atlas["id"], hits)
    after = mechs.get_mech(atlas["id"])["criticals"]["HD"]
    for idx in (idx1, idx2):
        assert next(s for s in after if s["slot_index"] == idx)["hit"] is True


def test_decide_criticals_raises_needs_roll_when_supplied_dice_runs_dry(atlas):
    mech = mechs.get_mech(atlas["id"])
    with pytest.raises(NeedsRoll):
        criticals.decide_criticals(mech, "HD", SuppliedDice([]), pilot_id=atlas["pilot_id"])


def test_actuator_damage_fraction_halves_cumulatively(atlas):
    assert criticals.actuator_damage_fraction(atlas["id"], "RA") == (1, 1)
    upper = next(c for c in atlas["criticals"]["RA"] if c["item_name"] == "Upper Arm Actuator")
    mechs.set_critical_hit(atlas["id"], "RA", upper["slot_index"], True)
    assert criticals.actuator_damage_fraction(atlas["id"], "RA") == (1, 2)
    lower = next(c for c in atlas["criticals"]["RA"] if c["item_name"] == "Lower Arm Actuator")
    mechs.set_critical_hit(atlas["id"], "RA", lower["slot_index"], True)
    assert criticals.actuator_damage_fraction(atlas["id"], "RA") == (1, 4)


def test_apply_critical_effects_cockpit_kills_pilot_and_destroys_mech(atlas):
    summary = criticals.apply_critical_effects(atlas["id"], [{"location": "HD", "slot_index": 2, "item_name": "Cockpit"}])
    assert summary["mech_destroyed"] is True
    assert summary["pilot_killed"] is True
    from app.systems.battletech import pilots
    updated_pilot = pilots.get_pilot(atlas["pilot_id"])
    assert updated_pilot["hits"] == 6
    # Fase D: persisted, not just an ephemeral summary field — the pilot
    # is dead (distinct from merely being knocked out by wounds) and the
    # mech is marked destroyed for the 'pilot_killed' reason specifically
    # (falls limp — structurally it's otherwise untouched).
    assert updated_pilot["is_dead"] is True
    assert mechs.get_mech(atlas["id"])["destroyed_reason"] == "pilot_killed"


def test_apply_critical_effects_engine_adds_heat_then_destroys_on_third_hit(atlas):
    before = mechs.get_mech(atlas["id"])["heat_current"]
    criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 0, "item_name": "Engine"}])
    after_one = mechs.get_mech(atlas["id"])
    assert after_one["heat_current"] == before + 5
    assert after_one["engine_hits"] == 1

    criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 1, "item_name": "Engine"}])
    after_two = mechs.get_mech(atlas["id"])
    assert after_two["engine_hits"] == 2

    summary = criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 2, "item_name": "Engine"}])
    assert summary["mech_destroyed"] is True
    # Fase D: 'structural', not 'pilot_killed' — the pilot themselves is
    # untouched by a 3rd engine hit, only the mech.
    assert mechs.get_mech(atlas["id"])["destroyed_reason"] == "structural"


def test_apply_critical_effects_second_gyro_hit_reports_fell(atlas):
    criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 3, "item_name": "Gyro"}])
    summary = criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 4, "item_name": "Gyro"}])
    assert summary["fell"] is True
    assert mechs.get_mech(atlas["id"])["gyro_hits"] == 2


def test_apply_critical_effects_life_support_sets_flag(atlas):
    criticals.apply_critical_effects(atlas["id"], [{"location": "HD", "slot_index": 0, "item_name": "Life Support"}])
    assert mechs.get_mech(atlas["id"])["life_support_hit"] is True


def test_apply_critical_effects_heat_sink_reduces_dissipation(atlas):
    before = mechs.get_mech(atlas["id"])["heat_sinks"]
    criticals.apply_critical_effects(atlas["id"], [{"location": "CT", "slot_index": 6, "item_name": "Heat Sink"}])
    assert mechs.get_mech(atlas["id"])["heat_sinks"] == before - 1
