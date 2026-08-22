# 🎲 MesaRPG

Una mesa física — pantalla, cámara cenital, luces perimetrales — que convierte una partida de rol/wargame de mesa en una experiencia asistida por software, sin quitarle la parte física que la gente valora: miniaturas reales, dados que ruedan, gente alrededor de una mesa. El software se encarga de lo tedioso (cálculos de reglas, colocación de fichas, niebla de guerra, arbitraje) para que el grupo juegue más y arbitre menos.

> 📋 **Estado del proyecto (2026-08-14)**: tras validar un prototipo funcional (visión por computadora, sincronización en tiempo real, fichas de personaje), se decidió una **reescritura completa** del sistema para llevarlo de "prototipo casero de Battletech" a producto vendible multi-sistema. Ver [`VISION.md`](VISION.md) para el producto/negocio objetivo y [`ROADMAP.md`](ROADMAP.md) para el plan de trabajo. Este README describe la visión; el prototipo anterior sigue documentado en [`SPECS.md`](SPECS.md) como referencia técnica de lo que ya se validó.

## ✨ Qué hace

- 🎯 **Detección de miniaturas físicas** por visión por computadora: modelo de mech, posición y orientación — sin marcadores que pegar.
- 🗺️ **Mapas hexagonales con elevación** y niebla de guerra combinada: cada jugador ve solo su línea de visión real; el GM ve siempre el tablero completo.
- 👻 **Colocación virtual de fichas del GM**: coloca enemigos antes de que existan físicamente en la mesa; el sistema avisa cuándo toca sacarlos de verdad, en cuanto un jugador los descubre.
- ⚔️ **Motor de reglas de Battletech** (y a futuro más sistemas): cálculos de movimiento, impacto, calor, daño y críticos resueltos automáticamente.
- 🎲 **Dados 3D** con físicas simuladas, rodando de verdad sobre la mesa.
- 💡 **Luces perimetrales** que reaccionan a la partida: misiles viajando por el borde, turno activo, calor crítico, impactos, victoria.
- 📱 **Apps de jugador y GM sin instalación**: se abren en el navegador del móvil/tablet.
- 🤖 **Asistente de GM con IA local** (fase progresiva hacia partidas sin master humano).
- 🧩 **Arquitectura multi-sistema**: Battletech es el primer sistema soportado, pensado desde el diseño para admitir D&D, Warhammer 40k, Pathfinder y otros como plugins.

Detalle completo de cada funcionalidad, modelo de negocio y estudio de hardware en [`VISION.md`](VISION.md).

## 🏗️ Hacia dónde va la arquitectura

Reescritura completa del stack anterior (Python/FastAPI + JS vanilla sin build) hacia:

- **Backend Python modularizado**: servicio de visión (YOLO/OpenVINO, ya entrenado), motor de reglas por sistema de juego, servidor de estado/sesión, asistente de IA local — comunicados por WebSocket.
- **Persistencia en SQLite embebido**, multi-campaña, cero infraestructura externa, funciona offline.
- **Frontend TypeScript + React + Three.js** (build real con Vite), manteniendo el modelo "se abre en el navegador" en móviles/tablets.
- **Arquitectura de plugins de sistema de juego**, inspirada en los "system packages" de Foundry VTT.
- **IA local sobre NPU** (sin GPU discreta), con nube como capa opcional de pago, no como dependencia.

Razonamiento completo de cada decisión en [`VISION.md` §3](VISION.md#3-arquitectura-objetivo-de-la-reescritura).

## 📁 Documentación

| Documento | Qué contiene |
|---|---|
| [`VISION.md`](VISION.md) | Visión de producto, modelo de negocio, arquitectura objetivo, catálogo completo de funcionalidades, estudio de hardware |
| [`ROADMAP.md`](ROADMAP.md) | Plan de trabajo por fases (R0 en adelante); historial de las fases ya completadas sobre el prototipo anterior |
| [`SPECS.md`](SPECS.md) | Cómo estaba construido el prototipo (referencia técnica, ya no es el destino) |
| `docs/` | Guías puntuales heredadas del prototipo (cámara, hardware, marcadores, API, despliegue) — a revisar/actualizar según avance la reescritura |

## 🚀 Prototipo actual (heredado, sigue funcionando)

El prototipo previo a la reescritura sigue siendo ejecutable y sirve de referencia de comportamiento mientras avanza la Fase R0. No es la base de código final.

```bash
cd MesaRPG
python -m venv venv
.\venv\Scripts\activate       # Windows
pip install -r server/requirements.txt
python server/main.py
```

- Pantalla de visualización: http://localhost:8000/display
- App móvil (jugadores): http://localhost:8000/mobile
- Panel de GM: http://localhost:8000/admin

Ver [`docs/SETUP.md`](docs/SETUP.md) y [`docs/CAMERA.md`](docs/CAMERA.md) para el detalle de este prototipo.

## 📄 Licencia

MIT License para el código propio del proyecto. El uso de reglas/contenido de sistemas de juego con copyright (Battletech, D&D, etc.) está pendiente de una decisión de licenciamiento antes de comercializar — ver [`VISION.md` §5](VISION.md#5-cuestión-legal--ip-pendiente-no-bloqueante-para-desarrollo).
