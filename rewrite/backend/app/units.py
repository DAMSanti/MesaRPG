"""Units on a map, plus the fog-of-war / ghost-token logic from VISION.md §4.2.

- A pilot "sees" an enemy/ghost unit if it's in LoS of any of that
  pilot's own (non-ghost) units on the map.
- A ghost unit (GM pre-placed, no physical miniature yet) that becomes
  visible to any pilot flips `revealed` — that's the trigger for "tell
  the GM to place the real miniature now" (main.py broadcasts it).
- Combined visibility (for the shared table display) is just the union
  across all pilots, tagged with *who* sees each unit — real per-player
  vision-cone outlines (VISION.md's colored contour) are a frontend
  rendering concern layered on top of this, not modeled here.
"""

import math

from . import db, events
from .hexgrid import Hex, has_los
from .hexgrid import distance as hex_distance
from .maps import get_map, tiles_lookup
from .squaregrid import Cell, has_los as square_has_los
from .systems.battletech import mechs as bt_mechs
from .squaregrid import distance as square_distance
from .systems.battletech import mechs

_SQRT3 = math.sqrt(3)

# A mech doesn't see equally in every direction — it has a facing, same as
# the frontend's own hex-to-world layout (HexMap.tsx's hexToWorld: pointy-top
# axial → world x/z). Mirrored here in Python so an angle computed from a
# (q, r) delta means the same thing on both sides. 0° = world +X, angles
# increase counter-clockwise (plain atan2 convention) — `facing_deg` isn't
# consumed anywhere else yet, so this is the convention until a real
# facing-arrow UI picks a different one.
_VISION_ARC_DEG = 180  # front half only, nothing directly behind


def _world_delta(from_q: int, from_r: int, to_q: int, to_r: int, grid_type: str) -> tuple[float, float]:
    if grid_type == "square":
        return float(to_q - from_q), float(to_r - from_r)
    dq, dr = to_q - from_q, to_r - from_r
    return _SQRT3 * (dq + dr / 2), 1.5 * dr


def _within_facing_arc(dx: float, dz: float, facing_deg: float, arc_deg: float) -> bool:
    if dx == 0 and dz == 0:
        return True  # a unit always sees its own tile
    target_deg = math.degrees(math.atan2(dz, dx))
    diff = (target_deg - facing_deg + 180) % 360 - 180
    return abs(diff) <= arc_deg / 2


def attack_side(attacker: dict, target: dict, grid_type: str) -> str:
    """Which of the target's 4 hit-location quadrants (front/left/right/
    rear — app/combat.py's HIT_LOCATION_TABLES) the attacker is actually
    firing from, based on real positions and the target's own facing_deg
    — server-side port of hexMath.ts's attackSide (same 4x90° quadrant
    heuristic, same angle convention as _within_facing_arc above). Was
    previously only computed client-side as an editable *suggestion*;
    this is the authoritative version app/combat.py's resolve_attack uses
    once real attacker_unit_id/target_unit_id are given."""
    dx, dz = _world_delta(target["q"], target["r"], attacker["q"], attacker["r"], grid_type)
    if dx == 0 and dz == 0:
        return "front"
    angle_deg = math.degrees(math.atan2(dz, dx))
    relative = (angle_deg - target["facing_deg"] + 180) % 360 - 180
    abs_relative = abs(relative)
    if abs_relative <= 45:
        return "front"
    if abs_relative >= 135:
        return "rear"
    return "left" if relative > 0 else "right"


class MechNotApproved(ValueError):
    pass


