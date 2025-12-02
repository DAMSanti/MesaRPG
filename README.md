# 🎲 MesaRPG - Sistema Interactivo de Mesa de Juego

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Python](https://img.shields.io/badge/python-3.9+-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## 📋 Descripción

MesaRPG es un sistema completo para transformar cualquier mesa con pantalla táctil en una superficie de juego interactiva para RPGs y juegos de mesa. Utiliza visión por computadora para detectar figuritas físicas y sincroniza todo en tiempo real con los dispositivos móviles de los jugadores.

### ✨ Características Principales

- 🎯 **Detección automática de figuritas** usando marcadores ArUco
- 📱 **Control remoto** desde cualquier dispositivo móvil (PWA)
- 🗺️ **Visualización de mapas** con efectos en tiempo real
- ⚔️ **Sistema de combate** con stats, habilidades y cooldowns
- 🔊 **Efectos de sonido** sincronizados
- 📜 **Historial de acciones** automático
- 🎨 **Efectos visuales** (áreas de efecto, rangos, proyectiles)

## 🏗️ Arquitectura

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Apps Móviles   │◄──────────────────►│ Servidor Central│
│  (PWA/React)    │                    │  (FastAPI)      │
└─────────────────┘                    └────────┬────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
                    ▼                           ▼                           ▼
         ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
         │ Pantalla Táctil │         │ Sistema Cámara  │         │   Base Datos    │
         │   (Web App)     │         │   (OpenCV)      │         │   (SQLite)      │
         └─────────────────┘         └─────────────────┘         └─────────────────┘
```

## 📁 Estructura del Proyecto

```
MesaRPG/
├── server/                    # Servidor central FastAPI
│   ├── main.py               # Punto de entrada del servidor
│   ├── game_state.py         # Estado del juego
│   ├── models.py             # Modelos de datos
│   ├── websocket_manager.py  # Gestión de WebSockets
│   └── requirements.txt      # Dependencias Python
│
├── vision/                    # Sistema de visión por computadora
│   ├── detector.py           # Detector de marcadores ArUco
│   ├── calibration.py        # Calibración de cámara
│   └── marker_generator.py   # Generador de marcadores
│
├── display/                   # Pantalla de visualización (Web)
│   ├── index.html            # Página principal
│   ├── css/
│   │   └── style.css         # Estilos
│   ├── js/
│   │   ├── app.js            # Aplicación principal
│   │   ├── renderer.js       # Renderizado de mapa y efectos
│   │   ├── websocket.js      # Conexión WebSocket
│   │   └── effects.js        # Sistema de efectos visuales
│   └── assets/
│       ├── maps/             # Mapas del juego
│       ├── tokens/           # Imágenes de tokens
│       └── sounds/           # Efectos de sonido
│
├── mobile/                    # App móvil PWA
│   ├── index.html            # Página principal
│   ├── manifest.json         # Manifest PWA
│   ├── sw.js                 # Service Worker
│   ├── css/
│   │   └── mobile.css        # Estilos móvil
│   └── js/
│       ├── app.js            # Aplicación móvil
│       └── controls.js       # Controles del jugador
│
├── config/                    # Configuración
│   ├── characters.json       # Definición de personajes
│   ├── abilities.json        # Habilidades y hechizos
│   ├── maps.json             # Configuración de mapas
│   └── settings.json         # Configuración general
│
├── tools/                     # Herramientas útiles
│   ├── generate_markers.py   # Generar marcadores ArUco
│   └── test_camera.py        # Probar cámara
│
├── docs/                      # Documentación adicional
│   ├── SETUP.md              # Guía de instalación
│   ├── MARKERS.md            # Guía de marcadores
│   ├── API.md                # Documentación API
│   └── HARDWARE.md           # Recomendaciones hardware
│
└── docker-compose.yml         # Para despliegue con Docker
```

## 🚀 Inicio Rápido

### Opción 1: Servidor en la Nube (Recomendado - Sin instalación para usuarios)

Despliega en DigitalOcean y los usuarios solo necesitan abrir una URL en el navegador:

```bash
# 1. Crear un Droplet en DigitalOcean (Ubuntu 22.04, $6/mes)
# 2. Apuntar tu dominio a la IP del servidor
# 3. Conectar al servidor y ejecutar:

ssh root@TU_IP
curl -fsSL https://raw.githubusercontent.com/tu-repo/mesarpg/main/deploy/setup-server.sh | bash

# 4. Subir proyecto desde tu PC:
scp -r ./MesaRPG/* root@TU_IP:/opt/mesarpg/

# 5. Desplegar:
cd /opt/mesarpg/deploy && ./deploy.sh tu-dominio.com
```

**URLs para usuarios (sin instalación):**
- 📺 **Pantalla**: `https://tu-dominio.com/display`
- 📱 **Móvil (jugadores)**: `https://tu-dominio.com/mobile`
- 🎮 **Admin (GM)**: `https://tu-dominio.com/admin`

Ver [docs/DEPLOY.md](docs/DEPLOY.md) para instrucciones detalladas.

### Opción 2: Local (Windows)

Para desarrollo o uso en red local:

```bash
# Ejecutar directamente
start.bat

# O con Docker
docker-compose up
```

### Prerrequisitos (Solo para instalación local)

- Python 3.9+
- Node.js 16+ (opcional, para desarrollo)
- Cámara web USB
- Pantalla táctil (recomendado)

### Instalación

```bash
# 1. Clonar o descargar el proyecto
cd MesaRPG

# 2. Crear entorno virtual
python -m venv venv
.\venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/Mac

# 3. Instalar dependencias
pip install -r server/requirements.txt

# 4. Generar marcadores ArUco
python tools/generate_markers.py

# 5. Iniciar el servidor
python server/main.py
```

### Acceso

- **Pantalla de visualización**: http://localhost:8000/display
- **App móvil (jugadores)**: http://localhost:8000/mobile
- **Panel de control (GM)**: http://localhost:8000/admin
- **API docs**: http://localhost:8000/docs

## 🎮 Uso Básico

### Para el Game Master (GM)

1. Inicia el servidor en el PC conectado a la pantalla táctil
2. Abre la pantalla de visualización en modo pantalla completa (F11)
3. Coloca la cámara sobre la mesa apuntando hacia abajo
4. Calibra la cámara usando el panel de control

### Para los Jugadores

1. Conectarse a la red WiFi local
2. Abrir en el móvil: `http://[IP-DEL-SERVIDOR]:8000/mobile`
3. Introducir nombre y seleccionar personaje
4. ¡Listo para jugar!

### Figuritas

1. Imprime los marcadores ArUco generados
2. Pega cada marcador en la base de una figurita
3. El sistema detectará automáticamente qué figurita es

## 🔧 Configuración

### Personajes (`config/characters.json`)

```json
{
  "marker_1": {
    "name": "Gandalf",
    "class": "Mago",
    "hp": 80,
    "max_hp": 80,
    "abilities": ["fireball", "shield", "teleport"]
  }
}
```

### Habilidades (`config/abilities.json`)

```json
{
  "fireball": {
    "name": "Bola de Fuego",
    "damage": 30,
    "range": 5,
    "aoe": 2,
    "cooldown": 3,
    "effect": "fire"
  }
}
```

## 💡 Mejoras Propuestas

### Hardware Adicional (Opcional)

- **Tiras LED WS2812B** bajo la mesa para efectos ambientales
- **Arduino/ESP32** para controlar LEDs según estado del juego
- **Altavoces** para efectos de sonido inmersivos
- **Segunda pantalla** para el GM con stats privados

### Software

- **Integración con Roll20/Foundry VTT** para importar mapas
- **Sistema de niebla de guerra** dinámico
- **IA para enemigos** controlados automáticamente
- **Grabación de sesiones** para replay

## 🐛 Solución de Problemas

### La cámara no detecta las figuritas

1. Verifica que hay buena iluminación
2. Asegúrate que los marcadores están bien impresos
3. Recalibra la cámara desde el panel de control
4. Ajusta el tamaño de los marcadores (mínimo 2x2 cm)

### Los móviles no conectan

1. Asegúrate que están en la misma red WiFi
2. Verifica que el firewall permite el puerto 8000
3. Usa la IP local del servidor, no localhost

### Lag en la visualización

1. Reduce la resolución de la cámara
2. Aumenta el intervalo de detección
3. Cierra otras aplicaciones pesadas

## 📄 Licencia

MIT License - Úsalo libremente para tu proyecto personal.

## 🤝 Contribuciones

¡Las contribuciones son bienvenidas! Si tienes ideas para mejorar el proyecto, abre un issue o un pull request.

---

**Desarrollado con ❤️ para la comunidad de rol**
