"""
MesaRPG - Modelos de datos
Define las estructuras de datos usadas en todo el sistema
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from enum import Enum
from datetime import datetime


class PlayerRole(str, Enum):
    """Roles de jugador"""
    PLAYER = "player"
    GM = "gm"
    SPECTATOR = "spectator"


class EffectType(str, Enum):
    """Tipos de efectos visuales"""
    FIRE = "fire"
    ICE = "ice"
    LIGHTNING = "lightning"
    HEAL = "heal"
    POISON = "poison"
    SHIELD = "shield"
    ATTACK = "attack"
    MOVE = "move"


class Position(BaseModel):
    """Posición en el tablero"""
    x: float
    y: float
    rotation: float = 0.0  # Rotación en grados


class Character(BaseModel):
    """Modelo de personaje"""
    id: str
    marker_id: int
    name: str
    character_class: str = Field(alias="class")
    hp: int
    max_hp: int
    mana: int = 100
    max_mana: int = 100
    armor: int = 0
    speed: int = 6  # Casillas por turno
    abilities: List[str] = []
    status_effects: List[str] = []
    position: Optional[Position] = None
    owner_id: Optional[str] = None  # ID del jugador que controla
    is_visible: bool = True
    
    class Config:
        populate_by_name = True


class Ability(BaseModel):
    """Modelo de habilidad"""
    id: str
    name: str
    description: str = ""
    damage: int = 0
    heal: int = 0
    range: int = 1  # Casillas de alcance
    aoe: int = 0  # Radio de área de efecto
    cooldown: int = 0  # Turnos de cooldown
    mana_cost: int = 0
    effect_type: EffectType = EffectType.ATTACK
    sound: Optional[str] = None
    animation: Optional[str] = None


class Player(BaseModel):
    """Modelo de jugador conectado"""
    id: str
    name: str
    role: PlayerRole = PlayerRole.PLAYER
    character_id: Optional[str] = None
    connected_at: datetime = Field(default_factory=datetime.now)
    is_ready: bool = False


class DetectedMarker(BaseModel):
    """Marcador detectado por la cámara"""
    marker_id: int
    position: Position
    corners: List[List[float]]  # Esquinas del marcador en píxeles
    timestamp: datetime = Field(default_factory=datetime.now)


class GameAction(BaseModel):
    """Acción de juego"""
    id: str = Field(default_factory=lambda: str(datetime.now().timestamp()))
    action_type: str
    source_character_id: str
    target_character_id: Optional[str] = None
    target_position: Optional[Position] = None
    ability_id: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    timestamp: datetime = Field(default_factory=datetime.now)


class GameState(BaseModel):
    """Estado completo del juego"""
    session_id: str
    current_turn: int = 0
    active_character_id: Optional[str] = None
    characters: Dict[str, Character] = {}
    players: Dict[str, Player] = {}
    action_history: List[GameAction] = []
    is_combat: bool = False
    initiative_order: List[str] = []
    current_map: str = "default"
    settings: Dict[str, Any] = {}


# Mensajes WebSocket

class WSMessageType(str, Enum):
    """Tipos de mensajes WebSocket"""
    # Cliente -> Servidor
    JOIN = "join"
    LEAVE = "leave"
    ACTION = "action"
    MOVE = "move"
    ABILITY = "ability"
    READY = "ready"
    CHAT = "chat"
    
    # Servidor -> Cliente
    STATE_UPDATE = "state_update"
    CHARACTER_UPDATE = "character_update"
    EFFECT = "effect"
    ERROR = "error"
    PLAYER_JOINED = "player_joined"
    PLAYER_LEFT = "player_left"
    TURN_CHANGE = "turn_change"
    COMBAT_START = "combat_start"
    COMBAT_END = "combat_end"
    
    # Cámara
    MARKER_DETECTED = "marker_detected"
    MARKER_LOST = "marker_lost"
    MARKERS_UPDATE = "markers_update"


class WSMessage(BaseModel):
    """Mensaje WebSocket genérico"""
    type: WSMessageType
    payload: Dict[str, Any] = {}
    sender_id: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.now)


class ActionRequest(BaseModel):
    """Solicitud de acción desde el móvil"""
    character_id: str
    action_type: str
    ability_id: Optional[str] = None
    target_id: Optional[str] = None
    target_position: Optional[Position] = None


class ActionResult(BaseModel):
    """Resultado de una acción"""
    success: bool
    message: str = ""
    damage_dealt: int = 0
    healing_done: int = 0
    effects_applied: List[str] = []
    cooldown_started: Optional[str] = None
