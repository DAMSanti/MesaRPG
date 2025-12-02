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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
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
    """Panel de administración del GM"""
    # Por simplicidad, admin está inline. En producción sería un archivo separado.
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>MesaRPG - Admin</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { box-sizing: border-box; }
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #1a1a2e; color: #eee; }
            h1 { color: #ffd700; }
            .container { max-width: 1200px; margin: 0 auto; }
            .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
            .card { background: #16213e; padding: 20px; border-radius: 10px; }
            .card h2 { margin-top: 0; color: #00d9ff; }
            button { 
                background: #e94560; color: white; border: none; padding: 10px 20px; 
                border-radius: 5px; cursor: pointer; margin: 5px; font-size: 14px;
            }
            button:hover { background: #ff6b6b; }
            button.success { background: #4caf50; }
            button.success:hover { background: #66bb6a; }
            .status { padding: 10px; background: #0f3460; border-radius: 5px; margin: 10px 0; }
            .character-list { max-height: 300px; overflow-y: auto; }
            .character-item { 
                padding: 10px; margin: 5px 0; background: #0f3460; border-radius: 5px;
                display: flex; justify-content: space-between; align-items: center;
            }
            .hp-bar { 
                width: 100px; height: 10px; background: #333; border-radius: 5px; overflow: hidden;
            }
            .hp-fill { height: 100%; background: #4caf50; transition: width 0.3s; }
            .log { 
                height: 200px; overflow-y: auto; background: #0a0a15; 
                padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px;
            }
            .log-entry { margin: 2px 0; }
            .log-entry.action { color: #ffd700; }
            .log-entry.system { color: #00d9ff; }
            .log-entry.error { color: #ff6b6b; }
            #connection-status { 
                position: fixed; top: 10px; right: 10px; padding: 10px 20px;
                border-radius: 20px; font-weight: bold;
            }
            #connection-status.connected { background: #4caf50; }
            #connection-status.disconnected { background: #e94560; }
        </style>
    </head>
    <body>
        <div id="connection-status" class="disconnected">Desconectado</div>
        <div class="container">
            <h1>🎮 Panel de Control - Game Master</h1>
            
            <div class="grid">
                <div class="card">
                    <h2>⚔️ Combate</h2>
                    <button class="success" onclick="startCombat()">Iniciar Combate</button>
                    <button onclick="endCombat()">Finalizar Combate</button>
                    <button onclick="nextTurn()">Siguiente Turno</button>
                    <div class="status">
                        <div>Turno: <span id="current-turn">-</span></div>
                        <div>Personaje activo: <span id="active-char">-</span></div>
                        <div>Estado: <span id="combat-status">Fuera de combate</span></div>
                    </div>
                </div>
                
                <div class="card">
                    <h2>👥 Personajes</h2>
                    <div id="character-list" class="character-list">
                        <p>No hay personajes detectados</p>
                    </div>
                    <div style="margin-top: 10px;">
                        <button class="success" onclick="addTestCharacter()">+ Añadir Personaje Test</button>
                        <button onclick="clearCharacters()">🗑️ Limpiar</button>
                    </div>
                </div>
                
                <div class="card">
                    <h2>📡 Conexiones</h2>
                    <div class="status">
                        <div>Pantallas: <span id="display-count">0</span></div>
                        <div>Móviles: <span id="mobile-count">0</span></div>
                        <div>Jugadores: <span id="player-list">-</span></div>
                        <div>Cámara: <span id="camera-status">❌</span></div>
                    </div>
                    <button onclick="refreshState()">Actualizar Estado</button>
                </div>
                
                <div class="card">
                    <h2>📜 Log de Acciones</h2>
                    <div id="action-log" class="log"></div>
                </div>
            </div>
        </div>
        
        <script>
            let ws;
            let gameState = {};
            let pingInterval = null;
            let testCharacterCount = 0;
            const pingIntervalMs = 25000;
            
            function startPing() {
                stopPing();
                pingInterval = setInterval(() => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ping' }));
                    }
                }, pingIntervalMs);
            }
            
            function stopPing() {
                if (pingInterval) {
                    clearInterval(pingInterval);
                    pingInterval = null;
                }
            }
            
            function connect() {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/admin`);
                
                ws.onopen = () => {
                    document.getElementById('connection-status').className = 'connected';
                    document.getElementById('connection-status').textContent = 'Conectado';
                    log('Conectado al servidor', 'system');
                    refreshState();
                    startPing();
                };
                
                ws.onclose = () => {
                    document.getElementById('connection-status').className = 'disconnected';
                    document.getElementById('connection-status').textContent = 'Desconectado';
                    log('Desconectado del servidor', 'error');
                    stopPing();
                    setTimeout(connect, 3000);
                };
                
                ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    handleMessage(data);
                };
            }
            
            function handleMessage(data) {
                // Ignorar mensajes pong
                if (data.type === 'pong') {
                    return;
                }
                
                if (data.type === 'state_update' || data.type === 'STATE_UPDATE') {
                    gameState = data.payload;
                    updateUI();
                } else if (data.type === 'action_executed') {
                    log(data.payload.result?.message || 'Acción ejecutada', 'action');
                } else if (data.type === 'character_added') {
                    log(`Personaje añadido: ${data.payload.character?.name}`, 'system');
                } else if (data.type === 'character_removed') {
                    log(`Personaje removido: ${data.payload.name}`, 'system');
                } else if (data.type === 'stats') {
                    updateConnectionStats(data.payload);
                }
                
                // Actualizar estado si viene en el mensaje
                if (data.payload?.characters) {
                    gameState.characters = data.payload.characters;
                    updateUI();
                }
            }
            
            function updateUI() {
                // Actualizar info de combate
                document.getElementById('current-turn').textContent = gameState.current_turn || '-';
                document.getElementById('active-char').textContent = 
                    gameState.characters?.[gameState.active_character_id]?.name || '-';
                document.getElementById('combat-status').textContent = 
                    gameState.is_combat ? '⚔️ En combate' : '🕊️ Fuera de combate';
                
                // Actualizar lista de personajes
                const charList = document.getElementById('character-list');
                if (gameState.characters && Object.keys(gameState.characters).length > 0) {
                    charList.innerHTML = Object.values(gameState.characters).map(char => `
                        <div class="character-item">
                            <div>
                                <strong>${char.name}</strong><br>
                                <small>${char.class || char.character_class}</small>
                            </div>
                            <div>
                                <div class="hp-bar">
                                    <div class="hp-fill" style="width: ${(char.hp/char.max_hp)*100}%"></div>
                                </div>
                                <small>${char.hp}/${char.max_hp} HP</small>
                            </div>
                        </div>
                    `).join('');
                } else {
                    charList.innerHTML = '<p>No hay personajes detectados</p>';
                }
            }
            
            function updateConnectionStats(stats) {
                document.getElementById('display-count').textContent = stats.displays || 0;
                document.getElementById('mobile-count').textContent = stats.mobiles || 0;
                document.getElementById('camera-status').textContent = stats.camera ? '✅' : '❌';
                
                // Mostrar lista de jugadores móviles
                const players = stats.mobile_players || [];
                document.getElementById('player-list').textContent = players.length > 0 
                    ? players.join(', ') 
                    : 'Ninguno';
            }
            
            function log(message, type = 'system') {
                const logDiv = document.getElementById('action-log');
                const entry = document.createElement('div');
                entry.className = `log-entry ${type}`;
                entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
                logDiv.appendChild(entry);
                logDiv.scrollTop = logDiv.scrollHeight;
            }
            
            function sendCommand(command, data = {}) {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: command, payload: data }));
                }
            }
            
            function startCombat() { sendCommand('start_combat'); log('Iniciando combate...', 'action'); }
            function endCombat() { sendCommand('end_combat'); log('Finalizando combate...', 'action'); }
            function nextTurn() { sendCommand('next_turn'); log('Siguiente turno...', 'action'); }
            
            function addTestCharacter() {
                testCharacterCount++;
                fetch('/api/debug/add-test-character?marker_id=' + testCharacterCount, {method: 'POST'})
                    .then(r => r.json())
                    .then(data => {
                        if (data.status === 'success') {
                            log('Personaje añadido: ' + data.character.name, 'action');
                            refreshState();
                        } else {
                            log('Error: ' + data.message, 'error');
                        }
                    })
                    .catch(e => log('Error añadiendo personaje: ' + e, 'error'));
            }
            
            function clearCharacters() {
                fetch('/api/debug/clear-characters', {method: 'DELETE'})
                    .then(r => r.json())
                    .then(data => {
                        log('Personajes eliminados', 'system');
                        testCharacterCount = 0;
                        refreshState();
                    })
                    .catch(e => log('Error: ' + e, 'error'));
            }
            
            function refreshState() { 
                fetch('/api/state').then(r => r.json()).then(data => {
                    gameState = data;
                    updateUI();
                });
                fetch('/api/connections').then(r => r.json()).then(updateConnectionStats);
            }
            
            connect();
            setInterval(refreshState, 3000);  // Actualizar cada 3 segundos
        </script>
    </body>
    </html>
    """


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
    """WebSocket para el sistema de cámara/visión"""
    await ws_manager.connect_camera(websocket)
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Responder a ping con pong para mantener conexión viva
            if message.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            
            if message.get("type") == "markers_update":
                markers = message.get("payload", {}).get("markers", [])
                await handle_markers_update(markers)
            
    except WebSocketDisconnect:
        ws_manager.disconnect_camera(websocket)

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