def create_unit(
    campaign_id: int,
    map_id: int,
    q: int,
    r: int,
    mech_id: int | None = None,
    pilot_id: int | None = None,
    facing_deg: int = 0,
    is_ghost: bool = False,
    dnd_character_id: int | None = None,
) -> dict:
    # A pending/rejected mech hasn't been reviewed yet — the GM shouldn't
    # be able to drop it on the board before deciding whether it's even
    # allowed in the game (real user request: "El GM solo puede colocar
    # aquellos mechs aprobados"). GMView's own drag-to-place already
    # blocks the drag client-side; this is the same rule enforced
    # server-side so it can't be bypassed by calling the API directly.
    if mech_id is not None:
        mech = bt_mechs.get_mech(mech_id)
        if mech and mech["status"] != "approved":
            raise MechNotApproved(f"Mech {mech_id} is {mech['status']!r}, not approved")
    with db.connect() as conn:
        # A mech can only be on one map at a time (real user request) —
        # placing it here (even on a different map than before) replaces
        # whatever unit it already had, instead of leaving a duplicate
        # token behind on the old map.
        if mech_id is not None:
            conn.execute("DELETE FROM units WHERE mech_id = ?", (mech_id,))
        cur = conn.execute(
            """
            INSERT INTO units
                (campaign_id, map_id, mech_id, pilot_id, q, r, facing_deg, is_ghost, revealed, dnd_character_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (campaign_id, map_id, mech_id, pilot_id, q, r, facing_deg, is_ghost, not is_ghost, dnd_character_id),
        )
        unit_id = cur.lastrowid
        if mech_id is not None:
            name = f"{mech['chassis']} {mech['model'] or ''}".strip() if mech else f"mech #{mech_id}"
            events.log_event(conn, campaign_id, "unit_placed", f"{name} colocado en el mapa", {"unit_id": unit_id})
        return _get(conn, unit_id)


def delete_unit(unit_id: int) -> bool:
    """Removes a token from its map without touching the mech/pilot/
    character it represents — the GM's "Quitar del mapa" action (real
    user request), distinct from mechs.delete_mech which removes the
    mech from the campaign entirely."""
    with db.connect() as conn:
        snapshot = _get(conn, unit_id)
        cur = conn.execute("DELETE FROM units WHERE id = ?", (unit_id,))
        if cur.rowcount and snapshot:
            name = f"{snapshot['mech_chassis']} {snapshot['mech_model'] or ''}".strip() if snapshot.get("mech_chassis") else f"unidad #{unit_id}"
            events.log_event(
                conn, snapshot["campaign_id"], "unit_removed", f"{name} quitado del mapa",
                {"snapshot": {
                    "map_id": snapshot["map_id"], "mech_id": snapshot["mech_id"], "pilot_id": snapshot["pilot_id"],
                    "q": snapshot["q"], "r": snapshot["r"], "facing_deg": snapshot["facing_deg"],
                    "is_ghost": snapshot["is_ghost"], "revealed": snapshot["revealed"],
                    "dnd_character_id": snapshot["dnd_character_id"],
                }},
            )
        return cur.rowcount > 0


def move_unit(unit_id: int, q: int, r: int, facing_deg: int | None = None) -> dict:
    with db.connect() as conn:
        prev = conn.execute(
            "SELECT campaign_id, q, r, facing_deg FROM units WHERE id = ?", (unit_id,)
        ).fetchone()
        if facing_deg is None:
            conn.execute("UPDATE units SET q = ?, r = ? WHERE id = ?", (q, r, unit_id))
        else:
            conn.execute(
                "UPDATE units SET q = ?, r = ?, facing_deg = ? WHERE id = ?",
                (q, r, facing_deg, unit_id),
            )
        if prev:
            events.log_event(
                conn, prev["campaign_id"], "unit_moved", "Unidad movida",
                {"unit_id": unit_id, "prev_q": prev["q"], "prev_r": prev["r"], "prev_facing_deg": prev["facing_deg"]},
            )
        return _get(conn, unit_id)


def list_units(map_id: int) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute("SELECT id FROM units WHERE map_id = ?", (map_id,)).fetchall()
        return [_get(conn, row["id"]) for row in rows]


def get_unit(unit_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, unit_id)


def _affected_maps(rows: list) -> set[tuple[int, int]]:
    """Distinct (campaign_id, map_id) pairs a set of raw unit rows sit
    on — so a caller (main.py) that just mutated a pilot/mech can find
    every live table view that needs a visibility_update broadcast,
    without assuming a campaign only ever has one active map."""
    return {(r["campaign_id"], r["map_id"]) for r in rows}


def maps_for_mech(mech_id: int) -> set[tuple[int, int]]:
    """Which (campaign_id, map_id) pairs have a unit for this mech right
    now — call *before* deleting the mech (units.mech_id is ON DELETE
    SET NULL, so afterward this would find nothing)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT campaign_id, map_id FROM units WHERE mech_id = ?", (mech_id,)
        ).fetchall()
        return _affected_maps(rows)


