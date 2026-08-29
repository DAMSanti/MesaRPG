# VISION.md — MesaRPG

> Generado a partir de una conversación de planificación el 2026-08-14. Este documento recoge **qué queremos que MesaRPG llegue a ser** (producto, negocio, arquitectura objetivo) tras decidir una reescritura completa del prototipo actual. `SPECS.md` sigue describiendo el prototipo tal cual existe hoy (ya obsoleto como destino, útil como referencia de lo que funcionaba). `ROADMAP.md` traduce esta visión en fases de trabajo concretas.

---

## 1. Qué es MesaRPG

Una mesa física (pantalla + cámara cenital + luces perimetrales) que convierte una partida de rol/wargame de mesa en una experiencia asistida por software, sin quitarle la parte física que la gente valora: miniaturas reales, dados que ruedan, gente alrededor de una mesa. El software se encarga de lo tedioso — cálculos de reglas, colocación de fichas, niebla de guerra, arbitraje — para que el grupo juegue más y arbitre menos.

Punto de partida: un prototipo funcional en Python/FastAPI + JS vanilla, con visión por computadora YOLO/OpenVINO ya entrenada para detectar miniaturas, pensado originalmente solo para Battletech casero. Se mantiene como base de conocimiento (modelos entrenados, lógica de reglas ya escrita) pero **el stack se reescribe por completo** — ver §3.

## 2. A quién va dirigido y modelo de negocio

**Cliente**: grupos de rol/wargame habituales (Battletech, D&D y sucesivamente otros sistemas) que quieren reducir la fricción de arbitrar partidas complejas sin perder la mesa física.

**Producto**: mesa completa en **flat-pack** (el cliente la ensambla), con todo el hardware necesario para jugar salvo el contenido específico de cada partida (miniaturas, libros). Dos variantes:
- **Estándar**: sin táctil en la pantalla; toda la interacción manual se hace desde tablet/móvil (GM y jugadores). Más barata y fiable.
- **Premium**: con marco táctil infrarrojo sobre el mismo panel, para interactuar directamente sobre el tablero físico.

**Ingresos más allá de la venta inicial**:
- Accesorios: bases de miniatura con NFC embebido (respaldo de identificación cuando falla la visión), kits de expansión para unir dos mesas en una batalla más grande, piezas de recambio.
- Suscripción opcional de IA en la nube (mejor modelo que el local) y sync/backup de campañas en la nube.
- A futuro: marketplace de sistemas de juego y contenido de terceros, con reparto de ingresos (ver §4.6).

**Cuestión legal pendiente, deliberadamente aplazada** (ver §5): se está desarrollando con datos/reglas reales de Battletech y D&D. La decisión de mantener nombres/contenido real (negociando licencia) vs. hacer un reskin genérico se toma **antes de comercializar**, no antes de programar.

## 3. Arquitectura objetivo de la reescritura

Decisión tomada: reescritura completa (frontend, backend, persistencia), no un parcheo incremental del prototipo. Propuesta de stack — de partida, sujeta a validación en Fase R0 del roadmap, no una decisión cerrada en piedra:

- **Backend** en Python, pero modularizado por responsabilidad en vez de un `main.py`/`game_state.py` monolítico: servicio de visión (`vision/`, YOLO/OpenVINO — se conserva, es la inversión ya hecha y el ecosistema correcto para CPU/NPU), motor de reglas por sistema de juego (`rules/<sistema>/`), servidor de estado/sesión (`state/`), asistente de IA local (`ai/`). Comunicación en tiempo real vía WebSocket (se mantiene, funcionaba bien).
- **Persistencia**: pasar del volcado plano a JSON actual a **SQLite embebido** (una base por campaña/mesa) — sigue siendo cero-infraestructura y funciona offline, pero permite consultas reales, histórico, y varias campañas en paralelo de forma nativa.
- **Frontend**: TypeScript con build real (Vite), React para paneles con estado complejo (admin, fichas, herramientas de GM) + Three.js/React Three Fiber para la capa 3D (mechs, dados, vista de mesa). Se mantiene el modelo "abre una URL en el navegador" en móviles/tablets — es una ventaja real frente a una app nativa o un motor tipo Godot que exigiría instalación en cada dispositivo de cada jugador.
- **Arquitectura de plugins de sistema de juego**: cada sistema (Battletech, D&D, y los que vengan) se implementa como paquete autocontenido — motor de reglas + esquema de ficha de personaje + tokens — cargado dinámicamente. Modelo directamente inspirado en los "system packages" de Foundry VTT.
- **IA local**: LLM cuantizado (rango 7-8B) corriendo vía OpenVINO GenAI / llama.cpp sobre la misma NPU del mini PC que ya hace inferencia de visión — evita depender de GPU discreta cara. Cloud como capa opcional de pago, no como dependencia.
- **Offline-first obligatorio**: la mesa tiene que funcionar sin internet en casa de cualquier cliente. Todo lo anterior está elegido con esa restricción como no negociable.

