





# MesaRPG — Plan de Trabajo (Actualizado)

> Proyecto: Sistema de mesa para partidas de rol con Display táctil, Admin y Mobile.

---

## 1. Visión

MesaRPG es una plataforma para gestionar partidas de rol presenciales/mixtas donde:
- El Display es la pantalla táctil principal que proyecta mapas, tokens, efectos y HUDs.
- El Admin (GM) controla la partida: elige el sistema de juego, acepta jugadores, asigna tokens, crea/genera mapas y proyecta contenido.
- Los Jugadores usan un Mobile PWA para unirse, gestionar fichas y enviar acciones.
- Hay una cámara cenital y un subsistema de visión por máquina que complementa la detección táctil para posicionar y trackear tokens físicos (no se usarán ArUco).

El editor de mapas debe permitir creación manual y generación procedural de mapas con alta calidad visual (top-down con sensación realista 3D), datos de tiles (línea de visión, coste de movimiento, cobertura, elevación), capas (terreno, objetos, efectos), guardado/carga y proyección al Display.

---

## 2. Alcance del MVP

- Editor de mapas (Admin): square + hex, paint/erase/fill, capas, undo/redo.
- Tiles con metadatos: id, name, icon, color, movementCost, blocksVision, providesCover, elevation.
- Guardar/cargar mapas en servidor (`/api/maps`), lista y preview en Admin.
- Generación procedural básica (dungeon, cave, forest, town) con parámetros y seed.
- Proyección de mapas al Display en tiempo real (WebSocket).
- Mobile PWA: unirse a la partida, ver estado, interactuar con fichas.
- Cámara cenital MVP: detección y tracking de miniaturas físicas (bounding boxes + refinamiento), identidad vía interacción táctil.
- Autenticación mínima: GM control (password), jugadores por token/session.

---

## 3. Fases y entregables

- **Fase 0 — Requisitos (entregable: documento de requisitos + criterios de aceptación).** (COMPLETADA)
- **Fase 1 — Arquitectura & API (entregable: OpenAPI + diagramas).**
- **Fase 2 — Modelos & Persistencia (entregable: CRUD `/api/maps`, `config/maps/` storage).**
- **Fase 3 — Editor UI (entregable: editor funcional en Admin).**
- **Fase 4 — Procedural Gen (entregable: generador con parámetros y UI).**
- **Fase 5 — Display Renderer (entregable: proyección de mapas y renderer optimizado, WebGL, normal maps).**
- **Fase 6 — Mobile & Sync (entregable: PWA player features, WebSocket stable).**
- **Fase 7 — Vision (entregable: pipeline CV/ML para detección y tracking de miniaturas + calibración Display↔Cámara).**
- **Fase 8 — Deploy & Ops (entregable: Docker/DO deployment, backups).**
- **Fase 9 — QA & Docs (entregable: tests, guías de uso y montaje).**

---

## 4. Criterios de aceptación (ejemplos)

- Editor: crear mapa a pantalla completa, pintar, guardar, cargar y proyectar en Display.
- Procedural: generar mazmorra reproducible (seed) con habitaciones y pasillos.
- Vision MVP: detectar y trackear miniaturas físicas con bounding boxes y refinar posición con tolerancia razonable; identidad por toque.
- Mobile: jugador puede unirse, ver su ficha y recibir notificaciones del Display.

---

## 5. Decisiones (resumen de tus respuestas)

### A — Tokens y detección
1. Registro táctil en el Display: las fichas se registran con el toque táctil en el Display; la cámara cenital enviará el feed al servidor y afinará la posición y manejará oclusiones.
2. Asignación automática de posición + identidad: posición detectada por visión; identidad confirmada/registrada por toque.
3. Tokens: miniaturas físicas (mecánicas). El sistema soportará miniaturas con bounding-box y tracking.

Design note: adoptamos un flujo híbrido: **touch-first id** + **vision-based tracking**. Habrá fallback manual en Admin.

