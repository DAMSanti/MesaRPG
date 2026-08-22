import pytest

from app import campaigns, db, mechs, pilots

ATLAS_LOCATIONS = [
    {"location": "HD", "armor_max": 9, "structure_max": 3},
    {"location": "CT", "armor_max": 47, "armor_rear_max": 12, "structure_max": 31},
    {"location": "LT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
    {"location": "RT", "armor_max": 32, "armor_rear_max": 10, "structure_max": 21},
    {"location": "LA", "armor_max": 34, "structure_max": 17},
    {"location": "RA", "armor_max": 34, "structure_max": 17},
    {"location": "LL", "armor_max": 41, "structure_max": 21},
    {"location": "RL", "armor_max": 41, "structure_max": 21},
]


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    """Every test gets its own throwaway SQLite file — never the dev DB."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    yield


@pytest.fixture
def campaign():
    return campaigns.create_campaign("Test Campaign")


@pytest.fixture
def pilot(campaign):
    return pilots.create_pilot(campaign["id"], "Miriam Voss", callsign="Widow", gunnery=3, piloting=4)


@pytest.fixture
def atlas(campaign, pilot):
    """A full Atlas AS7-D, same reference values used throughout manual testing."""
    return mechs.create_mech(
        campaign_id=campaign["id"],
        chassis="Atlas",
        model="AS7-D",
        tonnage=100,
        walk_mp=3,
        run_mp=5,
        pilot_id=pilot["id"],
        locations=ATLAS_LOCATIONS,
    )