def maps_for_pilot(pilot_id: int) -> set[tuple[int, int]]:
    """Same as maps_for_mech, but for a pilot — deleting/reassigning a
    pilot changes the faction color of any unit that had them, even
    though the unit itself survives."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT campaign_id, map_id FROM units WHERE pilot_id = ?", (pilot_id,)
        ).fetchall()
        return _affected_maps(rows)


def combined_visibility(campaign_id: int, map_id: int) -> dict:
    """Returns {"visible": {unit_id: [pilot_id, ...]}, "newly_revealed": [unit_id, ...]}."""
    units = list_units(map_id)
    tiles = tiles_lookup(map_id)
    elevation_of = {(u["q"], u["r"]): tiles.get((u["q"], u["r"]), {}).get("elevation", 0) for u in units}

    observers_by_pilot: dict[int, list[dict]] = {}
    for u in units:
        if u["pilot_id"] is not None and not u["is_ghost"]:
            observers_by_pilot.setdefault(u["pilot_id"], []).append(u)

    visible: dict[int, list[int]] = {u["id"]: [] for u in units}
    for pilot_id, observers in observers_by_pilot.items():
        for target in units:
            if target["pilot_id"] == pilot_id:
                continue  # you always see your own units; not the point of this map
            seen = any(
                has_los(
                    Hex(obs["q"], obs["r"]),
                    elevation_of[(obs["q"], obs["r"])],
                    Hex(target["q"], target["r"]),
                    elevation_of[(target["q"], target["r"])],
                    tiles,
                )
                for obs in observers
            )
            if seen:
                visible[target["id"]].append(pilot_id)

    newly_revealed = []
    with db.connect() as conn:
        for u in units:
            if u["is_ghost"] and not u["revealed"] and visible.get(u["id"]):
                conn.execute("UPDATE units SET revealed = 1 WHERE id = ?", (u["id"],))
                newly_revealed.append(u["id"])

    return {"visible": visible, "newly_revealed": newly_revealed}


def visible_hexes_from_unit(unit_id: int) -> list[dict] | None:
    """Every map tile visible from one unit's current position — a raw LoS
    debug view, unlike combined_visibility() which only considers pilot-owned
    observers and only reports unit-vs-unit sightlines. Lets the frontend
    show *something* on the table even for a mech placed without a pilot
    assigned yet (VISION.md §4.2's per-player vision cones are still
    unbuilt — this is the "at least show me it's computing something"
    stand-in until that lands)."""
    unit = get_unit(unit_id)
    if unit is None:
        return None

    m = get_map(unit["map_id"])
    grid_type = m["grid_type"] if m else "hex"
    tiles = tiles_lookup(unit["map_id"])
    observer_elevation = tiles.get((unit["q"], unit["r"]), {}).get("elevation", 0)

    if grid_type == "square":
        cell_cls, los = Cell, square_has_los
    else:
        cell_cls, los = Hex, has_los
    observer = cell_cls(unit["q"], unit["r"])
    facing_deg = unit["facing_deg"]

    visible = []
    for (q, r), tile in tiles.items():
        dx, dz = _world_delta(unit["q"], unit["r"], q, r, grid_type)
        if not _within_facing_arc(dx, dz, facing_deg, _VISION_ARC_DEG):
            continue
        if los(observer, observer_elevation, cell_cls(q, r), tile.get("elevation", 0), tiles):
            visible.append({"q": q, "r": r})
    return visible


def visible_enemies_from_unit(unit_id: int) -> list[dict] | None:
    """Enemy units inside this unit's own facing cone + LoS — the
    unit-vs-unit sibling of visible_hexes_from_unit, for the first-person
    HUD (PlayerView's "Vista en 1ª persona"): what this mech would
    actually spot looking the way it's currently facing, unlike
    combined_visibility() which is 360° and only considers pilot-owned
    observers. A target with no pilot assigned still counts as an
    unidentified contact — it isn't hidden just for lacking a faction."""
    unit = get_unit(unit_id)
    if unit is None:
        return None

    m = get_map(unit["map_id"])
    grid_type = m["grid_type"] if m else "hex"
    tiles = tiles_lookup(unit["map_id"])
    observer_elevation = tiles.get((unit["q"], unit["r"]), {}).get("elevation", 0)

    if grid_type == "square":
        cell_cls, los, dist = Cell, square_has_los, square_distance
    else:
        cell_cls, los, dist = Hex, has_los, hex_distance
    observer = cell_cls(unit["q"], unit["r"])
    facing_deg = unit["facing_deg"]

    visible = []
    for target in list_units(unit["map_id"]):
        if target["id"] == unit_id or target["mech_id"] is None:
            continue
        if target["pilot_faction"] is not None and target["pilot_faction"] == unit["pilot_faction"]:
            continue
        dx, dz = _world_delta(unit["q"], unit["r"], target["q"], target["r"], grid_type)
        if not _within_facing_arc(dx, dz, facing_deg, _VISION_ARC_DEG):
            continue
        target_elevation = tiles.get((target["q"], target["r"]), {}).get("elevation", 0)
        target_cell = cell_cls(target["q"], target["r"])
        if not los(observer, observer_elevation, target_cell, target_elevation, tiles):
            continue
        mech = mechs.get_mech(target["mech_id"])
        visible.append(
            {
                "unit_id": target["id"],
                "mech_id": target["mech_id"],
                "chassis": mech["chassis"] if mech else None,
                "model": mech["model"] if mech else None,
                "q": target["q"],
                "r": target["r"],
                "distance": dist(observer, target_cell),
            }
        )
    return visible


def _get(conn, unit_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT u.id, u.campaign_id, u.map_id, u.mech_id, u.pilot_id, u.q, u.r,
               u.facing_deg, u.is_ghost, u.revealed, u.created_at, p.faction AS pilot_faction,
               m.chassis AS mech_chassis, m.model AS mech_model,
               u.dnd_character_id, dc.name AS dnd_name, dc.ac AS dnd_ac,
               dc.hp_current AS dnd_hp_current, dc.hp_max AS dnd_hp_max
        FROM units u
        LEFT JOIN pilots p ON p.id = u.pilot_id
        LEFT JOIN mechs m ON m.id = u.mech_id
        LEFT JOIN dnd_characters dc ON dc.id = u.dnd_character_id
        WHERE u.id = ?
        """,
        (unit_id,),
    ).fetchone()
    if not row:
        return None
    unit = dict(row)
    unit["is_ghost"] = bool(unit["is_ghost"])
    unit["revealed"] = bool(unit["revealed"])
    return unit
