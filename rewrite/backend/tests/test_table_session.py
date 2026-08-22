from app import campaigns, table_session


def test_get_active_campaign_when_none_activated_returns_none():
    assert table_session.get_active_campaign() is None


def test_activating_campaign_persists_and_returns_it():
    camp = campaigns.create_campaign("Test Campaign")

    result = table_session.activate(camp["id"])

    assert result["id"] == camp["id"]
    assert table_session.get_active_campaign()["id"] == camp["id"]


def test_activating_a_second_campaign_replaces_the_first():
    first = campaigns.create_campaign("First")
    second = campaigns.create_campaign("Second")

    table_session.activate(first["id"])
    table_session.activate(second["id"])

    assert table_session.get_active_campaign()["id"] == second["id"]


def test_deactivating_clears_the_active_campaign():
    camp = campaigns.create_campaign("Test Campaign")
    table_session.activate(camp["id"])

    table_session.deactivate()

    assert table_session.get_active_campaign() is None


def test_deactivating_with_no_active_campaign_is_a_no_op():
    table_session.deactivate()

    assert table_session.get_active_campaign() is None
