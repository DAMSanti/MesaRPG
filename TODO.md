# 📋 MesaRPG - TODO List

## 🔥 PRIORITARIOS (Usuario)

- [x] **1. No hay forma de conectar cámara a la partida** - ARREGLADO (2026-08-11): pipeline YOLO/OpenVINO decidido como soportado, posiciones ya llegan al display con la resolución real de cámara + calibración aplicada. Ver ROADMAP.md Fase 1 y docs/CAMERA.md
- [x] **2. No se pueden asignar tokens a jugadores** - ~~El flujo de asignación no funciona~~ ARREGLADO: quitada validación ArUco
- [x] **3. Tokens de sistema no cargan automáticamente** - ~~Hay que cambiar de pestaña~~ ARREGLADO: se llama renderTokenGallery() automáticamente
- [ ] **4. Revampear sistema de creación de mapas** - Mejorar toda la experiencia del editor de mapas (ver ROADMAP.md Fase 4)
- [ ] **5. Mapas no se pasan al display** - No hay forma de enviar el mapa creado a la pantalla de visualización (revisar tras fix de `current_map`, ver ROADMAP.md Fase 0)

## 🐛 BUGS / PROBLEMAS

- [x] **Display no muestra tokens visuales** - ARREGLADO (2026-08-11): `renderer.js` usaba el id de `token_visual` como URL de imagen directamente; ahora se resuelve contra `assets/markers/tokens.json`
- [x] **Flujo incompleto fichas → tokens** - Verificado (2026-08-11): el móvil ya reflejaba el token asignado correctamente; no era un bug real
- [x] **No hay forma de quitar/reasignar tokens** - ARREGLADO (2026-08-11): faltaba el endpoint `POST /api/sheets/{id}/remove-token` en el backend (el admin ya lo llamaba)
- [x] **WebSocket no sincroniza token_visual** - Verificado (2026-08-11): ya se propagaba correctamente; el síntoma visible era el bug de renderizado de arriba
- [x] **Fichas aprobadas sin "en juego"** - Verificado (2026-08-11): el filtrado mezclado es intencional y correcto, no era un bug

## 🔧 MEJORAS RECOMENDADAS

- [x] **Display sin mapa cargado por defecto** - ARREGLADO (2026-08-11): `current_map` tenía como default un id de mapa ("default") que nunca existe; ahora es `None` hasta que el GM proyecta un mapa real
- [x] **No hay persistencia de sesión** - ARREGLADO (2026-08-11): el estado se guarda en `data/session_state.json` en cada cambio y se restaura al arrancar. Ver ROADMAP.md Fase 2
- [ ] **Falta indicador de jugador activo** - En admin/display no se ve claramente quién tiene el turno
- [ ] **Sin sistema de chat/comunicación** - Los jugadores no pueden comunicarse entre sí
- [ ] **Escaneo de fichas no funciona** - Funcionalidad de escanear PDFs con cámara está incompleta (no hay OCR)

## 📱 UX/UI

- [ ] **Móvil: demasiados campos en D&D** - El formulario es muy largo, simplificar o hacer progresivo
- [ ] **Admin: no hay confirmación visual** - Sin feedback claro al aprobar fichas
- [ ] **Tokens genéricos poco descriptivos** - "Player 1", "Player 2" podrían tener colores/nombres personalizables

## ⚠️ TÉCNICOS

- [x] **Archivos YOLO en el repo (>100MB)** - Verificado (2026-08-11): ya estaban excluidos por `.gitignore` (`*.pt`) y ninguno está trackeado en git (`git ls-files` no devuelve ninguno). No era un problema real
- [ ] **Sin tests automatizados** - No hay pruebas unitarias ni de integración (ver ROADMAP.md Fase 3)
- [ ] **Logs mínimos en producción** - Difícil debugear sin logs estructurados (ver ROADMAP.md Fase 3)
- [x] **Sin autenticación ni límite de CORS** - ARREGLADO (2026-08-11): `GM_SECRET` opcional para proteger acciones de GM, `CORS_ORIGINS` configurable, `/api/debug/*` apagado salvo `DEBUG=true`. Ver ROADMAP.md Fase 2
- [x] **Dos sistemas de personajes sin marcar cuál es el soportado** - ARREGLADO (2026-08-11): el sistema por marcador ArUco queda documentado como legacy/solo-debug; código muerto (`get_character_by_marker`) eliminado

---

## ✅ COMPLETADOS

- [x] ~~Quitar ArUco del admin~~ - Simplificado a selección visual de tokens
- [x] ~~Generar tokens visuales~~ - Creados tokens SVG para D&D y BattleTech
- [x] ~~Error de sintaxis admin.js línea 670~~ - Corregido `}` duplicado

---

*Última actualización: 11 Ago 2026 — Fases 0, 1 y 2 de ROADMAP.md completadas*
