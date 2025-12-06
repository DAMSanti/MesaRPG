"""
MesaRPG - Servidor Principal
FastAPI server que coordina todo el sistema
"""

import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .models import (
    WSMessageType, Position, DetectedMarker, PlayerRole,
    ActionRequest
)
from .game_state import GameStateManager
from .websocket_manager import ConnectionManager
from .camera_manager import camera_manager, CameraState
from .frame_processor import frame_processor


# === Utilidades ===
def json_serial(obj):
    """Serializador JSON para objetos que no son serializables por defecto"""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Type {type(obj)} not serializable")


async def send_json_safe(websocket: WebSocket, data: dict):
    """Envía JSON de forma segura, manejando tipos como datetime"""
    text = json.dumps(data, default=json_serial)
    await websocket.send_text(text)


# === Configuración ===
BASE_DIR = Path(__file__).parent.parent
CONFIG_DIR = BASE_DIR / "config"
DISPLAY_DIR = BASE_DIR / "display"
MOBILE_DIR = BASE_DIR / "mobile"

# === Inicialización ===
game_state = GameStateManager(str(CONFIG_DIR))
ws_manager = ConnectionManager()


# Callback para sincronizar cambios de estado
async def on_game_state_change(change_type: str, data: dict):
    """Callback cuando cambia el estado del juego"""
    message = {
        "type": change_type,
        "payload": data
    }
    await ws_manager.broadcast_all(message)
    
    # Si es un efecto, enviarlo específicamente a displays
    if change_type == "action_executed" and "effect" in data:
        await ws_manager.send_effect(data["effect"])

game_state.on_state_change(on_game_state_change)


# Configurar callbacks del camera manager para broadcasting
def on_markers_detected(markers: list):
    """Callback cuando se detectan marcadores"""
    import asyncio
    try:
        # Obtener miniaturas con información de jugador
        miniatures = camera_manager.get_visible_miniatures()
        # Programar el broadcast en el loop de eventos
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.create_task(ws_manager.send_miniature_positions(miniatures))
    except Exception as e:
        print(f"Error en callback de marcadores: {e}")

camera_manager.set_callbacks(on_markers_detected=on_markers_detected)


# === Lifespan ===
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gestión del ciclo de vida de la app"""
    print("🎲 MesaRPG iniciando...")
    print(f"📁 Directorio base: {BASE_DIR}")
    yield
    print("🎲 MesaRPG cerrando...")


# === App FastAPI ===
app = FastAPI(
    title="MesaRPG",
    description="Sistema interactivo de mesa de juego",
    version="1.0.0",
    lifespan=lifespan
)

# CORS para desarrollo
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# === Rutas HTML === (deben ir ANTES de los archivos estáticos)

@app.get("/", response_class=HTMLResponse)
async def root():
    """Página de inicio"""
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>MesaRPG</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            h1 { color: #333; }
            .links { display: flex; gap: 20px; flex-wrap: wrap; }
            .link-card { 
                padding: 20px; 
                border: 2px solid #ddd; 
                border-radius: 10px; 
                text-decoration: none;
                color: #333;
                width: 200px;
                text-align: center;
                transition: all 0.3s;
            }
            .link-card:hover { border-color: #007bff; background: #f0f7ff; }
            .link-card h3 { margin: 0 0 10px 0; }
            .link-card p { margin: 0; font-size: 14px; color: #666; }
            .emoji { font-size: 40px; }
        </style>
    </head>
    <body>
        <h1>🎲 MesaRPG</h1>
        <p>Sistema interactivo de mesa de juego</p>
        <div class="links">
            <a href="/display" class="link-card">
                <div class="emoji">📺</div>
                <h3>Pantalla</h3>
                <p>Visualización principal</p>
            </a>
            <a href="/mobile" class="link-card">
                <div class="emoji">📱</div>
                <h3>Móvil</h3>
                <p>Control de jugador</p>
            </a>
            <a href="/admin" class="link-card">
                <div class="emoji">🎮</div>
                <h3>Admin</h3>
                <p>Panel del GM</p>
            </a>
            <a href="/docs" class="link-card">
                <div class="emoji">📚</div>
                <h3>API Docs</h3>
                <p>Documentación</p>
            </a>
        </div>
    </body>
    </html>
    """

@app.get("/display", response_class=HTMLResponse)
async def display_page():
    """Página de la pantalla de visualización"""
    html_file = DISPLAY_DIR / "index.html"
    if html_file.exists():
        return FileResponse(html_file)
    return HTMLResponse("<h1>Display no configurado</h1><p>Falta el archivo display/index.html</p>")

@app.get("/mobile", response_class=HTMLResponse)
async def mobile_page():
    """Página de la app móvil"""
    html_file = MOBILE_DIR / "index.html"
    if html_file.exists():
        return FileResponse(html_file)
    return HTMLResponse("<h1>Mobile no configurado</h1><p>Falta el archivo mobile/index.html</p>")

@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    """Panel de administración del GM - Nuevo panel con soporte de sistemas de juego"""
    admin_dir = BASE_DIR / "admin"
    html_file = admin_dir / "index.html"
    if html_file.exists():
        return FileResponse(html_file)
    return HTMLResponse("<h1>Admin no configurado</h1><p>Falta el archivo admin/index.html</p>")


# === Archivos Estáticos para Admin ===
ADMIN_DIR = BASE_DIR / "admin"

