# 📷 Guía de Cámara para MesaRPG

## Opciones de Cámara

### Opción 1: Webcam USB (Más fácil)
- Cualquier webcam USB
- Montar encima de la mesa mirando hacia abajo
- Resolución mínima: 720p

### Opción 2: Móvil como Cámara (Flexible)

#### Android - DroidCam
1. Instala **DroidCam** desde Play Store
2. Instala **DroidCam Client** en tu PC: https://www.dev47apps.com/
3. Conecta móvil y PC a la misma WiFi
4. Abre DroidCam en el móvil, anota la IP (ej: 192.168.1.100)
5. Conecta desde el script:
   ```bash
   python vision/camera_test.py --url http://192.168.1.100:4747/video
   ```

#### Android - IP Webcam
1. Instala **IP Webcam** desde Play Store
2. Abre la app, baja hasta "Start server"
3. Anota la URL que muestra (ej: http://192.168.1.100:8080)
4. Conecta:
   ```bash
   python vision/camera_test.py --url http://192.168.1.100:8080/video
   ```

#### iPhone - EpocCam
1. Instala **EpocCam** desde App Store
2. Instala driver en PC: https://www.elgato.com/epoccam
3. Aparecerá como webcam virtual (usa --camera 1 o 2)

---

## Generar Marcadores ArUco

Los marcadores son códigos que la cámara reconoce. Cada figurita necesita uno.

```bash
# Instalar OpenCV si no lo tienes
pip install opencv-python opencv-contrib-python

# Generar 10 marcadores
python vision/generate_markers.py

# Generar más marcadores
python vision/generate_markers.py --count 20
```

Esto crea:
- `markers/marker_XX_nombre.png` - Marcadores individuales
- `markers/print_sheet.png` - Hoja para imprimir todos

**Instrucciones:**
1. Imprime la hoja de marcadores
2. Recorta cada marcador (cuadrado negro con borde blanco)
3. Pega debajo de cada figurita (o en una base)
4. El marcador debe ser visible para la cámara

---

## Probar la Cámara

```bash
# Webcam por defecto
python vision/camera_test.py

# Webcam secundaria
python vision/camera_test.py --camera 1

# Cámara IP/Móvil
python vision/camera_test.py --url http://192.168.1.100:4747/video
```

Deberías ver:
- Ventana con imagen de la cámara
- Marcadores detectados resaltados en verde
- ID y posición de cada marcador

---

## Conectar al Servidor

Una vez que la cámara detecta marcadores:

```bash
# Conectar al servidor local
python vision/detector.py --server ws://localhost:8000/ws/camera

# Conectar al servidor remoto
python vision/detector.py --server ws://209.97.131.243/ws/camera

# Con cámara IP
python vision/detector.py --url http://192.168.1.100:4747/video --server ws://209.97.131.243/ws/camera
```

---

## Montaje Físico

```
        [Cámara mirando abajo]
              ↓
    ┌─────────────────────┐
    │                     │
    │   Mesa / Pantalla   │  ← Figuritas con marcadores
    │                     │
    └─────────────────────┘
```

**Tips:**
- La cámara debe estar centrada sobre la mesa
- Altura recomendada: 60-100cm sobre la mesa
- Buena iluminación (evitar sombras fuertes)
- Los marcadores deben ser visibles y planos

---

## Solución de Problemas

### "No se pudo abrir la cámara"
- Verifica conexión USB
- Prueba otro ID: `--camera 1`, `--camera 2`
- En Windows, cierra otras apps que usen la cámara

### "No detecta marcadores"
- Asegúrate que el marcador esté completamente visible
- Mejora la iluminación
- Acerca la cámara o usa marcadores más grandes
- Imprime en blanco y negro con buen contraste

### "Detección inestable"
- Fija la cámara (evita vibraciones)
- Aumenta la iluminación
- Reduce reflejos en la superficie

