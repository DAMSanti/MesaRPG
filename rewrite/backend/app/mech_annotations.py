"""MechLab (real user request: a small in-app tool to mark where each
weapon/the cockpit actually sits on a mech's 3D model, since no AI can
auto-rig/animate a non-humanoid mech with claws/arm-cannons — this is the
one piece of that ambition genuinely buildable right now, without a rig or
any new animation clips). Also tags which named mesh nodes make up each
limb (real user follow-up: "nos falta una forma de seleccionar o pintar
las partes del mech correspondientes a los brazos y las piernas para que
puedan perderlas en combate").

Global catalog, unscoped by campaign — same nature as mechAssets.ts's own
MECH_CHASSIS_ASSETS on the frontend. Keyed by the resolved .glb URL
(resolveMechModelUrl's own output), not chassis+model — several chassis/
model combinations share one asset via that resolver's own placeholder
fallback, so annotating a URL once covers all of them.
"""

import json

from . import db

KINDS = {"weapon", "cockpit", "limb", "hit"}
# Same 8 codes api.ts's own MECH_LOCATIONS export already uses everywhere
# else in this app (mech_weapons.location, character sheet armor/structure,
# criticals) — duplicated here rather than imported (there's no shared
# Python/TS constants file), kept in sync by hand same as any other
# frontend/backend enum pair in this codebase.
LOCATIONS = {"HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"}
# Only arms/legs are ever a detachable "limb" — losing a Head or Torso
# location is mech death outright under the real Total Warfare rules this
# app already follows elsewhere (see mechs.mark_destroyed's own reasoning),
# not a part that visually falls off a still-standing mech.
LIMB_LOCATIONS = {"LA", "RA", "LL", "RL"}


class InvalidAnnotation(ValueError):
    pass


def _row_to_dict(row) -> dict:
    d = dict(row)
    d["mesh_names"] = json.loads(d["mesh_names"]) if d["mesh_names"] else None
    return d


def list_annotations() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, model_url, kind, location, x, y, z, mesh_names, updated_at "
            "FROM mech_model_annotations ORDER BY model_url, kind, location, id"
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def save_annotations(model_url: str, points: list[dict]) -> list[dict]:
    """Replaces the WHOLE point set for `model_url` — the editor always
    sends its full current state on save, not incremental patches, so
    delete-then-insert is simpler and safer than tracking per-point CRUD
    (and naturally handles a point/limb the user removed in the UI too).

    Real user request: "hay mechs que por ejemplo tienen 3 armas en el
    torso... necesito poder marcar las 3" — more than one row can share
    the same (kind='weapon', location) on purpose, no uniqueness enforced
    here; `points` is inserted in order and re-read ordered by `id`
    (insertion order), which the frontend treats as each location's own
    stable weapon-slot index (its own "arma 1", "arma 2", …)."

    Real user follow-up: "vamos a seleccionar las diferentes partes del
    cuerpo del mech, para que cuando reciba ataques en sitios especificos,
    podamos mostrar esos ataques golpeando donde deben" — kind='hit' is
    where an incoming attack's VFX should visually land for a given
    location; unlike 'weapon' this is meant as one point per location (any
    of the 8, including HD/CT which can visually be hit even though losing
    them is mech death, not a detachable limb), but nothing here enforces
    that uniqueness — the frontend only ever keeps one per location, same
    as it does for 'cockpit'."""
    for p in points:
        kind = p.get("kind")
        if kind not in KINDS:
            raise InvalidAnnotation(f"Unknown kind {kind!r}, expected one of {sorted(KINDS)}")
        if kind in ("weapon", "hit") and p.get("location") not in LOCATIONS:
            raise InvalidAnnotation(
                f"Unknown location {p.get('location')!r} for a {kind} point, expected one of {sorted(LOCATIONS)}"
            )
        if kind == "cockpit" and p.get("location") is not None:
            raise InvalidAnnotation("A cockpit point doesn't take a location")
        if kind == "limb":
            if p.get("location") not in LIMB_LOCATIONS:
                raise InvalidAnnotation(
                    f"Unknown location {p.get('location')!r} for a limb, expected one of {sorted(LIMB_LOCATIONS)}"
                )
            if not isinstance(p.get("mesh_names"), list) or not all(isinstance(n, str) for n in p["mesh_names"]):
                raise InvalidAnnotation("A limb's mesh_names must be a list of strings")

    with db.connect() as conn:
        conn.execute("DELETE FROM mech_model_annotations WHERE model_url = ?", (model_url,))
        for p in points:
            mesh_names = json.dumps(p["mesh_names"]) if p["kind"] == "limb" else None
            conn.execute(
                """
                INSERT INTO mech_model_annotations (model_url, kind, location, x, y, z, mesh_names, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (model_url, p["kind"], p.get("location"), p.get("x", 0), p.get("y", 0), p.get("z", 0), mesh_names),
            )
        rows = conn.execute(
            "SELECT id, model_url, kind, location, x, y, z, mesh_names, updated_at "
            "FROM mech_model_annotations WHERE model_url = ? ORDER BY kind, location, id",
            (model_url,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


TRACKS = {"weapons", "limbs", "rig", "texture", "footprint"}
STATUSES = {"not_started", "done", "accepted"}


class InvalidReview(ValueError):
    pass


def list_review() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT chassis, track, status, updated_at FROM mech_model_review ORDER BY chassis, track"
        ).fetchall()
        return [dict(r) for r in rows]


def set_review_status(chassis: str, track: str, status: str) -> dict:
    """Real user request: "necesito... poder ver a simple vista en que
    estado se encuentra el anotar armas, extremidades y rig... Solo yo
    puedo aceptar cada parte". The frontend decides WHEN to call this
    (right after a save with real data for 'weapons'/'limbs', right on
    first opening the 'rig' tab for a model) — this just persists
    whatever status it's told, no inference happens server-side.
    'accepted' is only ever reached by an explicit user action in the
    frontend, never set automatically.

    Real user request (later): "los marcadores... deberian estar en el
    chasis ahora, no en los modelos" — keyed by chassis name, not the
    specific model_url, since a chassis's tracks describe its one shared
    curated asset (mechAssets.ts), not any single catalog variant."""
    if track not in TRACKS:
        raise InvalidReview(f"Unknown track {track!r}, expected one of {sorted(TRACKS)}")
    if status not in STATUSES:
        raise InvalidReview(f"Unknown status {status!r}, expected one of {sorted(STATUSES)}")
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO mech_model_review (chassis, track, status, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(chassis, track) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
            """,
            (chassis, track, status),
        )
        row = conn.execute(
            "SELECT chassis, track, status, updated_at FROM mech_model_review WHERE chassis = ? AND track = ?",
            (chassis, track),
        ).fetchone()
        return dict(row)


