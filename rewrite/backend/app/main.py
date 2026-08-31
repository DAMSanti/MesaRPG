"""MesaRPG rewrite backend (ROADMAP.md Fase R0 onward).

Two game systems live behind this one API today: BattleTech (the
original, full rules engine — app/systems/battletech/) and D&D 5e (Fase
R4, a deliberately minimal validation slice — app/systems/dnd5e/). Map/
unit endpoints are shared (already generic by grid_type since Fase S0);
character/combat/round endpoints are separate families per system, not
a forced common interface — see rewrite/README.md for exactly what's in
and out of scope for each.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from . import board_marks, campaigns, db, dice_resolution, dice_styles, equipment, events, mapgen, maps, mech_annotations, mech_templates, model_config, rolls, systems, table_session, units
from .systems.battletech import combat, mechs, melee, movement, pilots, psr, turns, weapons
from .systems.dnd5e import characters as dnd_characters
from .systems.dnd5e import combat as dnd_combat
from .systems.dnd5e import turns as dnd_turns
from .ws import hub_manager, manager

# uvicorn's own logger, not this module's: uvicorn configures its handlers
# and leaves the root logger alone, so anything logged through
# getLogger(__name__) propagates to a root with no handler and is dropped at
# INFO. A startup message nobody can see is not a startup message.
logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    # MechLab's authored model config ships with the code, not in the
    # database -- see model_config for why, and for what "per model" means
    # here. Logged rather than silent: a database that rewrites part of
    # itself on boot should say so.
    seeded = model_config.seed_from_file()
    if any(seeded.values()):
        logger.info(
            "Configuracion de modelos sembrada desde %s: %s",
            model_config.SEED_PATH.name, seeded,
        )
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
    campaign = _require_campaign(campaign_id)
    target_map = _require_map(body.map_id)
    result = campaigns.set_active_map(campaign_id, body.map_id)
    # Logged here (not campaigns.py) since campaigns/maps already import
    # each other in the other direction — see events.py's own docstring
    # on why cross-module undo logging sometimes lives at this layer.
    with db.connect() as conn:
        events.log_event(
            conn, campaign_id, "map_projected", f"Mapa proyectado: {target_map['name']}",
            {"prev_active_map_id": campaign["active_map_id"]},
        )
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


class GmDieStyleIn(BaseModel):
    style: str | None = None


@app.post("/api/campaigns/{campaign_id}/gm-die-style")
async def set_gm_die_style(campaign_id: int, body: GmDieStyleIn) -> dict:
    _require_campaign(campaign_id)
    try:
        updated = campaigns.set_gm_die_style(campaign_id, body.style)
    except dice_styles.UnknownDieStyle as exc:
        raise HTTPException(422, str(exc)) from exc
    except dice_styles.DieStyleTaken as exc:
        raise HTTPException(409, str(exc)) from exc
    # Deliberate deviation from set_initiative_mode above (which never
    # broadcasts) — other clients' style pickers need to learn in real
    # time that the GM just took a slot, same reason every pilot
    # mutation already broadcasts roster_updated.
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
    return updated


class EnemyRevealCinematicIn(BaseModel):
    enabled: bool


@app.post("/api/campaigns/{campaign_id}/enemy-reveal-cinematic")
async def set_enemy_reveal_cinematic(campaign_id: int, body: EnemyRevealCinematicIn) -> dict:
    _require_campaign(campaign_id)
    updated = campaigns.set_enemy_reveal_cinematic(campaign_id, body.enabled)
    # Same reasoning as gm-die-style above — TableView (the one screen
    # that actually shows the cinematic) needs to learn the GM just
    # toggled this live, not only on its next unrelated refetch.
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
    return updated


class GmDiceModeIn(BaseModel):
    mode: str


@app.post("/api/campaigns/{campaign_id}/gm-dice-mode")
async def set_gm_dice_mode(campaign_id: int, body: GmDiceModeIn) -> dict:
    """Real user request/correction: "el GM también tiene que poder
    escoger entre dados físicos o tiradas automáticas... O TODOS SUS
    PILOTOS TIRAN AUTOMATICO O TODOS TIRAN FISICO" — one campaign-wide
    switch, not a per-pilot setting (unlike a player's own dice_mode).
    See dice_resolution.py's own _dice_mode_for."""
    _require_campaign(campaign_id)
    try:
        updated = campaigns.set_gm_dice_mode(campaign_id, body.mode)
    except pilots.UnknownDiceMode as exc:
        raise HTTPException(422, str(exc)) from exc
    # Same reasoning as gm-die-style/enemy-reveal-cinematic above.
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
    return updated


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
    # Real user request/report: PlayerView's own pilot picker must not
    # offer a pilot someone else already claimed as theirs — the raw
    # owner_token itself never leaves the server (same as before), but
    # "is somebody's" now does, so the picker can filter those out
    # instead of letting a second device silently start acting as the
    # same character.
    sanitized["is_claimed"] = owner_token is not None
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
async def create_pilot(
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
    except pilots.DuplicateOwnerPilot as exc:
        raise HTTPException(409, str(exc)) from exc
    # Without this, a player submitting their own ficha never shows up
    # on an already-open GM screen (or vice versa for review/resubmit
    # below) until someone reloads — real user report ("no se actualiza
    # en tiempo real"). No payload beyond the type: every listener just
    # refetches its own pilots/mechs list, same as a fresh page load.
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
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
    dice_mode: str | None = None


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
    except (pilots.UnknownFaction, pilots.UnknownDiceMode) as exc:
        raise HTTPException(422, str(exc)) from exc
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_pilot(updated, x_device_token)


class DieStyleIn(BaseModel):
    style: str | None = None


@app.post("/api/pilots/{pilot_id}/die-style")
async def set_pilot_die_style(
    pilot_id: int, body: DieStyleIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    """A dedicated endpoint rather than folding into PilotPatchIn above —
    see pilots.set_pilot_die_style's own docstring on why style=None
    needs to mean "clear it", which PilotPatchIn's generic
    None-means-unchanged semantics can't express."""
    _require_owner(_require_pilot(pilot_id), x_device_token)
    try:
        updated = pilots.set_pilot_die_style(pilot_id, body.style)
    except dice_styles.UnknownDieStyle as exc:
        raise HTTPException(422, str(exc)) from exc
    except dice_styles.DieStyleTaken as exc:
        raise HTTPException(409, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
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


@app.post("/api/pilots/{pilot_id}/claim")
async def claim_pilot(
    pilot_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    """PlayerView's "¿Quién eres?" picker calls this before finalizing a
    choice — real user request: a pilot already claimed by another
    device must not be selectable by a second one. Requires a device
    token (an anonymous device can't claim anything); a same-device
    re-claim of its own pilot is a no-op, a different device claiming an
    already-owned pilot is rejected."""
    _require_pilot(pilot_id)
    if not x_device_token:
        raise HTTPException(400, "X-Device-Token header is required to claim a pilot")
    try:
        updated = pilots.claim_pilot(pilot_id, x_device_token)
    except pilots.PilotAlreadyClaimed as exc:
        raise HTTPException(409, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_pilot(updated, x_device_token)


class ReviewIn(BaseModel):
    decision: str
    note: str | None = None


@app.post("/api/pilots/{pilot_id}/review")
async def review_pilot(
    pilot_id: int, body: ReviewIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_pilot(pilot_id)
    try:
        updated = pilots.review_pilot(pilot_id, body.decision, body.note)
    except pilots.UnknownStatus as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_pilot(updated, x_device_token)


@app.post("/api/pilots/{pilot_id}/resubmit")
async def resubmit_pilot(
    pilot_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_pilot(pilot_id), x_device_token)
    try:
        updated = pilots.resubmit_pilot(pilot_id)
    except pilots.InvalidStatusTransition as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_pilot(updated, x_device_token)


@app.delete("/api/pilots/{pilot_id}")
async def delete_pilot(pilot_id: int) -> dict:
    # GM-only action (no _require_owner) — same as review_pilot above,
    # not an owner-initiated edit.
    deleted_pilot = _require_pilot(pilot_id)
    affected_maps = units.maps_for_pilot(pilot_id)
    pilots.delete_pilot(pilot_id)
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    await manager.broadcast(deleted_pilot["campaign_id"], {"type": "roster_updated"})
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
async def create_mech(
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
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
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
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_mech(updated, x_device_token)


class ClaimMechIn(BaseModel):
    pilot_id: int


@app.post("/api/mechs/{mech_id}/claim")
async def claim_mech(mech_id: int, body: ClaimMechIn) -> dict:
    """A player claims an unassigned mech from the campaign's own roster
    (PlayerView's "elegir un mech existente", real user request) —
    deliberately a separate endpoint from the generic PATCH above, which
    stays unrestricted for the GM's own "Editar mech" reassignment
    (a trusted admin action). This one refuses to hand a mech to a
    second pilot once it already has a different one (real user report:
    "un mismo mech no le pueden usar dos players")."""
    _require_mech(mech_id)
    try:
        updated = mechs.claim_mech(mech_id, body.pilot_id)
    except mechs.MechAlreadyClaimed as exc:
        raise HTTPException(409, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return updated


@app.post("/api/mechs/{mech_id}/review")
async def review_mech(
    mech_id: int, body: ReviewIn, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_mech(mech_id)
    try:
        updated = mechs.review_mech(mech_id, body.decision, body.note)
    except mechs.UnknownStatus as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_mech(updated, x_device_token)


@app.post("/api/mechs/{mech_id}/resubmit")
async def resubmit_mech(
    mech_id: int, x_device_token: str | None = Header(default=None, alias="X-Device-Token")
) -> dict:
    _require_owner(_require_mech(mech_id), x_device_token)
    try:
        updated = mechs.resubmit_mech(mech_id)
    except mechs.InvalidStatusTransition as exc:
        raise HTTPException(422, str(exc)) from exc
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
    return _sanitize_mech(updated, x_device_token)


@app.delete("/api/mechs/{mech_id}")
async def delete_mech(mech_id: int) -> dict:
    # GM-only action (no _require_owner) — same as review_mech above,
    # not an owner-initiated edit.
    deleted_mech = _require_mech(mech_id)
    affected_maps = units.maps_for_mech(mech_id)
    mechs.delete_mech(mech_id)
    for campaign_id, map_id in affected_maps:
        await _broadcast_visibility(campaign_id, map_id)
    await manager.broadcast(deleted_mech["campaign_id"], {"type": "roster_updated"})
    return {"deleted": True}


class MechLocationPatchIn(BaseModel):
    armor_current: int | None = None
    armor_rear_current: int | None = None
    structure_current: int | None = None
    armor_max: int | None = None
    armor_rear_max: int | None = None
    structure_max: int | None = None


@app.patch("/api/mechs/{mech_id}/locations/{location}")
async def patch_mech_location(
    mech_id: int, location: str, body: MechLocationPatchIn,
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
) -> dict:
    if location not in db.MECH_LOCATIONS:
        raise HTTPException(422, f"Unknown location {location!r}")
    _require_owner(_require_mech(mech_id), x_device_token)
    updated = mechs.update_location(mech_id, location, **body.model_dump())
    # Everyone looking at this mech needs to hear about it, not just the
    # screen that made the edit. Structure reaching zero is what the 3D
    # views read as "that limb came off" (GMView's own
    # severedLocationsByUnitId), so without this a limb blown off in one
    # view stayed attached in every other one until something unrelated
    # happened to refresh them -- and a pencil-marked armour change is a
    # fact about the board like any other. One patch per committed edit,
    # not per keystroke, so this is not a chatty broadcast.
    await manager.broadcast(updated["campaign_id"], {"type": "roster_updated"})
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
def list_mech_chassis() -> list[dict]:
    """The GM's/player's chassis dropdown (ROADMAP.md Fase R3 follow-up)
    — a distinct path from /api/mech-import/{filename} below on purpose,
    so "chassis" is never ambiguous with a real .mtf filename. Each
    entry's own tonnage (real user request: group this dropdown by
    Light/Medium/Heavy/Assault) lives here, not a second round trip."""
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


# ---- MechLab (real user request: "una pequeña vista dentro de nuestra
# app donde seleccione el modelo del mech que quiero... y que yo tenga una
# forma de decirte a ti donde esta cada cosa") — dev-only 3D annotation
# tool, global/unscoped by campaign like everything else in this block.

class MechAnnotationPointIn(BaseModel):
    kind: str
    location: str | None = None
    x: float = 0
    y: float = 0
    z: float = 0
    mesh_names: list[str] | None = None


class MechAnnotationsSaveIn(BaseModel):
    model_url: str
    points: list[MechAnnotationPointIn]


@app.get("/api/mech-annotations")
def list_mech_annotations() -> list[dict]:
    return mech_annotations.list_annotations()


@app.put("/api/mech-annotations")
def save_mech_annotations(body: MechAnnotationsSaveIn) -> list[dict]:
    try:
        return mech_annotations.save_annotations(body.model_url, [p.model_dump() for p in body.points])
    except mech_annotations.InvalidAnnotation as exc:
        raise HTTPException(422, str(exc)) from exc


class MechAnnotationReviewIn(BaseModel):
    chassis: str
    track: str
    status: str


@app.get("/api/mech-annotations/review")
def list_mech_annotation_review() -> list[dict]:
    return mech_annotations.list_review()


@app.put("/api/mech-annotations/review")
def set_mech_annotation_review(body: MechAnnotationReviewIn) -> dict:
    try:
        return mech_annotations.set_review_status(body.chassis, body.track, body.status)
    except mech_annotations.InvalidReview as exc:
        raise HTTPException(422, str(exc)) from exc


# Real user request: "quiero poder guardarlo desde el mechlab y como lo
# demas, 3 estados y un marcador en el desplegable" — persists MechLabView's
# Textura tab (live PBR tuning, see Mech3D.tsx's own MechPbrSettings/
# useMechPbr). Review status for this tab reuses the existing
# /api/mech-annotations/review endpoint above with track='texture', same
# as weapons/limbs/rig — only the actual slider VALUES need their own
# storage/endpoint here.
class MechPbrSettingsIn(BaseModel):
    model_url: str
    repeat: float
    body_normal_scale: float
    body_roughness: float
    body_metalness: float
    body_color_boost: float
    body_ao_intensity: float
    body_metal_roughness: float
    body_metal_metalness: float
    body_metal_normal_scale: float
    body_metal_color_boost: float
    weapons_normal_scale: float
    weapons_roughness: float
    weapons_metalness: float
    weapons_color_boost: float
    weapons_ao_intensity: float
    weapons_metal_roughness: float
    weapons_metal_metalness: float
    weapons_metal_normal_scale: float
    weapons_metal_color_boost: float
    cockpit_normal_scale: float
    cockpit_roughness: float
    cockpit_metalness: float
    cockpit_color_boost: float
    cockpit_ao_intensity: float


@app.get("/api/mech-pbr-settings")
def list_mech_pbr_settings() -> list[dict]:
    return mech_annotations.list_pbr_settings()


@app.put("/api/mech-pbr-settings")
def save_mech_pbr_settings(body: MechPbrSettingsIn) -> dict:
    try:
        return mech_annotations.save_pbr_settings(body.model_url, body.model_dump(exclude={"model_url"}))
    except mech_annotations.InvalidPbrSettings as exc:
        raise HTTPException(422, str(exc)) from exc


# Real user request: "en la seccion de huella, quiero un boton de guardar,
# para cuando capture una, que se use esa siempre" — see db.py's own
# mech_footprint_masks doc comment.
class MechFootprintMaskIn(BaseModel):
    model_url: str
    image_data_url: str
    half_width: float
    half_depth: float


@app.get("/api/mech-footprint-masks")
def list_mech_footprint_masks() -> list[dict]:
    return mech_annotations.list_footprint_masks()


@app.put("/api/mech-footprint-masks")
def save_mech_footprint_mask(body: MechFootprintMaskIn) -> dict:
    try:
        return mech_annotations.save_footprint_mask(
            body.model_url, body.image_data_url, body.half_width, body.half_depth
        )
    except mech_annotations.InvalidFootprintMask as exc:
        raise HTTPException(422, str(exc)) from exc


# Real user report: the per-mech muzzle auto-detect "no funciona muy
# bien" — real user request instead: browse each weapon's own model,
# click its firing point once, apply it to that exact mount. Real
# follow-up correction: "los mechs pueden tener varias armas de un
# tipo... el autodetectar solo esta detectando 1" — see db.py's own
# weapon_muzzle_points doc comment for why this is keyed by
# (model_url, mount_key, visual), not visual_bucket alone.
class WeaponMuzzlePointIn(BaseModel):
    model_url: str
    mount_key: str
    visual: str
    x: float
    y: float
    z: float


@app.get("/api/weapon-muzzle-points")
def list_weapon_muzzle_points() -> list[dict]:
    return mech_annotations.list_weapon_muzzle_points()


@app.put("/api/weapon-muzzle-points")
def save_weapon_muzzle_point(body: WeaponMuzzlePointIn) -> dict:
    try:
        return mech_annotations.save_weapon_muzzle_point(
            body.model_url, body.mount_key, body.visual, body.x, body.y, body.z
        )
    except mech_annotations.InvalidWeaponMuzzlePoint as exc:
        raise HTTPException(422, str(exc)) from exc


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


class BoardMarkIn(BaseModel):
    kind: str
    x: float
    z: float
    data: dict | None = None


@app.get("/api/maps/{map_id}/marks")
def list_board_marks(map_id: int, kind: str | None = None) -> list[dict]:
    """Everything the board is carrying: severed limbs, and later craters
    and footprints. Read once when a client opens a map — see
    board_marks.py on why the three share one table."""
    if not maps.get_map(map_id):
        raise HTTPException(404, f"Map {map_id} not found")
    return board_marks.marks_for_map(map_id, kind)


@app.post("/api/maps/{map_id}/marks")
async def add_board_mark(map_id: int, body: BoardMarkIn) -> dict:
    m = maps.get_map(map_id)
    if not m:
        raise HTTPException(404, f"Map {map_id} not found")
    try:
        mark = board_marks.add_mark(map_id, body.kind, body.x, body.z, body.data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    # Broadcast so every other view drops the same limb in the same place,
    # instead of only the client that happened to witness it. The socket is
    # per CAMPAIGN, not per map, so the map's own campaign is what to send
    # it to.
    await manager.broadcast(m["campaign_id"], {"type": "board_mark", "mark": mark})
    return mark


@app.delete("/api/maps/{map_id}/marks/{mark_id}")
async def remove_board_mark(map_id: int, mark_id: int) -> dict:
    """Removes one mark -- a limb that has been put back on its mech.

    Broadcast like the POST is, so a board someone else is watching loses
    the piece at the same time this one does."""
    m = maps.get_map(map_id)
    if not m:
        raise HTTPException(404, f"Map {map_id} not found")
    removed = board_marks.remove_mark(mark_id)
    if removed:
        await manager.broadcast(
            m["campaign_id"], {"type": "board_mark_removed", "mark_id": mark_id},
        )
    return {"removed": removed}


@app.delete("/api/maps/{map_id}/marks")
def clear_board_marks(map_id: int, kind: str | None = None) -> dict:
    """Wipes the scenery — for a fresh battle on the same terrain."""
    if not maps.get_map(map_id):
        raise HTTPException(404, f"Map {map_id} not found")
    return {"removed": board_marks.clear_marks(map_id, kind)}


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


def _unit_walked_payload(unit: dict, path: list[dict], final_facing_deg: int, movement_type: str = "walk") -> dict:
    """Real user request: "la niebla se tiene que ir disipando con cada
    movimiento... cada giro, cada paso del mech tiene que actualizar la
    niebla, tanto en TableView como en FPV. Ahora mismo calcula la de la
    posicion final nada mas empezar el movimiento" — every unit_walked
    broadcast now carries per-waypoint fog snapshots the frontend applies
    exactly when its own walk animation reaches each hex, instead of the
    whole fog jumping straight to the final destination's the instant
    the move starts: fog_steps (TableView's team-wide combined fog) and
    cockpit_fog_steps (FirstPersonView's own single-mech sightline —
    getUnitVisibleHexes' own LoS, not the team union). Both only
    computed for a player-faction walker — an enemy/npc's own movement
    never changes what the player team's stationary units (or their own
    single mech, for the cockpit version) can see (units.py's
    visibility_steps_for_walk/unit_visibility_steps_for_walk's own doc
    comments), so there's nothing to step through for one and every
    other mover keeps the old single-broadcast-at-the-end behavior.

    `movement_type` (real user request: proper Walk/Run/Jump animation
    chains on the frontend, not the same Idle/Walk crossfade for every
    move) — defaults to "walk" for move_unit's free-drag path below,
    which has no real movement-type concept of its own (matches what
    record_free_move already assumes internally elsewhere)."""
    payload = {"type": "unit_walked", "unit_id": unit["id"], "path": path, "movement_type": movement_type}
    if unit["pilot_faction"] == "player":
        payload["fog_steps"] = units.visibility_steps_for_walk(
            unit["campaign_id"], unit["map_id"], unit["id"], unit["q"], unit["r"], path, final_facing_deg,
        )
        payload["cockpit_fog_steps"] = units.unit_visibility_steps_for_walk(
            unit["map_id"], unit["q"], unit["r"], path, final_facing_deg,
        )
    return payload


class TilePatchIn(BaseModel):
    elevation: int | None = None
    blocks_los: bool | None = None
    terrain: str | None = None
    los_points: int | None = None


class MapPatchIn(BaseModel):
    """The board's own clock, 0-24. See maps.set_time_of_day."""
    time_of_day: float


@app.patch("/api/maps/{map_id}")
async def patch_map(map_id: int, body: MapPatchIn) -> dict:
    m = _require_map(map_id)
    updated = maps.set_time_of_day(map_id, body.time_of_day)
    if not updated:
        raise HTTPException(404, f"Map {map_id} not found")
    # Sent as its own message rather than folded into a generic map refresh:
    # useMapState deliberately fetches a map ONCE per id (refetching it
    # recreates every tile and visibly flickers the whole board), so the
    # views need the new hour on its own, without the map around it.
    await manager.broadcast(m["campaign_id"], {
        "type": "map_time_changed",
        "map_id": map_id,
        "time_of_day": updated["time_of_day"],
    })
    return updated


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
    # A mech can only be on one map at a time (units.create_unit itself
    # enforces this) — captured *before* the create so an already-open
    # view of whatever OLD map it was on also learns it's gone, not just
    # the new map below.
    old_maps = units.maps_for_mech(body.mech_id) if body.mech_id is not None else set()
    try:
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
    except units.MechNotApproved as exc:
        raise HTTPException(422, str(exc)) from exc
    except units.HexOccupied as exc:
        raise HTTPException(409, str(exc)) from exc
    # Placing a token (GM sidebar drag, or a freshly-created mech) used to
    # be invisible to an already-open Mesa view until something else
    # happened to also touch visibility — same gap move_unit already
    # closed for repositioning.
    await _broadcast_visibility(m["campaign_id"], map_id)
    for old_campaign_id, old_map_id in old_maps:
        if old_map_id != map_id:
            await _broadcast_visibility(old_campaign_id, old_map_id)
    return created


@app.delete("/api/units/{unit_id}")
async def delete_unit(unit_id: int) -> dict:
    """Removes a token from the map (GM's "Quitar del mapa") without
    touching the mech/pilot it represents — see units.delete_unit."""
    unit = units.get_unit(unit_id)
    if not unit:
        raise HTTPException(404, f"Unit {unit_id} not found")
    units.delete_unit(unit_id)
    # Real user report: a pilot removed from the map mid-round stayed
    # stuck in that round's own participant snapshot forever, blocking
    # movement_order on a turn with no unit left to give it to.
    if unit["pilot_id"] is not None:
        turns.remove_participant(unit["campaign_id"], unit["pilot_id"])
    await _broadcast_visibility(unit["campaign_id"], unit["map_id"])
    await manager.broadcast(unit["campaign_id"], {"type": "round_updated", **turns.get_round(unit["campaign_id"])})
    return {"deleted": True}


@app.get("/api/maps/{map_id}/units")
def get_units(map_id: int) -> list[dict]:
    _require_map(map_id)
    return units.list_units(map_id)


class UnitMoveIn(BaseModel):
    q: int
    r: int
    facing_deg: int | None = None
    # Real user request: a debug-only "forzar salto" toggle that must work
    # regardless of the mech's own jump_mp/walk_mp/heat/anything — no MP
    # check, no reachable-hexes gate, just "let me see the animation".
    # This endpoint already has zero rule enforcement (real user request,
    # see its own docstring below), so it's the natural place for that:
    # purely an animation tag on the unit_walked broadcast, never
    # validated against the mech's own stats the way move-with-mp's real
    # movement_type is.
    movement_type: str | None = None


@app.post("/api/units/{unit_id}/move")
async def move_unit(unit_id: int, body: UnitMoveIn) -> dict:
    unit = units.get_unit(unit_id)
    if not unit:
        raise HTTPException(404, f"Unit {unit_id} not found")
    # Real user request: "cuando el GM hace drag, el movimiento no
    # contara MP, ni pasara turno, sin embargo si que tiene que calcular
    # el path mas barato y seguirle, y por supuesto actualizar camara y
    # LoS" — this endpoint (a free drag/"Mover"/sidebar-drop reposition,
    # NOT the MP-budgeted movement-phase flow below) never had its own
    # unit_walked broadcast, so every view watching this unit — including
    # its own pilot's FirstPersonView camera — had nothing to animate
    # through and just sat frozen on the pre-drag position/facing until
    # some UNRELATED broadcast happened to nudge it. Computed from the
    # hex BEFORE the move (unit's own q/r, still the old position here).
    avoid = {(u["q"], u["r"]) for u in units.list_units(unit["map_id"]) if u["id"] != unit_id}
    path = movement.shortest_terrain_path(unit["map_id"], unit["q"], unit["r"], body.q, body.r, avoid=avoid)
    try:
        updated = units.move_unit(unit_id, body.q, body.r, body.facing_deg)
    except units.HexOccupied as exc:
        raise HTTPException(409, str(exc)) from exc
    if path:
        await manager.broadcast(
            unit["campaign_id"],
            _unit_walked_payload(unit, path, updated["facing_deg"], body.movement_type or "walk"),
        )
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
    except movement.MechIncapacitated as exc:
        raise HTTPException(409, str(exc)) from exc
    # Real user report: a client that didn't itself pick this destination
    # (e.g. the shared table watching a move requested from PlayerView/
    # FirstPersonView) had no route data at all, so HexMap animated a
    # straight line through anything in between instead of the real
    # path — every connected client now learns the actual route to
    # populate its own local walkPaths with, regardless of who moved it.
    await manager.broadcast(
        unit["campaign_id"],
        _unit_walked_payload(unit, updated["path"], updated["facing_deg"], body.movement_type),
    )
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


async def _broadcast_physical_roll_requested(campaign_id: int, exc: dice_resolution.PendingRoll) -> None:
    """Fase B — a step needed a real physical die and a pilot in dice_mode
    'physical' owns it (dice_resolution.run_step already checked this
    before raising). Same die_style-fallback logic as turns.py's own
    request_pilot_initiative (a GM-controlled enemy/npc pilot with no
    style of its own borrows the GM's pick), duplicated rather than
    shared since that function's own docstring is specific to initiative
    and this is a different, newer broadcast type."""
    die_style = None
    pilot_name = None
    color = None
    if exc.pilot_id is not None:
        pilot = pilots.get_pilot(exc.pilot_id)
        if pilot:
            pilot_name = pilot["name"]
            color = pilot["color"]
            die_style = pilot["die_style"]
            if die_style is None and pilot["faction"] in ("enemy", "npc"):
                campaign = campaigns.get_campaign(campaign_id)
                die_style = campaign["gm_die_style"] if campaign else None
    await manager.broadcast(campaign_id, {
        "type": "physical_roll_requested",
        "pending_roll_id": exc.pending_roll_id,
        "pilot_id": exc.pilot_id,
        "pilot_name": pilot_name,
        "color": color,
        "die_style": die_style,
        "dice_spec": exc.dice_spec,
        "purpose": exc.purpose,
    })


@app.post("/api/campaigns/{campaign_id}/attack")
async def attack(campaign_id: int, body: AttackIn) -> dict:
    campaign = _require_campaign(campaign_id)
    try:
        result = combat.run_attack(campaign_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except dice_resolution.PendingRoll as exc:
        # Fase B: this pilot rolls physical dice — TableView needs to
        # actually throw them and report back (see the endpoint below)
        # before this attack can finish. No attack_result/round_updated
        # broadcast yet; those only fire once the whole thing resolves.
        await _broadcast_physical_roll_requested(campaign_id, exc)
        return {"pending": True, "pending_roll_id": exc.pending_roll_id}
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


class PendingRollReportIn(BaseModel):
    dice: list[int]


@app.post("/api/campaigns/{campaign_id}/pending-rolls/{pending_roll_id}/report")
async def report_pending_roll(campaign_id: int, pending_roll_id: int, body: PendingRollReportIn) -> dict:
    """TableView calls this once the real physical die/dice it spawned for
    a physical_roll_requested broadcast have actually settled — reads the
    real face(s) off the die same as initiative's own report-initiative
    endpoint does, no server-side correction. "attack"/"melee"/"stand_up"/
    "heat_phase" are the `kind`s that exist today (Fase B — every roll
    this app makes is now physical-dice-aware, initiative's own separate
    request/report pair aside, see main.py's own note on that)."""
    campaign = _require_campaign(campaign_id)
    pending = dice_resolution.get_pending(pending_roll_id)
    if pending is None or pending["campaign_id"] != campaign_id:
        raise HTTPException(404, "No such pending roll")
    expected = 2 if pending["next_dice_spec"] == "2d6" else 1
    if len(body.dice) != expected:
        raise HTTPException(422, f"Expected {expected} dice for a {pending['next_dice_spec']} roll, got {len(body.dice)}")
    dice_resolution.delete_pending(pending_roll_id)
    collected = pending["collected"] + [(pending["next_purpose"], body.dice)]

    # Same `rolls` history table initiative's own report endpoint logs
    # into — this is the real physical-dice counterpart of the auto-roll
    # logging in dice_resolution.run_step, so every roll this app makes
    # (auto or physical) ends up trackable the same way, not just
    # initiative's.
    for die_value in body.dice:
        if 1 <= die_value <= 6:
            rolls.insert_roll(campaign_id, "d6", die_value, pending["pilot_id"], label=f"{pending['kind']}:{pending['next_purpose']}")

    if pending["kind"] not in ("attack", "melee", "stand_up", "heat_phase"):
        raise HTTPException(404, f"Unknown pending-roll kind {pending['kind']!r}")

    try:
        if pending["kind"] == "attack":
            result = combat.run_attack(campaign_id, ctx=pending["ctx"], committed=pending["committed"], collected=collected)
        elif pending["kind"] == "melee":
            result = melee.run_melee_attack(campaign_id, ctx=pending["ctx"], committed=pending["committed"], collected=collected)
        elif pending["kind"] == "stand_up":
            result = psr.run_stand_up(ctx=pending["ctx"], committed=pending["committed"], collected=collected)
        else:
            result = turns.run_heat_phase(campaign_id, ctx=pending["ctx"], committed=pending["committed"], collected=collected)
    except dice_resolution.PendingRoll as exc:
        await _broadcast_physical_roll_requested(campaign_id, exc)
        return {"pending": True, "pending_roll_id": exc.pending_roll_id}

    if pending["kind"] == "stand_up":
        # Same shape as stand_up_unit's own non-pending path — the whole
        # Movement Phase is only consumed once the real roll (and any
        # resulting fall) has actually resolved.
        unit_id = pending["ctx"]["unit_id"]
        unit = units.get_unit(unit_id) if unit_id is not None else None
        if unit is not None:
            movement.record_free_move(campaign_id, unit, unit["q"], unit["r"])
        await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
        await manager.broadcast(campaign_id, {"type": "roster_updated"})
        return result

    if pending["kind"] == "heat_phase":
        await manager.broadcast(campaign_id, {"type": "heat_phase_resolved", **result})
        if campaign["active_map_id"] is not None:
            await _broadcast_visibility(campaign_id, campaign["active_map_id"])
        await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
        return result

    broadcast_type = "attack_result" if pending["kind"] == "attack" else "melee_result"
    await manager.broadcast(campaign_id, {"type": broadcast_type, **result})
    if campaign["active_map_id"] is not None:
        await _broadcast_visibility(campaign_id, campaign["active_map_id"])
    await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
    return result


class MeleeAttackIn(BaseModel):
    target_unit_id: int
    attack_type: str  # "punch" | "kick" | "charge" | "dfa" — melee.MELEE_ATTACK_TYPES
    arm: str | None = None  # "left" | "right" — punch only


@app.post("/api/units/{unit_id}/melee")
async def melee_attack(unit_id: int, body: MeleeAttackIn) -> dict:
    """Physical attacks (punch/kick/charge/DFA — see melee.py's module
    docstring for exactly which of the rulebook's seven physical attacks
    this covers and which are deliberately out of scope). Same broadcast
    shape as /attack (attack_result + round_updated + visibility), since
    the frontend's existing attack-result handling already knows how to
    show a hit/miss/damage summary regardless of which endpoint produced
    it."""
    attacker = units.get_unit(unit_id)
    if not attacker:
        raise HTTPException(404, f"Unit {unit_id} not found")
    campaign = _require_campaign(attacker["campaign_id"])
    try:
        result = melee.run_melee_attack(attacker["campaign_id"], unit_id, body.target_unit_id, body.attack_type, body.arm)
    except melee.UnknownMeleeAttackType as exc:
        raise HTTPException(422, str(exc)) from exc
    except (melee.NotAdjacent, melee.InvalidMeleeAttack, combat.NoLineOfSight) as exc:
        raise HTTPException(422, str(exc)) from exc
    except (melee.MechIncapacitated, combat.TargetAlreadyDestroyed) as exc:
        raise HTTPException(409, str(exc)) from exc
    except dice_resolution.PendingRoll as exc:
        # Fase B: same physical-dice pause as /attack — see its own
        # comment above.
        await _broadcast_physical_roll_requested(attacker["campaign_id"], exc)
        return {"pending": True, "pending_roll_id": exc.pending_roll_id}
    await manager.broadcast(attacker["campaign_id"], {"type": "melee_result", **result})
    if campaign["active_map_id"] is not None:
        await _broadcast_visibility(attacker["campaign_id"], campaign["active_map_id"])
    await manager.broadcast(attacker["campaign_id"], {"type": "round_updated", **turns.get_round(attacker["campaign_id"])})
    return result


@app.post("/api/units/{unit_id}/stand-up")
async def stand_up_unit(unit_id: int) -> dict:
    """A prone mech's only "movement" option — a Piloting Skill Roll to
    get back up (psr.py's stand_up), separate from normal move-with-mp
    since it doesn't spend hexes/facing the same way. Real rule (real
    user report: "se levanta y permite mover en la misma ronda... eso
    deberia ser asi? me parece que no" — correct, it shouldn't): standing
    up uses the WHOLE Movement Phase, success or fail — a mech can't
    also walk/run/jump afterward the same round. Recorded the same
    "0-hex move" way onSkipMovement/onRotate already do, so
    activeMoverPilotId/moved_pilot_ids treat this pilot as done moving."""
    unit = units.get_unit(unit_id)
    if not unit or unit["mech_id"] is None:
        raise HTTPException(404, f"Unit {unit_id} not found")
    try:
        result = psr.run_stand_up(unit["mech_id"], unit_id)
    except dice_resolution.PendingRoll as exc:
        # Fase B: same physical-dice pause as /attack — deliberately does
        # NOT call record_free_move yet (below) — the whole Movement
        # Phase only gets consumed once the real roll (and any resulting
        # fall) has actually resolved, not while it's still pending.
        await _broadcast_physical_roll_requested(unit["campaign_id"], exc)
        return {"pending": True, "pending_roll_id": exc.pending_roll_id}
    movement.record_free_move(unit["campaign_id"], unit, unit["q"], unit["r"])
    await manager.broadcast(unit["campaign_id"], {"type": "round_updated", **turns.get_round(unit["campaign_id"])})
    # Real user report: standing up correctly cleared is_prone (GMView
    # showed it fine — it refetches itself right after the call), but
    # TableView/FirstPersonView never noticed, since they only refresh
    # their own local `mechs` state off broadcasts, and this endpoint
    # wasn't sending one that means "a mech changed" — round_updated only
    # carries round/phase data, not mech state. A failed attempt also
    # applies real fall damage (psr.apply_fall), so this covers that too.
    await manager.broadcast(unit["campaign_id"], {"type": "roster_updated"})
    return result


@app.post("/api/units/{unit_id}/fall-over")
async def fall_over_unit(unit_id: int) -> dict:
    """Debug-only affordance (real user request: "una opcion de tirarse...
    en el menu de movimiento", to test Caerse/Levantarse without waiting
    for a real failed PSR) — sets is_prone directly, no PSR roll, no fall
    damage; this is for previewing the animation, not simulating a real
    fall. Broadcasts the same bare `roster_updated` stand_up already uses
    above — every OTHER connected client detects the is_prone transition
    itself (frontend's own prev-vs-current edge check), no dedicated event
    type needed."""
    unit = units.get_unit(unit_id)
    if not unit or unit["mech_id"] is None:
        raise HTTPException(404, f"Unit {unit_id} not found")
    result = mechs.set_prone(unit["mech_id"], True)
    await manager.broadcast(unit["campaign_id"], {"type": "roster_updated"})
    return result


@app.post("/api/campaigns/{campaign_id}/undo")
async def undo(campaign_id: int) -> dict:
    campaign = _require_campaign(campaign_id)
    try:
        result = events.undo_last_event(campaign_id)
    except events.NotUndoable as exc:
        raise HTTPException(409, "Esta acción no se puede deshacer automáticamente") from exc
    if not result:
        raise HTTPException(404, "No action to undo")
    await manager.broadcast(campaign_id, {"type": "action_undone", **result})
    # Whatever got reverted could be a pilot/mech/map (roster_updated) or
    # a unit on the board (visibility) — broadcast both unconditionally
    # rather than threading event_type-specific knowledge through here;
    # cheap, and matches how every other mutation already stays "seamless"
    # for open GM/player screens (real user report from the prior pass).
    await manager.broadcast(campaign_id, {"type": "roster_updated"})
    if campaign["active_map_id"] is not None:
        await _broadcast_visibility(campaign_id, campaign["active_map_id"])
    # Real user report: everything reverted (armor/heat/criticals/etc via
    # roster_updated above) except the "whose turn" overlay — undoing a
    # turn_acted/attack/melee/round_started event changes bt_round_acted/
    # bt_round_moves/bt_rounds, but nothing told any connected client to
    # refetch round state (every OTHER round-mutating endpoint already
    # broadcasts this same round_updated pairing; this was the one gap).
    await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
    return result


@app.get("/api/campaigns/{campaign_id}/events")
def get_campaign_events(campaign_id: int) -> list[dict]:
    _require_campaign(campaign_id)
    return events.list_events(campaign_id)


# ---- rounds/initiative (ROADMAP.md S2 — simplified, see turns.py) ------


@app.get("/api/campaigns/{campaign_id}/round")
def get_round(campaign_id: int) -> dict:
    _require_campaign(campaign_id)
    return turns.get_round(campaign_id)


@app.post("/api/campaigns/{campaign_id}/round/start")
async def start_round(campaign_id: int, expected_round_number: int | None = None) -> dict:
    _require_campaign(campaign_id)
    result = turns.start_round(campaign_id, expected_round_number=expected_round_number)
    await manager.broadcast(campaign_id, {"type": "round_started", **result})
    return result


@app.post("/api/campaigns/{campaign_id}/round/resolve-heat")
async def resolve_heat(campaign_id: int) -> dict:
    """The Heat Scale's shutdown/restart/ammo-explosion/life-support
    checks (turns.py's resolve_heat_phase) — idempotent per round, so the
    frontend calls this itself the instant it sees the round phase has
    nothing left to act on (no GM button needed), and a second call from
    another open tab is a harmless no-op."""
    campaign = _require_campaign(campaign_id)
    try:
        result = turns.run_heat_phase(campaign_id)
    except dice_resolution.PendingRoll as exc:
        # Fase B: same physical-dice pause as /attack — each mech's own
        # pilot governs whether THEIR shutdown/ammo rolls pause,
        # independent of every other mech's (see turns.run_heat_phase's
        # own docstring). Whichever caller triggered this (every screen
        # calls it the instant it sees nothing left to act on) just needs
        # to know to wait — TableView is what actually throws the dice.
        await _broadcast_physical_roll_requested(campaign_id, exc)
        return {"pending": True, "pending_roll_id": exc.pending_roll_id}
    await manager.broadcast(campaign_id, {"type": "heat_phase_resolved", **result})
    if campaign["active_map_id"] is not None:
        # An ammo explosion can destroy a mech right here — its team must
        # immediately lose whatever only it could see (real user report).
        await _broadcast_visibility(campaign_id, campaign["active_map_id"])
    await manager.broadcast(campaign_id, {"type": "round_updated", **turns.get_round(campaign_id)})
    return result


class RoundActIn(BaseModel):
    pilot_id: int


@app.post("/api/campaigns/{campaign_id}/round/act")
async def mark_round_acted(campaign_id: int, body: RoundActIn) -> dict:
    _require_campaign(campaign_id)
    result = turns.mark_acted(campaign_id, body.pilot_id)
    await manager.broadcast(campaign_id, {"type": "round_updated", **result})
    return result


class RoundPassIn(BaseModel):
    pilot_id: int
    phase: str


@app.post("/api/campaigns/{campaign_id}/round/pass")
async def pass_round_phase(campaign_id: int, body: RoundPassIn) -> dict:
    """Explicit "Pasar turno" for one phase only — see turns.pass_phase's
    own doc comment for why this is a separate endpoint from /round/act
    rather than reusing it."""
    _require_campaign(campaign_id)
    try:
        result = turns.pass_phase(campaign_id, body.pilot_id, body.phase)
    except turns.InvalidPassPhase as exc:
        raise HTTPException(422, str(exc))
    await manager.broadcast(campaign_id, {"type": "round_updated", **result})
    return result


class RollInitiativeIn(BaseModel):
    pilot_id: int


@app.post("/api/campaigns/{campaign_id}/round/roll-initiative")
async def request_round_initiative(campaign_id: int, body: RollInitiativeIn) -> dict:
    """Validates the pilot may roll right now, then branches on their own
    dice_mode preference (real user request: "cada jugador puede escoger
    en opciones si quiere dados físicos siempre o tiradas automáticas"):
    'physical' (default) broadcasts "please physically throw dice for
    this pilot" — the shared table (TableView) is the one that actually
    rolls, by reporting whatever its physics dice land on (see
    /round/report-initiative below). 'auto' skips that entirely and
    records a real server-rolled 2d6 immediately, same idempotent path
    report-initiative uses, so no physical dice ever get thrown for this
    pilot at all."""
    _require_campaign(campaign_id)
    try:
        result = turns.request_pilot_initiative(campaign_id, body.pilot_id)
    except (turns.WrongInitiativeMode, turns.RoundNotStarted, turns.UnknownCombatPilot, turns.PilotIsDestroyed) as exc:
        raise HTTPException(422, str(exc)) from exc

    pilot = pilots.get_pilot(body.pilot_id)
    if pilot and pilot["dice_mode"] == "auto":
        _, _, total = combat.roll_2d6()
        try:
            round_state = turns.report_pilot_initiative(campaign_id, body.pilot_id, total)
        except (turns.WrongInitiativeMode, turns.RoundNotStarted, turns.UnknownCombatPilot, turns.InvalidRollValue, turns.PilotIsDestroyed) as exc:
            raise HTTPException(422, str(exc)) from exc
        await manager.broadcast(campaign_id, {"type": "round_updated", **round_state})
        return round_state

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
    except (turns.WrongInitiativeMode, turns.RoundNotStarted, turns.UnknownCombatPilot, turns.InvalidRollValue, turns.PilotIsDestroyed) as exc:
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
