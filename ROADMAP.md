# ROADMAP.md — MesaRPG

Plan de trabajo priorizado. Sustituye y absorbe `TODO.md` (que queda como changelog de lo ya completado, no lo borres sin migrar su histórico). Ver `SPECS.md` para el detalle técnico de por qué cada punto es un problema.

Cada fase asume que la anterior está cerrada, pero los ítems "críticos" de cualquier fase pueden adelantarse si bloquean una sesión de juego real.

---

## Fase 0 — Estabilización (bugs que rompen el uso actual) ✅ Completada (2026-08-11)

Objetivo: que una partida completa (crear ficha → aprobar → asignar token → jugar → combate) funcione sin errores silenciosos.

- [x] **Arreglar `Character` sin `sheet_id`** en el flujo legacy de marcador ([server/game_state.py:328](server/game_state.py#L328)) y en `character_create` del display ([server/main.py:966](server/main.py#L966)) — hoy revienta con `ValidationError` si se ejecutan. Decidir: o se les da un `sheet_id` sintético, o se elimina el camino legacy (ver Fase 2).
  → `sheet_id` y `marker_id` pasan a `Optional` en el modelo `Character`; ambos caminos legacy ya no revientan.
- [x] **Display no renderiza tokens SVG** — usa el sistema antiguo de marcadores en vez de los tokens visuales asignados. Bloquea que los jugadores vean sus fichas en mesa.
  → El bug real era que `renderer.js` usaba `token_visual` (un id) directamente como `src` de imagen en vez de resolverlo contra `assets/markers/tokens.json`, como ya hacían admin.js y mobile/sheets.js. Se añadió `GameRenderer.loadTokenLibrary()`/`resolveTokenImage()`.
- [x] **`token_visual` no se propaga por WebSocket a todas las pantallas** de forma fiable.
  → Ya se propagaba (`token_assigned`/`token_removed` via `broadcast_all`); el problema visible era el de renderizado de arriba. Se añadió además el evento `token_removed` que faltaba en admin.js/mobile.
- [x] **Flujo ficha → token incompleto**: al asignar token, el móvil del jugador no refleja su token asignado.
  → Verificado en código: `mobile/js/app.js` ya recarga la ficha (`loadMySheet()`) en `token_assigned`; ahora también en `token_removed`. Sin más cambios necesarios.
- [x] **`removeToken()` / reasignación de tokens** no libera el estado correctamente — auditar `assign_token_to_sheet` y el camino inverso.
  → El bug real: `admin.js` ya llamaba a `POST /api/sheets/{id}/remove-token`, pero ese endpoint **no existía en el backend** (404 silencioso). Se añadió `GameStateManager.remove_token_from_sheet()` + el endpoint, que revierte la ficha a `APPROVED` y libera el `marker_id`.
- [x] **Filtro `approved` vs `in_game` inconsistente** en `GET /api/sheets` — clarificar si "aprobada" debe incluir "en juego" en todos los consumidores del frontend, no solo en el backend.
  → Verificado: el backend ya mezcla intencionalmente `approved`+`in_game` bajo `status=approved`, y `admin.js` ya filtra client-side (`!s.marker_id`) para las vistas que necesitan solo pendientes de token. Comportamiento correcto, no era un bug.
- [x] **Display sin mapa por defecto al arrancar** — cargar automáticamente `current_map` desde el estado al conectar (ya viaja en `state_update` inicial; el bug está en el consumo del lado del cliente).
  → El bug real estaba en el backend: `GameState.current_map` tenía como default el string `"default"` (un id de mapa que nunca existe), y `set_current_map`/`save_map` en realidad le asignan un `dict`. Se corrigió el tipo a `Optional[Dict]=None`, así el display ya no intenta cargar un mapa inexistente en una partida nueva.

## Fase 1 — Integración de cámara (la funcionalidad central pendiente) ✅ Completada (2026-08-11)

Es el ítem #1 del backlog original y la razón de ser del proyecto (visión por computadora + mesa física). Existían dos pipelines completos pero solo uno conectado de punta a punta a una partida real.

- [x] **Decidir un único pipeline de detección** antes de invertir más en integración — evita seguir duplicando trabajo entre YOLO/OpenVINO y ArUco.
  → Decisión: **YOLO/OpenVINO vía `/ws/camera`** (captura en el navegador del admin + `frame_processor.py`) es el pipeline soportado — es el único que tiene frontend real conectándose a él. El camino ArUco (`vision/detector.py`, `server/camera_manager.py`) queda documentado como legacy/no integrado, con nota explícita en el código. Ver `docs/CAMERA.md`.
- [x] Conectar `/ws/camera` a un flujo real de partida: frame → detección → track_id → personaje/ficha → posición reflejada en el display.
  → El cableado ya existía (WS → `miniature_positions` → display), pero la posición llegaba mal calculada: `cameraToScreen()` asumía una resolución fija de 1280x720 en vez de la resolución real negociada por cada webcam. Ahora `frame_processor` expone `get_frame_size()`, se propaga en el mensaje `miniature_positions`, y el display lo usa — aplicando además la calibración manual del GM, que antes se ignoraba en esta capa.
- [x] Unificar `camera_manager.assign_player_to_miniature()` (por `marker_id`) y `_miniature_assignments` de `main.py` (por `track_id`) en **un solo modelo de asignación**.
  → `camera_manager.assign_player_to_miniature()` resultó ser código huérfano (ningún frontend lo llama). La asignación realmente en uso (`track_id -> sheet_id`) se movió de un diccionario global en `main.py` a `GameStateManager.miniature_assignments`, como única fuente de verdad dentro del gestor de estado central.
- [x] UI en admin para calibración y asignación guiada.
  → La asignación guiada (lista de figuritas detectadas con selector de ficha) ya existía en `admin.js` y funciona correctamente. La calibración vive en el **display** (no en admin) a propósito: es donde se ve en tiempo real si el token cae en el sitio correcto de la mesa física.
- [x] Documentar en `docs/CAMERA.md` el flujo soportado end-to-end.
  → Reescrito por completo; antes documentaba solo el pipeline ArUco no integrado.

**Deuda que queda fuera de esta fase** (anotada para Fase 2/3, no bloquea jugar una partida):
- `server/camera_manager.py` y `vision/detector.py` (pipeline ArUco huérfano) siguen en el repo sin usarse desde ningún frontend — candidatos a eliminar o revivir deliberadamente, no a dejar ambiguos.
- El tracking por proximidad (`simple_tracker.py`) reasigna `track_id` si una miniatura se pierde varios frames — aceptable para uso doméstico, pero puede exigir reasignar en el admin más de lo ideal en mesas con mucho movimiento.

## Fase 2 — Deuda técnica estructural

Cambios de arquitectura que hacen más barato todo lo que viene después. Vale la pena hacerlos antes de seguir añadiendo features sobre las mismas grietas.

- [ ] **Eliminar (o aislar explícitamente como "legacy/experimental") el sistema de personajes por plantilla ArUco** (`config/characters.json`, `add_character_from_marker`) si el sistema de fichas dinámicas es el soportado. Mantener ambos sin marcar cuál es la fuente de verdad es lo que causó el bug de Fase 0.
- [ ] **Persistencia real del estado de partida.** Hoy solo los mapas sobreviven a un reinicio. Opciones, de menor a mayor esfuerzo:
  1. Volcar `GameState` completo a JSON en disco periódicamente + al cerrar (rápido, suficiente para uso doméstico).
  2. SQLite embebido (ya insinuado en `.env.example`, nunca implementado) si se necesita consultas/histórico.
- [ ] **Autenticación mínima viable**: al menos un secreto compartido para el rol GM (admin panel) y una cookie/token de sesión para jugadores, para que `PlayerRole.GM` deje de ser un campo decorativo. No hace falta un sistema de usuarios completo — el riesgo real es que cualquiera con la URL pueda aprobar fichas o borrar mapas ajenos si el servidor está expuesto a Internet (ver `SPECS.md §8.2-8.3`).
- [ ] **Restringir CORS** a los orígenes reales de despliegue en vez de `*`, o quitar `allow_credentials=True` si `*` se mantiene por simplicidad de LAN.
- [ ] **Proteger o eliminar endpoints `/api/debug/*`** en despliegues de producción (flag de entorno `DEBUG`, que ya existe en `.env.example` pero no se lee en el código).
- [ ] Fijar rangos de versión de dependencias (`server/requirements.txt`) en vez de solo `>=`, y considerar un lockfile (`pip-compile` o similar).

## Fase 3 — Calidad y mantenibilidad

- [ ] **Tests automatizados mínimos**: empezar por `GameStateManager` (lógica pura, fácil de testear sin FastAPI ni cámara) — ciclo de vida de fichas, ejecución de habilidades, cooldowns, turnos. Luego tests de integración de los endpoints REST más críticos con `TestClient` de FastAPI.
- [ ] **Actualizar `docs/API.md`** para cubrir fichas, mapas, sistemas, cámara y asignaciones de miniaturas (hoy falta ~60% de los endpoints reales — ver `SPECS.md §6.1`).
- [ ] **Logs estructurados** en vez de `print()` repartidos por todo `main.py`/`game_state.py` — facilita debug en producción (ya señalado en `TODO.md`).
- [ ] Mensajes de commit descriptivos de aquí en adelante (el historial actual tiene entradas como `"1231"`, `"123"` que no ayudan a auditar cambios).
- [ ] Revisar si conviene mover los scripts de `tools/` (entrenamiento, datasets) a un subproyecto/paquete separado del runtime de servidor, ya que no forman parte de lo que corre en producción y abultan el repo.

## Fase 4 — UX / funcionalidad de juego

- [ ] **Revampear el editor de mapas** (`admin/js/map-editor.js`) — mejorar la experiencia completa de creación, no solo funcionalidad puntual.
- [ ] **Simplificar la ficha de D&D en móvil** — demasiados campos en un solo formulario; evaluar flujo progresivo (wizard) o colapsar secciones opcionales.
- [ ] **Feedback visual claro en admin** al aprobar/rechazar fichas (hoy no hay confirmación visible).
- [ ] **Indicador de jugador/personaje activo** visible en admin y display durante combate.
- [ ] **Tokens genéricos personalizables** — nombre y color en vez de "Player 1", "Player 2".
- [ ] **Sistema de chat básico** entre jugadores (mencionado como mejora deseada, sin implementación).
- [ ] Reevaluar si el **escaneo de fichas por OCR** (capturar PDF con cámara) sigue siendo objetivo — está incompleto y es una pieza grande; si no es prioritario, sacarlo del scope activo y documentarlo como "futuro" en vez de bug pendiente.

## Fase 5 — Ideas a futuro (bajo prioridad, del README original)

Mantener aquí, no mezclar con el trabajo activo hasta que las fases anteriores estén resueltas:

- Niebla de guerra dinámica.
- IA para enemigos controlados automáticamente.
- Grabación de sesiones para replay.
- Integración con Roll20/Foundry VTT para importar mapas.
- Hardware adicional: LEDs WS2812B controlados por Arduino/ESP32 según estado del juego, segunda pantalla privada para el GM.

---

## Cómo priorizar si el tiempo es limitado

1. **Fase 0** siempre primero — son bugs, no trabajo nuevo.
2. Entre Fase 1 y Fase 2: si el objetivo inmediato es "jugar una sesión real pronto", prioriza Fase 1 (cámara) aunque quede deuda técnica. Si el objetivo es "que el proyecto sea sostenible a largo plazo o lo toquen más personas", prioriza Fase 2 primero (especialmente persistencia y el sistema de personajes duplicado, que son la raíz de varios bugs de Fase 0).
3. Fase 3 (tests) rinde más cuanto antes se adopte — cada feature nueva sin tests aumenta el costo de añadirlos después.
4. Fase 4 es la que más valor visible da a los jugadores, pero construir sobre el estado actual (sin persistencia, con dos sistemas de personajes) multiplica el retrabajo. Considera intercalar solo los ítems de Fase 4 que no dependan de la Fase 2.
