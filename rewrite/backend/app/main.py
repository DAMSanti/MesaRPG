"""MesaRPG rewrite backend (ROADMAP.md Fase R0 onward).

Two game systems live behind this one API today: BattleTech (the
original, full rules engine — app/systems/battletech/) and D&D 5e (Fase
R4, a deliberately minimal validation slice — app/systems/dnd5e/). Map/
unit endpoints are shared (already generic by grid_type since Fase S0);
character/combat/round endpoints are separate families per system, not
a forced common interface — see rewrite/README.md for exactly what's in
and out of scope for each.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from . import campaigns, db, equipment, mapgen, maps, mech_templates, rolls, systems, table_session, units
from .systems.battletech import combat, mechs, movement, pilots, turns, weapons
from .systems.dnd5e import characters as dnd_characters
from .systems.dnd5e import combat as dnd_combat
from .systems.dnd5e import turns as dnd_turns
from .ws import hub_manager, manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="MesaRPG rewrite — vertical slice", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# ---- game systems (ROADMAP.md S0 — grid_type only, no rules yet) --------


@app.get("/api/systems")
def get_systems() -> dict:
    return systems.GAME_SYSTEMS


# ---- campaigns ----------------------------------------------------------


class CampaignIn(BaseModel):
    name: str
    system: str = "battletech"


@app.post("/api/campaigns")
def create_campaign(body: CampaignIn) -> dict:
    try:
        return campaigns.create_campaign(body.name, body.system)
    except systems.UnknownGameSystem as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/campaigns")
def get_campaigns() -> list[dict]:
    return campaigns.list_campaigns()


class ActiveMapIn(BaseModel):
    map_id: int


@app.post("/api/campaigns/{campaign_id}/active-map")
async def set_active_map(campaign_id: int, body: ActiveMapIn) -> dict:
    _require_campaign(campaign_id)
    _require_map(body.map_id)
    result = campaigns.set_active_map(campaign_id, body.map_id)
    # Without this, an already-open table view (`/`) never learns a
    # different map was projected — it only ever read active_map_id once
    # on mount (see useMapId.ts). Found by the user testing live.
    await manager.broadcast(campaign_id, {"type": "active_map_changed", "map_id": body.map_id})
    return result


class InitiativeModeIn(BaseModel):
    mode: str


@app.post("/api/campaigns/{campaign_id}/initiative-mode")
def set_initiative_mode(campaign_id: int, body: InitiativeModeIn) -> dict:
    _require_campaign(campaign_id)
    try:
        return campaigns.set_initiative_mode(campaign_id, body.mode)
    except campaigns.UnknownInitiativeMode as exc:
        raise HTTPException(422, str(exc)) from exc


def _require_campaign(campaign_id: int) -> dict:
    campaign = campaigns.get_campaign(campaign_id)
    if not campaign:
        raise HTTPException(404, f"Campaign {campaign_id} not found")
    return campaign


# ---- character sheet approval (ROADMAP.md Fase R3 — "suite jugable") ----
#
# A pilot/mech's owner_token is a per-device secret (generated client-side,
# see frontend/src/deviceToken.ts) — it must never leave this process as
# JSON, or any client could impersonate the owner of any pending/rejected
# sheet. _sanitize_* strips it and replaces it with `is_own`, computed
# server-side against the calling request's own header.


def _sanitize_pilot(pilot: dict, token: str | None) -> dict:
    sanitized = dict(pilot)
    owner_token = sanitized.pop("owner_token", None)
    sanitized["is_own"] = owner_token is not None and owner_token == token
    return sanitized


def _sanitize_mech(mech: dict, token: str | None) -> dict:
    sanitized = dict(mech)
    owner_token = sanitized.pop("owner_token", None)
    sanitized["is_own"] = owner_token is not None and owner_token == token
    return sanitized


def _require_owner(record: dict, token: str | None) -> None:
    """A pending/rejected sheet may only be edited/resubmitted by the
    device that created it. Approved sheets stay editable by anyone, same
    as today — this only ever tightens the pending/rejected case."""
    if record["status"] in ("pending", "rejected") and record["owner_token"] != token:
        raise HTTPException(403, "Only the device that submitted this sheet can edit it")


# ---- table session (which campaign the physical table is playing now) ---


@app.get("/api/table-session")
def get_table_session() -> dict:
    campaign = table_session.get_active_campaign()
    return {"active_campaign_id": campaign["id"] if campaign else None}


class ActivateTableSessionIn(BaseModel):
    campaign_id: int


@app.post("/api/table-session/activate")
async def activate_table_session(body: ActivateTableSessionIn) -> dict:
    _require_campaign(body.campaign_id)
    campaign = table_session.activate(body.campaign_id)
    await hub_manager.broadcast({"type": "active_campaign_changed", "campaign_id": campaign["id"]})
    return {"active_campaign_id": campaign["id"]}


@app.post("/api/table-session/deactivate")
async def deactivate_table_session() -> dict:
    table_session.deactivate()
    await hub_manager.broadcast({"type": "active_campaign_changed", "campaign_id": None})
    return {"active_campaign_id": None}


# ---- pilots ---------------------------------------------------------------


class PilotIn(BaseModel):
    name: str
    callsign: str | None = None
    gunnery: int = 4
    piloting: int = 5
    faction: str = "player"
    status: str = "approved"
    owner_token: str | None = None
    color: str | None = None
    # 4-digit PIN a player sets when creating their own character from the
    # shared pick-a-pilot list (see /api/pilots/{id}/verify-pin below) —
    # optional so the GM's own pilot-creation path (which never prompts
    # for one) keeps working unchanged; a pilot with no PIN stays freely
    # selectable, same as before this existed.
    pin: str | None = None


@app.post("/api/campaigns/{campaign_id}/pilots")
def create_pilot(
    campaign_id: int, body: PilotIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_campaign(campaign_id)
    try:
        created = pilots.create_pilot(
            campaign_id, body.name, body.callsign, body.gunnery, body.piloting, body.faction,
            body.status, body.owner_token, body.color, body.pin,
        )
    except (pilots.UnknownFaction, pilots.UnknownStatus, pilots.InvalidPin) as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_pilot(created, x_device_token)


@app.get("/api/campaigns/{campaign_id}/pilots")
def get_pilots(
    campaign_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> list[dict]:
    _require_campaign(campaign_id)
    return [_sanitize_pilot(p, x_device_token) for p in pilots.list_pilots(campaign_id)]


def _require_pilot(pilot_id: int) -> dict:
    pilot = pilots.get_pilot(pilot_id)
    if not pilot:
        raise HTTPException(404, f"Pilot {pilot_id} not found")
    return pilot


class PilotPatchIn(BaseModel):
    name: str | None = None
    callsign: str | None = None
    gunnery: int | None = None
    piloting: int | None = None
    faction: str | None = None
    hits: int | None = None
    color: str | None = None


@app.patch("/api/pilots/{pilot_id}")
async def patch_pilot(
    pilot_id: int, body: PilotPatchIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_pilot(pilot_id), x_device_token)
    # A faction change (the GM's "Editar" modal allows it) recolors any
    # unit this pilot has on the map, so an already-open table view needs
    # to hear about it same as a move/create/delete would.
    affected_maps = units.maps_for_pilot(pilot_id) if body.faction is not None else set()
    try:
        updated = pilots.update_pilot(pilot_id, **body.model_dump())
    except pilots.UnknownFaction as exc:
        raise HTTPException(422, str(exc)) from exc
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    return _sanitize_pilot(updated, x_device_token)


class VerifyPinIn(BaseModel):
    pin: str


@app.post("/api/pilots/{pilot_id}/verify-pin")
def verify_pilot_pin(pilot_id: int, body: VerifyPinIn) -> dict:
    """Gates *picking* an already-approved pilot from PlayerView's shared
    list — a separate concern from `_require_owner` above, which only
    ever gated *editing* a pending/rejected draft. No lockout/rate-limit:
    a 4-digit PIN at a casual home table doesn't need one, and adding it
    would only make it easy for a player to lock themselves out."""
    _require_pilot(pilot_id)
    if not pilots.verify_pin(pilot_id, body.pin):
        raise HTTPException(403, "PIN incorrecto")
    return {"ok": True}


class ReviewIn(BaseModel):
    decision: str
    note: str | None = None


@app.post("/api/pilots/{pilot_id}/review")
def review_pilot(
    pilot_id: int, body: ReviewIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_pilot(pilot_id)
    try:
        updated = pilots.review_pilot(pilot_id, body.decision, body.note)
    except pilots.UnknownStatus as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_pilot(updated, x_device_token)


@app.post("/api/pilots/{pilot_id}/resubmit")
def resubmit_pilot(
    pilot_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_pilot(pilot_id), x_device_token)
    try:
        updated = pilots.resubmit_pilot(pilot_id)
    except pilots.InvalidStatusTransition as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_pilot(updated, x_device_token)


@app.delete("/api/pilots/{pilot_id}")
async def delete_pilot(pilot_id: int) -> dict:
    # GM-only action (no _require_owner) — same as review_pilot above,
    # not an owner-initiated edit.
    _require_pilot(pilot_id)
    affected_maps = units.maps_for_pilot(pilot_id)
    pilots.delete_pilot(pilot_id)
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    return {"deleted": True}


# ---- mechs ------------------------------------------------------------


class MechLocationIn(BaseModel):
    location: str
    armor_max: int
    structure_max: int
    armor_rear_max: int | None = None


class MechIn(BaseModel):
    chassis: str
    tonnage: int
    walk_mp: int
    run_mp: int
    locations: list[MechLocationIn]
    model: str | None = None
    jump_mp: int = 0
    pilot_id: int | None = None
    heat_sinks: int = 10
    status: str = "approved"
    owner_token: str | None = None
    criticals: dict[str, list[str]] | None = None


@app.post("/api/campaigns/{campaign_id}/mechs")
def create_mech(
    campaign_id: int, body: MechIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_campaign(campaign_id)
    try:
        created = mechs.create_mech(
            campaign_id=campaign_id,
            chassis=body.chassis,
            tonnage=body.tonnage,
            walk_mp=body.walk_mp,
            run_mp=body.run_mp,
            jump_mp=body.jump_mp,
            pilot_id=body.pilot_id,
            model=body.model,
            heat_sinks=body.heat_sinks,
            status=body.status,
            owner_token=body.owner_token,
            locations=[loc.model_dump() for loc in body.locations],
            criticals=body.criticals,
        )
    except (mechs.InvalidMechLocation, mechs.UnknownStatus) as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_mech(created, x_device_token)


@app.get("/api/campaigns/{campaign_id}/mechs")
def get_mechs(
    campaign_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> list[dict]:
    _require_campaign(campaign_id)
    return [_sanitize_mech(m, x_device_token) for m in mechs.list_mechs(campaign_id)]


def _require_mech(mech_id: int) -> dict:
    mech = mechs.get_mech(mech_id)
    if not mech:
        raise HTTPException(404, f"Mech {mech_id} not found")
    return mech


@app.get("/api/mechs/{mech_id}")
def get_mech(mech_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")) -> dict:
    return _sanitize_mech(_require_mech(mech_id), x_device_token)


class MechPatchIn(BaseModel):
    chassis: str | None = None
    model: str | None = None
    tonnage: int | None = None
    walk_mp: int | None = None
    run_mp: int | None = None
    jump_mp: int | None = None
    heat_sinks: int | None = None
    pilot_id: int | None = None


@app.patch("/api/mechs/{mech_id}")
async def patch_mech(
    mech_id: int, body: MechPatchIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    # Reassigning the pilot (the GM's "Editar" modal) recolors this
    # mech's unit on the map if it has one — broadcast the same as
    # move/create/delete already do.
    affected_maps = units.maps_for_mech(mech_id) if body.pilot_id is not None else set()
    updated = mechs.update_mech(mech_id, **body.model_dump())
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    return _sanitize_mech(updated, x_device_token)


@app.post("/api/mechs/{mech_id}/review")
def review_mech(
    mech_id: int, body: ReviewIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_mech(mech_id)
    try:
        updated = mechs.review_mech(mech_id, body.decision, body.note)
    except mechs.UnknownStatus as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_mech(updated, x_device_token)


@app.post("/api/mechs/{mech_id}/resubmit")
def resubmit_mech(
    mech_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    try:
        updated = mechs.resubmit_mech(mech_id)
    except mechs.InvalidStatusTransition as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_mech(updated, x_device_token)


@app.delete("/api/mechs/{mech_id}")
async def delete_mech(mech_id: int) -> dict:
    # GM-only action (no _require_owner) — same as review_mech above,
    # not an owner-initiated edit.
    _require_mech(mech_id)
    affected_maps = units.maps_for_mech(mech_id)
    mechs.delete_mech(mech_id)
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    return {"deleted": True}


class MechLocationPatchIn(BaseModel):
    armor_current: int | None = None
    armor_rear_current: int | None = None
    structure_current: int | None = None
    armor_max: int | None = None
    armor_rear_max: int | None = None
    structure_max: int | None = None


@app.patch("/api/mechs/{mech_id}/locations/{location}")
def patch_mech_location(
    mech_id: int, location: str, body: MechLocationPatchIn,
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
) -> dict:
    if location not in db.MECH_LOCATIONS:
        raise HTTPException(422, f"Unknown location {location!r}")
    _require_owner(_require_mech(mech_id), x_device_token)
    updated = mechs.update_location(mech_id, location, **body.model_dump())
    return _sanitize_mech(updated, x_device_token)


class MechCriticalPatchIn(BaseModel):
    hit: bool


@app.patch("/api/mechs/{mech_id}/criticals/{location}/{slot_index}")
def patch_mech_critical(
    mech_id: int, location: str, slot_index: int, body: MechCriticalPatchIn,
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
) -> dict:
    if location not in db.MECH_LOCATIONS:
        raise HTTPException(422, f"Unknown location {location!r}")
    _require_owner(_require_mech(mech_id), x_device_token)
    updated = mechs.set_critical_hit(mech_id, location, slot_index, body.hit)
    return _sanitize_mech(updated, x_device_token)


# ---- weapons (ROADMAP.md Fase R2 follow-up — see app/weapons.py) -------


@app.get("/api/weapons")
def get_weapon_catalog() -> dict:
    return weapons.WEAPON_CATALOG


# ---- mech import (real mechs from our own local catalog — see
# app/mech_templates.py; populated offline by scripts/sync_mech_catalog.py
# from the public MegaMek unit database app/mech_import.py knows how to
# parse. No network call in this request path — VISION.md §3 offline-first.

@app.get("/api/mech-import/search")
def search_mech_import(q: str) -> list[dict]:
    return mech_templates.search_templates(q)


@app.get("/api/mech-catalog/chassis")
def list_mech_chassis() -> list[str]:
    """The GM's chassis dropdown (ROADMAP.md Fase R3 follow-up) — a
    distinct path from /api/mech-import/{filename} below on purpose, so
    "chassis" is never ambiguous with a real .mtf filename."""
    return mech_templates.list_chassis()


@app.get("/api/mech-catalog/chassis/{chassis}/models")
def list_mech_models(chassis: str) -> list[dict]:
    return mech_templates.list_models(chassis)


@app.get("/api/mech-import/{filename}")
def get_mech_import(filename: str) -> dict:
    template = mech_templates.get_template(filename)
    if not template:
        raise HTTPException(404, f"Mech template {filename!r} not found in the local catalog")
    return template


class MechWeaponIn(BaseModel):
    weapon_name: str
    location: str


@app.post("/api/mechs/{mech_id}/weapons")
def add_mech_weapon(
    mech_id: int, body: MechWeaponIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    try:
        updated = mechs.add_weapon(mech_id, body.weapon_name, body.location)
    except (weapons.UnknownWeapon, mechs.InvalidMechLocation) as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_mech(updated, x_device_token)


@app.delete("/api/mechs/{mech_id}/weapons/{weapon_id}")
def remove_mech_weapon(
    mech_id: int, weapon_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    updated = mechs.remove_weapon(weapon_id)
    if not updated:
        raise HTTPException(404, f"Mech weapon {weapon_id} not found")
    return _sanitize_mech(updated, x_device_token)


# ---- equipment (non-weapon gear — see app/equipment.py) -----------------


@app.get("/api/equipment")
def get_equipment_catalog() -> dict:
    return equipment.EQUIPMENT_CATALOG


class MechEquipmentIn(BaseModel):
    equipment_name: str
    location: str


@app.post("/api/mechs/{mech_id}/equipment")
def add_mech_equipment(
    mech_id: int, body: MechEquipmentIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    try:
        updated = mechs.add_equipment(mech_id, body.equipment_name, body.location)
    except (equipment.UnknownEquipment, mechs.InvalidMechLocation) as exc:
        raise HTTPException(422, str(exc)) from exc
    return _sanitize_mech(updated, x_device_token)


@app.delete("/api/mechs/{mech_id}/equipment/{equipment_id}")
def remove_mech_equipment(
    mech_id: int, equipment_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    updated = mechs.remove_equipment(equipment_id)
    if not updated:
        raise HTTPException(404, f"Mech equipment {equipment_id} not found")
    return _sanitize_mech(updated, x_device_token)


# ---- maps + units (hex grid, fog of war, ghost tokens) ------------------


class MapIn(BaseModel):
    name: str
    width: int = 12
    height: int = 10


@app.post("/api/campaigns/{campaign_id}/maps")
def create_map(campaign_id: int, body: MapIn) -> dict:
    _require_campaign(campaign_id)
    return maps.create_map(campaign_id, body.name, body.width, body.height)


@app.get("/api/campaigns/{campaign_id}/maps")
def get_maps(campaign_id: int) -> list[dict]:
    _require_campaign(campaign_id)
    return maps.list_maps(campaign_id)


@app.get("/api/terrain-types")
def get_terrain_types() -> dict:
    return {
        name: {
            "elevation": e, "blocks_los": b, "los_points": p, "move_cost": mapgen.TERRAIN_MOVE_COST[name],
        }
        for name, (e, b, p) in mapgen.TERRAIN_DEFAULTS.items()
    }


class MapGenerateIn(BaseModel):
    name: str
    width: int = 12
    height: int = 10
    biome: str = "grasslands"


@app.post("/api/campaigns/{campaign_id}/maps/generate")
def generate_map(campaign_id: int, body: MapGenerateIn) -> dict:
    _require_campaign(campaign_id)
    try:
        return mapgen.generate_map(campaign_id, body.name, body.width, body.height, body.biome)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/maps/{map_id}")
def get_map(map_id: int) -> dict:
    m = maps.get_map(map_id)
    if not m:
        raise HTTPException(404, f"Map {map_id} not found")
    return m


@app.delete("/api/maps/{map_id}")
def delete_map(map_id: int) -> dict:
    if not maps.delete_map(map_id):
        raise HTTPException(404, f"Map {map_id} not found")
    return {"ok": True}


def _require_map(map_id: int) -> dict:
    m = maps.get_map(map_id)
    if not m:
        raise HTTPException(404, f"Map {map_id} not found")
    return m


async def _broadcast_visibility(campaign_id: int, map_id: int) -> None:
    """Same visibility_update (+ unit_revealed) broadcast move_unit below
    already does, factored out so every other mutation that changes what
    a table view should render (creating/deleting a unit, deleting a
    pilot/mech, reassigning a mech's pilot) can push it too — a GM
    action was invisible to an already-open Mesa/other-GM view until it
    happened to also change visibility for some other reason."""
    visibility = units.combined_visibility(campaign_id, map_id)
    await manager.broadcast(campaign_id, {"type": "visibility_update", **visibility})
    for revealed_id in visibility["newly_revealed"]:
        await manager.broadcast(campaign_id, {"type": "unit_revealed", "unit_id": revealed_id})


class TilePatchIn(BaseModel):
    elevation: int | None = None
    blocks_los: bool | None = None
    terrain: str | None = None
    los_points: int | None = None


@app.patch("/api/maps/{map_id}/tiles/{q}/{r}")
def patch_tile(map_id: int, q: int, r: int, body: TilePatchIn) -> dict:
    _require_map(map_id)
    updated = maps.update_tile(map_id, q, r, **body.model_dump())
    if not updated:
        raise HTTPException(404, f"Tile ({q}, {r}) not found on map {map_id}")
    return updated


class UnitIn(BaseModel):
    q: int
    r: int
    mech_id: int | None = None
    pilot_id: int | None = None
    facing_deg: int = 0
    is_ghost: bool = False
    dnd_character_id: int | None = None


@app.post("/api/maps/{map_id}/units")
async def create_unit(map_id: int, body: UnitIn) -> dict:
    m = _require_map(map_id)
    created = units.create_unit(
        campaign_id=m["campaign_id"],
        map_id=map_id,
        q=body.q,
        r=body.r,
        mech_id=body.mech_id,
        pilot_id=body.pilot_id,
        facing_deg=body.facing_deg,
        is_ghost=body.is_ghost,
        dnd_character_id=body.dnd_character_id,
    )
    # Placing a token (GM sidebar drag, or a freshly-created mech) used to
    # be invisible to an already-open Mesa view until something else
    # happened to also touch visibility — same gap move_unit already
    # closed for repositioning.
    await _broadcast_visibility(m["campaign_id"], map_id)
    return created


@app.get("/api/maps/{map_id}/units")
def get_units(map_id: int) -> list[dict]:
    _require_map(map_id)
    return units.list_units(map_id)


class UnitMoveIn(BaseModel):
    q: int
    r: int
    facing_deg: int | None = None


@app.post("/api/units/{unit_id}/move")
async def move_unit(unit_id: int, body: UnitMoveIn) -> dict:
    unit = units.get_unit(unit_id)
    if not unit:
        raise HTTPException(404, f"Unit {unit_id} not found")
    updated = units.move_unit(unit_id, body.q, body.r, body.facing_deg)
    # A free-form reposition (drag, "Mover", sidebar drop) during this
    # pilot's movement-phase turn still counts as their move for the
    # round — otherwise activeMoverPilotId never advances past them and
    # the phase gets stuck on that pilot forever unless the GM happens
    # to use Caminar/Correr/Saltar specifically (see
    # movement.py::record_free_move).
    round_state = turns.get_round(unit["campaign_id"])
    if unit["pilot_id"] is not None and unit["pilot_id"] in round_state["movement_order"]:
        movement.record_free_move(unit["campaign_id"], unit, body.q, body.r)
        await manager.broadcast(unit["campaign_id"], {"type": "round_updated", **turns.get_round(unit["campaign_id"])})
    await _broadcast_visibility(unit["campaign_id"], unit["map_id"])
    return updated


@app.get("/api/maps/{map_id}/visibility")
def get_visibility(map_id: int) -> dict:
    m = _require_map(map_id)
    return units.combined_visibility(m["campaign_id"], map_id)


@app.get("/api/units/{unit_id}/reachable-hexes")
def get_reachable_hexes(unit_id: int, movement_type: str) -> list[dict]:
    """Hexes this unit could move to right now via walk/run/jump — see
    app/systems/battletech/movement.py::reachable_hexes."""
    try:
        hexes = movement.reachable_hexes(unit_id, movement_type)  # type: ignore[arg-type]
    except movement.UnknownMovementType as exc:
        raise HTTPException(422, str(exc)) from exc
    if hexes is None:
        raise HTTPException(404, f"Unit {unit_id} not found")
    return hexes


class MoveWithMpIn(BaseModel):
    q: int
    r: int
    movement_type: str
    # Optional — GM/player explicitly picked a final facing (same "pick
    # a direction after the move" UX as the free-form /move's own
    # FacingPicker); omitted, execute_move keeps its default of facing
    # the direction of the last step.
    facing_deg: int | None = None


@app.post("/api/units/{unit_id}/move-with-mp")
async def move_unit_with_mp(unit_id: int, body: MoveWithMpIn) -> dict:
    """Movement-phase move — unlike the free-form /move above, the
    destination is validated server-side against the unit's own real
    movement range (app/systems/battletech/movement.py::execute_move),
    and the move is recorded for this round's attacker/target-movement
    to-hit modifiers."""
    unit = units.get_unit(unit_id)
    if not unit:
        raise HTTPException(404, f"Unit {unit_id} not found")
    try:
        updated = movement.execute_move(
            unit["campaign_id"], unit_id, body.q, body.r, body.movement_type, body.facing_deg,  # type: ignore[arg-type]
        )
    except (movement.UnknownMovementType, movement.UnreachableDestination) as exc:
        raise HTTPException(422, str(exc)) from exc
    await _broadcast_visibility(unit["campaign_id"], unit["map_id"])
    await manager.broadcast(unit["campaign_id"], {"type": "round_updated", **turns.get_round(unit["campaign_id"])})
    return updated


class RequestMovementIn(BaseModel):
    movement_type: str


@app.post("/api/units/{unit_id}/request-movement")
async def request_movement(unit_id: int, body: RequestMovementIn) -> dict:
    """PlayerView has no map of its own — this computes the reachable
    hexes and broadcasts them so TableView (the shared board) can paint
    the highlight and capture the confirming click, the same "triggered
    from Acciones, executed on the shared table" split the initiative
    dice throw already uses."""
    unit = units.get_unit(unit_id)
    if not unit:
        raise HTTPException(404, f"Unit {unit_id} not found")
    try:
        hexes = movement.reachable_hexes(unit_id, body.movement_type)  # type: ignore[arg-type]
    except movement.UnknownMovementType as exc:
        raise HTTPException(422, str(exc)) from exc
    message = {
        "type": "movement_started",
        "pilot_id": unit["pilot_id"],
        "unit_id": unit_id,
        "movement_type": body.movement_type,
        "hexes": hexes,
    }
    await manager.broadcast(unit["campaign_id"], message)
    return message


@app.get("/api/units/{unit_id}/visible-hexes")
def get_unit_visible_hexes(unit_id: int) -> list[dict]:
    """Raw LoS debug view for one unit — see units.visible_hexes_from_unit."""
    hexes = units.visible_hexes_from_unit(unit_id)
    if hexes is None:
        raise HTTPException(404, f"Unit {unit_id} not found")
    return hexes


@app.get("/api/units/{unit_id}/visible-enemies")
def get_unit_visible_enemies(unit_id: int) -> list[dict]:
    """Enemy units in this unit's facing cone + LoS — see units.visible_enemies_from_unit."""
    enemies = units.visible_enemies_from_unit(unit_id)
    if enemies is None:
        raise HTTPException(404, f"Unit {unit_id} not found")
    return enemies


# ---- combat (Fase R2 core: to-hit, hit location, damage, undo) ----------


class AttackIn(BaseModel):
    # Derived from the attacker's own pilot when attacker_unit_id is given
    # and this is omitted — see combat.resolve_attack's docstring. Only
    # needed explicitly for the legacy manual (no unit ids) path.
    gunnery: int | None = None
    # attacker_unit_id/target_unit_id (both required together) switch on
    # real server-side validation in combat.resolve_attack (LOS, weapon
    # range, real side/movement) — target_mech_id/range_bracket/side then
    # become optional overrides the server mostly ignores in favor of the
    # real computed value; see resolve_attack's own docstring. Omitting
    # both IDs keeps the legacy fully-manual path.
    attacker_unit_id: int | None = None
    target_unit_id: int | None = None
    target_mech_id: int | None = None
    damage: int | None = None
    weapon_id: int | None = None
    attacker_movement: str | None = None
    target_hexes_moved: int | None = None
    target_jumped: bool | None = None
    range_bracket: str | None = None
    side: str | None = None
    other_modifiers: int = 0


@app.post("/api/campaigns/{campaign_id}/attack")
async def attack(campaign_id: int, body: AttackIn) -> dict:
    campaign = _require_campaign(campaign_id)
    try:
        result = combat.resolve_attack(campaign_id=campaign_id, **body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(campaign_id, {"type": "attack_result", **result})
    # A shot changes heat/ammo (always) and armor/structure (on a hit) —
    # every connected client needs to see that on the mech sheet, not just
    # whichever GM screen happened to trigger it (GMView's own
    # submitAttackFromPanel already refetches locally after this returns,
    # which is why this bug was easy to miss). Same visibility_update +
    # round_updated pairing app/main.py's move-with-mp already broadcasts.
    if campaign["active_map_id"] is not None:
        await _broadcast_visibility(campaign_id, campaign["active_map_id"])
    await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
    return result


@app.post("/api/campaigns/{campaign_id}/undo")
async def undo(campaign_id: int) -> dict:
    campaign = _require_campaign(campaign_id)
    result = combat.undo_last_action(campaign_id)
    if not result:
        raise HTTPException(404, "No action to undo")
    await manager.broadcast(campaign_id, {"type": "action_undone", **result})
    # Reverts armor/structure too — same live-sheet fix as /attack above.
    if campaign["active_map_id"] is not None:
        await _broadcast_visibility(campaign_id, campaign["active_map_id"])
    return result


# ---- rounds/initiative (ROADMAP.md S2 — simplified, see turns.py) ------


@app.get("/api/campaigns/{campaign_id}/round")
def get_round(campaign_id: int) -> dict:
    _require_campaign(campaign_id)
    return turns.get_round(campaign_id)


@app.post("/api/campaigns/{campaign_id}/round/start")
async def start_round(campaign_id: int) -> dict:
    _require_campaign(campaign_id)
    result = turns.start_round(campaign_id)
    await manager.broadcast(campaign_id, {"type": "round_started", **result})
    return result


class RoundActIn(BaseModel):
    pilot_id: int


@app.post("/api/campaigns/{campaign_id}/round/act")
async def mark_round_acted(campaign_id: int, body: RoundActIn) -> dict:
    _require_campaign(campaign_id)
    result = turns.mark_acted(campaign_id, body.pilot_id)
    await manager.broadcast(campaign_id, {"type": "round_updated", **result})
    return result


class RollInitiativeIn(BaseModel):
    pilot_id: int


@app.post("/api/campaigns/{campaign_id}/round/roll-initiative")
async def request_round_initiative(campaign_id: int, body: RollInitiativeIn) -> dict:
    """Doesn't roll anything itself — validates the pilot may roll right
    now and broadcasts "please physically throw dice for this pilot" to
    every connected client. The shared table (TableView) is the one that
    actually rolls, by reporting whatever its physics dice land on (see
    /round/report-initiative below) — this app no longer has a
    server-side random-number stand-in for this flow."""
    _require_campaign(campaign_id)
    try:
        result = turns.request_pilot_initiative(campaign_id, body.pilot_id)
    except (turns.WrongInitiativeMode, turns.RoundNotStarted, turns.UnknownCombatPilot) as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(campaign_id, {"type": "initiative_roll_requested", **result})
    return result


class ReportInitiativeIn(BaseModel):
    pilot_id: int
    roll: int
    # Each individual d6 face the physics dice actually landed on (2
    # entries for a 2d6 initiative roll) — logged into the same `rolls`
    # history table the generic dice tray already uses, purely so the
    # real distribution can be checked later ("comprobar como de reales
    # son, si tienen las probabilidades bien repartidas"). Optional so an
    # older client that only ever sends the sum doesn't 422.
    dice: list[int] = []


@app.post("/api/campaigns/{campaign_id}/round/report-initiative")
async def report_round_initiative(campaign_id: int, body: ReportInitiativeIn) -> dict:
    """The shared table calls this once its two dice have actually come
    to rest, with the real value they landed on."""
    _require_campaign(campaign_id)
    try:
        result = turns.report_pilot_initiative(campaign_id, body.pilot_id, body.roll)
    except (turns.WrongInitiativeMode, turns.RoundNotStarted, turns.UnknownCombatPilot, turns.InvalidRollValue) as exc:
        raise HTTPException(422, str(exc)) from exc
    for die_value in body.dice:
        if 1 <= die_value <= 6:
            rolls.insert_roll(campaign_id, "d6", die_value, body.pilot_id, label="iniciativa")
    await manager.broadcast(campaign_id, {"type": "round_updated", **result})
    return result


# ---- D&D 5e (ROADMAP.md Fase R4 — segundo sistema, slice mínimo de
# validación de la arquitectura de plugins). Deliberadamente una familia
# de endpoints separada, no una reutilización genérica de /attack o
# /round/* de arriba — mech+piloto vs. una ficha única son formas
# demasiado distintas para forzar una interfaz común con solo dos
# sistemas reales de referencia (ver ROADMAP.md, Fase R4). Los endpoints
# de mapa/unidad (arriba) SÍ se reutilizan tal cual — ya son genéricos
# por grid_type desde la Fase S0. -------------------------------------


def _require_dnd_campaign(campaign_id: int) -> dict:
    campaign = _require_campaign(campaign_id)
    if campaign["system"] != "dnd5e":
        raise HTTPException(422, f"Campaign {campaign_id} is not a D&D 5e campaign")
    return campaign


class DndCharacterIn(BaseModel):
    # Pydantic can't build a model with a field literally named `int`
    # annotated `int` (collides internally, unlike a plain Python
    # function parameter — see characters.create_character, which uses
    # bare `str`/`int` params without issue). `str_`/`int_` + an alias
    # keeps the wire format ("str": 16, "int": 8) matching D&D's own
    # ability names — see create_dnd_character's model_dump(by_alias=True).
    model_config = ConfigDict(populate_by_name=True)
    name: str
    str_: int = Field(10, alias="str")
    dex: int = 10
    con: int = 10
    int_: int = Field(10, alias="int")
    wis: int = 10
    cha: int = 10
    ac: int = 10
    hp_max: int = 10
    proficiency_bonus: int = 2


@app.post("/api/campaigns/{campaign_id}/dnd/characters")
def create_dnd_character(campaign_id: int, body: DndCharacterIn) -> dict:
    _require_dnd_campaign(campaign_id)
    return dnd_characters.create_character(campaign_id, **body.model_dump(by_alias=True))


@app.get("/api/campaigns/{campaign_id}/dnd/characters")
def get_dnd_characters(campaign_id: int) -> list[dict]:
    _require_dnd_campaign(campaign_id)
    return dnd_characters.list_characters(campaign_id)


class DndAttackIn(BaseModel):
    attacker_id: int
    target_id: int
    attack_mod: int
    damage_dice: str


@app.post("/api/campaigns/{campaign_id}/dnd/attack")
async def dnd_attack(campaign_id: int, body: DndAttackIn) -> dict:
    _require_dnd_campaign(campaign_id)
    try:
        result = dnd_combat.resolve_attack(body.attacker_id, body.target_id, body.attack_mod, body.damage_dice)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(campaign_id, {"type": "dnd_attack_result", **result})
    return result


@app.get("/api/campaigns/{campaign_id}/dnd/round")
def get_dnd_round(campaign_id: int) -> dict:
    _require_dnd_campaign(campaign_id)
    return dnd_turns.get_round(campaign_id)


@app.post("/api/campaigns/{campaign_id}/dnd/round/start")
async def start_dnd_round(campaign_id: int) -> dict:
    _require_dnd_campaign(campaign_id)
    result = dnd_turns.start_round(campaign_id)
    await manager.broadcast(campaign_id, {"type": "dnd_round_started", **result})
    return result


class DndRoundActIn(BaseModel):
    character_id: int


@app.post("/api/campaigns/{campaign_id}/dnd/round/act")
async def mark_dnd_round_acted(campaign_id: int, body: DndRoundActIn) -> dict:
    _require_dnd_campaign(campaign_id)
    result = dnd_turns.mark_acted(campaign_id, body.character_id)
    await manager.broadcast(campaign_id, {"type": "dnd_round_updated", **result})
    return result


# ---- rolls, scoped per campaign -----------------------------------------


@app.get("/api/campaigns/{campaign_id}/rolls")
def get_recent_rolls(campaign_id: int, limit: int = 200) -> list[dict]:
    _require_campaign(campaign_id)
    return rolls.recent_rolls(campaign_id, limit)


# Registered before /ws/{campaign_id}: that route's path template has no
# :int converter (FastAPI validates campaign_id as a parameter, not at
# the Starlette route-matching level), so if /ws/hub were registered
# after it, "/ws/hub" would match /ws/{campaign_id} first and fail int
# conversion instead of ever reaching this route.
@app.websocket("/ws/hub")
async def ws_hub_endpoint(websocket: WebSocket) -> None:
    await hub_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub_manager.disconnect(websocket)


@app.websocket("/ws/{campaign_id}")
async def ws_endpoint(websocket: WebSocket, campaign_id: int) -> None:
    if not campaigns.get_campaign(campaign_id):
        await websocket.close(code=4404)
        return

    await manager.connect(campaign_id, websocket)
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "roll":
                die = message.get("die", "d6")
                pilot_id = message.get("pilot_id")
                label = message.get("label")
                result = rolls.resolve(die)
                record = rolls.insert_roll(campaign_id, die, result, pilot_id, label)
                await manager.broadcast(campaign_id, {"type": "roll_result", **record})
    except WebSocketDisconnect:
        manager.disconnect(campaign_id, websocket)
