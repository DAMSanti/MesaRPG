"""Shared d6 style catalog + cross-table exclusivity check (real user
request: every pilot AND the GM can each pick a distinct die style, one
per person at the table). Lives outside systems/battletech because the
exclusivity pool spans both pilots.die_style and campaigns.gm_die_style,
and campaigns.py must not import a battletech-specific module.

Must match frontend/src/dieStyles.ts's DIE_STYLES ids 1:1 — kept in sync
by eye, same as pilotColors.ts vs scripts/backfill_pilot_colors.py (no
shared config between the two languages in this codebase).
"""

DIE_STYLE_IDS = {
    "standard-ivory", "standard-onyx", "crimson-pip", "cobalt-pip",
    "verdant-pip", "amber-numeral", "slate-numeral", "chrome-metallic",
    "gunmetal-metallic", "opal-pearl", "jade-glass",
}


class UnknownDieStyle(ValueError):
    pass


class DieStyleTaken(ValueError):
    pass


def check_style_id(style: str) -> None:
    if style not in DIE_STYLE_IDS:
        raise UnknownDieStyle(f"Unknown die style {style!r}, expected one of {sorted(DIE_STYLE_IDS)}")


def check_available(conn, campaign_id: int, style: str, *, exclude_pilot_id: int | None = None) -> None:
    """Raises DieStyleTaken if another pilot, or the GM, already holds
    `style` in this campaign. `exclude_pilot_id` lets a pilot re-pick
    their own already-held style (a no-op) without tripping on themself."""
    row = conn.execute(
        "SELECT id, name FROM pilots WHERE campaign_id = ? AND die_style = ? AND id != ?",
        (campaign_id, style, exclude_pilot_id if exclude_pilot_id is not None else -1),
    ).fetchone()
    if row:
        raise DieStyleTaken(f"Die style {style!r} is already taken by {row['name']!r}")
    gm_row = conn.execute("SELECT gm_die_style FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
    if gm_row and gm_row["gm_die_style"] == style:
        raise DieStyleTaken(f"Die style {style!r} is already taken by the GM")