@app.get("/admin/css/{filename}")
async def admin_css(filename: str):
    file_path = ADMIN_DIR / "css" / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="text/css")
    raise HTTPException(status_code=404, detail="CSS file not found")

@app.get("/admin/js/{filename}")
async def admin_js(filename: str):
    file_path = ADMIN_DIR / "js" / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="JS file not found")


# === Archivos Estáticos para Display ===
@app.get("/css/style.css")
async def display_css():
    return FileResponse(DISPLAY_DIR / "css" / "style.css", media_type="text/css")

@app.get("/js/websocket.js")
async def display_websocket_js():
    return FileResponse(DISPLAY_DIR / "js" / "websocket.js", media_type="application/javascript")

@app.get("/js/effects.js")
async def display_effects_js():
    return FileResponse(DISPLAY_DIR / "js" / "effects.js", media_type="application/javascript")

@app.get("/js/renderer.js")
async def display_renderer_js():
    return FileResponse(DISPLAY_DIR / "js" / "renderer.js", media_type="application/javascript")

@app.get("/js/app.js")
async def display_app_js():
    return FileResponse(DISPLAY_DIR / "js" / "app.js", media_type="application/javascript")


# === Archivos Estáticos para Mobile ===
@app.get("/css/mobile.css")
async def mobile_css():
    return FileResponse(MOBILE_DIR / "css" / "mobile.css", media_type="text/css")

@app.get("/mobile/css/mobile.css")
async def mobile_css_alt():
    return FileResponse(MOBILE_DIR / "css" / "mobile.css", media_type="text/css")

@app.get("/mobile/js/app.js")
async def mobile_app_js():
    return FileResponse(MOBILE_DIR / "js" / "app.js", media_type="application/javascript")

@app.get("/mobile/js/controls.js")
async def mobile_controls_js():
    return FileResponse(MOBILE_DIR / "js" / "controls.js", media_type="application/javascript")

@app.get("/mobile/js/sheets.js")
async def mobile_sheets_js():
    return FileResponse(MOBILE_DIR / "js" / "sheets.js", media_type="application/javascript")

@app.get("/mobile/manifest.json")
async def mobile_manifest():
    return FileResponse(MOBILE_DIR / "manifest.json", media_type="application/json")

@app.get("/mobile/sw.js")
async def mobile_sw():
    return FileResponse(MOBILE_DIR / "sw.js", media_type="application/javascript")

@app.get("/mobile/assets/{filename}")
async def mobile_assets(filename: str):
    file_path = MOBILE_DIR / "assets" / filename
    if file_path.exists():
        return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="Asset not found")

# === Assets (tokens, markers, etc.) ===

@app.get("/assets/markers/tokens.json")
async def tokens_index():
    """Índice de todos los tokens disponibles"""
    file_path = BASE_DIR / "assets" / "markers" / "tokens.json"
    if file_path.exists():
        return FileResponse(file_path, media_type="application/json")
    raise HTTPException(status_code=404, detail="Token index not found")

@app.get("/assets/markers/{category}/{filename}")
async def get_token_image(category: str, filename: str):
    """Obtiene una imagen de token (dnd, battletech, generic)"""
    if category not in ["dnd", "battletech", "generic"]:
        raise HTTPException(status_code=400, detail="Invalid token category")
    
    file_path = BASE_DIR / "assets" / "markers" / category / filename
    if file_path.exists():
        media_type = "image/svg+xml" if filename.endswith(".svg") else "image/png"
        return FileResponse(file_path, media_type=media_type)
    raise HTTPException(status_code=404, detail="Token not found")


# === Assets de Tiles para Mapas ===

@app.get("/assets/tiles/{system}/{filename}")
async def get_tile_image(system: str, filename: str):
    """Obtiene una imagen de tile para el editor de mapas"""
    file_path = BASE_DIR / "assets" / "tiles" / system / filename
    if file_path.exists():
        media_type = "image/png" if filename.endswith(".png") else "image/svg+xml"
        return FileResponse(file_path, media_type=media_type)
    raise HTTPException(status_code=404, detail="Tile not found")

@app.get("/assets/tiles/{system}/thumbnails/{filename}")
async def get_tile_thumbnail(system: str, filename: str):
    """Obtiene un thumbnail de tile para la paleta del editor"""
    file_path = BASE_DIR / "assets" / "tiles" / system / "thumbnails" / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="image/png")
    raise HTTPException(status_code=404, detail="Thumbnail not found")


# === API REST ===

@app.get("/api/state")
async def get_state():
    """Obtiene el estado completo del juego"""
    return game_state.get_full_state()

@app.get("/api/connections")
async def get_connections():
    """Obtiene estadísticas de conexiones"""
    return ws_manager.get_stats()

@app.get("/api/characters")
async def get_characters():
    """Obtiene todos los personajes"""
    return {cid: char.model_dump() for cid, char in game_state.state.characters.items()}

@app.get("/api/characters/{character_id}")
async def get_character(character_id: str):
    """Obtiene un personaje específico"""
    if character_id not in game_state.state.characters:
        raise HTTPException(status_code=404, detail="Personaje no encontrado")
    return game_state.state.characters[character_id].model_dump()

@app.get("/api/characters/{character_id}/abilities")
async def get_character_abilities(character_id: str):
    """Obtiene las habilidades disponibles de un personaje"""
    return game_state.get_available_abilities(character_id)

