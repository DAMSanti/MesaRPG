# 📋 MesaRPG - TODO List

## 🔥 PRIORITARIOS (Usuario)

- [ ] **1. No hay forma de conectar cámara a la partida** - Falta integración para tracking de miniaturas en tiempo real
- [x] **2. No se pueden asignar tokens a jugadores** - ~~El flujo de asignación no funciona~~ ARREGLADO: quitada validación ArUco
- [x] **3. Tokens de sistema no cargan automáticamente** - ~~Hay que cambiar de pestaña~~ ARREGLADO: se llama renderTokenGallery() automáticamente
- [ ] **4. Revampear sistema de creación de mapas** - Mejorar toda la experiencia del editor de mapas
- [ ] **5. Mapas no se pasan al display** - No hay forma de enviar el mapa creado a la pantalla de visualización

## 🐛 BUGS / PROBLEMAS

- [ ] **Display no muestra tokens visuales** - El display usa el sistema antiguo de marcadores, no renderiza los tokens SVG
- [ ] **Flujo incompleto fichas → tokens** - Cuando asignas un token, el jugador en móvil no ve su token asignado
- [ ] **No hay forma de quitar/reasignar tokens** - `removeToken()` existe pero puede no liberar el estado correctamente
- [ ] **WebSocket no sincroniza token_visual** - El campo se guarda pero puede no propagarse a todas las pantallas
- [ ] **Fichas aprobadas sin "en juego"** - Lógica de filtrado mezcla `approved` e `in_game`, puede causar confusión

## 🔧 MEJORAS RECOMENDADAS

- [ ] **Display sin mapa cargado por defecto** - El display arranca vacío, debería cargar el mapa activo
- [ ] **No hay persistencia de sesión** - Si el servidor reinicia, se pierden fichas y tokens
- [ ] **Falta indicador de jugador activo** - En admin/display no se ve claramente quién tiene el turno
- [ ] **Sin sistema de chat/comunicación** - Los jugadores no pueden comunicarse entre sí
- [ ] **Escaneo de fichas no funciona** - Funcionalidad de escanear PDFs con cámara está incompleta (no hay OCR)

## 📱 UX/UI

- [ ] **Móvil: demasiados campos en D&D** - El formulario es muy largo, simplificar o hacer progresivo
- [ ] **Admin: no hay confirmación visual** - Sin feedback claro al aprobar fichas
- [ ] **Tokens genéricos poco descriptivos** - "Player 1", "Player 2" podrían tener colores/nombres personalizables

## ⚠️ TÉCNICOS

- [ ] **Archivos YOLO en el repo (>100MB)** - Los `.pt` files no deberían estar en git
- [ ] **Sin tests automatizados** - No hay pruebas unitarias ni de integración
- [ ] **Logs mínimos en producción** - Difícil debugear sin logs estructurados

---

## ✅ COMPLETADOS

- [x] ~~Quitar ArUco del admin~~ - Simplificado a selección visual de tokens
- [x] ~~Generar tokens visuales~~ - Creados tokens SVG para D&D y BattleTech
- [x] ~~Error de sintaxis admin.js línea 670~~ - Corregido `}` duplicado

---

*Última actualización: 4 Dic 2025*