## 4. Catálogo de funcionalidades nuevas

### 4.1 Visión (miniatura → modelo, posición, orientación)
- Una figura física fija por jugador; deben poder usar miniaturas propias, no solo las del dataset de entrenamiento → el modelo debe generalizar, no memorizar.
- Orientación (facing) real, usada para arcos de fuego y movimiento de Battletech, no solo estética.
- Tracking robusto como requisito duro: combinar visión (posición + orientación) con **NFC opcional embebido en la base** como respaldo de identidad cuando falla la luz/oclusión. Accesorio vendible aparte, nunca obligatorio.
- Cámara recomendada: obturador global (evita "efecto goma" con movimiento rápido) si el presupuesto lo permite; webcam estándar como base.

### 4.2 Mesa, colocación virtual del GM y niebla de guerra
- Mapas hexagonales con elevación visible sobre el propio mapa (no solo números).
- El GM puede colocar fichas "fantasma" antes de que exista la miniatura física en mesa. En cuanto el LoS de un jugador alcanza esa casilla, el software muestra la ficha en pantalla y avisa al GM (alerta visual en su panel) para que coloque la miniatura real — desde ese momento, la posición física manda sobre la virtual.
- Niebla de guerra combinada en pantalla compartida: zona fuera de todo LoS queda oscura; zona vista por al menos un jugador se ve a brillo normal; el borde del cono de visión de cada jugador se dibuja con un contorno de su color asignado; cada unidad enemiga visible muestra puntos de color indicando quién la ve. El GM tiene un toggle de "sin niebla" permanente y un modo "aislar visión de jugador X" para depurar.

### 4.3 Luces perimetrales (LED)
Además del ejemplo original (misiles viajando por el borde): turno activo recorriendo el perímetro (doble uso como cuenta atrás), pulso rojo de calor crítico, flash en impacto crítico/explosión de munición, barrido rojo→apagado al destruirse un mech, barra de progreso de fase con límite de tiempo, aviso ámbar de estructura/PV bajos, barrido arcoíris al terminar la partida.

### 4.4 Motor de reglas de Battletech
- Fase inicial centrada en combate core de BattleMechs (movimiento, tiradas de impacto, calor, daño, críticos). Vehículos, aeroespacial, infantería y reglas de construcción quedan documentados como objetivo futuro, no descartados.
- Selector Total Warfare (completo) / Alpha Strike (simplificado) si el coste de implementarlo no es desproporcionado.
- Generador de encuentros balanceados por Battle Value, para GMs improvisando.

### 4.5 Fichas y modelos de mech
- Digitalización de ficha física por foto (capturar con cámara del móvil/tablet, extraer datos, integrar en la partida).
- Modelos 3D de los mechs si es técnicamente viable; alternativa: tokens mucho más detallados que representen fielmente a los mechs reales.
- Dados 3D con físicas simuladas, visibles rodando sobre la mesa; lectura de dados físicos reales vía cámara queda como fase futura.

### 4.6 Multi-partida y multi-sistema
- Varias campañas/partidas guardadas en paralelo en el mismo servidor (no solo una sesión activa).
- Arquitectura de plugins de sistema de juego (ver §3), validada implementando un segundo sistema real (D&D, aprovechando el SRD abierto) además de Battletech.
- Formato estándar de import/export de fichas entre mesas/grupos.
- A futuro: marketplace de sistemas y contenido de terceros con reparto de ingresos.

### 4.7 Herramientas de GM adicionales
- Log de partida exportable/imprimible al final de sesión (resumen, MVP, bajas) — también sirve como contenido compartible en redes.
- Modo espectador/salida limpia para retransmitir por Twitch/OBS sin overlays de admin.
- Undo de la última acción resuelta (crítico una vez todo el cálculo está automatizado — un clic erróneo sin deshacer es muy frustrante).

### 4.8 GM IA
Fase progresiva: primero asistente que automatiza cálculos y resolución de reglas con un humano narrando; la narrativa/decisión autónoma completa (reemplazar al GM humano del todo) queda como fase posterior, una vez la base de reglas automatizadas esté sólida.

### 4.9 Producto físico
- Mesa flat-pack, dos SKUs (estándar sin táctil / premium con marco IR).
- Guía de montaje con QR/AR enlazando a vídeo, usando la propia tecnología del producto en el unboxing.
- Kits de expansión para unir dos mesas en una batalla más grande.

