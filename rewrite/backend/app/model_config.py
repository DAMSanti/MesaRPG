"""MechLab's model authoring — weapon/hit/cockpit points, limb membership,
review state and PBR tuning — as a file that ships with the code.

Real user report: "he descubierto un problema en lo que hemos subido antes
al servidor, entre en mechlab y esta vacio, no estan las configuraciones de
puntos de arma, puntos de hit etc.... esa info debe estar sincronizada
entre local y el servidor."

The three tables behind that screen are not game state. A campaign, its
pilots and the craters on a board belong to whoever is playing; where the
autocannon sits on a Jenner is a fact about the MODEL, authored once, true
for every deployment that ships that .glb. Keeping it only in SQLite meant
it lived in a Docker volume that starts empty, so a fresh server came up
with the models unannotated and no amount of redeploying fixed it -- the
work simply was not in what gets deployed.

So the file is the source of truth and the database is a cache of it. The
workflow that follows is the ordinary one for authored content:

    annotate in MechLab  ->  python -m app.model_config dump  ->  commit

and any server that starts with that commit has the annotations.

`seed_from_file` is deliberately scoped PER MODEL: it replaces what it has
data for and leaves every other model alone. That is what makes it safe to
run on every startup -- re-annotating a model locally and redeploying
actually updates the server (a "only fill in what is missing" rule would
silently keep serving the old points forever), while a model someone
annotated directly on a server, which the file has never heard of, is not
quietly deleted underneath them.

Worth being plain about the consequence: for a model the file DOES cover,
the file wins on every restart. MechLab is a local authoring tool -- see
its own doc comment -- so annotating on a server is not the intended
workflow, and anything done there is expected to be temporary.
"""

import json
from pathlib import Path

from . import db, mech_annotations

#: Committed alongside the code, not written at runtime by the app -- only
#: ever by the dump command below, which a person runs on purpose.
#:
#: Inside app/ and NOT in data/ for two independent reasons, either of
#: which alone would break it: data/ is in .dockerignore (it holds the
#: SQLite file, which must never be baked into an image), and the compose
#: file mounts a volume over /app/data at runtime, which would hide
#: anything the image did manage to ship there. app/ is copied into the
#: image and nothing is mounted over it.
SEED_PATH = Path(__file__).resolve().parent / "model_config.json"


def export_config() -> dict:
    """Everything MechLab has authored, in the shape the seed file holds."""
    annotations: dict[str, list[dict]] = {}
    for row in mech_annotations.list_annotations():
        # id/updated_at are per-database bookkeeping: carrying them across
        # would make the file churn on every dump and mean nothing on the
        # other side, where the rows get fresh ones anyway.
        point = {
            "kind": row["kind"],
            "location": row["location"],
            "x": row["x"],
            "y": row["y"],
            "z": row["z"],
        }
        if row["mesh_names"] is not None:
            point["mesh_names"] = row["mesh_names"]
        annotations.setdefault(row["model_url"], []).append(point)

    return {
        "annotations": annotations,
        "review": [
            {"model_url": r["model_url"], "track": r["track"], "status": r["status"]}
            for r in mech_annotations.list_review()
        ],
        "pbr": [
            {"model_url": r["model_url"], **{f: r[f] for f in mech_annotations.PBR_FIELDS}}
            for r in mech_annotations.list_pbr_settings()
        ],
    }


def write_seed(path: Path = SEED_PATH) -> dict:
    """Writes the seed file from this database. Run after annotating."""
    config = export_config()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Sorted and newline-terminated so a dump that changes nothing produces
    # no diff, and one that changes a single point produces a small one.
    path.write_text(
        json.dumps(config, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return config


def seed_from_file(path: Path = SEED_PATH) -> dict:
    """Brings this database in line with the seed file, per model.

    Returns what it touched, so startup can say so in the log rather than
    doing it silently -- a database quietly rewriting itself on boot is
    exactly the kind of thing that should be visible when it goes wrong.
    """
    if not path.exists():
        return {"annotations": 0, "review": 0, "pbr": 0}

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # A corrupt seed must not stop the server booting. The models come
        # up unannotated, which is survivable; not starting is not.
        return {"annotations": 0, "review": 0, "pbr": 0}

    counts = {"annotations": 0, "review": 0, "pbr": 0}

    for model_url, points in (config.get("annotations") or {}).items():
        try:
            # Same path the editor itself saves through, so the file cannot
            # smuggle in a shape the validation would have rejected.
            mech_annotations.save_annotations(model_url, points)
            counts["annotations"] += len(points)
        except mech_annotations.InvalidAnnotation:
            # One bad model should not cost the other twenty theirs.
            continue

    for entry in config.get("review") or []:
        try:
            mech_annotations.set_review_status(
                entry["model_url"], entry["track"], entry["status"]
            )
            counts["review"] += 1
        except (KeyError, ValueError):
            continue

    for entry in config.get("pbr") or []:
        try:
            mech_annotations.save_pbr_settings(entry["model_url"], entry)
            counts["pbr"] += 1
        except (KeyError, mech_annotations.InvalidPbrSettings):
            continue

    return counts


if __name__ == "__main__":  # pragma: no cover - a developer command
    import sys

    db.init_db()
    command = sys.argv[1] if len(sys.argv) > 1 else "dump"
    if command == "dump":
        config = write_seed()
        print(
            f"escrito {SEED_PATH}: "
            f"{sum(len(v) for v in config['annotations'].values())} anotaciones, "
            f"{len(config['review'])} estados de revision, "
            f"{len(config['pbr'])} ajustes PBR"
        )
    elif command == "load":
        counts = seed_from_file()
        print(f"cargado desde {SEED_PATH}: {counts}")
    else:
        print(f"uso: python -m app.model_config [dump|load]")
        raise SystemExit(2)
