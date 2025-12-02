"""
MesaRPG - Gestión del estado del juego
Mantiene el estado sincronizado entre todos los componentes
"""

import json
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, List, Callable, Any
import uuid

from models import (
    GameState, Character, Player, Ability, Position,
    GameAction, DetectedMarker, PlayerRole, ActionResult
)


class GameStateManager:
    """
    Gestor centralizado del estado del juego.
    Maneja personajes, jugadores, acciones y sincronización.
    """
    
    def __init__(self, config_path: str = "../config"):
        self.config_path = Path(config_path)
        self.state = GameState(session_id=str(uuid.uuid4()))
        self.abilities: Dict[str, Ability] = {}
        self.character_templates: Dict[int, dict] = {}  # marker_id -> template
        self.cooldowns: Dict[str, Dict[str, int]] = {}  # character_id -> {ability_id: turns_left}
        self.callbacks: List[Callable] = []
        
        # Cargar configuración
        self._load_config()
    
    def _load_config(self):
        """Carga la configuración desde archivos JSON"""
        try:
            # Cargar personajes
            chars_file = self.config_path / "characters.json"
            if chars_file.exists():
                with open(chars_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for marker_id, char_data in data.items():
                        self.character_templates[int(marker_id)] = char_data
            
            # Cargar habilidades
            abilities_file = self.config_path / "abilities.json"
            if abilities_file.exists():
                with open(abilities_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for ability_id, ability_data in data.items():
                        ability_data['id'] = ability_id
                        self.abilities[ability_id] = Ability(**ability_data)
            
            # Cargar configuración general
            settings_file = self.config_path / "settings.json"
            if settings_file.exists():
                with open(settings_file, 'r', encoding='utf-8') as f:
                    self.state.settings = json.load(f)
                    
            print(f"✅ Configuración cargada: {len(self.character_templates)} personajes, {len(self.abilities)} habilidades")
            
        except Exception as e:
            print(f"⚠️ Error cargando configuración: {e}")
    
    def on_state_change(self, callback: Callable):
        """Registra un callback para cambios de estado"""
        self.callbacks.append(callback)
    
    async def _notify_change(self, change_type: str, data: dict):
        """Notifica a todos los callbacks de un cambio"""
        for callback in self.callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(change_type, data)
                else:
                    callback(change_type, data)
            except Exception as e:
                print(f"Error en callback: {e}")
    
    # === Gestión de Jugadores ===
    
    async def add_player(self, player_id: str, name: str, role: PlayerRole = PlayerRole.PLAYER) -> Player:
        """Añade un nuevo jugador a la sesión"""
        player = Player(id=player_id, name=name, role=role)
        self.state.players[player_id] = player
        await self._notify_change("player_joined", {"player": player.model_dump()})
        return player
    
    async def remove_player(self, player_id: str):
        """Elimina un jugador de la sesión"""
        if player_id in self.state.players:
            player = self.state.players.pop(player_id)
            # Liberar el personaje que controlaba
            for char in self.state.characters.values():
                if char.owner_id == player_id:
                    char.owner_id = None
            await self._notify_change("player_left", {"player_id": player_id, "name": player.name})
    
    def assign_character_to_player(self, player_id: str, character_id: str) -> bool:
        """Asigna un personaje a un jugador"""
        if player_id not in self.state.players:
            return False
        if character_id not in self.state.characters:
            return False
        
        # Desasignar de otro jugador si estaba asignado
        char = self.state.characters[character_id]
        char.owner_id = player_id
        self.state.players[player_id].character_id = character_id
        return True
    
    # === Gestión de Personajes ===
    
    async def add_character_from_marker(self, marker: DetectedMarker) -> Optional[Character]:
        """Crea o actualiza un personaje basado en un marcador detectado"""
        marker_id = marker.marker_id
        
        # Ver si ya existe
        existing = None
        for char_id, char in self.state.characters.items():
            if char.marker_id == marker_id:
                existing = char
                break
        
        if existing:
            # Actualizar posición
            existing.position = marker.position
            await self._notify_change("character_update", {
                "character_id": existing.id,
                "position": marker.position.model_dump()
            })
            return existing
        
        # Crear nuevo personaje desde template
        if marker_id not in self.character_templates:
            print(f"⚠️ Marcador {marker_id} no tiene template de personaje")
            return None
        
        template = self.character_templates[marker_id]
        char_id = f"char_{marker_id}_{uuid.uuid4().hex[:6]}"
        
        character = Character(
            id=char_id,
            marker_id=marker_id,
            name=template.get("name", f"Personaje {marker_id}"),
            character_class=template.get("class", "Aventurero"),
            hp=template.get("hp", 100),
            max_hp=template.get("max_hp", 100),
            mana=template.get("mana", 100),
            max_mana=template.get("max_mana", 100),
            armor=template.get("armor", 0),
            speed=template.get("speed", 6),
            abilities=template.get("abilities", []),
            position=marker.position
        )
        
        self.state.characters[char_id] = character
        self.cooldowns[char_id] = {}
        
        await self._notify_change("character_added", {"character": character.model_dump()})
        print(f"✅ Personaje añadido: {character.name} (marker {marker_id})")
        
        return character
    
    async def remove_character_by_marker(self, marker_id: int):
        """Elimina un personaje cuando su marcador desaparece"""
        to_remove = None
        for char_id, char in self.state.characters.items():
            if char.marker_id == marker_id:
                to_remove = char_id
                break
        
        if to_remove:
            char = self.state.characters.pop(to_remove)
            if to_remove in self.cooldowns:
                del self.cooldowns[to_remove]
            await self._notify_change("character_removed", {
                "character_id": to_remove,
                "name": char.name
            })
    
    def get_character_by_marker(self, marker_id: int) -> Optional[Character]:
        """Obtiene un personaje por su ID de marcador"""
        for char in self.state.characters.values():
            if char.marker_id == marker_id:
                return char
        return None
    
    # === Sistema de Combate ===
    
    async def start_combat(self):
        """Inicia el combate y calcula iniciativa"""
        self.state.is_combat = True
        self.state.current_turn = 1
        
        # Iniciativa simple: orden de adición por ahora
        # TODO: Implementar tiradas de iniciativa
        self.state.initiative_order = list(self.state.characters.keys())
        
        if self.state.initiative_order:
            self.state.active_character_id = self.state.initiative_order[0]
        
        await self._notify_change("combat_start", {
            "turn": 1,
            "initiative_order": self.state.initiative_order,
            "active_character": self.state.active_character_id
        })
    
    async def end_combat(self):
        """Finaliza el combate"""
        self.state.is_combat = False
        self.state.initiative_order = []
        self.state.active_character_id = None
        
        await self._notify_change("combat_end", {})
    
    async def next_turn(self):
        """Avanza al siguiente turno"""
        if not self.state.is_combat or not self.state.initiative_order:
            return
        
        # Reducir cooldowns del personaje actual
        current_char = self.state.active_character_id
        if current_char in self.cooldowns:
            for ability_id in list(self.cooldowns[current_char].keys()):
                self.cooldowns[current_char][ability_id] -= 1
                if self.cooldowns[current_char][ability_id] <= 0:
                    del self.cooldowns[current_char][ability_id]
        
        # Siguiente personaje
        current_idx = self.state.initiative_order.index(self.state.active_character_id)
        next_idx = (current_idx + 1) % len(self.state.initiative_order)
        
        # Si volvemos al inicio, nuevo turno
        if next_idx == 0:
            self.state.current_turn += 1
        
        self.state.active_character_id = self.state.initiative_order[next_idx]
        
        await self._notify_change("turn_change", {
            "turn": self.state.current_turn,
            "active_character": self.state.active_character_id
        })
    
    # === Sistema de Acciones ===
    
    async def execute_ability(
        self,
        character_id: str,
        ability_id: str,
        target_id: Optional[str] = None,
        target_position: Optional[Position] = None
    ) -> ActionResult:
        """Ejecuta una habilidad"""
        
        # Validaciones
        if character_id not in self.state.characters:
            return ActionResult(success=False, message="Personaje no encontrado")
        
        if ability_id not in self.abilities:
            return ActionResult(success=False, message="Habilidad no encontrada")
        
        character = self.state.characters[character_id]
        ability = self.abilities[ability_id]
        
        # Verificar que tiene la habilidad
        if ability_id not in character.abilities:
            return ActionResult(success=False, message=f"{character.name} no tiene esa habilidad")
        
        # Verificar cooldown
        if character_id in self.cooldowns and ability_id in self.cooldowns[character_id]:
            turns_left = self.cooldowns[character_id][ability_id]
            return ActionResult(success=False, message=f"Habilidad en cooldown ({turns_left} turnos)")
        
        # Verificar maná
        if character.mana < ability.mana_cost:
            return ActionResult(success=False, message="Maná insuficiente")
        
        # Ejecutar acción
        result = ActionResult(success=True, message=f"{character.name} usa {ability.name}")
        
        # Gastar maná
        character.mana -= ability.mana_cost
        
        # Aplicar daño o curación
        if ability.damage > 0 and target_id:
            if target_id in self.state.characters:
                target = self.state.characters[target_id]
                target.hp = max(0, target.hp - ability.damage)
                result.damage_dealt = ability.damage
                result.message += f" - {ability.damage} daño a {target.name}"
        
        if ability.heal > 0:
            heal_target = self.state.characters.get(target_id, character)
            heal_target.hp = min(heal_target.max_hp, heal_target.hp + ability.heal)
            result.healing_done = ability.heal
            result.message += f" - {ability.heal} HP curados"
        
        # Iniciar cooldown
        if ability.cooldown > 0:
            if character_id not in self.cooldowns:
                self.cooldowns[character_id] = {}
            self.cooldowns[character_id][ability_id] = ability.cooldown
            result.cooldown_started = ability_id
        
        # Registrar acción
        action = GameAction(
            action_type="ability",
            source_character_id=character_id,
            target_character_id=target_id,
            target_position=target_position,
            ability_id=ability_id,
            result=result.model_dump()
        )
        self.state.action_history.append(action)
        
        # Notificar
        await self._notify_change("action_executed", {
            "action": action.model_dump(),
            "result": result.model_dump(),
            "effect": {
                "type": ability.effect_type,
                "source_position": character.position.model_dump() if character.position else None,
                "target_position": target_position.model_dump() if target_position else None,
                "aoe": ability.aoe,
                "sound": ability.sound,
                "animation": ability.animation
            }
        })
        
        return result
    
    # === Utilidades ===
    
    def get_available_abilities(self, character_id: str) -> List[dict]:
        """Obtiene las habilidades disponibles para un personaje"""
        if character_id not in self.state.characters:
            return []
        
        character = self.state.characters[character_id]
        available = []
        
        for ability_id in character.abilities:
            if ability_id not in self.abilities:
                continue
            
            ability = self.abilities[ability_id]
            cooldown_left = 0
            
            if character_id in self.cooldowns:
                cooldown_left = self.cooldowns[character_id].get(ability_id, 0)
            
            can_use = (
                cooldown_left == 0 and
                character.mana >= ability.mana_cost
            )
            
            available.append({
                "id": ability_id,
                "name": ability.name,
                "description": ability.description,
                "mana_cost": ability.mana_cost,
                "damage": ability.damage,
                "heal": ability.heal,
                "range": ability.range,
                "aoe": ability.aoe,
                "cooldown": ability.cooldown,
                "cooldown_left": cooldown_left,
                "can_use": can_use,
                "effect_type": ability.effect_type
            })
        
        return available
    
    def get_full_state(self) -> dict:
        """Obtiene el estado completo para enviar a clientes"""
        return {
            "session_id": self.state.session_id,
            "current_turn": self.state.current_turn,
            "is_combat": self.state.is_combat,
            "active_character_id": self.state.active_character_id,
            "characters": {
                cid: char.model_dump() for cid, char in self.state.characters.items()
            },
            "players": {
                pid: player.model_dump() for pid, player in self.state.players.items()
            },
            "initiative_order": self.state.initiative_order,
            "current_map": self.state.current_map,
            "recent_actions": [
                action.model_dump() for action in self.state.action_history[-10:]
            ]
        }
