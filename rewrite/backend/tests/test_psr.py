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


def test_stand_up_clears_prone_on_success_or_falls_again_on_failure(atlas):
    psr.apply_fall(atlas["id"])
    assert mechs.get_mech(atlas["id"])["is_prone"] is True
    result = psr.stand_up(atlas["id"])
    updated = mechs.get_mech(atlas["id"])
    if result["stood_up"]:
        assert updated["is_prone"] is False
    else:
        assert updated["is_prone"] is True
        assert result["fall"] is not None


def test_stand_up_no_op_when_already_standing(atlas):
    result = psr.stand_up(atlas["id"])
    assert result["already_standing"] is True
