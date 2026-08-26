"""Generic "pause mid-resolution for a real physical die, resume later"
driver (Fase B — real user request: every roll, not just initiative,
should be a real physical throw when the rolling pilot has dice_mode=
'physical', and the mechanism has to genuinely wait for an external
result, not fake it, since a future camera-based reader will feed into
this exact same primitive).

A resolution like an attack is broken into a fixed sequence of named
STEPS (see combat.py's ATTACK_STEP_ORDER) — each step's own `decide_fn`
may need one or more dice rolls before it can produce a result; once it
has them, the caller (combat.py) applies that step's mutation immediately
and moves on. `run_step` drives exactly ONE step:

- Tries `decide_fn(SuppliedDice(collected))`.
- If it raises NeedsRoll, checks the OWNING pilot's dice_mode (the
  pilot_id NeedsRoll carries — not a single mode for the whole
  resolution, since e.g. an attacker's to-hit roll and a target's own
  PSR can belong to different pilots with different preferences):
  - 'auto' (or no pilot / `force_auto`): rolls instantly via RandomDice
    and retries in the SAME call — zero added latency, identical to
    every roll in this codebase before this module existed.
  - 'physical': persists a bt_pending_rolls row capturing everything
    needed to resume this exact step later, and raises PendingRoll
    instead of returning — the caller (main.py's endpoint) turns that
    into a `{"pending": true, ...}` HTTP response + a physical_roll_
    requested broadcast, and TableView eventually reports the real
    result back via POST .../pending-rolls/{id}/report, which reloads
    this same row and calls the SAME step function again with one more
    known value.
"""

import json

from . import db
from .dice_source import NeedsRoll, RandomDice, SuppliedDice
from .systems.battletech import pilots


class PendingRoll(Exception):
    """Not an error — unwinds back to the HTTP endpoint when a step needs
    a real physical roll and has to wait for it."""

    def __init__(self, pending_roll_id: int, dice_spec: str, purpose: str, pilot_id: int | None):
        self.pending_roll_id = pending_roll_id
        self.dice_spec = dice_spec
        self.purpose = purpose
        self.pilot_id = pilot_id
        super().__init__(f"waiting on a physical {dice_spec} roll for {purpose!r} (pilot {pilot_id})")


def _dice_mode_for(pilot_id: int | None) -> str:
    if pilot_id is None:
        return "auto"
    pilot = pilots.get_pilot(pilot_id)
    return pilot["dice_mode"] if pilot else "auto"


def run_step(decide_fn, collected: list, *, campaign_id: int, kind: str, step: str, ctx, committed: dict, force_auto: bool = False):
    """Runs one step to completion (looping through any number of instant
    auto-rolls) or raises PendingRoll once a real physical roll is
    needed. `force_auto` skips the dice_mode check entirely and always
    auto-rolls — used by the OLD synchronous entrypoints (combat.py's
    resolve_attack) so they stay 100% behavior-identical to before this
    module existed, regardless of what dice_mode a pilot happens to have
    (existing callers/tests never expect a pending result)."""
    collected = list(collected)
    while True:
        try:
            return decide_fn(SuppliedDice(collected))
        except NeedsRoll as need:
            mode = "auto" if force_auto else _dice_mode_for(need.pilot_id)
            if mode != "physical":
                rd = RandomDice()
                if need.spec == "2d6":
                    d1, d2, _ = rd.next_2d6(need.purpose, need.pilot_id)
                    values = [d1, d2]
                else:
                    values = [rd.next_1d6(need.purpose, need.pilot_id)]
                collected.append((need.purpose, values))
                continue
            pending_id = _persist_pending(
                campaign_id, kind, need.pilot_id, step, ctx, committed, collected, need.spec, need.purpose,
            )
            raise PendingRoll(pending_id, need.spec, need.purpose, need.pilot_id)


def _persist_pending(
    campaign_id: int, kind: str, pilot_id: int | None, step: str,
    ctx, committed: dict, collected: list, dice_spec: str, purpose: str,
) -> int:
    with db.connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO bt_pending_rolls
                (campaign_id, kind, pilot_id, step, original_params_json, committed_json, collected_json, next_dice_spec, next_purpose)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                campaign_id, kind, pilot_id, step,
                json.dumps(ctx), json.dumps(committed), json.dumps(collected),
                dice_spec, purpose,
            ),
        )
        return cur.lastrowid


def get_pending(pending_roll_id: int) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM bt_pending_rolls WHERE id = ?", (pending_roll_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"], "campaign_id": row["campaign_id"], "kind": row["kind"], "pilot_id": row["pilot_id"],
        "step": row["step"], "ctx": json.loads(row["original_params_json"]),
        "committed": json.loads(row["committed_json"]),
        "collected": [tuple(c) for c in json.loads(row["collected_json"])],
        "next_dice_spec": row["next_dice_spec"], "next_purpose": row["next_purpose"],
    }


def delete_pending(pending_roll_id: int) -> None:
    with db.connect() as conn:
        conn.execute("DELETE FROM bt_pending_rolls WHERE id = ?", (pending_roll_id,))