@app.post("/api/action")
async def execute_action(request: ActionRequest):
    """Ejecuta una acción de juego"""
    result = await game_state.execute_ability(
        request.character_id,
        request.ability_id,
        request.target_id,
        request.target_position
    )
    return result.model_dump()


@app.post("/api/action/with-position")
async def execute_action_with_camera_position(body: dict = Body(...)):
    """
    Ejecuta una acción y usa la posición de la miniatura del jugador desde la cámara.
    Útil para reproducir animaciones en la posición correcta del tablero.
    """
    player_id = body.get("player_id")
    action_type = body.get("action_type", "action")
    effect_data = body.get("effect")
    
    if not player_id:
        raise HTTPException(status_code=400, detail="player_id es requerido")
    
    # Obtener la posición de la miniatura del jugador
    miniature = camera_manager.get_miniature_for_player(player_id)
    
    if not miniature or not miniature.is_visible:
        raise HTTPException(status_code=404, detail="Miniatura del jugador no encontrada o no visible")
    
    # Enviar la acción con la posición a todos los displays
    await ws_manager.send_player_action_at_position(
        player_id=player_id,
        player_name=miniature.player_name,
        x=miniature.x,
        y=miniature.y,
        action_type=action_type,
        effect_data=effect_data
    )
    
    return {
        "status": "success",
        "player_id": player_id,
        "position": {"x": miniature.x, "y": miniature.y},
        "action_type": action_type
    }

@app.post("/api/combat/start")
async def start_combat():
    """Inicia el combate"""
    await game_state.start_combat()
    return {"status": "combat_started"}

@app.post("/api/combat/end")
async def end_combat():
    """Finaliza el combate"""
    await game_state.end_combat()
    return {"status": "combat_ended"}

@app.post("/api/combat/next-turn")
async def next_turn():
    """Avanza al siguiente turno"""
    await game_state.next_turn()
    return {"status": "turn_advanced", "turn": game_state.state.current_turn}


# === API de Sistemas de Juego ===

@app.get("/api/systems")
async def get_game_systems():
    """Obtiene los sistemas de juego disponibles"""
    return {"systems": game_state.get_available_systems()}

@app.get("/api/systems/{system_id}")
async def get_system_config(system_id: str):
    """Obtiene la configuración completa de un sistema"""
    config = game_state.get_system_config(system_id)
    if not config:
        raise HTTPException(status_code=404, detail="Sistema no encontrado")
    return config

@app.post("/api/systems/set/{system_id}")
async def set_game_system(system_id: str):
    """Establece el sistema de juego activo (solo GM)"""
    success = await game_state.set_game_system(system_id)
    if not success:
        raise HTTPException(status_code=400, detail="Sistema no válido")
    return {"status": "success", "system_id": system_id}

@app.post("/api/session/select-system")
async def select_game_system(data: dict):
    """Establece el sistema de juego activo (endpoint alternativo para admin panel)"""
    system_id = data.get("system_id")
    if not system_id:
        raise HTTPException(status_code=400, detail="system_id es requerido")
    success = await game_state.set_game_system(system_id)
    if not success:
        raise HTTPException(status_code=400, detail="Sistema no válido")
    return {"status": "success", "system_id": system_id}


# === API de Fichas de Personaje ===

@app.get("/api/sheets")
async def get_all_sheets(status: Optional[str] = None, player_id: Optional[str] = None):
    """Obtiene fichas de personaje, opcionalmente filtradas por estado o jugador"""
    sheets = list(game_state.state.character_sheets.values())
    
    # Filtrar por jugador si se especifica
    if player_id:
        sheets = [s for s in sheets if s.player_id == player_id]
    
    # Filtrar por estado si se especifica
    if status:
        if status == "approved":
            # Incluir tanto 'approved' como 'in_game' para fichas aprobadas
            sheets = [s for s in sheets if s.status.value in ["approved", "in_game"]]
        else:
            sheets = [s for s in sheets if s.status.value == status]
    
    return [game_state._serialize_sheet(s) for s in sheets]

@app.get("/api/sheets/pending")
async def get_pending_sheets():
    """Obtiene las fichas pendientes de aprobación"""
    return [game_state._serialize_sheet(s) for s in game_state.get_pending_sheets()]

@app.get("/api/sheets/{sheet_id}")
async def get_sheet(sheet_id: str):
    """Obtiene una ficha específica"""
    sheet = game_state.state.character_sheets.get(sheet_id)
    if not sheet:
        raise HTTPException(status_code=404, detail="Ficha no encontrada")
    return game_state._serialize_sheet(sheet)

@app.post("/api/sheets")
async def create_sheet(body: dict = Body(...)):
    """Crea una nueva ficha de personaje"""
    player_id = body.get('player_id')
    player_name = body.get('player_name', 'Jugador')
    data = body.get('data', {})
    
    if not player_id:
        raise HTTPException(status_code=400, detail="Se requiere player_id")
    
    sheet = await game_state.create_character_sheet(player_id, player_name, data)
    return {"status": "success", "sheet": game_state._serialize_sheet(sheet)}

