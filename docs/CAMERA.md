# 📷 Guía de Cámara para MesaRPG

## Pipeline soportado: YOLO/OpenVINO vía panel de admin

MesaRPG detecta miniaturas físicas con un modelo YOLO propio (entrenado con
las herramientas de `tools/`, exportado a OpenVINO para correr en CPU), no
con marcadores ArUco. El flujo completo es:

```
Navegador del admin          Servidor (FastAPI)              Todas las pantallas
─────────────────────       ──────────────────────           ───────────────────
getUserMedia (webcam)   ──►  /ws/camera (WebSocket)
captura frame en canvas      frame_processor.py
envía frame JPEG base64      (YOLO + OpenVINO + tracking) ──► miniature_positions
por WS                       devuelve tracks + frame           (posiciones + frame_size)
                              anotado al admin                       │
                                                                      ▼
                                                          display/js/renderer.js
                                                          dibuja el token en el
                                                          mapa (con calibración)
```

No hace falta ningún script aparte ni marcadores impresos: todo ocurre
dentro del navegador del admin y el servidor.

### Pasos para usarlo

1. Abre el panel de admin (`/admin`) en el equipo con la cámara (webcam USB
   apuntando hacia abajo sobre la mesa, o cámara IP — ver más abajo).
2. En la pestaña de cámara, conecta la webcam y arranca el streaming. El
   navegador pide permiso de cámara (`getUserMedia`) y empieza a enviar
   frames al servidor.
3. El servidor procesa cada frame con YOLO, detecta miniaturas y les asigna
   un `track_id` estable mientras sigan visibles (tracking simple por
   proximidad, ver `server/simple_tracker.py`).
4. En el propio panel de admin aparece la lista de "figuritas detectadas"
   (una por `track_id`). Para cada una, elige en el desplegable la ficha de
   personaje (ya aprobada) a la que corresponde — eso llama a
   `POST /api/miniature-assignments`.
5. Esa asignación (`track_id -> sheet_id`) vive en
   `GameStateManager.miniature_assignments` (única fuente de verdad) y se
   difunde por WebSocket a todas las pantallas conectadas.
6. El display recibe las posiciones (`miniature_positions`) y, para cada
   track asignado, dibuja el token visual de la ficha (`token_visual`) en el
   mapa, en la posición correspondiente.

### Cámara IP en vez de webcam USB

El panel de admin también permite conectar una cámara IP (móvil con
DroidCam/IP Webcam, o similar) enviando su URL de streaming MJPEG; el
servidor la consume directamente (`stream_ip_camera` en `server/main.py`)
sin pasar por el navegador. El resto del flujo (YOLO, tracking, asignación,
display) es idéntico.

### Calibración

El display tiene su propio panel de calibración (offset X/Y, escala X/Y)
para corregir el mapeo entre las coordenadas del frame de cámara y la
pantalla física — útil si la cámara no está perfectamente centrada/alineada
sobre la mesa. Vive en el display (no en el admin) porque ahí es donde se ve
en tiempo real si el token cae en el sitio correcto de la mesa. El servidor
también envía la resolución real del frame procesado junto con cada
actualización de posiciones, así que la conversión no depende de asumir una
resolución fija de cámara.

### Montaje físico

```
        [Cámara mirando abajo]
              ↓
    ┌─────────────────────┐
    │                     │
    │   Mesa / Pantalla   │  ← Figuritas (sin marcador, YOLO las reconoce directamente)
    │                     │
    └─────────────────────┘
```

**Tips:**
- La cámara debe estar centrada sobre la mesa, altura recomendada 60-100 cm.
- Buena iluminación uniforme (evitar sombras fuertes y reflejos).
- Cuantas más miniaturas distintas veas en el dataset de entrenamiento
  (`tools/capture_dataset.py`, `tools/train_miniatures.ipynb`), mejor
  detecta el modelo en tu mesa específica.

### Solución de problemas

**"No aparecen figuritas detectadas en el admin"**
- Verifica que el streaming esté activo (frames viajando por `/ws/camera`).
- Revisa la consola del servidor: debería loguear FPS de YOLO al procesar.
- Comprueba que el modelo cargó bien (`GET /api/camera/status` /
  `frame_processor.get_status()` en la respuesta `camera_status` del WS).

**"Los tokens aparecen desplazados en el display"**
- Ajusta la calibración (offset/escala) desde el panel de calibración del
  display.
- Confirma que el display está recibiendo `frame_size` en los mensajes
  `miniature_positions` (si el servidor es una versión anterior a esta
  actualización, puede faltar y se usará una resolución 1280x720 por
  defecto).

**"Track_id cambia todo el rato / pierde la asignación"**
- El tracking es por proximidad entre frames (`simple_tracker.py`); si la
  miniatura se mueve muy rápido o se pierde muchos frames seguidos, se le
  asigna un `track_id` nuevo y hay que reasignarla en el admin.

---

## Pipeline legacy: marcadores ArUco (no integrado)

El repo incluye un sistema de detección por marcadores ArUco en `vision/`
(`detector.py`, `generate_markers.py`, `camera_test.py`) y un
`server/camera_manager.py` que también sabe detectar ArUco capturando la
cámara directamente en el servidor. **Ninguno de los dos está conectado al
flujo actual del admin/display**: no hay frontend que los use, y sus
endpoints (`/api/camera/connect`, `/api/camera/miniatures/assign`, etc.)
quedan huérfanos. Se mantienen en el repo por si se retoma ese enfoque, pero
no son el camino soportado — usa el pipeline YOLO/OpenVINO descrito arriba.

Si aun así quieres probarlo de forma aislada (fuera del servidor principal):

```bash
pip install opencv-python opencv-contrib-python
python vision/generate_markers.py --count 20   # genera marcadores para imprimir
python vision/camera_test.py                   # prueba la detección con tu webcam
```
