# SPECS.md — MesaRPG

Especificación técnica del estado actual del sistema. Este documento describe **qué es** el sistema y **cómo está construido hoy** (no qué debería ser — eso vive en `ROADMAP.md`).

> Generado a partir de una auditoría del código el 2026-08-10. Actualizado el 2026-08-11 tras completar las Fases 0, 1 y 2 del ROADMAP. Si el código cambia, este documento debe actualizarse junto con él.

---

## 1. Visión general

MesaRPG convierte una mesa con pantalla táctil en una superficie de juego para RPGs de mesa. Combina:

- Un **servidor central** (FastAPI) que mantiene el estado de la partida en memoria.
- Un **sistema de visión por computadora** que detecta miniaturas físicas sobre la mesa (dos enfoques en paralelo, ver §5).
- Tres **clientes web** sin build step (HTML/CSS/JS vanilla): pantalla (`display`), móvil de jugador (`mobile`, PWA) y panel de GM (`admin`).
- Sincronización en tiempo real vía **WebSocket** entre los tres clientes.

No hay base de datos: el estado de partida vive en memoria del proceso Python, pero se vuelca automáticamente a `data/session_state.json` en cada cambio y se restaura al arrancar (ver §7), así que sobrevive a un reinicio del servidor. No es un motor de consultas ni soporta histórico — para eso haría falta SQLite (ver `ROADMAP.md` Fase 2).

## 2. Arquitectura

```
┌──────────────┐   WebSocket/HTTP   ┌────────────────────┐
│  mobile (PWA)│◄──────────────────►│                    │
├──────────────┤                    │   server/main.py   │
│  display     │◄──────────────────►│   (FastAPI, único  │──► config/*.json (lectura)
├──────────────┤                    │   proceso, estado  │──► config/maps/*.json (r/w)
│  admin       │◄──────────────────►│   en memoria)      │
└──────────────┘                    └─────────┬──────────┘
                                               │
                                    camera_manager / frame_processor
                                               │
                                     cámara USB/IP + YOLO/OpenVINO
                                     (o vision/detector.py ArUco,
                                      camino legacy independiente)
```

- **Proceso único**: un solo `uvicorn` sirviendo API REST, WebSockets y archivos estáticos. No hay separación de servicios, cola de mensajes ni workers.
- **Autenticación de GM opcional**: si se define `GM_SECRET` (env), los endpoints de mutación de solo-GM y `/ws/admin` exigen una cookie de sesión (`POST /api/admin/login`). Si no se define, el admin funciona sin login (uso doméstico en LAN, comportamiento por defecto). No hay autenticación de jugador propiamente dicha: `player_id` sigue siendo autodeclarado por el cliente, pero ahora se genera con `crypto.randomUUID()` (antes `Math.random()`), lo que lo hace impracticable de adivinar.
- **CORS restringible**: `allow_origins` configurable vía `CORS_ORIGINS` (env), `*` por defecto; `allow_credentials=False` (la cookie de sesión de GM es same-origin, no depende de CORS). Ver [server/main.py](server/main.py).

## 3. Componentes

### 3.1 `server/` (Python 3.11, FastAPI)

| Archivo | Responsabilidad |
|---|---|
| `main.py` (1437 líneas) | Definición de la app FastAPI: rutas HTML, estáticos, API REST completa, y los 4 endpoints WebSocket (`/ws/display`, `/ws/mobile`, `/ws/camera`, `/ws/admin`). |
| `game_state.py` (701 líneas) | `GameStateManager`: única fuente de verdad del estado de partida. Carga configuración desde `config/*.json`, gestiona fichas de personaje, jugadores, combate/turnos, ejecución de habilidades y mapas. Notifica cambios vía callbacks (patrón observer) que `main.py` conecta al broadcast WebSocket. |
| `models.py` (257 líneas) | Modelos Pydantic v2: `Character`, `CharacterSheet`, `Ability`, `Player`, `Position`, `GameState`, mensajes WS, etc. |
| `websocket_manager.py` (225 líneas) | `ConnectionManager`: mantiene sets/dicts de conexiones activas por tipo de cliente y expone métodos de broadcast dirigido. |
| `camera_manager.py` (652 líneas) | Gestión de cámara cenital (USB local o IP), tracking suavizado de miniaturas (`TrackedMiniature`), calibración imagen→coordenadas de juego. |
| `frame_processor.py` (446 líneas) | Inferencia YOLO/OpenVINO sobre frames recibidos por WebSocket, produce tracks de miniaturas. |
| `simple_tracker.py` (143 líneas) | Tracker auxiliar (asociación de detecciones entre frames). |

