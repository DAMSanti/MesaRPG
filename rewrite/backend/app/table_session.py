"""Which campaign the physical table is playing right now (singleton).

Drives real-time Hub activation: when the GM picks a campaign, every
other device sitting on /hub learns about it live over /ws/hub, instead
of needing a manually-shared ?campaign= link. See app/ws.py's
HubManager for the broadcast side.
"""

from . import campaigns, db


def get_active_campaign() -> dict | None:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT active_campaign_id FROM table_session WHERE id = 1"
        ).fetchone()
        campaign_id = row["active_campaign_id"] if row else None
    return campaigns.get_campaign(campaign_id) if campaign_id is not None else None


def activate(campaign_id: int) -> dict:
    with db.connect() as conn:
        conn.execute(
            "UPDATE table_session SET active_campaign_id = ?, updated_at = datetime('now') WHERE id = 1",
            (campaign_id,),
        )
    return campaigns.get_campaign(campaign_id)


def deactivate() -> None:
    """End the table's current session — leaves it in the "no campaign"
    state (the campaign itself is untouched, just no longer the one the
    table is playing). Devices on /hub revert to only "GM" clickable."""
    with db.connect() as conn:
        conn.execute(
            "UPDATE table_session SET active_campaign_id = NULL, updated_at = datetime('now') WHERE id = 1"
        )
