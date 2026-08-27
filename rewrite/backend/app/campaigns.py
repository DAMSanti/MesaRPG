from . import db, dice_styles, systems
from .systems.battletech import pilots

INITIATIVE_MODES = {"team", "individual"}


class UnknownInitiativeMode(ValueError):
    pass


def create_campaign(name: str, system: str = "battletech") -> dict:
    systems.grid_type_for(system)  # raises UnknownGameSystem if invalid
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO campaigns (name, system) VALUES (?, ?)", (name, system)
        )
        return _get(conn, cur.lastrowid)


def list_campaigns() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            """
            SELECT c.id, c.name, c.created_at, c.active_map_id, c.system, c.initiative_mode, c.gm_die_style,
                   c.enemy_reveal_cinematic, c.gm_dice_mode,
                   (SELECT COUNT(*) FROM pilots WHERE campaign_id = c.id) AS pilot_count,
                   (SELECT COUNT(*) FROM mechs WHERE campaign_id = c.id) AS mech_count
            FROM campaigns c
            ORDER BY c.id DESC
            """
        ).fetchall()
        return [_with_grid_type(dict(r)) for r in rows]


def get_campaign(campaign_id: int) -> dict | None:
    with db.connect() as conn:
        return _get(conn, campaign_id)


def set_active_map(campaign_id: int, map_id: int) -> dict | None:
    with db.connect() as conn:
        conn.execute(
            "UPDATE campaigns SET active_map_id = ? WHERE id = ?", (map_id, campaign_id)
        )
        return _get(conn, campaign_id)


def set_initiative_mode(campaign_id: int, mode: str) -> dict | None:
    if mode not in INITIATIVE_MODES:
        raise UnknownInitiativeMode(
            f"Unknown initiative mode {mode!r}, expected one of {sorted(INITIATIVE_MODES)}"
        )
    with db.connect() as conn:
        conn.execute(
            "UPDATE campaigns SET initiative_mode = ? WHERE id = ?", (mode, campaign_id)
        )
        return _get(conn, campaign_id)


def set_gm_die_style(campaign_id: int, style: str | None) -> dict | None:
    """The GM's own pick (real user request) — GM has no `pilots` row of
    their own, so this lives directly on the campaign. Mirrors
    pilots.set_pilot_die_style: style=None always clears, a non-None
    style is validated + checked against the SAME exclusivity pool
    (pilots.die_style ⨯ campaigns.gm_die_style) via dice_styles."""
    with db.connect() as conn:
        if style is not None:
            dice_styles.check_style_id(style)
            dice_styles.check_available(conn, campaign_id, style)
        conn.execute("UPDATE campaigns SET gm_die_style = ? WHERE id = ?", (style, campaign_id))
        return _get(conn, campaign_id)


def set_gm_dice_mode(campaign_id: int, mode: str) -> dict | None:
    """Real user request: "el GM también tiene que poder escoger entre
    dados físicos o tiradas automáticas" — then corrected to be campaign-
    wide, not per-pilot: "O TODOS SUS PILOTOS TIRAN AUTOMATICO O TODOS
    TIRAN FISICO". One switch (default 'physical', same as a fresh
    pilot's own dice_mode) governs every enemy/npc pilot's rolls at once
    — see dice_resolution.py's own _dice_mode_for."""
    if mode not in pilots.DICE_MODES:
        raise pilots.UnknownDiceMode(f"Unknown dice_mode {mode!r}, expected one of {sorted(pilots.DICE_MODES)}")
    with db.connect() as conn:
        conn.execute("UPDATE campaigns SET gm_dice_mode = ? WHERE id = ?", (mode, campaign_id))
        return _get(conn, campaign_id)


def set_enemy_reveal_cinematic(campaign_id: int, enabled: bool) -> dict | None:
    """Real user request: TableView shows a 360°-orbit cinematic modal
    the instant an enemy enters the team's LOS — this toggle (default
    on) lets the GM turn it off from their own Ajustes modal."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE campaigns SET enemy_reveal_cinematic = ? WHERE id = ?", (1 if enabled else 0, campaign_id)
        )
        return _get(conn, campaign_id)


def _with_grid_type(campaign: dict) -> dict:
    campaign["grid_type"] = systems.grid_type_for(campaign["system"])
    campaign["enemy_reveal_cinematic"] = bool(campaign["enemy_reveal_cinematic"])
    return campaign


def _get(conn, campaign_id: int) -> dict | None:
    row = conn.execute(
        """
        SELECT id, name, created_at, active_map_id, system, initiative_mode, gm_die_style, enemy_reveal_cinematic,
               gm_dice_mode
        FROM campaigns WHERE id = ?
        """,
        (campaign_id,),
    ).fetchone()
    return _with_grid_type(dict(row)) if row else None
