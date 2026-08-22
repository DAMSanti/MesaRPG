"""Minimal game-system registry (ROADMAP.md S0).

Deliberately NOT the plugin contract of Fase R4 — no rules engine, no
character sheet schema, no tokens. Just enough to stop "grid = hexagon"
being an unstated assumption baked into maps.py: each system says what
kind of grid it uses, nothing else. D&D 5e is registered with zero rules
content, purely to force `grid_type="square"` to be real in the data
model instead of a promise nobody has tested.
"""

GAME_SYSTEMS: dict[str, dict[str, str]] = {
    "battletech": {"name": "BattleTech", "grid_type": "hex"},
    "dnd5e": {"name": "D&D 5e", "grid_type": "square"},
}


class UnknownGameSystem(ValueError):
    pass


def grid_type_for(system_id: str) -> str:
    try:
        return GAME_SYSTEMS[system_id]["grid_type"]
    except KeyError:
        raise UnknownGameSystem(
            f"Unknown game system {system_id!r}, expected one of {list(GAME_SYSTEMS)}"
        ) from None
