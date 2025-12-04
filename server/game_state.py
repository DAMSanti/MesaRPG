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

from .models import (
    GameState, Character, CharacterSheet, CharacterStatus, Player, Ability, Position,
    GameAction, DetectedMarker, PlayerRole, ActionResult
)

from server.schemas import MapModel


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
        self.game_systems: Dict[str, dict] = {}  # Sistemas de juego disponibles
        self.cooldowns: Dict[str, Dict[str, int]] = {}  # character_id -> {ability_id: turns_left}
        self.callbacks: List[Callable] = []
        
        # Cargar configuración
        self._load_config()
    
    def _load_config(self):
        """Carga la configuración desde archivos JSON"""
        try:
            # Cargar sistemas de juego
            systems_file = self.config_path / "game_systems.json"
            if systems_file.exists():
                with open(systems_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self.game_systems = data.get("systems", {})
            
            # Cargar personajes (templates legacy)
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
                    
            print(f"✅ Configuración cargada: {len(self.character_templates)} personajes, {len(self.abilities)} habilidades, {len(self.game_systems)} sistemas")
            
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
    
    # === Gestión de Sistemas de Juego ===
    
    def get_available_systems(self) -> List[dict]:
        """Obtiene los sistemas de juego disponibles"""
        result = []
        for sys_id, sys_data in self.game_systems.items():
            # Extraer campos planos del characterSheet para el frontend
            character_template = []
            char_sheet = sys_data.get("characterSheet", {})
            for section in char_sheet.get("sections", []):
                for field in section.get("fields", []):
                    character_template.append(field)
            
            result.append({
                "id": sys_id,
                "name": sys_data.get("name"),
                "shortName": sys_data.get("shortName"),
                "icon": sys_data.get("icon"),
                "gridType": sys_data.get("gridType"),
                "character_template": character_template
            })
        return result
    
    def get_system_config(self, system_id: str) -> Optional[dict]:
        """Obtiene la configuración completa de un sistema"""
        return self.game_systems.get(system_id)
    
    async def set_game_system(self, system_id: str) -> bool:
        """Establece el sistema de juego activo"""
        if system_id not in self.game_systems:
            return False
        
        self.state.game_system = system_id
        await self._notify_change("game_system_changed", {
            "system_id": system_id,
            "system": self.game_systems[system_id]
        })
        return True
    
    # === Gestión de Fichas de Personaje ===
    
    async def create_character_sheet(self, player_id: str, player_name: str, sheet_data: dict) -> CharacterSheet:
        """Crea una nueva ficha de personaje"""
        sheet_id = str(uuid.uuid4())[:8]
        sheet = CharacterSheet(
            id=sheet_id,
            player_id=player_id,
            player_name=player_name,
            game_system=self.state.game_system,
            data=sheet_data,
            status=CharacterStatus.DRAFT
        )
        self.state.character_sheets[sheet_id] = sheet
        await self._notify_change("sheet_created", {"sheet": self._serialize_sheet(sheet)})
        return sheet
    
    async def update_character_sheet(self, sheet_id: str, sheet_data: dict, player_id: str) -> Optional[CharacterSheet]:
        """Actualiza una ficha existente"""
        sheet = self.state.character_sheets.get(sheet_id)
        if not sheet:
            return None
        
        # Solo el propietario o GM puede editar
        if sheet.player_id != player_id:
            player = self.state.players.get(player_id)
            if not player or player.role != PlayerRole.GM:
                return None
        
        # No se puede editar si ya está en juego
        if sheet.status == CharacterStatus.IN_GAME:
            return None
        
        sheet.data = sheet_data
        sheet.updated_at = datetime.now()
        sheet.status = CharacterStatus.DRAFT  # Vuelve a borrador si estaba rechazada
        
        await self._notify_change("sheet_updated", {"sheet": self._serialize_sheet(sheet)})
        return sheet
    
    async def submit_character_sheet(self, sheet_id: str, player_id: str) -> bool:
        """Envía una ficha para aprobación"""
        sheet = self.state.character_sheets.get(sheet_id)
        if not sheet or sheet.player_id != player_id:
            return False
        
        if sheet.status not in [CharacterStatus.DRAFT, CharacterStatus.REJECTED]:
            return False
        
        sheet.status = CharacterStatus.PENDING
        sheet.updated_at = datetime.now()
        
        await self._notify_change("sheet_pending", {"sheet": self._serialize_sheet(sheet)})
        return True
    
    async def approve_character_sheet(self, sheet_id: str) -> bool:
        """Aprueba una ficha de personaje (solo GM)"""
        sheet = self.state.character_sheets.get(sheet_id)
        if not sheet or sheet.status != CharacterStatus.PENDING:
            return False
        
        sheet.status = CharacterStatus.APPROVED
        sheet.approved_at = datetime.now()
        sheet.rejection_reason = None
        
        await self._notify_change("sheet_approved", {"sheet": self._serialize_sheet(sheet)})
        return True
    
    async def reject_character_sheet(self, sheet_id: str, reason: str = "") -> bool:
        """Rechaza una ficha de personaje (solo GM)"""
        sheet = self.state.character_sheets.get(sheet_id)
        if not sheet or sheet.status != CharacterStatus.PENDING:
            return False
        
        sheet.status = CharacterStatus.REJECTED
        sheet.rejection_reason = reason
        sheet.updated_at = datetime.now()
        
        await self._notify_change("sheet_rejected", {
            "sheet": self._serialize_sheet(sheet),
            "reason": reason
        })
        return True
    
    async def assign_token_to_sheet(self, sheet_id: str, marker_id: int, token_visual: Optional[str] = None) -> bool:
        """Asigna un token/marcador a una ficha aprobada"""
        sheet = self.state.character_sheets.get(sheet_id)
        if not sheet or sheet.status != CharacterStatus.APPROVED:
            return False
        
        # Verificar que el marcador está disponible
        if marker_id not in self.state.available_markers:
            return False
        
        # Asignar marcador y token visual
        sheet.marker_id = marker_id
        sheet.token_visual = token_visual
        sheet.status = CharacterStatus.IN_GAME
        self.state.available_markers.remove(marker_id)
        
        await self._notify_change("token_assigned", {
            "sheet": self._serialize_sheet(sheet),
            "marker_id": marker_id,
            "token_visual": token_visual
        })
        return True
    
    def get_player_sheet(self, player_id: str) -> Optional[CharacterSheet]:
        """Obtiene la ficha de un jugador"""
        for sheet in self.state.character_sheets.values():
            if sheet.player_id == player_id:
                return sheet
        return None
    
    def get_pending_sheets(self) -> List[CharacterSheet]:
        """Obtiene todas las fichas pendientes de aprobación"""
        return [s for s in self.state.character_sheets.values() if s.status == CharacterStatus.PENDING]
    
    def get_approved_sheets(self) -> List[CharacterSheet]:
        """Obtiene todas las fichas aprobadas (con o sin token)"""
        return [s for s in self.state.character_sheets.values() 
                if s.status in [CharacterStatus.APPROVED, CharacterStatus.IN_GAME]]
    
    def _serialize_sheet(self, sheet: CharacterSheet) -> dict:
        """Serializa una ficha para enviar por WebSocket"""
        data = sheet.model_dump()
        # Convertir datetimes a ISO strings
        for key in ['created_at', 'updated_at', 'approved_at']:
            if data.get(key):
                data[key] = data[key].isoformat() if hasattr(data[key], 'isoformat') else str(data[key])
        
        # Añadir campos para compatibilidad con el admin panel
        data['system_id'] = data.get('game_system')  # alias para el frontend
        data['character_name'] = sheet.data.get('name', sheet.data.get('mech_name', 'Sin nombre'))
        data['submitted_at'] = data.get('updated_at')  # para ordenamiento en pendientes
        
        return data
    
    # === Gestión de Jugadores ===
    
    async def add_player(self, player_id: str, name: str, role: PlayerRole = PlayerRole.PLAYER) -> Player:
        """Añade un nuevo jugador a la sesión"""
        player = Player(id=player_id, name=name, role=role)
        self.state.players[player_id] = player
        await self._notify_change("player_joined", {"player": self._serialize_datetime(player.model_dump())})
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
    
    def _serialize_datetime(self, obj):
        """Convierte datetime a string ISO para JSON"""
        if hasattr(obj, 'isoformat'):
            return obj.isoformat()
        elif isinstance(obj, dict):
            return {k: self._serialize_datetime(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._serialize_datetime(item) for item in obj]
        return obj

    
    # === Gestión de Mapas ===

    async def get_all_maps(self) -> List[dict]:
        """Obtiene todos los mapas guardados"""
        maps_dir = self.config_path / "maps"
        maps_dir.mkdir(exist_ok=True)
        
        maps = []
        for map_file in maps_dir.glob("*.json"):
            try:
                with open(map_file, 'r', encoding='utf-8') as f:
                    map_data = json.load(f)
                    try:
                        model = MapModel(**map_data)
                        maps.append({
                            "id": map_file.stem,
                            "name": model.name,
                            "width": model.width,
                            "height": model.height,
                            "type": model.type,
                            "created_at": model.created_at,
                            "updated_at": model.updated_at
                        })
                    except Exception:
                        # Fallback: include minimal metadata if validation fails
                        maps.append({
                            "id": map_file.stem,
                            "name": map_data.get("name", map_file.stem),
                            "width": map_data.get("width", 20),
                            "height": map_data.get("height", 15),
                            "type": map_data.get("type", "custom"),
                            "created_at": map_data.get("created_at"),
                            "updated_at": map_data.get("updated_at")
                        })
            except Exception as e:
                print(f"⚠️ Error leyendo mapa {map_file}: {e}")
        
        return maps
    
    async def get_map(self, map_id: str) -> Optional[dict]:
        """Obtiene un mapa específico"""
        map_file = self.config_path / "maps" / f"{map_id}.json"
        if not map_file.exists():
            return None
        
        try:
            with open(map_file, 'r', encoding='utf-8') as f:
                map_data = json.load(f)
                try:
                    model = MapModel(**map_data)
                    return model.model_dump()
                except Exception:
                    return map_data
        except Exception as e:
            print(f"⚠️ Error leyendo mapa {map_id}: {e}")
            return None
    
    async def save_map(self, map_data: dict) -> dict:
        """Guarda un mapa (nuevo o existente)"""
        maps_dir = self.config_path / "maps"
        maps_dir.mkdir(exist_ok=True)
        # Validate and normalize via Pydantic model
        try:
            model = MapModel(**map_data)
        except Exception as e:
            # If validation fails, raise to caller
            raise

        # Generar ID si no tiene
        map_id = model.id or str(uuid.uuid4())[:8]
        model.id = map_id

        # Timestamps
        now = datetime.now().isoformat()
        if not model.created_at:
            model.created_at = now
        model.updated_at = now

        # Dump normalized dict
        out = model.model_dump()

        # Guardar
        map_file = maps_dir / f"{map_id}.json"
        with open(map_file, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2, ensure_ascii=False)

        # Notificar cambio
        await self._notify_change("map_saved", {"map_id": map_id, "name": model.name})

        return {"id": map_id, "status": "saved"}
    
    async def delete_map(self, map_id: str) -> bool:
        """Elimina un mapa"""
        map_file = self.config_path / "maps" / f"{map_id}.json"
        if map_file.exists():
            map_file.unlink()
            await self._notify_change("map_deleted", {"map_id": map_id})
            return True
        return False
    
    async def set_current_map(self, map_id: str) -> bool:
        """Establece el mapa actual para el display"""
        map_data = await self.get_map(map_id)
        if not map_data:
            return False
        
        self.state.current_map = map_data
        
        # Notificar a todos los displays
        await self._notify_change("map_changed", {"map": map_data})
        
        return True
    
    def get_full_state(self) -> dict:
        """Obtiene el estado completo para enviar a clientes"""
        try:
            return {
                "session_id": str(self.state.session_id) if self.state.session_id else "",
                "game_system": self.state.game_system,
                "game_system_id": self.state.game_system,  # alias para frontend
                "game_system_info": self.game_systems.get(self.state.game_system, {}),
                "current_turn": self.state.current_turn or 0,
                "is_combat": bool(self.state.is_combat),
                "active_character_id": self.state.active_character_id,
                "characters": {
                    str(cid): self._serialize_datetime(char.model_dump()) for cid, char in self.state.characters.items()
                } if self.state.characters else {},
                "character_sheets": {
                    str(sid): self._serialize_sheet(sheet) for sid, sheet in self.state.character_sheets.items()
                } if self.state.character_sheets else {},
                "players": {
                    str(pid): self._serialize_datetime(player.model_dump()) for pid, player in self.state.players.items()
                } if self.state.players else {},
                "initiative_order": list(self.state.initiative_order) if self.state.initiative_order else [],
                "current_map": self.state.current_map,
                "available_markers": self.state.available_markers,
                "available_systems": self.get_available_systems(),
                "recent_actions": [
                    self._serialize_datetime(action.model_dump()) for action in (self.state.action_history[-10:] if self.state.action_history else [])
                ]
            }
        except Exception as e:
            print(f"⚠️ Error en get_full_state: {e}")
            return {
                "session_id": "",
                "game_system": "generic",
                "current_turn": 0,
                "is_combat": False,
                "active_character_id": None,
                "characters": {},
                "character_sheets": {},
                "players": {},
                "initiative_order": [],
                "current_map": None,
                "available_markers": [],
                "available_systems": [],
                "recent_actions": []
            }
