"""WebSocket broadcast, scoped per campaign.

Each campaign is its own room: a broadcast to campaign 1 never reaches a
client connected to campaign 2. This is what "several campaigns running
in parallel on the same server" (VISION.md) actually requires — the
single shared channel from the first version of this slice didn't.
"""

from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: dict[int, list[WebSocket]] = defaultdict(list)

    async def connect(self, campaign_id: int, ws: WebSocket) -> None:
        await ws.accept()
        self._rooms[campaign_id].append(ws)

    def disconnect(self, campaign_id: int, ws: WebSocket) -> None:
        room = self._rooms.get(campaign_id)
        if room and ws in room:
            room.remove(ws)

    async def broadcast(self, campaign_id: int, message: dict) -> None:
        dead: list[WebSocket] = []
        for ws in self._rooms.get(campaign_id, []):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(campaign_id, ws)


manager = ConnectionManager()


class HubManager:
    """Broadcast-only channel for devices sitting on /hub with no campaign
    chosen yet — carries a single meta signal ("which campaign is active
    at the table now"), never game state, so it doesn't reintroduce the
    cross-campaign leakage that got the original shared channel removed
    (see module docstring above): there's nothing here to leak between
    campaigns because this channel isn't scoped to one.
    """

    def __init__(self) -> None:
        self._listeners: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._listeners.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self._listeners:
            self._listeners.remove(ws)

    async def broadcast(self, message: dict) -> None:
        dead: list[WebSocket] = []
        for ws in self._listeners:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


hub_manager = HubManager()
