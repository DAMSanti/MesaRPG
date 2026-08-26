"""Shared abstraction so every dice-consuming resolver (combat/melee/psr/
criticals/heat-phase) can be fed either instant server-side randomness
(`RandomDice`, today's behavior — used for a pilot in 'auto' dice_mode) or
a growing list of already-known values (`SuppliedDice` — used to replay a
resolution that's mid-way through collecting real physical dice results,
Fase B of the plan this was built from). A resolver never calls
`secrets.randbelow` directly anymore; it asks its `DiceSource` for the
next roll it needs, tagged with a `purpose` string (e.g. "to_hit",
"hit_location", "psr") and the id of whichever PILOT that specific roll
conceptually belongs to (not necessarily the resolver's own "owner" — a
charge's self-damage hit-location roll still belongs to the attacker, but
a gyro-destroyed fall's PSR belongs to whoever's mech just fell).

`SuppliedDice` raising `NeedsRoll` the moment it runs out of known values
is the whole trick that makes "pause mid-resolution, wait for a real
physical die, resume" possible without turning every resolver into a
generator/coroutine: a resolver function is 100% pure computation (no DB
writes) up to the point it needs a die it doesn't have — re-invoking it
from scratch with one more known value in the list is always safe and
cheap, since nothing has been mutated yet. See dice_resolution.py for the
retry loop that catches NeedsRoll and either rolls automatically (auto
mode) or persists a pending request and waits for a real report (physical
mode).
"""

from abc import ABC, abstractmethod
import secrets


class NeedsRoll(Exception):
    """Raised by SuppliedDice when it has no more known values for the
    next roll a resolver is asking for. Not an error in the normal sense
    — dice_resolution.py's run_or_pend() catches this on every attempt and
    decides what to do next (roll automatically, or pend for a physical
    one) based on `pilot_id`'s own dice_mode."""

    def __init__(self, spec: str, purpose: str, pilot_id: int | None):
        self.spec = spec
        self.purpose = purpose
        self.pilot_id = pilot_id
        super().__init__(f"needs a {spec} roll for {purpose!r} (pilot {pilot_id})")


class DiceSource(ABC):
    @abstractmethod
    def next_2d6(self, purpose: str, pilot_id: int | None = None) -> tuple[int, int, int]:
        """Returns (die1, die2, total)."""

    @abstractmethod
    def next_1d6(self, purpose: str, pilot_id: int | None = None) -> int:
        ...


class RandomDice(DiceSource):
    """Instant, server-side, `secrets`-based — identical to every dice call
    in this codebase before this module existed. Used whenever the roll's
    owning pilot is in 'auto' dice_mode (or has no pilot at all — GM
    narrative attacks, NPC mechs)."""

    def next_2d6(self, purpose: str, pilot_id: int | None = None) -> tuple[int, int, int]:
        d1, d2 = secrets.randbelow(6) + 1, secrets.randbelow(6) + 1
        return d1, d2, d1 + d2

    def next_1d6(self, purpose: str, pilot_id: int | None = None) -> int:
        return secrets.randbelow(6) + 1


class SuppliedDice(DiceSource):
    """Replays a resolution using dice values already collected from real
    physical rolls (or already-rolled-and-recorded auto rolls earlier in
    the SAME retry loop — see run_or_pend). `values` is consumed strictly
    in the order a resolver's own code asks for it — a resolver must ask
    for its rolls in a stable, deterministic order every time it re-runs
    from the top, which decide_attack/decide_melee/etc. already do (same
    code path every time, no branching on anything the dice themselves
    haven't determined yet)."""

    def __init__(self, values: list[tuple[str, list[int]]]):
        # values: [(purpose, [d1, d2, ...]), ...] in the exact order they
        # were requested — each entry is one prior next_2d6/next_1d6 call's
        # full result, so replay can just pop them off the front in order
        # instead of trying to match by purpose (two rolls can share a
        # purpose, e.g. two crit-slot placement rolls in one attack).
        self._values = list(values)
        self._index = 0

    def _next(self, spec: str, purpose: str, pilot_id: int | None, count: int) -> list[int]:
        if self._index >= len(self._values):
            raise NeedsRoll(spec, purpose, pilot_id)
        _, dice = self._values[self._index]
        if len(dice) != count:
            raise ValueError(f"expected {count} dice at supplied-dice index {self._index}, got {dice!r}")
        self._index += 1
        return dice

    def next_2d6(self, purpose: str, pilot_id: int | None = None) -> tuple[int, int, int]:
        d1, d2 = self._next("2d6", purpose, pilot_id, 2)
        return d1, d2, d1 + d2

    def next_1d6(self, purpose: str, pilot_id: int | None = None) -> int:
        (d,) = self._next("1d6", purpose, pilot_id, 1)
        return d
