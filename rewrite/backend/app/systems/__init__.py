"""Minimal game-system registry (ROADMAP.md S0).

Just enough to stop "grid = hexagon" being an unstated assumption baked
into maps.py: each system says what kind of grid it uses, nothing else.
The real rules content for each system lives in its own package
(app/systems/battletech/, app/systems/dnd5e/ — ROADMAP.md Fase R4),
dispatched by separate endpoint families in main.py rather than a
formal `GameSystem` interface here — with only 2 systems of genuinely
different shape (mech+pilot pair vs. a single character sheet), forcing
a common interface from a sample size of 2 would have been premature
abstraction. This file stays a plain id -> {name, grid_type} registry.
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
