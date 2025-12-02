# API REST Documentation

## Base URL
```
http://localhost:8000/api
```

## Endpoints

### Estado del Juego

#### GET /api/state
Obtiene el estado completo del juego.

**Response:**
```json
{
    "session_id": "abc123",
    "current_turn": 3,
    "is_combat": true,
    "active_character_id": "char_1_abc123",
    "characters": {
        "char_1_abc123": {
            "id": "char_1_abc123",
            "marker_id": 1,
            "name": "Gandalf",
            "class": "Mago",
            "hp": 80,
            "max_hp": 80,
            "mana": 120,
            "max_mana": 150,
            "position": {"x": 500, "y": 300, "rotation": 45}
        }
    },
    "players": {},
    "initiative_order": ["char_1_abc123", "char_2_def456"],
    "current_map": "default"
}
```

---

### Personajes

#### GET /api/characters
Lista todos los personajes activos.

**Response:**
```json
{
    "char_1_abc123": {
        "id": "char_1_abc123",
        "name": "Gandalf",
        "hp": 80,
        "max_hp": 80,
        ...
    }
}
```

#### GET /api/characters/{character_id}
Obtiene un personaje específico.

**Parameters:**
- `character_id` (path): ID del personaje

**Response:**
```json
{
    "id": "char_1_abc123",
    "marker_id": 1,
    "name": "Gandalf",
    "class": "Mago",
    "hp": 80,
    "max_hp": 80,
    "mana": 120,
    "max_mana": 150,
    "armor": 5,
    "speed": 5,
    "abilities": ["fireball", "lightning", "shield"],
    "status_effects": [],
    "position": {"x": 500, "y": 300, "rotation": 45},
    "owner_id": "player_abc",
    "is_visible": true
}
```

#### GET /api/characters/{character_id}/abilities
Obtiene las habilidades disponibles de un personaje.

**Response:**
```json
[
    {
        "id": "fireball",
        "name": "Bola de Fuego",
        "description": "Lanza una devastadora bola de fuego",
        "mana_cost": 30,
        "damage": 35,
        "heal": 0,
        "range": 6,
        "aoe": 2,
        "cooldown": 3,
        "cooldown_left": 0,
        "can_use": true,
        "effect_type": "fire"
    }
]
```

---

### Acciones

#### POST /api/action
Ejecuta una acción de juego.

**Request Body:**
```json
{
    "character_id": "char_1_abc123",
    "action_type": "ability",
    "ability_id": "fireball",
    "target_id": "char_2_def456",
    "target_position": {"x": 800, "y": 400}
}
```

**Response:**
```json
{
    "success": true,
    "message": "Gandalf usa Bola de Fuego - 35 daño a Orco",
    "damage_dealt": 35,
    "healing_done": 0,
    "effects_applied": ["burning"],
    "cooldown_started": "fireball"
}
```

---

### Combate

#### POST /api/combat/start
Inicia el modo combate.

**Response:**
```json
{
    "status": "combat_started"
}
```

#### POST /api/combat/end
Finaliza el combate.

**Response:**
```json
{
    "status": "combat_ended"
}
```

#### POST /api/combat/next-turn
Avanza al siguiente turno.

**Response:**
```json
{
    "status": "turn_advanced",
    "turn": 4
}
```

---

### Conexiones

#### GET /api/connections
Obtiene estadísticas de conexiones activas.

**Response:**
```json
{
    "displays": 1,
    "mobiles": 3,
    "camera": true,
    "admins": 1,
    "mobile_players": ["player_abc", "player_def", "player_ghi"]
}
```

---

## WebSocket API

### Endpoints

| Endpoint | Descripción |
|----------|-------------|
| `/ws/display` | Pantalla de visualización |
| `/ws/mobile?player_id=X&name=Y` | App móvil de jugador |
| `/ws/camera` | Sistema de cámara |
| `/ws/admin` | Panel de administración |

### Mensajes del Cliente → Servidor

#### join
```json
{
    "type": "join",
    "payload": {
        "player_id": "player_abc",
        "name": "Juan"
    }
}
```

#### ability
```json
{
    "type": "ability",
    "payload": {
        "character_id": "char_1_abc123",
        "ability_id": "fireball",
        "target_id": "char_2_def456"
    }
}
```

#### select_character
```json
{
    "type": "select_character",
    "payload": {
        "character_id": "char_1_abc123"
    }
}
```

### Mensajes del Servidor → Cliente

#### state_update
```json
{
    "type": "state_update",
    "payload": {
        "characters": {...},
        "is_combat": true,
        "current_turn": 3
    },
    "timestamp": "2024-01-15T10:30:00Z"
}
```

#### character_added
```json
{
    "type": "character_added",
    "payload": {
        "character": {
            "id": "char_1_abc123",
            "name": "Gandalf",
            ...
        }
    }
}
```

#### effect
```json
{
    "type": "effect",
    "payload": {
        "type": "fire",
        "source_position": {"x": 500, "y": 300},
        "target_position": {"x": 800, "y": 400},
        "aoe": 2,
        "sound": "fireball"
    }
}
```

#### turn_change
```json
{
    "type": "turn_change",
    "payload": {
        "turn": 4,
        "active_character": "char_2_def456"
    }
}
```

#### error
```json
{
    "type": "error",
    "payload": {
        "message": "Maná insuficiente"
    }
}
```

---

## Códigos de Error

| Código | Descripción |
|--------|-------------|
| 404 | Recurso no encontrado |
| 400 | Solicitud inválida |
| 500 | Error interno del servidor |

## Rate Limiting

No hay rate limiting implementado actualmente. Para producción, considera añadir limitación de requests.
