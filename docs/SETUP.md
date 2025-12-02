# Guía de Instalación y Configuración

## Requisitos del Sistema

### Hardware Mínimo
- **PC/Servidor**: 
  - CPU: Intel i5 o equivalente
  - RAM: 8GB
  - GPU: Integrada (recomendado dedicada para efectos más fluidos)
- **Pantalla táctil**: Cualquier monitor táctil o TV con touch overlay
- **Cámara**: Webcam USB 720p mínimo (recomendado 1080p)
- **Red**: Router WiFi para conexión de móviles

### Hardware Recomendado
- Pantalla táctil de 40"+ para mejor experiencia
- Cámara con buen rendimiento en baja luz
- Montaje cenital para la cámara (brazo articulado o soporte de techo)
- Iluminación difusa sobre la mesa

### Software
- Windows 10/11, Linux o macOS
- Python 3.9 o superior
- Navegador moderno (Chrome, Firefox, Edge)

---

## Instalación Paso a Paso

### 1. Preparar Python

```powershell
# Verificar versión de Python
python --version

# Si no tienes Python, descárgalo de https://python.org
```

### 2. Clonar/Descargar el Proyecto

```powershell
# Si usas git
git clone <url-del-repositorio>
cd MesaRPG

# O descargar y extraer el ZIP
```

### 3. Crear Entorno Virtual

```powershell
# Crear entorno virtual
python -m venv venv

# Activar (Windows PowerShell)
.\venv\Scripts\Activate.ps1

# Activar (Windows CMD)
.\venv\Scripts\activate.bat

# Activar (Linux/Mac)
source venv/bin/activate
```

### 4. Instalar Dependencias

```powershell
pip install -r server/requirements.txt
```

### 5. Generar Marcadores ArUco

```powershell
cd vision
python marker_generator.py --output ../assets/markers --num 20
cd ..
```

Los marcadores se guardarán en `assets/markers/`. Imprime `print_page.png`.

### 6. Configurar Personajes

Edita `config/characters.json` para asignar cada marcador (1-20) a un personaje.

### 7. Iniciar el Servidor

```powershell
cd server
python main.py
```

El servidor mostrará las URLs de acceso:
```
📺 Pantalla:  http://192.168.1.X:8000/display
📱 Móvil:     http://192.168.1.X:8000/mobile
🎮 Admin:     http://192.168.1.X:8000/admin
```

### 8. Iniciar la Cámara (opcional, en otra terminal)

```powershell
cd vision
python detector.py --camera 0
```

---

## Configuración de Red

### Firewall de Windows

Permite el puerto 8000:
1. Panel de Control → Firewall de Windows
2. Configuración avanzada → Reglas de entrada
3. Nueva regla → Puerto → TCP 8000 → Permitir

### Encontrar tu IP Local

```powershell
ipconfig
# Busca "IPv4 Address" en tu adaptador de red
```

---

## Configuración de la Cámara

### Posicionamiento
- Monta la cámara directamente sobre la mesa
- Altura recomendada: 80-120 cm
- Ángulo: perpendicular a la mesa (90°)
- Evita sombras directas sobre los marcadores

### Calibración
1. Abre el detector con preview: `python detector.py`
2. Verifica que los marcadores se detectan correctamente
3. Ajusta la iluminación si hay problemas
4. Presiona 'c' para calibrar el área de juego

### Solución de Problemas de Cámara

| Problema | Solución |
|----------|----------|
| Cámara no detectada | Verificar ID con `python test_camera.py` |
| Marcadores no detectados | Mejorar iluminación, imprimir más grande |
| Detección intermitente | Reducir reflejos, limpiar marcadores |
| Lag en detección | Reducir resolución de cámara |

---

## Configuración Avanzada

### Cambiar Puerto del Servidor

Edita `config/settings.json`:
```json
{
    "server": {
        "port": 8080
    }
}
```

### Añadir Nuevos Personajes

1. Edita `config/characters.json`
2. Añade entrada con ID de marcador como clave
3. Define stats y habilidades

### Crear Nuevas Habilidades

1. Edita `config/abilities.json`
2. Define la habilidad con todos sus parámetros
3. Asígnala a personajes en `characters.json`

### Cambiar Tamaño de Grid

Edita `config/settings.json`:
```json
{
    "display": {
        "grid_size": 60
    }
}
```

---

## Verificación de Instalación

Ejecuta estas comprobaciones:

```powershell
# 1. Verificar servidor
curl http://localhost:8000/api/state

# 2. Verificar cámara
python vision/test_camera.py

# 3. Verificar WebSocket (en navegador)
# Abre http://localhost:8000/display
# Debería conectar automáticamente
```

---

## Actualización

```powershell
# Detener servidor (Ctrl+C)

# Actualizar código
git pull

# Actualizar dependencias
pip install -r server/requirements.txt --upgrade

# Reiniciar servidor
python server/main.py
```
