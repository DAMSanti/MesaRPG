# Recomendaciones de Hardware

## Configuración Básica (Económica)

**Presupuesto aproximado: 200-400€**

### Pantalla
- **TV de 32-40"** con HDMI
- Alternativa: Monitor de PC de 27"+
- No necesita ser táctil para empezar

### Cámara
- **Webcam Logitech C270** o similar (~30€)
- Resolución: 720p
- Montaje: Trípode o soporte improvisado

### Ordenador
- Cualquier PC/laptop de los últimos 5 años
- 4GB RAM mínimo
- Windows 10/11 o Linux

### Montaje
- Mesa normal
- Soporte de cámara DIY (lámpara de pie, estantería)

---

## Configuración Recomendada

**Presupuesto aproximado: 500-1000€**

### Pantalla Táctil
- **TV táctil de 43-55"** o
- **Overlay táctil** sobre TV existente (~200€)
- Alternativa: Panel interactivo educativo usado

### Cámara
- **Logitech C920/C922** (~80€)
- Resolución: 1080p
- Mejor rendimiento en baja luz

### Montaje de Cámara
- **Brazo articulado** de monitor o micrófono (~30€)
- Altura: 80-100 cm sobre la mesa
- Ángulo: Perpendicular (90°)

### Ordenador
- Intel i5 o AMD Ryzen 5
- 8GB RAM
- SSD recomendado

### Iluminación
- **Tira LED blanca** alrededor de la mesa
- Luz difusa, sin sombras fuertes

---

## Configuración Premium

**Presupuesto aproximado: 1500-3000€**

### Mesa Integrada
Construye una mesa con:
- **Panel táctil de 55"** empotrado en superficie
- Marco de madera alrededor
- Cámara integrada en estructura

### Cámara Profesional
- **Intel RealSense D435** (~200€) para profundidad
- O cámara industrial con montura C/CS
- Múltiples cámaras para mesa grande

### Sistema de Audio
- **Altavoces 2.1** integrados en la mesa
- Subwoofer para efectos de impacto

### Iluminación Ambiental
- **Tiras LED WS2812B** controladas por Arduino
- Hue Sync o similar para sincronización
- LED bajo las figuritas

### Mini PC
- **Intel NUC** o similar
- i7, 16GB RAM, SSD NVMe
- Montado bajo la mesa

---

## Opciones de Pantalla Táctil

### 1. TV + Overlay Táctil
- Comprar TV normal + frame táctil
- Más económico
- El frame táctil va sobre la pantalla

**Productos:**
- PQLabs overlay frames
- SUR40-style DIY

### 2. Panel Interactivo
- Todo en uno (pantalla + táctil)
- Usado en educación
- Buscar "interactive flat panel" usados

**Productos:**
- Promethean ActivPanel
- SMART Board
- ViewSonic ViewBoard

### 3. Proyector + Mesa Táctil
- Proyector cenital sobre mesa blanca
- Sistema táctil por infrarrojos
- Más complejo pero muy grande

### 4. TV Horizontal sin Touch
- Funciona solo con figuritas detectadas por cámara
- Los jugadores usan móviles para interactuar
- La opción más económica

---

## Montaje de Cámara

### Opción 1: Brazo de Monitor
```
     [Cámara]
         |
    ═════╪═════  ← Brazo articulado
         |
    ─────┴─────  ← Borde de mesa
```

### Opción 2: Soporte de Techo
```
    ══════════════  ← Techo/Estante
         |
     [Cámara]
         |
         ↓
    ┌─────────────┐
    │    Mesa     │
    └─────────────┘
```

### Opción 3: Marco sobre Mesa
```
    ┌─────[Cam]─────┐
    │               │
    │     Mesa      │
    │               │
    └───────────────┘
```

---

## Sistema de LEDs (Opcional)

### Componentes
- Arduino Nano o ESP32
- Tiras WS2812B (60 LED/m)
- Fuente de alimentación 5V 10A

### Conexión con el Sistema
1. Arduino se conecta por USB al servidor
2. El servidor envía comandos de color
3. Los LEDs reaccionan a eventos del juego

### Efectos Posibles
- Cambio de color según personaje activo
- Parpadeo rojo al recibir daño
- Pulso verde al curarse
- Arcoíris al ganar combate

### Código Arduino Básico
```cpp
#include <FastLED.h>
#define NUM_LEDS 60
#define DATA_PIN 6

CRGB leds[NUM_LEDS];

void setup() {
    FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
    Serial.begin(115200);
}

void loop() {
    if (Serial.available()) {
        // Leer color RGB del servidor
        int r = Serial.parseInt();
        int g = Serial.parseInt();
        int b = Serial.parseInt();
        fill_solid(leds, NUM_LEDS, CRGB(r, g, b));
        FastLED.show();
    }
}
```

---

## Lista de Compras por Configuración

### Básica (~300€)
- [ ] TV 32" HDMI - 150€
- [ ] Webcam 720p - 30€
- [ ] Trípode pequeño - 15€
- [ ] Cable HDMI largo - 10€
- [ ] Regleta eléctrica - 15€
- [ ] Materiales impresión marcadores - 10€

### Recomendada (~800€)
- [ ] TV 43" - 300€
- [ ] Overlay táctil - 200€
- [ ] Webcam 1080p - 80€
- [ ] Brazo articulado - 40€
- [ ] Tira LED blanca - 20€
- [ ] Mini PC o laptop - 150€

### Premium (~2000€)
- [ ] Panel táctil 55" - 800€
- [ ] Intel RealSense - 200€
- [ ] Intel NUC i7 - 500€
- [ ] Sistema audio 2.1 - 150€
- [ ] LEDs + Arduino - 50€
- [ ] Mesa custom - 300€

---

## Proveedores Recomendados

### España
- Amazon.es
- PcComponentes
- AliExpress (para LEDs y Arduino)

### Pantallas Táctiles
- MultiClass (paneles interactivos)
- Acer, ViewSonic (pantallas comerciales)

### Componentes DIY
- BricoGeek
- Electan
- Amazon

---

## Tips de Ahorro

1. **Buscar en segunda mano**: Wallapop, eBay para paneles interactivos de colegios
2. **Usar hardware existente**: Tu laptop actual puede servir
3. **Empezar sin táctil**: Los móviles hacen de controladores
4. **DIY overlay táctil**: Hay tutoriales para construir marcos infrarrojos
5. **Proyector viejo**: Los proyectores de oficina funcionan bien