@app.put("/api/sheets/{sheet_id}")
async def update_sheet(sheet_id: str, body: dict = Body(...)):
    """Actualiza una ficha existente"""
    player_id = body.get('player_id')
    data = body.get('data', {})
    
    sheet = await game_state.update_character_sheet(sheet_id, data, player_id)
    if not sheet:
        raise HTTPException(status_code=400, detail="No se pudo actualizar la ficha")
    return {"status": "success", "sheet": game_state._serialize_sheet(sheet)}

@app.post("/api/sheets/{sheet_id}/submit")
async def submit_sheet(sheet_id: str, body: dict = Body(...)):
    """Envía una ficha para aprobación"""
    player_id = body.get('player_id')
    success = await game_state.submit_character_sheet(sheet_id, player_id)
    if not success:
        raise HTTPException(status_code=400, detail="No se pudo enviar la ficha")
    return {"status": "success"}

@app.post("/api/sheets/{sheet_id}/approve")
async def approve_sheet(sheet_id: str):
    """Aprueba una ficha (solo GM)"""
    success = await game_state.approve_character_sheet(sheet_id)
    if not success:
        raise HTTPException(status_code=400, detail="No se pudo aprobar la ficha")
    return {"status": "success"}

@app.post("/api/sheets/{sheet_id}/reject")
async def reject_sheet(sheet_id: str, body: dict = Body(default={})):
    """Rechaza una ficha (solo GM)"""
    reason = body.get('reason', '')
    success = await game_state.reject_character_sheet(sheet_id, reason)
    if not success:
        raise HTTPException(status_code=400, detail="No se pudo rechazar la ficha")
    return {"status": "success"}

@app.post("/api/sheets/{sheet_id}/assign-token")
async def assign_token(sheet_id: str, body: dict = Body(...)):
    """Asigna un token/marcador a una ficha aprobada (solo GM)"""
    marker_id = body.get('marker_id')
    token_visual = body.get('token_visual')  # ID del token visual (opcional)
    if marker_id is None:
        raise HTTPException(status_code=400, detail="Se requiere marker_id")
    success = await game_state.assign_token_to_sheet(sheet_id, marker_id, token_visual)
    if not success:
        raise HTTPException(status_code=400, detail="No se pudo asignar el token")
    return {"status": "success", "marker_id": marker_id, "token_visual": token_visual}

@app.get("/api/markers/available")
async def get_available_markers():
    """Obtiene los marcadores disponibles para asignar"""
    return {"markers": game_state.state.available_markers}


# === Archivos de Configuración ===

@app.get("/config/{filename}")
async def get_config_file(filename: str):
    """Sirve archivos JSON de configuración"""
    if not filename.endswith('.json'):
        raise HTTPException(status_code=400, detail="Solo archivos JSON permitidos")
    
    file_path = CONFIG_DIR / filename
    if file_path.exists():
        return FileResponse(file_path, media_type="application/json")
    raise HTTPException(status_code=404, detail=f"Archivo de configuración no encontrado: {filename}")


# === API de Tiles y Mapas ===

@app.get("/api/tiles")
async def get_tiles():
    """Obtiene la biblioteca de tiles disponibles (genéricos)"""
    tiles_file = CONFIG_DIR / "tiles.json"
    if tiles_file.exists():
        with open(tiles_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"categories": {}, "tiles": {}}

