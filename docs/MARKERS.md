# Guía de Marcadores ArUco

## ¿Qué son los Marcadores ArUco?

Los marcadores ArUco son patrones visuales similares a códigos QR pero optimizados para detección en tiempo real. Cada marcador tiene un ID único que el sistema usa para identificar qué figurita es.

## Ventajas sobre Reconocimiento de Imágenes

| ArUco | Reconocimiento de Imagen |
|-------|-------------------------|
| ✅ Rápido y preciso | ❌ Lento y costoso |
| ✅ Funciona con cualquier iluminación | ❌ Sensible a luz |
| ✅ Detecta rotación | ❌ Requiere entrenamiento |
| ✅ Muy robusto | ❌ Puede fallar |
| ❌ Requiere imprimir marcadores | ✅ Sin preparación |

## Generación de Marcadores

### Usando el Script Incluido

```powershell
cd vision
python marker_generator.py --output ../assets/markers --num 20 --size 200
```

**Parámetros:**
- `--output`: Directorio de salida
- `--num`: Cantidad de marcadores (máximo 50 con DICT_4X4_50)
- `--size`: Tamaño en píxeles

### Generación Online

También puedes generar marcadores en:
- https://chev.me/arucogen/
- Selecciona: Dictionary = 4x4, Marker ID = 0-19

---

## Impresión

### Recomendaciones

1. **Tamaño mínimo**: 2x2 cm (recomendado 3x3 cm)
2. **Papel**: Mate (evita reflejos)
3. **Impresión**: Alta calidad, blanco y negro
4. **Contraste**: Máximo (negro puro, blanco puro)

### Página Lista para Imprimir

El script genera `print_page.png` con 20 marcadores organizados para imprimir en una hoja A4.

### Protección de Marcadores

Para durabilidad, considera:
- Laminar con acabado mate
- Usar cartulina gruesa
- Aplicar spray fijador
- Cubrir con cinta transparente (evitar brillos)

---

## Colocación en Figuritas

### Métodos Recomendados

1. **Pegar en la base**
   - Recorta el marcador
   - Pégalo debajo de la figurita
   - La cámara debe ver la base

2. **Base intercambiable**
   - Crea bases circulares con marcadores
   - Cambia el marcador sin modificar la figurita

3. **Peana con marcador**
   - Imprime el marcador más grande
   - Pega la figurita encima
   - El marcador es visible alrededor

### Tamaño del Marcador vs Base

```
┌─────────────────┐
│    Figurita     │
│   ┌─────────┐   │
│   │ Marcador│   │
│   │  3x3cm  │   │
│   └─────────┘   │
│    Base 5cm     │
└─────────────────┘
```

---

## Asignación de IDs

### Tabla de Referencia

Edita `config/characters.json` para asignar cada ID:

| Marcador | Personaje | Clase |
|----------|-----------|-------|
| 0 | (Reservado para calibración) | - |
| 1 | Gandalf | Mago |
| 2 | Aragorn | Guerrero |
| 3 | Legolas | Arquero |
| ... | ... | ... |

### Enemigos y NPCs

Reserva rangos de IDs para diferentes tipos:
- 1-10: Personajes jugadores
- 11-15: NPCs aliados
- 16-20: Enemigos

---

## Solución de Problemas

### El marcador no se detecta

1. **Verificar tamaño**: Mínimo 2cm, idealmente 3cm+
2. **Mejorar iluminación**: Luz uniforme, sin sombras fuertes
3. **Verificar impresión**: Debe ser nítido, sin manchas
4. **Limpiar superficie**: Sin polvo o suciedad
5. **Revisar ángulo**: Debe estar horizontal

### Detección intermitente

1. Reducir reflejos (usar papel mate)
2. Evitar movimiento de la cámara
3. Aumentar iluminación
4. Verificar enfoque de la cámara

### Múltiples detecciones falsas

1. Verificar que no hay otros patrones similares
2. Reducir sensibilidad del detector
3. Mejorar contraste del marcador

### El marcador se confunde con otro

Esto no debería pasar con ArUco, pero si ocurre:
1. Verificar que el marcador está bien impreso
2. Reimprimir el marcador afectado
3. Usar IDs más separados

---

## Diccionarios Disponibles

El sistema usa `DICT_4X4_50` por defecto (50 marcadores de 4x4 bits).

Otros diccionarios disponibles:
- `DICT_4X4_100`: 100 marcadores
- `DICT_5X5_50`: Más robusto, 50 marcadores
- `DICT_6X6_50`: Máxima robustez, 50 marcadores

Para cambiar, edita `config/settings.json`:
```json
{
    "camera": {
        "marker_dictionary": "DICT_5X5_50"
    }
}
```

**Nota**: Si cambias el diccionario, debes regenerar todos los marcadores.

---

## Tips Avanzados

### Marcadores de Calibración

Usa los IDs 0-3 para las esquinas de la mesa:
- ID 0: Esquina superior izquierda
- ID 1: Esquina superior derecha
- ID 2: Esquina inferior derecha
- ID 3: Esquina inferior izquierda

### Múltiples Cámaras

Para mesas muy grandes, puedes usar varias cámaras:
1. Ejecuta múltiples instancias del detector
2. Cada una conecta al mismo servidor
3. El servidor combina las detecciones

### Marcadores LED

Para efectos visuales, considera:
1. Imprimir marcador en transparencia
2. Colocar LED RGB debajo
3. El LED puede cambiar color según estado del personaje

---

## Referencias

- [OpenCV ArUco Tutorial](https://docs.opencv.org/4.x/d5/dae/tutorial_aruco_detection.html)
- [ArUco Marker Generator](https://chev.me/arucogen/)
