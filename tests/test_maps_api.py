import asyncio
import pytest

from fastapi.testclient import TestClient

from server.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_get_root(client):
    r = client.get("/")
    assert r.status_code == 200


def test_maps_crud(client):
    # create
    payload = {
        "name": "pytest-map",
        "width": 5,
        "height": 5,
        "gridType": "square",
        "cellSize": 32,
        "tiles": [{"x": 0, "y": 0, "tileId": "grass"}]
    }
    r = client.post("/api/maps", json=payload)
    assert r.status_code == 200 or r.status_code == 201
    data = r.json()
    assert "id" in data
    mid = data.get("id")

    # get
    r2 = client.get(f"/api/maps/{mid}")
    assert r2.status_code == 200
    m = r2.json()
    assert m["name"] == "pytest-map"

    # project
    r3 = client.post(f"/api/maps/{mid}/project")
    assert r3.status_code == 200

    # delete
    r4 = client.delete(f"/api/maps/{mid}")
    assert r4.status_code == 200