# Real user request: "quiero poder guardarlo desde el mechlab y como lo
# demas, 3 estados y un marcador en el desplegable" — MechLabView's Textura
# tab. Field names mirror Mech3D.tsx's own MechPbrSettings exactly (just
# snake_case for the DB/wire format — normalScale -> normal_scale, etc.)
# so the frontend can round-trip the object with a simple key rename, not
# a bespoke mapping.
#
# Real user follow-up: "deberían ser cambios independientes" (cuerpo/armas/
# cabina) — see db.py's own mech_pbr_settings doc comment for why the 5
# tunable values are now per-zone. `repeat` alone stays unprefixed/shared.
# This whole module stays zone-agnostic on purpose (list/save just push
# whatever PBR_FIELDS says through, no zone-specific logic here) — the
# actual body/weapons/cockpit MEANING of each column only matters to
# Mech3D.tsx's own useMechPbr, which is the only place that needs it.
# Real user follow-up: "quiero otro slider que afecte a las partes FUERA
# de la mask" — body_metal_roughness/body_metal_metalness (and their
# weapons_ twins) are the bare-metal-region target these two zones alone
# support; MechLabView always has real numbers for them (Body/Weapons
# always populate metalRoughness/metalMetalness, unlike Cockpit, which
# has neither the columns nor the UI for this split), so they're
# required here exactly like every other field, not optional.
PBR_FIELDS = (
    "repeat",
    "body_normal_scale", "body_roughness", "body_metalness", "body_color_boost", "body_ao_intensity",
    "body_metal_roughness", "body_metal_metalness", "body_metal_normal_scale", "body_metal_color_boost",
    "weapons_normal_scale", "weapons_roughness", "weapons_metalness", "weapons_color_boost", "weapons_ao_intensity",
    "weapons_metal_roughness", "weapons_metal_metalness", "weapons_metal_normal_scale", "weapons_metal_color_boost",
    "cockpit_normal_scale", "cockpit_roughness", "cockpit_metalness", "cockpit_color_boost", "cockpit_ao_intensity",
)


class InvalidPbrSettings(ValueError):
    pass


def _pbr_row_to_dict(row) -> dict:
    return dict(row)


