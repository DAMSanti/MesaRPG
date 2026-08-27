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


TRACKS = {"weapons", "limbs", "rig", "texture"}
STATUSES = {"not_started", "done", "accepted"}


class InvalidReview(ValueError):
    pass


def list_review() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT model_url, track, status, updated_at FROM mech_model_review ORDER BY model_url, track"
        ).fetchall()
        return [dict(r) for r in rows]


def set_review_status(model_url: str, track: str, status: str) -> dict:
    """Real user request: "necesito... poder ver a simple vista en que
    estado se encuentra el anotar armas, extremidades y rig... Solo yo
    puedo aceptar cada parte". The frontend decides WHEN to call this
    (right after a save with real data for 'weapons'/'limbs', right on
    first opening the 'rig' tab for a model) — this just persists
    whatever status it's told, no inference happens server-side.
    'accepted' is only ever reached by an explicit user action in the
    frontend, never set automatically."""
    if track not in TRACKS:
        raise InvalidReview(f"Unknown track {track!r}, expected one of {sorted(TRACKS)}")
    if status not in STATUSES:
        raise InvalidReview(f"Unknown status {status!r}, expected one of {sorted(STATUSES)}")
    with db.connect() as conn:
        conn.execute(
            """
            INSERT INTO mech_model_review (model_url, track, status, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(model_url, track) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
            """,
            (model_url, track, status),
        )
        row = conn.execute(
            "SELECT model_url, track, status, updated_at FROM mech_model_review WHERE model_url = ? AND track = ?",
            (model_url, track),
        ).fetchone()
        return dict(row)


# Real user request: "quiero poder guardarlo desde el mechlab y como lo
# demas, 3 estados y un marcador en el desplegable" — MechLabView's Textura
# tab. Field names mirror Mech3D.tsx's own MechPbrSettings exactly (just
# snake_case for the DB/wire format — normalScale -> normal_scale, etc.)
# so the frontend can round-trip the object with a simple key rename, not
# a bespoke mapping.
PBR_FIELDS = ("repeat", "normal_scale", "roughness", "metalness", "color_boost", "ao_intensity")


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
