"""
MesaRPG - Gestor de WebSockets
Maneja conexiones en tiempo real con todos los clientes
"""

import asyncio
import json
from datetime import datetime
from typing import Dict, Set, Optional, Any
from fastapi import WebSocket, WebSocketDisconnect
from models import WSMessage, WSMessageType, PlayerRole


class ConnectionManager:
    """
    Gestor de conexiones WebSocket.
    Maneja diferentes tipos de clientes: display, móviles, cámara.
    """
    
    def __init__(self):
        # Conexiones activas por tipo
        self.display_connections: Set[WebSocket] = set()
        self.mobile_connections: Dict[str, WebSocket] = {}  # player_id -> websocket
        self.camera_connection: Optional[WebSocket] = None
        self.admin_connections: Set[WebSocket] = set()
        
        # Mapeo inverso para encontrar player_id por websocket
        self._ws_to_player: Dict[WebSocket, str] = {}
    
    async def connect_display(self, websocket: WebSocket):
        """Conecta una pantalla de visualización"""
        await websocket.accept()
        self.display_connections.add(websocket)
        print(f"📺 Pantalla conectada. Total: {len(self.display_connections)}")
    
    async def connect_mobile(self, websocket: WebSocket, player_id: str):
        """Conecta un dispositivo móvil de jugador"""
        await websocket.accept()
        self.mobile_connections[player_id] = websocket
        self._ws_to_player[websocket] = player_id
        print(f"📱 Móvil conectado: {player_id}. Total: {len(self.mobile_connections)}")
    
    async def connect_camera(self, websocket: WebSocket):
        """Conecta el sistema de cámara"""
        await websocket.accept()
        if self.camera_connection:
            # Desconectar cámara anterior
            try:
                await self.camera_connection.close()
            except:
                pass
        self.camera_connection = websocket
        print("📷 Cámara conectada")
    
    async def connect_admin(self, websocket: WebSocket):
        """Conecta un panel de administración"""
        await websocket.accept()
        self.admin_connections.add(websocket)
        print(f"🎮 Admin conectado. Total: {len(self.admin_connections)}")
    
    def disconnect_display(self, websocket: WebSocket):
        """Desconecta una pantalla"""
        self.display_connections.discard(websocket)
        print(f"📺 Pantalla desconectada. Total: {len(self.display_connections)}")
    
    def disconnect_mobile(self, websocket: WebSocket) -> Optional[str]:
        """Desconecta un móvil y retorna el player_id"""
        player_id = self._ws_to_player.pop(websocket, None)
        if player_id:
            self.mobile_connections.pop(player_id, None)
            print(f"📱 Móvil desconectado: {player_id}. Total: {len(self.mobile_connections)}")
        return player_id
    
    def disconnect_camera(self, websocket: WebSocket):
        """Desconecta la cámara"""
        if self.camera_connection == websocket:
            self.camera_connection = None
            print("📷 Cámara desconectada")
    
    def disconnect_admin(self, websocket: WebSocket):
        """Desconecta un admin"""
        self.admin_connections.discard(websocket)
        print(f"🎮 Admin desconectado. Total: {len(self.admin_connections)}")
    
    async def broadcast_to_displays(self, message: dict):
        """Envía mensaje a todas las pantallas"""
        if not self.display_connections:
            return
        
        data = json.dumps(message, default=str)
        disconnected = []
        
        for ws in self.display_connections:
            try:
                await ws.send_text(data)
            except Exception:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.disconnect_display(ws)
    
    async def broadcast_to_mobiles(self, message: dict, exclude: Optional[str] = None):
        """Envía mensaje a todos los móviles"""
        if not self.mobile_connections:
            return
        
        data = json.dumps(message, default=str)
        disconnected = []
        
        for player_id, ws in self.mobile_connections.items():
            if player_id == exclude:
                continue
            try:
                await ws.send_text(data)
            except Exception:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.disconnect_mobile(ws)
    
    async def send_to_mobile(self, player_id: str, message: dict):
        """Envía mensaje a un móvil específico"""
        ws = self.mobile_connections.get(player_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message, default=str))
            except Exception:
                self.disconnect_mobile(ws)
    
    async def broadcast_to_admins(self, message: dict):
        """Envía mensaje a todos los admins"""
        if not self.admin_connections:
            return
        
        data = json.dumps(message, default=str)
        disconnected = []
        
        for ws in self.admin_connections:
            try:
                await ws.send_text(data)
            except Exception:
                disconnected.append(ws)
        
        for ws in disconnected:
            self.disconnect_admin(ws)
    
    async def broadcast_all(self, message: dict, exclude_player: Optional[str] = None):
        """Envía mensaje a todos los clientes"""
        await asyncio.gather(
            self.broadcast_to_displays(message),
            self.broadcast_to_mobiles(message, exclude=exclude_player),
            self.broadcast_to_admins(message)
        )
    
    async def send_effect(self, effect_data: dict):
        """Envía un efecto visual a las pantallas"""
        message = {
            "type": WSMessageType.EFFECT,
            "payload": effect_data,
            "timestamp": datetime.now().isoformat()
        }
        await self.broadcast_to_displays(message)
    
    async def send_state_update(self, state: dict):
        """Envía actualización de estado a todos"""
        message = {
            "type": WSMessageType.STATE_UPDATE,
            "payload": state,
            "timestamp": datetime.now().isoformat()
        }
        await self.broadcast_all(message)
    
    async def send_error(self, websocket: WebSocket, error_message: str):
        """Envía un error a un cliente específico"""
        message = {
            "type": WSMessageType.ERROR,
            "payload": {"message": error_message},
            "timestamp": datetime.now().isoformat()
        }
        try:
            await websocket.send_text(json.dumps(message, default=str))
        except:
            pass
    
    def get_stats(self) -> dict:
        """Obtiene estadísticas de conexiones"""
        return {
            "displays": len(self.display_connections),
            "mobiles": len(self.mobile_connections),
            "camera": self.camera_connection is not None,
            "admins": len(self.admin_connections),
            "mobile_players": list(self.mobile_connections.keys())
        }