### B — Visual quality & assets
4. Nivel: **High (gran realismo)**. Se usará WebGL en el Display renderer con texturas, normal maps y efectos de iluminación.
5. Assets: usarás **assets libres** para el prototipo (OpenGameArt / CC0 / CC-BY compatibles).

### C — Grids & game systems
6. Sistemas MVP: **D&D 5e** y **BattleTech**.
7. Escala editable por partida; por defecto el sistema calculará px ↔ pulgadas físicas (1 pulgada por tile por defecto, configurable).

### D — Map size & server
8. El mapa tiene como máximo la superficie del Display (mapa a pantalla completa). Internamente la resolución/tiles dependerá de calibración y escala.
9. Servidor central (DigitalOcean) es suficiente para el MVP.

### E — Cámara y procesamiento
10. El feed de la cámara se enviará al servidor y se procesará allí (OpenCV/ML), con opción de offload si se requiere.
11. Resolución: **1080p** (o superior) a 30 FPS recomendados como punto de partida.

### F — Seguridad y backups
12. Autenticación para jugadores y admin (session tokens, password para GM).
13. Backups opcionales (S3 o snapshots en DO).

### G — Prioridades y timeline
14. Prioridad máxima: **generación de mapas + proyección + visual polish**.
15. Plazo: **cuanto antes**; propongo un roadmap con hitos cortos (ver sección siguiente).

---

## 6. Roadmap inicial y primeros hitos

- **Hito 1 (3–7 días)**: Editor básico (pintar, capas, export/import JSON), API maps CRUD, proyección simple al Display.
- **Hito 2 (1–2 semanas)**: Integrar renderer WebGL con texturas y normal maps (visual polish inicial).
- **Hito 3 (2–4 semanas)**: Pipeline de visión: detección de miniaturas (bounding-box), calibración Display↔Cámara, flujo touch-to-id y tracking estable.

---

## 7. Preguntas técnicas pendientes (necesito tu confirmación rápida)
1. Touch workflow details:
   - ¿La pantalla actualmente es una mesa táctil que acepta toques a través de la superficie donde se colocan miniaturas, o prefieres que la identificación se haga tocando la pantalla (tap) cerca de la miniatura? En otras palabras: ¿las miniaturas producen toque directo en el panel?
2. Display physical calibration:
   - ¿Conoces las dimensiones físicas (ancho x alto en pulgadas o mm) y la resolución (px) del Display? Si no, ¿prefieres que el sistema haga una calibración guiada (medir un objeto conocido en pantalla)?
3. Número de tokens simultáneos:
   - ¿Cuántas miniaturas esperas tener simultáneamente en escena (estimación)? Esto afecta el rendimiento del tracking.
4. Identidad automática:
   - Si la visión detecta bounding boxes pero no puede identificar la miniatura (ej. dos minis iguales), ¿prefieres que el sistema pida confirmación táctil o que el GM asigne manualmente en Admin?
5. Hardware de servidor y ML:
   - ¿El servidor DO tiene GPU disponible para inferencia ML, o debemos planear inferencia en CPU y optimizar modelos ligeros?

---

## 8. Acciones inmediatas propuestas (tras tu confirmación)
1. Finalizar Fase 1: arquitectura y OpenAPI (endpoints: `/api/maps`, `/api/tiles`, `/api/maps/{id}/project`, `/api/vision/track`, `/api/tokens/register-touch`, auth endpoints).
2. Implementar Hito 1 en el repo: editor básico + export/import + proyección (PRs pequeños y revisables).
3. Preparar catálogo de assets libres y pipeline de texturas (normal maps) para Hito 2.
4. Definir pipeline MVP de visión: dataset inicial, modelo ligero (MobileNet/YOLO-lite), evaluación en CPU y opción de offload.

---

Si confirmas las preguntas técnicas (1, 2 y 5 son críticas), actualizo el plan ya en tareas concretas y empiezo el desglose de la Fase 1 en issues/PRs.

*Documento actualizado con tus respuestas — siguiente paso: confirmar las preguntas técnicas rápidas o decirme cuál quieres priorizar.*