@app.get("/api/tiles/{system_id}")
async def get_tiles_for_system(system_id: str):
    """Obtiene la biblioteca de tiles para un sistema de juego específico"""
    # Primero intentar cargar tiles específicos del sistema
    system_tiles_file = CONFIG_DIR / f"tiles_{system_id}.json"
    if system_tiles_file.exists():
        with open(system_tiles_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    # Fallback a tiles genéricos
    tiles_file = CONFIG_DIR / "tiles.json"
    if tiles_file.exists():
        with open(tiles_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    return {"categories": {}, "tiles": {}}

@app.get("/api/maps")
async def get_all_maps():
    """Obtiene todos los mapas guardados"""
    maps = await game_state.get_all_maps()
    return {"maps": maps}

@app.get("/api/maps/{map_id}")
async def get_map(map_id: str):
    """Obtiene un mapa específico"""
    map_data = await game_state.get_map(map_id)
    if not map_data:
        raise HTTPException(status_code=404, detail="Mapa no encontrado")
    return map_data

@app.post("/api/maps")
async def save_map(body: dict = Body(...)):
    """Guarda un mapa (nuevo o actualizado)"""
    result = await game_state.save_map(body)
    return result

@app.delete("/api/maps/{map_id}")
async def delete_map(map_id: str):
    """Elimina un mapa"""
    success = await game_state.delete_map(map_id)
    if not success:
        raise HTTPException(status_code=404, detail="Mapa no encontrado")
    return {"status": "deleted", "map_id": map_id}

@app.post("/api/maps/{map_id}/project")
async def project_map(map_id: str):
    """Proyecta un mapa al display"""
    success = await game_state.set_current_map(map_id)
    if not success:
        raise HTTPException(status_code=404, detail="Mapa no encontrado")
    return {"status": "projected", "map_id": map_id}

@app.post("/api/display/project-map")
async def project_map_data(body: dict = Body(...)):
    """Proyecta datos de mapa directamente al display (sin guardar)"""
    map_data = body.get("mapData")
    if not map_data:
        raise HTTPException(status_code=400, detail="Se requiere mapData")
    
    # Actualizar estado y notificar a displays
    game_state.state.current_map = map_data
    await game_state._notify_change("map_changed", {"map": map_data})
    
    return {"status": "projected"}


# === Debug API ===

@app.post("/api/debug/add-test-character")
async def add_test_character(marker_id: int = 1, name: str = "Test Character"):
    """Añade un personaje de prueba (para desarrollo sin cámara)"""
    from .models import DetectedMarker, Position
    
    # Crear un marcador ficticio
    marker = DetectedMarker(
        marker_id=marker_id,
        position=Position(x=400, y=300, rotation=0),
        corners=[[0,0], [100,0], [100,100], [0,100]]
    )
    
    # Añadir personaje desde el marcador
    character = await game_state.add_character_from_marker(marker)
    
    if character:
        return {"status": "success", "character": character.model_dump()}
    else:
        return {"status": "error", "message": "No hay template para ese marker_id"}


@app.delete("/api/debug/clear-characters")
async def clear_characters():
    """Elimina todos los personajes (para desarrollo)"""
    for char_id in list(game_state.state.characters.keys()):
        await game_state.remove_character_by_marker(
            game_state.state.characters[char_id].marker_id
        )
    return {"status": "success", "message": "Todos los personajes eliminados"}


# === API de Cámara ===

@app.get("/api/camera/status")
async def get_camera_status():
    """Obtiene el estado completo de la cámara"""
    return camera_manager.get_status()

@app.get("/api/camera/devices")
async def get_camera_devices():
    """Lista las cámaras disponibles"""
    cameras = camera_manager.get_available_cameras()
    return {"cameras": cameras}

@app.post("/api/camera/connect")
async def connect_camera(body: dict = Body(...)):
    """Conecta a una cámara"""
    camera_id = body.get("camera_id", 0)
    camera_url = body.get("camera_url")  # Para cámaras IP
    
    success = camera_manager.connect(camera_id=camera_id, camera_url=camera_url)
    if success:
        return {"status": "connected", "camera": camera_manager.get_status()}
    else:
        raise HTTPException(status_code=500, detail=camera_manager.error_message or "No se pudo conectar a la cámara")

@app.post("/api/camera/disconnect")
async def disconnect_camera():
    """Desconecta la cámara"""
    camera_manager.disconnect()
    return {"status": "disconnected"}

@app.post("/api/camera/stream/start")
async def start_camera_stream():
    """Inicia el streaming de video"""
    if camera_manager.state not in [CameraState.CONNECTED, CameraState.STREAMING]:
        raise HTTPException(status_code=400, detail="Cámara no conectada")
    
    success = camera_manager.start_streaming()
    if success:
        return {"status": "streaming"}
    else:
        raise HTTPException(status_code=500, detail="No se pudo iniciar el streaming")

@app.post("/api/camera/stream/stop")
async def stop_camera_stream():
    """Detiene el streaming de video"""
    camera_manager.stop_streaming()
    return {"status": "stopped"}

@app.get("/api/camera/frame")
async def get_camera_frame():
    """Obtiene el frame actual de la cámara (para polling)"""
    frame = camera_manager.get_current_frame()
    if frame:
        return {"frame": frame}
    else:
        # Intentar capturar un frame si no está en streaming
        if camera_manager.state == CameraState.CONNECTED:
            frame = camera_manager.capture_single_frame()
            if frame:
                return {"frame": frame}
        raise HTTPException(status_code=404, detail="No hay frame disponible")

@app.get("/api/camera/miniatures")
async def get_all_miniatures():
    """Obtiene todas las miniaturas trackeadas"""
    return {"miniatures": camera_manager.get_all_miniatures()}

@app.get("/api/camera/miniatures/visible")
async def get_visible_miniatures():
    """Obtiene solo las miniaturas visibles"""
    return {"miniatures": camera_manager.get_visible_miniatures()}

@app.post("/api/camera/miniatures/assign")
async def assign_player_to_miniature(body: dict = Body(...)):
    """Asigna un jugador a una miniatura"""
    marker_id = body.get("marker_id")
    player_id = body.get("player_id")
    player_name = body.get("player_name")
    character_name = body.get("character_name")
    
    if marker_id is None or player_id is None or player_name is None:
        raise HTTPException(status_code=400, detail="marker_id, player_id y player_name son requeridos")
    
    success = camera_manager.assign_player_to_miniature(
        marker_id=marker_id,
        player_id=player_id,
        player_name=player_name,
        character_name=character_name
    )
    
    return {"status": "assigned" if success else "error"}

@app.post("/api/camera/miniatures/unassign/{marker_id}")
async def unassign_miniature(marker_id: int):
    """Desasigna un jugador de una miniatura"""
    success = camera_manager.unassign_miniature(marker_id)
    return {"status": "unassigned" if success else "not_found"}

@app.get("/api/camera/miniatures/player/{player_id}")
async def get_player_miniature(player_id: str):
    """Obtiene la miniatura asignada a un jugador"""
    miniature = camera_manager.get_miniature_for_player(player_id)
    if miniature:
        return miniature.to_dict()
    raise HTTPException(status_code=404, detail="Jugador no tiene miniatura asignada")

@app.post("/api/camera/calibration/start")
async def start_calibration():
    """Inicia el modo de calibración"""
    camera_manager.start_calibration()
    return {"status": "calibrating"}

@app.post("/api/camera/calibration/point")
async def add_calibration_point(body: dict = Body(...)):
    """Añade un punto de calibración"""
    image_x = body.get("image_x")
    image_y = body.get("image_y")
    game_x = body.get("game_x")
    game_y = body.get("game_y")
    
    if None in [image_x, image_y, game_x, game_y]:
        raise HTTPException(status_code=400, detail="Se requieren image_x, image_y, game_x, game_y")
    
    count = camera_manager.add_calibration_point(image_x, image_y, game_x, game_y)
    return {"status": "point_added", "total_points": count}

@app.post("/api/camera/calibration/finish")
async def finish_calibration():
    """Finaliza la calibración"""
    success = camera_manager.finish_calibration()
    if success:
        return {"status": "calibrated", "calibration": camera_manager.get_status()["calibration"]}
    else:
        raise HTTPException(status_code=400, detail="Se necesitan al menos 4 puntos de calibración")

@app.post("/api/camera/calibration/simple")
async def simple_calibration(body: dict = Body(...)):
    """Calibración simple: mapeo lineal de imagen a área de juego"""
    game_width = body.get("game_width", 1920)
    game_height = body.get("game_height", 1080)
    
    success = camera_manager.set_simple_calibration(game_width, game_height)
    if success:
        return {"status": "calibrated", "game_size": {"width": game_width, "height": game_height}}
    else:
        raise HTTPException(status_code=500, detail="Error en calibración simple")


# === WebSocket Endpoints ===

@app.websocket("/ws/display")
async def websocket_display(websocket: WebSocket):
    """WebSocket para pantallas de visualización"""
    await ws_manager.connect_display(websocket)
    try:
        # Enviar estado inicial
        try:
            initial_state = game_state.get_full_state()
            await send_json_safe(websocket, {
                "type": "state_update",
                "payload": initial_state
            })
        except Exception as e:
            print(f"⚠️ Error enviando estado inicial a display: {e}")
            await send_json_safe(websocket, {"type": "error", "payload": {"message": str(e)}})
        
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                
                # Responder a ping con pong para mantener conexión viva
                if message.get("type") == "ping":
                    await send_json_safe(websocket, {"type": "pong"})
                    continue
                
                # Procesar eventos táctiles del display
                await handle_display_message(message, websocket)
                
            except json.JSONDecodeError as e:
                print(f"⚠️ Error parseando mensaje de display: {e}")
            
    except WebSocketDisconnect:
        ws_manager.disconnect_display(websocket)
    except Exception as e:
        print(f"❌ Error en WebSocket display: {e}")
        ws_manager.disconnect_display(websocket)


async def handle_display_message(message: dict, websocket: WebSocket):
    """Procesa mensajes enviados desde el display táctil"""
    msg_type = message.get("type", "")
    payload = message.get("payload", {})
    
    if msg_type == "character_move":
        # Mover un personaje existente
        char_id = payload.get("character_id")
        position = payload.get("position", {})
        
        if char_id and char_id in game_state.state.characters:
            char = game_state.state.characters[char_id]
            char.position = Position(
                x=position.get("x", 0),
                y=position.get("y", 0),
                rotation=position.get("rotation", 0)
            )
            
            # Notificar a todos los clientes
            await ws_manager.broadcast_all({
                "type": "character_update",
                "payload": {
                    "character_id": char_id,
                    "position": char.position.model_dump()
                }
            })
            print(f"📍 Personaje {char.name} movido a ({position.get('x')}, {position.get('y')})")
    
    elif msg_type == "character_create":
        # Crear un nuevo personaje desde el display táctil
        char_id = payload.get("id", f"touch_{uuid.uuid4().hex[:6]}")
        name = payload.get("name", "Aventurero")
        char_class = payload.get("character_class", "Guerrero")
        position = payload.get("position", {"x": 100, "y": 100})
        
        # Crear personaje
        from .models import Character
        character = Character(
            id=char_id,
            marker_id=None,
            name=name,
            character_class=char_class,
            hp=100,
            max_hp=100,
            mana=50,
            max_mana=50,
            armor=0,
            speed=6,
            abilities=["attack", "defend"],
            position=Position(
                x=position.get("x", 0),
                y=position.get("y", 0),
                rotation=position.get("rotation", 0)
            )
        )
        
        game_state.state.characters[char_id] = character
        
        # Notificar a todos los clientes
        await ws_manager.broadcast_all({
            "type": "character_added",
            "payload": {"character": character.model_dump()}
        })
        print(f"✨ Personaje creado desde display: {name} en ({position.get('x')}, {position.get('y')})")
    
    elif msg_type == "character_remove":
        # Eliminar un personaje
        char_id = payload.get("character_id")
        if char_id and char_id in game_state.state.characters:
            char = game_state.state.characters.pop(char_id)
            await ws_manager.broadcast_all({
                "type": "character_removed",
                "payload": {
                    "character_id": char_id,
                    "name": char.name
                }
            })
            print(f"🗑️ Personaje eliminado: {char.name}")

@app.websocket("/ws/mobile")
async def websocket_mobile(websocket: WebSocket, player_id: str = Query(None), name: str = Query("Jugador")):
    """WebSocket para dispositivos móviles de jugadores"""
    if not player_id:
        player_id = str(uuid.uuid4())[:8]
    
    await ws_manager.connect_mobile(websocket, player_id)
    await game_state.add_player(player_id, name, PlayerRole.PLAYER)
    
    try:
        # Enviar estado inicial
        try:
            initial_state = game_state.get_full_state()
            await send_json_safe(websocket, {
                "type": "connected",
                "payload": {
                    "player_id": player_id,
                    "state": initial_state
                }
            })
        except Exception as e:
            print(f"⚠️ Error enviando estado inicial a mobile {player_id}: {e}")
            await send_json_safe(websocket, {"type": "error", "payload": {"message": str(e)}})
        
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                await handle_mobile_message(player_id, message, websocket)
            except json.JSONDecodeError as e:
                print(f"⚠️ Error parseando mensaje de mobile {player_id}: {e}")
            
    except WebSocketDisconnect:
        ws_manager.disconnect_mobile(websocket)
        await game_state.remove_player(player_id)
    except Exception as e:
        print(f"❌ Error en WebSocket mobile {player_id}: {e}")
        ws_manager.disconnect_mobile(websocket)
        await game_state.remove_player(player_id)

async def handle_mobile_message(player_id: str, message: dict, websocket: WebSocket):
    """Procesa mensajes del móvil"""
    msg_type = message.get("type")
    payload = message.get("payload", {})
    
    # Responder a ping con pong para mantener conexión viva
    if msg_type == "ping":
        await send_json_safe(websocket, {"type": "pong"})
        return
    
    if msg_type == "ability":
        result = await game_state.execute_ability(
            payload.get("character_id"),
            payload.get("ability_id"),
            payload.get("target_id"),
            Position(**payload["target_position"]) if payload.get("target_position") else None
        )
        await ws_manager.send_to_mobile(player_id, {
            "type": "ability_result",
            "payload": result.model_dump()
        })
    
    elif msg_type == "select_character":
        success = game_state.assign_character_to_player(player_id, payload.get("character_id"))
        await ws_manager.send_to_mobile(player_id, {
            "type": "character_selected",
            "payload": {"success": success}
        })

@app.websocket("/ws/camera")
async def websocket_camera(websocket: WebSocket):
    """WebSocket para el sistema de cámara/visión
    
    El admin envía frames de su cámara local, el servidor los procesa
    con YOLO y devuelve los frames con bounding boxes.
    """
    await ws_manager.connect_camera(websocket)
    
    try:
        # Enviar estado inicial
        await send_json_safe(websocket, {
            "type": "camera_status",
            "payload": {
                "processor": frame_processor.get_status(),
                "camera": camera_manager.get_status()
            }
        })
        
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type", "")
            
            # Responder a ping
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            
            # === Frame del Admin para procesar ===
            if msg_type == "frame":
                payload = message.get("payload", {})
                frame_base64 = payload.get("frame")
                
                if frame_base64:
                    # Procesar frame con YOLO
                    processed_frame, detections = frame_processor.process_frame(frame_base64)
                    
                    # Devolver frame procesado con bounding boxes
                    await send_json_safe(websocket, {
                        "type": "processed_frame",
                        "payload": {
                            "frame": processed_frame,
                            "detections": len(detections),
                            "objects": detections,
                            "timestamp": payload.get("timestamp")
                        }
                    })
            
            # Comandos de control
            elif msg_type == "camera_control":
                action = message.get("payload", {}).get("action")
                await handle_camera_control(websocket, action, message.get("payload", {}))
            
            # === Conectar a cámara IP directamente desde el servidor ===
            elif msg_type == "connect_ip_camera":
                ip_url = message.get("payload", {}).get("url")
                if ip_url:
                    asyncio.create_task(stream_ip_camera(websocket, ip_url))
            
            # === Desconectar cámara IP ===
            elif msg_type == "disconnect_ip_camera":
                camera_manager.stop_ip_stream()
                await send_json_safe(websocket, {
                    "type": "ip_camera_disconnected",
                    "payload": {"success": True}
                })
            
            # Solicitar estado
            elif msg_type == "get_status":
                await send_json_safe(websocket, {
                    "type": "camera_status",
                    "payload": {
                        "processor": frame_processor.get_status(),
                        "camera": camera_manager.get_status()
                    }
                })
            
    except WebSocketDisconnect:
        ws_manager.disconnect_camera(websocket)


async def handle_camera_control(websocket: WebSocket, action: str, payload: dict):
    """Procesa comandos de control de cámara"""
    result = {"action": action, "success": False}
    
    if action == "connect":
        camera_id = payload.get("camera_id", 0)
        camera_url = payload.get("camera_url")
        result["success"] = camera_manager.connect(camera_id, camera_url)
    
    elif action == "disconnect":
        camera_manager.disconnect()
        result["success"] = True
    
    elif action == "start_stream":
        result["success"] = camera_manager.start_streaming()
    
    elif action == "stop_stream":
        camera_manager.stop_streaming()
        result["success"] = True
    
    elif action == "get_status":
        result["status"] = camera_manager.get_status()
        result["success"] = True
    
    result["camera_status"] = camera_manager.get_status()
    await send_json_safe(websocket, {
        "type": "camera_control_result",
        "payload": result
    })
    
    # Broadcast estado a todos los admins
    await ws_manager.broadcast_admins({
        "type": "camera_status",
        "payload": camera_manager.get_status()
    })


async def stream_ip_camera(websocket: WebSocket, ip_url: str):
    """Consume stream de cámara IP y envía frames procesados al admin"""
    import cv2
    import base64
    import time
    
    # Normalizar URL
    if not ip_url.startswith('http'):
        ip_url = 'http://' + ip_url
    if not any(x in ip_url for x in ['/video', '/mjpeg', '/stream']):
        ip_url = ip_url + '/video'
    
    print(f"📷 Conectando a cámara IP: {ip_url}")
    
    try:
        cap = cv2.VideoCapture(ip_url)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimizar buffer
        
        if not cap.isOpened():
            await send_json_safe(websocket, {
                "type": "ip_camera_error",
                "payload": {"error": f"No se puede conectar a {ip_url}"}
            })
            return
        
        await send_json_safe(websocket, {
            "type": "ip_camera_connected",
            "payload": {"url": ip_url}
        })
        
        camera_manager._ip_stream_active = True
        frame_count = 0
        target_fps = 10
        frame_time = 1.0 / target_fps
        
        while camera_manager._ip_stream_active:
            start = time.time()
            
            ret, frame = cap.read()
            if not ret:
                print("📷 Frame perdido, reintentando...")
                await asyncio.sleep(0.5)
                continue
            
            # Comprimir y codificar frame
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            frame_base64 = base64.b64encode(buffer).decode('utf-8')
            
            # Procesar con YOLO
            processed_frame, detections = frame_processor.process_frame(frame_base64)
            
            # Enviar al admin
            try:
                await send_json_safe(websocket, {
                    "type": "processed_frame",
                    "payload": {
                        "frame": processed_frame,
                        "detections": len(detections),
                        "objects": detections,
                        "timestamp": int(time.time() * 1000)
                    }
                })
            except Exception as e:
                print(f"Error enviando frame: {e}")
                break
            
            frame_count += 1
            
            # Control de FPS
            elapsed = time.time() - start
            if elapsed < frame_time:
                await asyncio.sleep(frame_time - elapsed)
        
        cap.release()
        print(f"📷 Cámara IP desconectada. Frames enviados: {frame_count}")
        
    except Exception as e:
        print(f"Error en stream IP: {e}")
        await send_json_safe(websocket, {
            "type": "ip_camera_error",
            "payload": {"error": str(e)}
        })
    finally:
        camera_manager._ip_stream_active = False


async def handle_markers_update(markers: list):
    """Procesa actualización de marcadores detectados"""
    detected_ids = set()
    
    for marker_data in markers:
        marker = DetectedMarker(
            marker_id=marker_data["id"],
            position=Position(
                x=marker_data["x"],
                y=marker_data["y"],
                rotation=marker_data.get("rotation", 0)
            ),
            corners=marker_data.get("corners", [])
        )
        detected_ids.add(marker.marker_id)
        await game_state.add_character_from_marker(marker)
    
    # Eliminar personajes cuyos marcadores ya no se detectan
    current_markers = {
        char.marker_id for char in game_state.state.characters.values()
    }
    lost_markers = current_markers - detected_ids
    
    for marker_id in lost_markers:
        await game_state.remove_character_by_marker(marker_id)

@app.websocket("/ws/admin")
async def websocket_admin(websocket: WebSocket):
    """WebSocket para panel de administración"""
    await ws_manager.connect_admin(websocket)
    
    try:
        # Enviar estado inicial
        try:
            initial_state = game_state.get_full_state()
            await send_json_safe(websocket, {
                "type": "state_update",
                "payload": initial_state
            })
            await send_json_safe(websocket, {
                "type": "stats",
                "payload": ws_manager.get_stats()
            })
        except Exception as e:
            print(f"⚠️ Error enviando estado inicial a admin: {e}")
            await send_json_safe(websocket, {"type": "error", "payload": {"message": str(e)}})
        
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                await handle_admin_message(websocket, message)
            except json.JSONDecodeError as e:
                print(f"⚠️ Error parseando mensaje de admin: {e}")
            
    except WebSocketDisconnect:
        ws_manager.disconnect_admin(websocket)
    except Exception as e:
        print(f"❌ Error en WebSocket admin: {e}")
        ws_manager.disconnect_admin(websocket)

async def handle_admin_message(websocket: WebSocket, message: dict):
    """Procesa mensajes del admin"""
    msg_type = message.get("type")
    
    # Responder a ping con pong para mantener conexión viva
    if msg_type == "ping":
        await send_json_safe(websocket, {"type": "pong"})
        return
    
    if msg_type == "start_combat":
        await game_state.start_combat()
    elif msg_type == "end_combat":
        await game_state.end_combat()
    elif msg_type == "next_turn":
        await game_state.next_turn()
    elif msg_type == "refresh":
        await send_json_safe(websocket, {
            "type": "state_update",
            "payload": game_state.get_full_state()
        })


# === Main ===
if __name__ == "__main__":
    import socket
    
    # Obtener IP local para mostrar
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    
    print("\n" + "="*50)
    print("🎲 MesaRPG - Servidor")
    print("="*50)
    print(f"📺 Pantalla:  http://{local_ip}:8000/display")
    print(f"📱 Móvil:     http://{local_ip}:8000/mobile")
    print(f"🎮 Admin:     http://{local_ip}:8000/admin")
    print(f"📚 API Docs:  http://{local_ip}:8000/docs")
    print("="*50 + "\n")
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(BASE_DIR / "server")]
    )