## 5. Cuestión legal / IP (pendiente, no bloqueante para desarrollo)

D&D 5e tiene un SRD publicado bajo licencia abierta (OGL/CC) — implementarlo es legalmente seguro. Battletech (Catalyst Game Labs) y Warhammer 40k (Games Workshop) no tienen un equivalente: solo permiten contenido de fans no comercial. Las mecánicas de juego (fórmulas, tablas) en sí no suelen tener copyright — la expresión concreta (nombres, arte, lore) sí. Antes de comercializar hay que decidir entre: reskin propio con motor mecánicamente equivalente, negociar licencia directa con Catalyst, o limitar el contenido preinstalado y dejar que cada mesa aporte sus propios datos. Decisión explícitamente aplazada hasta que el producto funcione y esté cerca de venderse.

## 6. Estudio de hardware (orientativo, verificar precios antes de fijar PVP)

| Elemento | Recomendación | Motivo |
|---|---|---|
| Panel | TV 4K 55", sin táctil en el SKU estándar | El táctil capacitivo nativo en gran formato es carísimo; marco IR como upgrade en el SKU premium |
| Cristal | Templado con capa antirreflejo | Sin esto la niebla/colores se ven mal bajo luz de sala |
| Cámara | Webcam 1080p/4K; upgrade a obturador global | Evita el "efecto goma" en tracking con movimiento rápido |
| Cómputo | Raspberry Pi 5 (8GB) + AI HAT+ (Hailo-8, ~13 TOPS) | Decisión revisada 2026-08-14 tras cuestionar el coste de un mini PC "AI PC" (~600€): innecesario para la carga real de trabajo. Hailo está diseñado justo para inferencia YOLO en el borde; consume mucho menos y encaja mejor dentro de un mueble con cristal encima. Coste real acotado, ecosistema/soporte a largo plazo más sólido que una SBC genérica |
| LEDs | WS2812B + ESP32 | Coste bajo, no es el cuello de botella de precio |

Estimación orientativa de electrónica (verificar antes de comprometer PVP): panel ~350€, cómputo (Pi 5 + AI HAT+ + caja/disipación) ~200-230€, cámara ~80€, LEDs/ESP32 ~50€, altavoces/cableado/fuente ~100€ → **≈750-850€ en electrónica** (antes ~1.200€ con la propuesta de mini PC), más estructura/cristal/embalaje a definir. Un PVP en la zona de 2.000-3.000€ sería coherente con mesas de juego premium ya existentes en el mercado hobby, con mejor margen que la estimación anterior.

**Nota técnica pendiente para Fase R0**: los modelos YOLO ya entrenados están exportados a OpenVINO (stack de Intel), que no corre bien sobre el Hailo de la Pi. Hay que reexportar el pipeline de visión al toolchain de Hailo (soportado por Ultralytics) antes de dar por cerrada esta elección — validar con el prototipo mínimo de Fase R0, no asumir que es gratis.

**Entorno de desarrollo vs. hardware objetivo**: el desarrollo del día a día (meses) va a hacerse en PC, sin acceso físico a una Raspberry Pi. Esto no debe bloquear nada si el backend de visión se diseña detrás de una interfaz (`VisionBackend` o similar) con dos implementaciones: **OpenVINO/x86 para desarrollo** (lo que ya funciona hoy en el prototipo) y **Hailo/ARM para el hardware de producción**, seleccionable por configuración. El grueso del trabajo (reglas, UI, niebla de guerra, persistencia, plugins de sistema) se construye y prueba enteramente en PC; el port a Hailo es una tarea acotada y tardía — se valida cuando haya una Raspberry Pi física disponible (comprarla es barato, no hace falta antes de empezar a programar), no algo que condicione la arquitectura desde el primer día.

**Sobre la IA local**: con este cómputo, el nivel local solo debe aspirar a un modelo pequeño (1-3B, cuantizado) para consultas puntuales de reglas — no a narrativa fluida en tiempo real. La IA "GM narrativo completo" (Fase R6, progresiva) sigue planteada como capa de nube de pago, no como requisito del hardware base — evita tener que sobredimensionar la mesa para un caso de uso que de todas formas iba a ser opcional/premium.

## 7. Decisiones abiertas / a revisar cuando toque

- Confirmación final del stack de reescritura (§3) al arrancar Fase R0 del roadmap.
- Aspecto de pantalla (16:9 estándar vs. ultrawide 32:9, mejor ajuste a mapas hexagonales rectangulares pero más caro) — de momento 16:9 por disponibilidad/precio.
- Selector Total Warfare/Alpha Strike: confirmar viabilidad una vez se investiguen las reglas a fondo.
- Decisión de marca/licencia de IP (§5), antes de comercializar.
