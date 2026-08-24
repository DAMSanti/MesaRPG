"""D&D 5e combat resolution (ROADMAP.md Fase R4 — slice mínimo).

One generic attack action: d20 + modifier vs the target's AC, damage by
dice notation on a hit. Deliberately no range/LoS enforcement — the
approved scope is "un ataque genérico", not ranged/melee/cover rules,
and building that would repeat the phase of work BattleTech's own
combat.py already invested in real position-based validation. No
advantage/disadvantage, no saving throws, no conditions, no multiattack
— see this package's own README/ROADMAP entry for the full exclusion
list. Natural 20/1 always hit/miss is basic 5e core rules text, not an
excluded feature, so it's implemented here.
"""

import random
import re

from . import characters

_DICE_RE = re.compile(r"^(?:(\d+)d(\d+))?\s*([+-]?\s*\d+)?$")


class InvalidDiceNotation(ValueError):
    pass


def _roll_die(sides: int) -> int:
    return random.randint(1, sides)


def roll_d20() -> int:
    return _roll_die(20)


def roll_damage(dice: str) -> int:
    """Parses simple dice notation: "XdY", "XdY+Z", "XdY-Z", or a flat
    integer ("5"). Not a full dice-expression parser (no "2d6+1d4",
    no exploding/reroll modifiers) — this slice's combat only ever needs
    one damage roll per attack."""
    match = _DICE_RE.match(dice.strip())
    if not match or not any(match.groups()):
        raise InvalidDiceNotation(f"Unrecognized dice notation: {dice!r}")
    count_str, sides_str, mod_str = match.groups()
    total = sum(_roll_die(int(sides_str)) for _ in range(int(count_str))) if count_str else 0
    if mod_str:
        total += int(mod_str.replace(" ", ""))
    return total


def resolve_attack(attacker_id: int, target_id: int, attack_mod: int, damage_dice: str) -> dict:
    """d20 + attack_mod vs target's AC. A natural 20 always hits (and
    still rolls damage normally, not doubled — critical-hit damage
    dice are out of scope for this slice); a natural 1 always misses
    regardless of modifier. On a hit, damage is rolled and applied to
    the target's HP (characters.update_hp, which clamps at 0/hp_max)."""
    target = characters.get_character(target_id)
    if target is None:
        raise ValueError(f"Unknown target character {target_id!r}")

    roll = roll_d20()
    total = roll + attack_mod
    if roll == 20:
        hit = True
    elif roll == 1:
        hit = False
    else:
        hit = total >= target["ac"]

    damage = roll_damage(damage_dice) if hit else 0
    if damage:
        characters.update_hp(target_id, -damage)

    return {
        "attacker_id": attacker_id,
        "target_id": target_id,
        "roll": roll,
        "attack_mod": attack_mod,
        "total": total,
        "hit": hit,
        "damage": damage,
    }