**Estado en memoria (`GameStateManager.state: GameState`)**: personajes, fichas, jugadores conectados, historial de acciones (últimas 10 expuestas), orden de iniciativa, mapa actual, marcadores disponibles, asignaciones de miniaturas, cooldowns.

**Persistencia**: `config/maps/*.json` (uno por mapa, vía `save_map`/`get_map`/`delete_map`) y `data/session_state.json` (fichas, personajes, cooldowns, asignaciones de miniaturas, mapa actual, turno/combate — volcado en cada cambio de estado, restaurado al arrancar; ver `GameStateManager.save_state_to_disk`/`_load_persisted_state`). Los jugadores conectados (`state.players`) NO se persisten — se recrean cuando cada móvil reconecta. El resto de `config/*.json` (`characters.json`, `abilities.json`, `game_systems.json`, `settings.json`) se carga en arranque como configuración de solo lectura.

### 3.2 `display/` — Pantalla de visualización

HTML/CSS/JS vanilla. `renderer.js` (1424 líneas, el archivo más grande del frontend) dibuja mapa, tokens y efectos sobre canvas/DOM. `effects.js` gestiona animaciones de habilidades (fuego, hielo, curación, etc.). `websocket.js` mantiene la conexión a `/ws/display` con reconexión y ping/pong.

### 3.3 `mobile/` — PWA de jugador

`manifest.json` + `sw.js` (service worker) para instalación como PWA. `app.js` gestiona conexión y estado de sesión del jugador. `sheets.js` (960 líneas) implementa el formulario dinámico de ficha de personaje según el sistema de juego activo. `controls.js` gestiona el uso de habilidades.

### 3.4 `admin/` — Panel del GM

`admin.js` (1137 líneas) concentra: selección de sistema de juego, revisión/aprobación de fichas, asignación de tokens visuales, control de cámara y streaming, y disparo de combate/turnos. Incluye módulos separados: `map-editor.js` (editor de mapas por tiles), `camera-panel.js`, `battletech-map-generator.js`.

### 3.5 `vision/` — Módulo de visión legacy

`detector.py`, `marker_generator.py`, `generate_markers.py`: detección por marcadores **ArUco**, generación de marcadores imprimibles. Es un camino de detección **paralelo e independiente** del pipeline YOLO/OpenVINO de `server/camera_manager.py` + `frame_processor.py`. No está claro cuál es el camino soportado activamente (ver §8).

### 3.6 `tools/` — Scripts de utilidad (fuera del runtime de producción)

Scripts de captura y preparación de datasets, entrenamiento de modelos YOLO (`train_miniatures.ipynb`, `train_pose_cli.py`), exportación a OpenVINO, generación de tiles/tokens/iconos. Confirma que el proyecto incluye su propio pipeline de entrenamiento de modelos de visión, no solo inferencia.

## 4. Modelo de dominio

### 4.1 Ciclo de vida de una ficha de personaje (`CharacterSheet`)

```
DRAFT ──submit──► PENDING ──approve──► APPROVED ──assign_token──► IN_GAME
  ▲                  │
  └──────reject───────┘ (vuelve a DRAFT al editar tras rechazo)
```