def list_pbr_settings() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            f"SELECT model_url, {', '.join(PBR_FIELDS)}, updated_at FROM mech_pbr_settings ORDER BY model_url"
        ).fetchall()
        return [_pbr_row_to_dict(r) for r in rows]


def save_pbr_settings(model_url: str, settings: dict) -> dict:
    values = []
    for field in PBR_FIELDS:
        value = settings.get(field)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise InvalidPbrSettings(f"{field} must be a number, got {value!r}")
        values.append(float(value))
    with db.connect() as conn:
        conn.execute(
            f"""
            INSERT INTO mech_pbr_settings (model_url, {', '.join(PBR_FIELDS)}, updated_at)
            VALUES (?, {', '.join('?' for _ in PBR_FIELDS)}, datetime('now'))
            ON CONFLICT(model_url) DO UPDATE SET
                {', '.join(f'{f} = excluded.{f}' for f in PBR_FIELDS)},
                updated_at = excluded.updated_at
            """,
            (model_url, *values),
        )
        row = conn.execute(
            f"SELECT model_url, {', '.join(PBR_FIELDS)}, updated_at FROM mech_pbr_settings WHERE model_url = ?",
            (model_url,),
        ).fetchone()
        return _pbr_row_to_dict(row)


# Real user request: "en la seccion de huella, quiero un boton de guardar...
# quiero que ademas se use ya como forma real de la pisada" — see
# db.py's own mech_footprint_masks doc comment for the shape/units.
class InvalidFootprintMask(ValueError):
    pass


def list_footprint_masks() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT model_url, image_data_url, half_width, half_depth, updated_at "
            "FROM mech_footprint_masks ORDER BY model_url"
        ).fetchall()
        return [dict(r) for r in rows]


def save_footprint_mask(model_url: str, image_data_url: str, half_width: float, half_depth: float) -> dict:
    if not isinstance(image_data_url, str) or not image_data_url.startswith("data:image/"):
        raise InvalidFootprintMask("image_data_url must be a data:image/... URL")
    for name, value in (("half_width", half_width), ("half_depth", half_depth)):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            raise InvalidFootprintMask(f"{name} must be a positive number, got {value!r}")
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO mech_footprint_masks (model_url, image_data_url, half_width, half_depth, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(model_url) DO UPDATE SET
                image_data_url = excluded.image_data_url,
                half_width = excluded.half_width,
                half_depth = excluded.half_depth,
                updated_at = excluded.updated_at
            """,
            (model_url, image_data_url, float(half_width), float(half_depth)),
        )
        row = conn.execute(
            "SELECT model_url, image_data_url, half_width, half_depth, updated_at "
            "FROM mech_footprint_masks WHERE model_url = ?",
            (model_url,),
        ).fetchone()
        return dict(row)


# Real user report: the per-mech muzzle auto-detect "no funciona muy
# bien" — real user request instead: browse each weapon's own model,
# click its firing point once, apply it to that exact mount.
#
# Real follow-up correction: "los mechs pueden tener varias armas de un
# tipo... el autodetectar solo esta detectando 1" — see db.py's own
# weapon_muzzle_points doc comment for why this moved from one shared
# point per visual_bucket to one point per (model_url, mount_key, visual).
class InvalidWeaponMuzzlePoint(ValueError):
    pass


def list_weapon_muzzle_points() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT model_url, mount_key, visual, x, y, z, updated_at "
            "FROM weapon_muzzle_points ORDER BY model_url, mount_key, visual"
        ).fetchall()
        return [dict(r) for r in rows]


def save_weapon_muzzle_point(model_url: str, mount_key: str, visual: str, x: float, y: float, z: float) -> dict:
    for name, value in (("model_url", model_url), ("mount_key", mount_key), ("visual", visual)):
        if not isinstance(value, str) or not value:
            raise InvalidWeaponMuzzlePoint(f"{name} must be a non-empty string")
    for name, value in (("x", x), ("y", y), ("z", z)):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise InvalidWeaponMuzzlePoint(f"{name} must be a number, got {value!r}")
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO weapon_muzzle_points (model_url, mount_key, visual, x, y, z, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(model_url, mount_key, visual) DO UPDATE SET
                x = excluded.x, y = excluded.y, z = excluded.z, updated_at = excluded.updated_at
            """,
            (model_url, mount_key, visual, float(x), float(y), float(z)),
        )
        row = conn.execute(
            "SELECT model_url, mount_key, visual, x, y, z, updated_at "
            "FROM weapon_muzzle_points WHERE model_url = ? AND mount_key = ? AND visual = ?",
            (model_url, mount_key, visual),
        ).fetchone()
        return dict(row)
