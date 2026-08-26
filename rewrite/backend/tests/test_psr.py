from unittest.mock import patch

from app.dice_source import RandomDice
from app.systems.battletech import mechs, pilots, psr


def test_roll_psr_within_bounds(atlas):
    for _ in range(100):
        result = psr.roll_psr(atlas["id"], 0, "test")
        assert result["roll"] is None or 2 <= result["roll"] <= 12
        assert result["target_number"] == 4  # pilot fixture's piloting is 4


def test_roll_psr_auto_fails_when_shutdown(atlas):
    mechs.set_shutdown(atlas["id"], True)
    result = psr.roll_psr(atlas["id"], 0, "test")
    assert result["auto_fail"] is True
    assert result["success"] is False
    assert result["roll"] is None


def test_roll_psr_auto_fails_when_pilot_at_fatal_wounds(atlas):
    pilots.add_pilot_hits(atlas["pilot_id"], 6)
    result = psr.roll_psr(atlas["id"], 0, "test")
    assert result["auto_fail"] is True


def test_roll_psr_does_not_auto_fail_when_prone(atlas):
    # Real bug fix: a prone mech attempting to stand up IS the roll, not
    # a disqualifying state for it — this used to be lumped in with
    # is_shutdown's own auto-fail, which made stand_up below permanently
    # unable to succeed (every attempt auto-failed, fell again, stayed
    # prone forever).
    psr.apply_fall(atlas["id"])
    assert mechs.get_mech(atlas["id"])["is_prone"] is True
    result = psr.roll_psr(atlas["id"], 0, "test")
    assert result["auto_fail"] is False
    assert result["roll"] is not None


def test_apply_fall_marks_prone_and_damages(atlas):
    result = psr.apply_fall(atlas["id"])
    updated = mechs.get_mech(atlas["id"])
    assert updated["is_prone"] is True
    # ceil(100/10) * (0 + 1) = 10 points of falling damage.
    assert result["total_damage"] == 10
    assert result["damage_results"]


def test_apply_fall_extra_levels_multiply_damage(atlas):
    result = psr.apply_fall(atlas["id"], levels=2)
    assert result["total_damage"] == 30  # ceil(100/10) * (2 + 1)


def test_apply_fall_seatbelt_auto_wounds_when_already_immobile(atlas):
    mechs.set_shutdown(atlas["id"], True)
    result = psr.apply_fall(atlas["id"])
    assert result["seatbelt"]["auto_fail"] is True
    assert result["pilot_wounded"] is True
    updated_pilot = pilots.get_pilot(atlas["pilot_id"])
    assert updated_pilot["hits"] == 1


def test_stand_up_clears_prone_on_a_successful_roll(atlas):
    # pilot fixture's piloting is 4, stand_up rolls at +0 -> TN 4. Rolling
    # is centralized in RandomDice.next_2d6 now (roll_psr/apply_fall's own
    # decide_psr/decide_fall route every instant roll through it) — that's
    # the actual thing to patch for a deterministic result, not psr's own
    # (now-unused) _roll_2d6.
    psr.apply_fall(atlas["id"])
    assert mechs.get_mech(atlas["id"])["is_prone"] is True
    with patch.object(RandomDice, "next_2d6", return_value=(2, 2, 4)):
        result = psr.stand_up(atlas["id"])
    assert result["stood_up"] is True
    assert result["psr"]["auto_fail"] is False
    assert mechs.get_mech(atlas["id"])["is_prone"] is False


def test_stand_up_falls_again_in_place_on_a_failed_roll(atlas):
    psr.apply_fall(atlas["id"])
    with patch.object(RandomDice, "next_2d6", return_value=(1, 1, 2)):  # below TN 4
        result = psr.stand_up(atlas["id"])
    assert result["stood_up"] is False
    assert result["fall"] is not None
    assert mechs.get_mech(atlas["id"])["is_prone"] is True


def test_stand_up_no_op_when_already_standing(atlas):
    result = psr.stand_up(atlas["id"])
    assert result["already_standing"] is True


def test_stand_up_never_succeeds_with_a_destroyed_gyro(atlas):
    from app.systems.battletech import criticals

    psr.apply_fall(atlas["id"])
    criticals.apply_critical_effects(atlas["id"], [
        {"location": "CT", "slot_index": 0, "item_name": "Gyro"},
        {"location": "CT", "slot_index": 1, "item_name": "Gyro"},
    ])
    assert mechs.get_mech(atlas["id"])["gyro_hits"] == 2
    result = psr.stand_up(atlas["id"])
    assert result["stood_up"] is False
    assert result["gyro_destroyed"] is True
    assert mechs.get_mech(atlas["id"])["is_prone"] is True


def test_run_stand_up_never_pauses_for_an_auto_mode_pilot(atlas):
    pilots.update_pilot(atlas["pilot_id"], dice_mode="auto")
    psr.apply_fall(atlas["id"])
    result = psr.run_stand_up(atlas["id"])
    assert result["stood_up"] in (True, False)  # proves it fully resolved, no PendingRoll


def test_run_stand_up_pauses_for_a_physical_pilot_and_resumes_to_a_full_result(atlas):
    # dice_mode defaults to 'physical' — pilots fixture never overrides it.
    from app import dice_resolution

    psr.apply_fall(atlas["id"])
    assert mechs.get_mech(atlas["id"])["is_prone"] is True

    ctx = committed = collected = None
    result = None
    for _ in range(10):
        try:
            result = (
                psr.run_stand_up(atlas["id"]) if ctx is None
                else psr.run_stand_up(atlas["id"], ctx=ctx, committed=committed, collected=collected)
            )
            break
        except dice_resolution.PendingRoll as exc:
            assert exc.pilot_id == atlas["pilot_id"]
            pending = dice_resolution.get_pending(exc.pending_roll_id)
            dice_resolution.delete_pending(exc.pending_roll_id)
            ctx, committed = pending["ctx"], pending["committed"]
            collected = pending["collected"] + [(pending["next_purpose"], [6, 6])]  # guaranteed success (TN 4)

    assert result is not None
    assert result["stood_up"] is True
    assert result["psr"]["roll"] == 12
    assert mechs.get_mech(atlas["id"])["is_prone"] is False


def test_run_stand_up_short_circuits_without_any_roll_when_already_standing(atlas):
    result = psr.run_stand_up(atlas["id"])
    assert result == {"mech_id": atlas["id"], "already_standing": True}