Estados definidos en `CharacterStatus` ([server/models.py:19](server/models.py#L19)). `data: Dict[str, Any]` es un blob libre cuyo esquema depende del `game_system` (`dnd5e`, `battletech`, `generic`) definido en `config/game_systems.json`.

### 4.2 Dos sistemas de personaje coexistentes

- **Legacy (marcador ArUco → plantilla)**: `config/characters.json` mapea `marker_id → template`; `GameStateManager.add_character_from_marker()` crea un `Character` directamente al detectar un marcador.
- **Actual (ficha dinámica)**: jugador crea `CharacterSheet` desde el móvil, el GM la aprueba y le asigna un token visual (`assign_token_to_sheet`). `Character.from_sheet()` puede derivar un personaje de juego desde la ficha.

Ambos caminos generan instancias de `Character`, pero solo el segundo es alcanzable desde el flujo actual del admin/mobile. El primero sigue presente en el código y referenciado en `characters.json`.

### 4.3 Sistema de combate

Iniciativa simple = orden de inserción (no hay tirada de iniciativa). Turnos avanzan de forma manual desde el admin (`next_turn`). Cooldowns de habilidades se descuentan al pasar de personaje en cada turno, no por tiempo real.

### 4.4 Habilidades (`Ability`)

Definidas en `config/abilities.json`, referenciadas por id desde `Character.abilities`. Ejecutar una habilidad (`execute_ability`) valida: personaje existe, habilidad existe y es conocida por el personaje, cooldown, maná suficiente; aplica daño/curación, inicia cooldown, registra en `action_history` y emite un evento `effect` a los displays.

## 5. Pipeline de visión

> Actualizado 2026-08-11 tras Fase 1 del ROADMAP. Decisión tomada: **YOLO/OpenVINO es el pipeline soportado**; ver `docs/CAMERA.md` para el flujo completo.

| | Camino YOLO/OpenVINO (soportado) | Camino ArUco (`vision/` + `camera_manager.py`, legacy) |
|---|---|---|
| Detección | Modelos entrenados propios (`miniatures_obb`, `miniatures_pose`) exportados a OpenVINO para CPU | `cv2.aruco` con marcadores impresos |
| Identificación de miniatura | Tracking por posición (`simple_tracker.py`); `track_id` estable mientras la miniatura siga visible | ID directo por marcador impreso |
| Entrada de frames | WebSocket `/ws/camera`: `admin/js/camera-panel.js` captura con `getUserMedia` en el navegador y envía frames al servidor; `frame_processor.py` expone además `get_frame_size()` con la resolución real del frame, propagada al display en cada `miniature_positions` | Captura directa en el proceso servidor vía `cv2.VideoCapture` (`camera_manager.py`), o script standalone (`vision/detector.py`) |
| Asignación jugador↔miniatura | `GameStateManager.miniature_assignments` (`track_id → sheet_id`), única fuente de verdad, expuesta en `/api/miniature-assignments` | `camera_manager.assign_player_to_miniature()` (por `marker_id`) — sin frontend que lo llame, código huérfano |
| Estado de integración | Conectado de punta a punta: frame → detección → track_id → asignación → posición renderizada en display con calibración aplicada | Aislado; endpoints `/api/camera/connect`, `/api/camera/miniatures/assign`, etc. siguen existiendo pero ningún cliente los usa |

El camino ArUco se conserva en el repo (documentado como legacy en el docstring de ambos módulos) por si se retoma deliberadamente, pero no debe asumirse activo al leer el código.

## 6. API

### 6.1 REST (resumen por área)

| Área | Endpoints |
|---|---|
| Estado / conexiones | `GET /api/state`, `GET /api/connections` |
| Personajes (legacy) | `GET /api/characters`, `GET /api/characters/{id}`, `GET /api/characters/{id}/abilities` |
| Acciones/combate | `POST /api/action`, `POST /api/action/with-position`, `POST /api/combat/{start,end,next-turn}` |
| Sistemas de juego | `GET /api/systems`, `GET /api/systems/{id}`, `POST /api/systems/set/{id}`, `POST /api/session/select-system` |
| Fichas | `GET /api/sheets`, `GET /api/sheets/pending`, `GET/PUT /api/sheets/{id}`, `POST /api/sheets`, `POST /api/sheets/{id}/{submit,approve,reject,assign-token,remove-token}` |
| Mapas | `GET /api/maps`, `GET/DELETE /api/maps/{id}`, `POST /api/maps`, `POST /api/maps/{id}/project`, `POST /api/display/project-map` |
| Tiles/config/assets | `GET /api/tiles`, `GET /api/tiles/{system_id}`, `GET /config/{filename}`, `GET /assets/markers/...`, `GET /assets/tiles/...` |
| Cámara | `GET /api/camera/status`, `GET /api/camera/devices`, `POST /api/camera/{connect,disconnect}`, `POST /api/camera/stream/{start,stop}`, `GET /api/camera/frame`, `GET /api/camera/miniatures[/visible]`, `POST /api/camera/miniatures/assign`, `POST /api/camera/miniatures/unassign/{marker_id}`, `GET /api/camera/miniatures/player/{player_id}`, `POST /api/camera/calibration/{start,point,finish,simple}` |
| Asignación figurita↔personaje | `GET/POST /api/miniature-assignments`, `DELETE /api/miniature-assignments/{track_id}` |
| Debug (404 salvo `DEBUG=true`) | `POST /api/debug/add-test-character`, `DELETE /api/debug/clear-characters` |
| Sesión de GM | `GET /api/admin/session`, `POST /api/admin/login` |

~25 endpoints de mutación (fichas GM-only, mapas, combate, sistemas, cámara, asignación de miniaturas, debug) llevan `dependencies=[Depends(require_gm)]`: no-op si `GM_SECRET` no está configurado, 401 sin cookie de sesión si sí lo está.

⚠️ `docs/API.md` documenta solo el subconjunto original (estado, personajes legacy, acciones, combate, conexiones, WS básico) y **está desactualizado** respecto a fichas, mapas, sistemas, cámara y asignaciones de miniaturas.

### 6.2 WebSocket

| Endpoint | Cliente | Notas |
|---|---|---|
| `/ws/display` | Pantalla | Recibe `state_update` inicial, luego eventos broadcast. Puede enviar `character_move/create/remove` (edición táctil directa) y `ping`. |
| `/ws/mobile?player_id=&name=` | Jugador | `player_id` autodeclarado (ahora generado con `crypto.randomUUID()`, no verificado contra servidor). Recibe `connected` con estado inicial. Envía `ability`, `select_character`, `ping`. |
| `/ws/admin` | GM | Si `GM_SECRET` está configurado, exige cookie `gm_session` válida (se cierra con código 4401 si no). Recibe `state_update` + `stats`. Envía `start_combat`, `end_combat`, `next_turn`, `refresh`, `ping`. |
| `/ws/camera` | Admin (streaming de frames) | Envía frames en base64 para procesar server-side; recibe `processed_frame` con detecciones/tracks. Soporta conexión a cámara IP vía `connect_ip_camera`. |

Todos los mensajes de servidor→cliente van serializados con `json.dumps(default=json_serial)` para manejar `datetime`.

## 7. Configuración y despliegue

- **Config**: archivos JSON planos en `config/` (sin schema validation más allá de los modelos Pydantic que los consumen parcialmente).
- **Contenedores**: `Dockerfile` (Python 3.11-slim + libs OpenCV/OpenVINO), `docker-compose.yml` + variantes `deploy/docker-compose.{prod,simple}.yml`, `deploy/nginx*.conf`, `deploy/setup-server.sh` (aprovisionamiento inicial), `deploy/deploy.sh` (deploy con Let's Encrypt).
- **`.env.example`** referencia `DATABASE_URL` (Postgres) como opcional "por defecto usa SQLite" — **sigue sin haber ningún uso real de base de datos en el código** (la persistencia es el volcado JSON de §3.1/§7); es documentación aspiracional, no una capacidad existente. Sí son reales y se leen en `main.py`: `DEBUG`, `GM_SECRET`, `CORS_ORIGINS`.
- **Arranque local**: `start.bat`/`start.sh` o `python server/main.py` (con `reload=True`, no apto para producción — el `Dockerfile` sí usa el comando correcto sin reload).
- **Hardware objetivo**: PC con pantalla táctil + cámara cenital USB o IP; recomendaciones en `docs/HARDWARE.md`.
- **Dependencias** (`server/requirements.txt`): rangos acotados al siguiente major por encima de la versión mínima probada (no solo `>=`). No hay lockfile real todavía.

## 8. Deuda técnica y riesgos conocidos (observados en código, no solo en TODO.md)

> Los puntos 1, 2, 3, 4, 5 y 6 se corrigieron en las Fases 0/1/2 del ROADMAP (2026-08-11); se dejan documentados como referencia histórica de por qué el modelo quedó como quedó.

1. ~~**Inconsistencia de modelo**: `Character` requiere `sheet_id` sin valor por defecto...~~ **Corregido**: `sheet_id` y `marker_id` son `Optional` en `Character` ([server/models.py](server/models.py#L77)).
2. ~~**Sin autenticación/autorización** en ningún endpoint REST ni WebSocket...~~ **Mitigado**: `GM_SECRET` opcional protege las acciones de GM (ver §2/§6.1). Sigue sin haber autenticación de jugador propiamente dicha, solo un `player_id` difícil de adivinar — suficiente para una mesa de confianza, no para un servicio multiusuario público.
3. ~~**CORS `*` + credentials `True`**...~~ **Corregido**: `allow_credentials=False`, orígenes configurables vía `CORS_ORIGINS`.
4. ~~**Endpoints de debug sin guardas de entorno**...~~ **Corregido**: `/api/debug/*` devuelve 404 salvo `DEBUG=true`, y además exige sesión de GM si `GM_SECRET` está configurado.
5. ~~**Estado global duplicado**: `_miniature_assignments` en `main.py`...~~ **Corregido**: movido a `GameStateManager.miniature_assignments`, única fuente de verdad. `camera_manager.assign_player_to_miniature()` resultó ser código huérfano (sin frontend que lo llame), no un segundo camino activo — ver §5.
6. ~~**Sin persistencia de sesión**...~~ **Corregido**: volcado automático a `data/session_state.json` en cada cambio, restaurado al arrancar (ver §3.1/§7). No es una base de datos real.
7. **Sin tests automatizados**: no existe carpeta `tests/`; único artefacto relacionado es `vision/camera_test.py`, un script de prueba manual con cámara real. (Esta sesión sí verificó el código con `ast.parse`, `node --check`, y pruebas manuales con `FastAPI TestClient` para la persistencia y la autenticación, pero eso no sustituye una suite de tests versionada — ver `ROADMAP.md` Fase 3.)
8. ~~**Dos pipelines de visión en paralelo**...~~ **Corregido en Fase 1**: YOLO/OpenVINO es el pipeline soportado, documentado en `docs/CAMERA.md`; el camino ArUco queda marcado como legacy en el docstring de sus propios módulos — ver §5.
9. **Documentación de API desactualizada** (`docs/API.md` no cubre ~60% de los endpoints reales, y ahora tampoco cubre `/api/admin/*`). Sigue pendiente — ver `ROADMAP.md` Fase 3.
10. **Historial de git con mensajes no descriptivos** (`"1231"`, `"123421234"`, `"123"`, etc. en los commits previos a esta serie de sesiones) — dificulta auditar cambios pasados. Los commits de las Fases 0-2 del ROADMAP sí llevan mensajes descriptivos.
11. ~~**Dependencias con floor version únicamente**...~~ **Corregido**: rangos acotados en `server/requirements.txt` (ver §7). Sigue sin haber lockfile real.

## 9. Fuera de alcance de este documento

- Detalles de UI/UX de cada pantalla (ver capturas o probar la app).
- Contenido específico de los sistemas de juego (`config/game_systems.json`).
- Rendimiento de los modelos YOLO entrenados (ver `runs/train/miniatures_obb/`).
