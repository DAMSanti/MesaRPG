# Pipeline de texturizado de mechs MW5 → MesaRPG

Documentado tras el proceso completo con el Bushwacker (primer chasis MW5
llevado a producción, sustituyendo el placeholder HBS). Estos modelos van
a sustituir a los actuales; esto es la referencia para repetir el proceso
en el resto del roster sin volver a descubrir todo esto por las bravas.

**`rewrite/frontend/public/models/mechs/legacy/` está OBSOLETO.** Son los
`.glb` viejos (pipeline placeholder-tier o hand-authored anterior a este
documento), movidos ahí solo para no confundirlos con los curados —
NUNCA arrancar un chasis nuevo desde ahí. La única fuente real para
CUALQUIER chasis nuevo es `modelsmw5/activos/<Chasis>/` (ver sección 2
para la organización completa en `activos/`/`extra/`/`_Common`).

## 0. Resumen del pipeline completo

1. FModel exporta el chasis en modo **UEFormat** desde el juego a `Output/Exports/`.
2. Se organiza todo en `modelsmw5/<Chasis>/` (mismo patrón que ya existe para ~90 chasis).
3. Se importa a Blender con el addon `io_scene_ueformat`.
4. Se rota, se montan las armas, se construyen los materiales reales.
5. Se exporta a `.glb` y se coloca en `rewrite/frontend/public/models/mechs/`.
6. Se sincroniza el loadout real del chasis (`mech_templates`) para que el
   juego sepa qué arma va en cada hardpoint.

## 1. Extracción con FModel

- Exportar en modo **UEFormat** (no "raw") — produce `.uemodel`/`.ueanim`,
  directamente importables en Blender. El modo raw (`.uasset`/`.uexp`) no
  sirve sin un parser aparte.
- Mechas: `Objects/Mechs/<Chasis>/` (y su equivalente bajo cada `DLCx/Objects/Mechs/` — el mismo chasis puede tener partes repartidas en varios DLC).
- **Ojo**: `Objects/Weapons/` (el árbol de armas por tipo — AC10, PPC, etc.) es
  casi seguro lógica de juego (Blueprints, stats, VFX, audio), NO asset
  visual — verificado indirectamente, sin Texture2D/SkeletalMesh dentro.
  No merece la pena exportarlo salvo que se busque algo muy concreto (p.ej.
  `MissileHead_MTI`, ver más abajo).
- `_Common` (dentro de `Objects/Mechs/_common` y `Objects/Mechs/CLANS/_common`)
  contiene assets COMPARTIDOS entre chasis — cabina genérica, materiales de
  armas, texturas "Clan_Generic_*". Exportar también.

## 2. Organización en `modelsmw5/`

Ya existe `organize_mw5.py` (mueve/fusiona por chasis, resuelve mayúsculas
canónicas, gestiona `_common` y la carpeta `Clans`). Reusar tal cual —
el único bug real que tuvo fue no expandir el prefijo `DLCx/Objects/Mechs`
correctamente; si se toca, verificar que arrastra TODO el contenido de cada
DLC, no solo `Objects` (base game).

**Estructura real desde esta sesión**: `modelsmw5/` tiene DOS subcarpetas
de chasis, no una carpeta plana:

- `modelsmw5/activos/<Chasis>/` — chasis con ficha real en `mech_templates`
  (comparado por nombre normalizado contra la base de datos, incluyendo
  los pares nombre-clan/designación-IS conocidos: `MistLynx`↔`Koshi`,
  `Nova`↔`Black Hawk`, `Executioner`↔`Gladiator`). Estos son los únicos
  que tiene sentido llevar por el pipeline completo — sin ficha no hay
  con qué jugarlos.
- `modelsmw5/extra/<Chasis>/` — el resto (mayoría Clan sin ficha
  sincronizada: Adder, DireWolf, Ebonjaguar, FireMoth, Gargoyle,
  Hellbringer, Incubus, KitFox, Maddog, Naga, Nightgyr, ShadowCat,
  Stormcrow, Summoner, Sunder, TimberWolf, Warhawk; más Bullshark,
  Corsair, Linebacker, Roughneck sin match encontrado bajo ningún
  nombre alterno; y `Tutorial`, que no es un chasis real).
- `modelsmw5/_Common/` se queda en la raíz, FUERA de ambas — lo
  referencian `.blend` de chasis en cualquiera de las dos carpetas
  (rutas absolutas, ver más abajo), moverlo rompería los enlaces de
  todos a la vez.

**Trampa real si se re-organiza esto otra vez**: Blender guarda las rutas
de imagen EXTERNAS como rutas ABSOLUTAS (confirmado inspeccionando
`Bushwacker.blend` con `bpy` — `D:\Portfolio\mesa\MesaRPG\modelsmw5\
Bushwacker\...`, no rutas relativas `//`). Mover la carpeta de un chasis
que YA tiene `.blend` con texturas importadas (cualquiera bajo
`activos/` con trabajo real, no solo el placeholder) sin re-enlazar dejó
esas imágenes en rojo/perdidas. Fix real usado (headless, sin abrir la
UI): recorrer `bpy.data.images`, para cada `img.filepath` que empiece por
el prefijo viejo sustituirlo por el nuevo, comprobar con
`bpy.path.abspath()` + `os.path.exists()` que ninguna queda perdida, y
`bpy.ops.wm.save_as_mainfile()` para persistir.

## 3. Import en Blender

### Addon UEFormat

El addon YA está instalado (`io_scene_ueformat`, en
`%APPDATA%/Blender Foundation/Blender/5.2/scripts/addons/`). Si se corre
Blender en modo `--factory-startup` (recomendado para scripts, evita
arrastrar basura de sesiones anteriores), hay que **habilitarlo a mano en
cada script**:

```python
bpy.ops.preferences.addon_enable(module="io_scene_ueformat")
```

### Import de un `.uemodel`

El operador real es `uf.import_uemodel` (NO `uf.import_ueformat`), y
**no** acepta `filepath` — acepta `directory` + `files` (lista de dicts
`{"name": "archivo.uemodel"}`), el patrón estándar de Blender para
importadores multi-archivo:

```python
bpy.ops.uf.import_uemodel(
    directory=r"D:\...\Model\Cockpit" + os.sep,
    files=[{"name": "Bushwacker_Cockpit_SKM.uemodel"}],
)
```

Cada import crea SIEMPRE un Armature nuevo + un Mesh nuevo (nunca
reutiliza un armature existente, ni para mallas simples). El mesh
resultante suele tener escala 0.01 (cm de UE → metros de Blender) por
defecto.

### Rotación

El chasis suele importar rotado 90° en Z. Rotar y aplicar transform
(`bpy.ops.object.transform_apply`) — **cuidado**: aplicar el transform dos
veces (por ejemplo relanzando el mismo script "para ver el log completo")
acumula la rotación (-90 → -180) y duplica todo lo que el script monte
después. No relanzar un script de montaje sin comprobar antes si ya se
ejecutó.

### Montaje de armas

Cada arma es su propio `.uemodel` con su propio mini-Armature. Se monta
parenteando el armature raíz (el objeto con `parent is None` tras
importar) al hueso correspondiente del armature principal, vía
`parent_type="BONE"`.

**Convención de nombres obligatoria** para que el sistema de
visibilidad/loadout de la app funcione (`weaponMountOfMesh` en
`Mech3D.tsx`): renombrar cada arma montada a

```
chrMdlWeap_<chasis>_<localización>_<visual>_<slot>
```

- `<localización>`: debe contener uno de los hints de `LOCATION_NAME_HINTS`
  (`left_arm`, `right_arm`, `left_torso`, `right_torso`, `center_torso`,
  `left_leg`, `right_leg`, `head`) como substring — con guion bajo.
- `<visual>`: debe ser exactamente uno de los tokens de
  `WEAPON_VISUAL_BUCKETS` (ej. `ac10`, `lbx20`, `ppc`, `missile10`,
  `narc`, `gauss`, `laser` genérico para cualquier tamaño de láser...).
  Si el arma que se está montando no tiene bucket todavía, añadirlo a
  `WEAPON_VISUAL_BUCKETS` en `Mech3D.tsx` ANTES de exportar, o esa arma
  quedará invisible para siempre (`weaponMountOfMesh` devuelve `null` si
  el token no está en la tabla).
- `<slot>`: el código de punto de montaje del `.uemodel` original (p.ej.
  `bh1`, `eh2`, `mh1`) — todo lo que vaya DESPUÉS del token `<visual>` en
  el nombre se trata como parte del slot.

### Detección automática del cañón/punto de disparo

`computeWeaponMuzzlePoint` (`Mech3D.tsx`) intenta encontrar solo, sin
click manual, qué extremo de la malla del arma es el cañón — mide la
caja delimitadora del arma, coge su eje más largo, y elige el extremo
correcto. La regla para elegir el extremo NO es "el más lejano del hueso
de montaje" (falla si el arma tiene un receptor/culata grande detrás del
punto de montaje) — es **la dirección real hacia delante del chasis**:
el cañón siempre apunta hacia delante, nunca hacia atrás.

Esa dirección "adelante" se calcula (`detectChassisForward`) a partir del
hueso `Cockpit` frente al hueso `Torso_Pitch` (o `Pelvis`/`Root` si no
existe) — la cabina siempre está desplazada hacia delante del centro del
torso, por diseño (el piloto tiene que ver hacia delante). Es un hecho
físico real del chasis, no una convención de ejes que pueda variar entre
exportaciones (a diferencia de un eje fijo tipo "siempre +Z" — este mismo
fichero ya se topó con chasis exportados con el eje de avance invertido:
ver el comentario de `computeWalkGaitCurve` sobre "veo literalmente las
partes de atrás alante"). Si el chasis no tiene hueso `Cockpit` (pipeline
antiguo), esta función devuelve `null` y todo cae al comportamiento
anterior sin cambios — cero riesgo de regresión ahí.

Para un chasis nuevo: si el esqueleto no usa el nombre `Cockpit` para ese
hueso, hay que añadir el nombre real a la lista de candidatos dentro de
`detectChassisForward`.

## 4. El sistema de materiales real (no inventarlo a ojo)

### Dónde está la receta real

El fichero clave es el **SKN** de cada chasis:
`modelsmw5/<Chasis>/Skins/<Chasis>_Default_SKN.json` (o `_Hero_SKN.json`,
etc. para otras skins). Su `UnitSkin.MechMaterialInstances` lista, por
cada `MaterialSlotName`, qué texturas usa:

- **Body**: `RGBPaintMask`, `(R)Scratch(R)(G)Dirt(G)(B)Grime(B)` (mask de
  suciedad), `NormalMap`, `MetalID`.
- **Variant**: la MISMA estructura, pero con SU PROPIO set de texturas
  (`Bushwacker_Variant_default_msk.png`, `_Variant_Wear_MSK.png`,
  `_Variant_NRM.png`, `_variant_metalID.png` — todas específicas del
  chasis, en la misma carpeta `Model/Body/Textures/`). **Esto no es una
  segunda zona de pintura del cuerpo que se pueda ignorar** — es el
  set de texturas que corresponde al slot `"Variant"` que las MALLAS DE
  ARMA llevan internamente (ver más abajo). Confirmado con datos reales
  del propio chasis, con detalle ilustrado real (paneles, remaches) —
  nada que ver con el set genérico `Clan_Generic_*`.
- **Window**: `Window_MSK`, `WindowNormal`.
- **Weapons**: normalmente apunta al material COMPARTIDO
  `_Common/SkinMaterials/Weapon_Clan_MTI` (confirmado igual en chasis
  Clan e Inner Sphere) — universal, no hay que rehacerlo por chasis.
- **DefaultPrimaryColor / DefaultSecondaryColor / DefaultTertiaryColor**:
  los 3 colores reales de pintura del chasis, en hex.

### El RGBPaintMask: cómo se lee de verdad

No es una textura de color — es una MÁSCARA. Separar por canal
(`SeparateColor`): R, G, B son el PESO (0–1) de Primary/Secondary/Tertiary
respectivamente en ese píxel. Lo que sobra (`1 - R - G - B`, clampeado)
se tiñe con un color genérico de "metal" (`MetalColorMultiplier`, normalmente
~`7F7F7F` si el MTI concreto no lo sobreescribe). El color final es la
suma ponderada de los 4 términos.

### El "MetalID": NO es un mapa continuo, es una máscara binaria

Verificado con un histograma real (`Clan_Generic_MetalID.png`): **el
99.97% de cada canal es exactamente 0.0 o exactamente 1.0**. Es una
máscara de región (qué zonas son "Black Metal" vs otro preset), no un
valor de rugosidad/metalicidad por texel. Los valores reales de cada
preset están en el propio `Weapon_Clan_MTI.json`
(`ScalarParameterValues`): `Black Metal Roughness/Metallic`, `Gun Metal
Roughness`, `Steel Roughness/Metallic`, `Base Metal Metallic`, etc. — casi
todos rondan Metallic ≈0.95 EXCEPTO "Black Metal" (≈0.06, prácticamente no
metálico — pintura/lacado, no metal desnudo). Mezclar entre dos presets
reales usando el canal R de MetalID como factor da resultados con
variación real; usar el canal directamente como si fuera "roughness/metal
en crudo" da un resultado plano y sin detalle.

Para el **cuerpo** (`Bushwacker_body_metalID.png`), en cambio, SÍ resultó
tener variación continua real — no asumir que todo MetalID es binario,
comprobarlo con un histograma antes de decidir cómo usarlo.

### El Wear/Dirt mask

`(R)Scratch(R)(G)Dirt(G)(B)Grime(B)` — canal R=arañazos, G=suciedad,
B=mugre. Combinar G y B (p.ej. `MAXIMUM`) da un buen "cuánto de sucio"
por texel. Cada chasis/zona tiene el suyo propio
(`<Chasis>_Body_Wear_MSK`, `<Chasis>_Variant_Wear_MSK`,
`Clan_Generic_Wear_MSK` para armas) — no compartir entre zonas sin
comprobar que tienen señal real (`Clan_Generic_Wear_MSK` tenía B en
0 total en un caso, hay que medir antes de asumir).

**El wear mask NO se aplica oscureciendo el color existente — se
aplica MEZCLANDO hacia un color de suciedad real.** Confirmado dos
veces (Bushwacker primero, Annihilator después, mismo error repetido
dos veces): un primer intento en cada chasis oscureció el color base
multiplicándolo por `(1 - wear*0.3)` — técnicamente "aplica el mask",
pero el resultado es casi imperceptible y el usuario lo reportó como
"no veo la capa de suciedad" en AMBOS chasis. La receta real que sí
se ve (encontrada en `fix_lighting_response_and_dirt.py` de
Bushwacker): mezclar (`MIX`, no `MULTIPLY`) el color base hacia un
tono de suciedad real —
```python
DIRT_TINT = (0.10, 0.085, 0.065)  # marrón sucio, en espacio LINEAL
wear_amount = max(canal_G, canal_B) * 0.5  # 0.5 = intensidad, ajustable
resultado = color_base * (1 - wear_amount) + DIRT_TINT * wear_amount
```
— en espacio LINEAL (si el color base sale de un PNG guardado en sRGB,
decodificar antes de mezclar y volver a codificar sRGB al guardar).
Aplicar esto tanto al Body como al Variant (mismo mask, mismo patrón,
solo cambia qué `<Chasis>_*_Wear_MSK` se usa). **Para el siguiente
chasis: aplicar la mezcla-hacia-color desde el principio, no la versión
oscurecer-por-multiplicación** — ahorra tener que volver a rehacerlo
después de que el usuario lo note.

### Dónde está cada textura en disco (rutas reales usadas en Bushwacker)

Todas las rutas son relativas a `modelsmw5/`. El patrón de carpetas se
repite igual para cualquier chasis (solo cambia `Bushwacker` por el
nombre del chasis nuevo); las de `_Common/` son literalmente las mismas
para todos.

**Cuerpo (Body + Variant, específicas del chasis)** — carpeta
`Bushwacker/Model/Body/Textures/`:
- `Bushwacker_body_default_msk.png` — RGBPaintMask del cuerpo (skin
  "default"; hay una por skin, ej. `_body_hero_msk.png`).
- `Bushwacker_Body_Wear_MSK.png` — mask de suciedad del cuerpo.
- `Bushwacker_Body_NRM.png` — normal map del cuerpo.
- `Bushwacker_body_metalID.png` — roughness/metal del cuerpo (comprobar
  si es continuo o binario antes de usarlo, ver arriba).
- `Bushwacker_Variant_default_msk.png` — RGBPaintMask del "Variant"
  (el que usan los slots `Body`/`Variant` de las MALLAS DE ARMA, no una
  segunda zona del cuerpo — ver punto 7).
- `Bushwacker_Variant_Wear_MSK.png`, `Bushwacker_Variant_NRM.png`,
  `Bushwacker_variant_metalID.png` — sus equivalentes de suciedad/normal/
  metal.
- `Bushwacker_Window_MSK.png`, `Bushwacker_Window_NRM.png` — cristal de
  cabina.

**Cabina (específica del chasis)** — carpeta
`Bushwacker/Model/Cockpit/Material/`:
- `bushwacker_cockpit_dash_CLR.png` / `_NRM.png` / `_ORM.png` — el
  salpicadero propiamente dicho (slot `LB1` de la malla de cabina).

**Cabina (compartidas entre TODOS los chasis)** — carpeta
`_Common/Cockpit/Material/`:
- `is_a_cockpit_shared_second/is_a_cockpit_shared_second_{CLR,NRM,ORM}.png`
  — slot `Greeble` (en Bushwacker era el trozo más grande de la malla,
  probablemente la carcasa exterior).
- `is_a_cockpit_tile/is_a_cockpit_tile_{CLR,NRM,ORM}.png` — slot `Trim`.
- `Tile_coordinate/Tiles/Rough_Steel_{CLR,NRM,ORM}.png` — slot
  `Basemetal` (referenciado por `RoughSteelTile_Cockpit_MTI.json`).
- El slot `Greeble_a` (`Clan_Greeble_A_MTI`, de
  `DLC7/Marketplace/ClanWeapons/...`) no llegó a exportarse esta sesión
  — si hace falta, exportar esa ruta de FModel aparte.

**Armas (compartidas entre TODOS los chasis)** — carpeta
`_Common/Textures/`:
- `Clan_Generic_MetalID.png` — máscara de región (binaria, ver punto 4)
  para el slot `Weapons`.
- `Clan_Generic_NRM.png` — normal map de armas.
- `Clan_Generic_Wear_MSK.png` — suciedad de armas.
- `Clan_Generic_Aux_Color.png` — resultó ser una máscara de acentos
  MUY dispersa (media ~0.01, casi todo negro) — NO usar como base color,
  no aporta nada útil para el look general del arma.
- `Clan_Generic_Aux_MREB.png`, `_Emissive.png`, `_GlassHeight.png`,
  `_Heatmap.png` — sin usar esta sesión, quedan pendientes de explorar
  si se necesita más detalle en el futuro.

**Receta de colores/valores reales (no una textura, pero la fuente de
verdad para los números)**:
- `<Chasis>/Skins/<Chasis>_Default_SKN.json` → colores Primary/Secondary/
  Tertiary reales del chasis.
- `_Common/SkinMaterials/Weapon_Clan_MTI.json` → valores reales de
  Roughness/Metallic por preset de metal ("Black Metal", "Gun Metal",
  etc.) y colores (`Black Metal Color`, `DirtColor`, `GrimeColor`).

## 5. LA REGLA MÁS IMPORTANTE: qué sobrevive la exportación a glTF

**`io_scene_gltf2` NO es capaz de traducir un grafo de nodos "vivo" salvo
en los patrones más simples.** Esto se descubrió y se volvió a pisar
varias veces esta sesión — documentarlo aquí para no repetir el error.

Patrones **confirmados rotos** (el exportador los ignora en silencio y
mete la textura más cercana que encuentre, sin avisar — hay que
verificar SIEMPRE decodificando el `.glb` exportado, no fiarse del
render en Blender):

- Cualquier grafo con **más de una textura mezclándose con matemáticas**
  alimentando Base Color (el sistema RGBPaintMask completo, por ejemplo).
- Un nodo **Mix** (`ShaderNodeMix`, tipo FLOAT o RGBA) en la cadena de
  Roughness/Metallic — aunque sea un blend simple entre dos constantes.

Patrón que **parece funcionar pero no siempre** (usar con cautela y
**verificar siempre**): `SeparateColor` de una textura → directo a un
socket, o con como mucho un `ShaderNodeMath` simple de por medio. A veces
sobrevive, a veces no (varió entre pruebas) — no confiar en él a ciegas.

### Los dos patrones que SÍ funcionan siempre

**A) Hornear con Cycles (para grafos ligados a la geometría de UN
objeto)** — válido para materiales de un solo mesh (el Body, por
ejemplo):
1. Conectar el grafo vivo a Base Color.
2. Crear una imagen nueva vacía + nodo Image Texture con esa imagen,
   dejarlo **activo/seleccionado** (Blender hornea sobre el nodo activo).
3. Motor = Cycles. Render Properties → Bake. Tipo `Diffuse`, marcar solo
   **Color** (desmarcar Direct/Indirect) — o el truco de meter un
   `ShaderNodeEmission` de por medio y hornear tipo `Emit` (mismo
   resultado, evita depender de cómo esté iluminada la escena).
4. Guardar la imagen, reconectarla a Base Color con un link directo,
   borrar el grafo vivo.

**B) Precalcular en Python/numpy (para grafos compartidos por VARIOS
objetos con distinto UV)** — obligatorio para el material de armas
(Weapons/Weapon_Paint), porque cada arma tiene su propio UV sobre el
MISMO material compartido; un bake de Cycles solo captura la huella UV
del objeto contra el que se hornea, dejando el resto del atlas en negro.
Cargar las texturas fuente con `bpy.data.images...pixels.foreach_get`,
hacer la mezcla en numpy (misma fórmula que el grafo de nodos), escribir
con `foreach_set` + `image.save()`, y enlazar esa imagen resultante
directamente. Esto es lo que se usó para: el ORM de armas (roughness/
metal desde MetalID + wear), el Base Color de Weapons y de Weapon_Paint
(receta RGBPaintMask completa, en numpy en vez de nodos).

**Regla práctica**: si el material se aplica a un solo objeto → hornear
con Cycles. Si se comparte entre varios objetos con UV distinto →
precalcular en numpy. Nunca dejar un grafo vivo con más de una textura
alimentando Base Color, Roughness o Metallic en el material final.

## 6. UVs fuera de [0,1]: NO es un bug, es trim-sheet

Si un mesh importa con UVs que se salen mucho de [0,1] (ej. cabina:
U de -5.18 a 7.82), **no lo remapees/estires a [0,1]** — eso rompe el
mapeo real. Es la convención normal de Unreal para texturas "trim sheet"
(un atlas de detalles reutilizado, donde cada panel indexa una zona
distinta repitiendo el mismo `[0,1]` varias veces vía wrapping). La
solución correcta es dejar las UVs como vienen y poner el nodo Image
Texture en modo `extension = 'REPEAT'`.

Si en algún momento se estropean las UVs originales (por un intento
previo de "arreglarlas"), se recuperan re-importando el mismo `.uemodel`
en un objeto temporal (mismo recuento de vértices/loops garantizado) y
copiando `uv_layers["UV0"].data[i].uv` 1:1 al objeto real.

## 7. Bug de exportación: mallas con 2+ material slots se parten en glTF

Si un mesh tiene caras repartidas en 2 o más material slots (algo
NORMAL — las armas MW5 traen de fábrica hasta 3 slots: `Body`, `Variant`,
`Weapons`, en ese orden, confirmado contra varios `_SKM.json` reales),
Blender a veces exporta un **nodo vacío** con el nombre correcto del
objeto + los meshes reales como HIJOS con nombres sin renombrar
(`Weapon_Mech_..._SKM_LOD0`). El sistema de visibilidad de la app
(`assignWeaponMountMeshes` en `Mech3D.tsx`) tiene que buscar el nombre
correcto en CUALQUIER objeto de la jerarquía (no solo en los que son
`Mesh`), y ocultar/mostrar por ahí — la visibilidad en three.js cae en
cascada a los hijos, así que ocultar el wrapper vacío basta. Para
`computeWeaponMuzzlePoints` (que necesita geometría real, no un nodo
vacío) hay un helper `firstMeshDescendant` que baja un nivel a buscar el
mesh de verdad. Esto YA está arreglado en el código compartido — no hace
falta tocarlo por chasis, pero si un chasis nuevo muestra "las armas
grandes no aparecen nunca" es la primera sospecha.

### Los slots reales del arma: `Body` / `Variant` / `Weapons`

Confirmado contra el JSON original de varias armas (no solo Bushwacker):
casi todas traen 2 slots (`Variant`, `Weapons`) o 3 (`Body`, `Variant`,
`Weapons`), en ESE orden consistente. `Weapons` es el metal desnudo
(usar el material compartido `Weapon_Clan_MTI`/`Clan_Generic_*`).
`Body`/`Variant` son la carcasa PINTADA — a veces son la MAYORÍA del
arma (un lanzamisiles puede ser 278 de 444 triángulos "Variant"), no un
detalle menor. Usan la MISMA receta de pintura del chasis (RGBPaintMask
del punto 4, colores reales del SKN) — construir un material aparte
(`<Chasis>_Weapon_Paint`) con esa receta y asignarlo al slot 0 (y 1, si
hay 3 slots), dejando `Weapons` solo para el último slot.

## 8. Ajuste de PBR sin mapa de entorno (el error más repetido esta sesión)

La escena de la app (`MechLabView.tsx`) solo tiene un `ambientLight` +
un `directionalLight`, **sin environment/reflection map**. Esto significa:

- **Metalicidad alta sin mapa de entorno aplasta la respuesta difusa** —
  no hay nada que reflejar, así que cualquier fracción metálica se come
  brillo sin devolver nada a cambio. Un material "razonable" en Blender
  (con su propio World HDRI) puede salir casi negro en la app.
- La fórmula útil para estimar cómo se va a ver ANTES de exportar:
  `brillo_efectivo ≈ luminancia(base_color) × (1 - metallic)`.
- **Medir, no adivinar**: decodificar el PNG final con numpy
  (`0.2126*R + 0.7152*G + 0.0722*B`, media) y comparar contra una
  referencia que ya se sabe que se ve bien (el Body horneado, por
  ejemplo) en vez de ajustar valores a ojo y volver a exportar en bucle.
  Un material de "metal negro" NO tiene que aproximarse a 0 — tiene que
  quedar visiblemente más oscuro que el cuerpo pintado pero seguir
  siendo LEGIBLE (brillo efectivo bajo pero no nulo, roughness con
  variación real en vez de un valor plano).

## 9. Otros bugs de la app que afectan a CUALQUIER chasis nuevo con mapas reales

Estos ya están arreglados en el código compartido (`Mech3D.tsx`), pero
hay que saber que existen si un chasis nuevo "pierde" su normal map o su
color al añadirlo:

- **`useMechPbr`** aplica un detalle PBR genérico (textura de cromo
  reutilizada) a CUALQUIER mesh sin mapas reales — pensado para los
  placeholders que nunca tuvieron normal/roughness/metalness propios.
  Si el chasis nuevo SÍ trae mapas reales, `useMechPbr` los respeta
  automáticamente (comprueba `mat.normalMap`/`roughnessMap`/
  `metalnessMap` antes de sobreescribir) — no hace falta tocar nada,
  pero si algo se ve "genérico" en vez de con el detalle real, es la
  primera sospecha.
- **El tinte de facción** (`Anotar armas`/color de equipo) resetea
  `mat.color` a blanco antes de aplicar el tinte — inofensivo para
  materiales con textura (el blanco no cambia nada al multiplicar), pero
  destructivo para un material sin textura (solo `baseColorFactor`
  plano) porque ESE factor plano ES el color real. Ya está arreglado
  (usa un snapshot del color real la primera vez), pero si un material
  nuevo sale "lavado hacia blanco" en la pestaña de anotar armas, es la
  causa más probable.

## 10. Loadout real y visibilidad en el juego (obligatorio, no solo MechLab)

Tener el modelo 3D bien texturizado NO basta — sin datos de loadout real,
el sistema de visibilidad oculta TODAS las armas por defecto (contrato:
"sin match, mostrar `blank`").

1. **Sincronizar el catálogo real**: el chasis tiene que existir en la
   tabla local `mech_templates` (viene de la base de datos pública de
   MegaMek). Comprobar/sincronizar variante por variante:
   ```python
   from app import db, mech_import, mech_templates
   db.init_db()
   units = mech_import.list_all_units()
   variantes = [u for u in units if 'chasis' in u['file'].lower()]
   for u in variantes:
       parsed = mech_import.import_mech(u['file'])
       chassis = parsed.pop('chassis'); model = parsed.pop('model')
       mech_templates.upsert_template(u['file'], chassis, model, parsed['tonnage'], parsed)
   ```
2. **Revisar `WEAPON_VISUAL_BUCKETS`** contra los nombres de arma reales
   del loadout sincronizado — cualquier arma sin bucket (ej. "Plasma
   Rifle", "MML 5" no existían en el catálogo visual de Bushwacker) hay
   que mapearla al visual más parecido que SÍ exista como malla montada,
   o se queda invisible en ese hardpoint sin avisar.
3. **HexMap/FirstPersonView tienen que recibir `mechs`** — el prop
   `weapons` de `<Mech3D>` solo se rellena si el componente que lo
   renderiza (HexMap, y su propia instancia dentro de FirstPersonView)
   recibe la lista de mechs reales y hace el lookup por `unit.mech_id`.
   MechLabView ya lo hacía; TableView/GMView/FirstPersonView necesitaron
   el cableado añadido explícitamente — comprobar que las 3 rutas de
   juego reales pasan `mechs`, no solo la vista de desarrollo.

## 11. Checklist para el siguiente chasis

1. Exportar con FModel (UEFormat) — chasis + `_common` relevante.
2. `organize_mw5.py` para fusionar en `modelsmw5/<Chasis>/`.
3. Importar cuerpo, rotar, aplicar transform UNA vez.
4. Leer el `_Default_SKN.json` — anotar colores Primary/Secondary/Tertiary
   y qué textura usa cada slot (Body/Variant/Window/Weapons).
5. Comprobar con histograma si el MetalID de este chasis es binario
   (máscara de región) o continuo (dato real) — cambia cómo se usa.
6. Construir Body: RGBPaintMask real + 3 colores + metal sobrante,
   mezclado con wear, horneado con Cycles (patrón A).
7. Montar armas con la convención de nombres `chrMdlWeap_...`, añadir
   buckets nuevos a `WEAPON_VISUAL_BUCKETS` si hace falta.
8. Para cada arma con 2-3 slots: separar `Weapons` (material compartido
   Weapon_Clan_MTI, reutilizable tal cual) de `Body`/`Variant`
   (construir `<Chasis>_Weapon_Paint` con la receta de pintura del
   chasis, precalculado en numpy — patrón B).
9. Cabina: revisar cuántos slots de material trae realmente (Bushwacker
   tenía 5: dashboard propio + 4 compartidos de `_common/Cockpit/` que
   casi nadie mira) — no dar por hecho que el dashboard es el único.
9b. Cristal de la cabina (`_CockpitGlass`): comprobar en Blender que el
    objeto usa `Armature` deform (no `parent_type: 'BONE'`) ANTES de
    exportar, o saldrá mal orientado en el glTF pase lo que pase en el
    editor — ver sección 13 completa (material real, qué es la textura
    `_Window_MSK`, y el fix de re-parenting) antes de darlo por perdido
    y ocultarlo sin más como Bushwacker.
9c. **Justo antes de exportar** (después de montar TODAS las armas Y
    TODAS las animaciones): resetear el esqueleto principal a rest pose
    de verdad (`bpy.ops.pose.transforms_clear()` con todos los huesos
    seleccionados) — importar animaciones deja huesos con pose residual
    aunque el active action esté a `None` y las NLA tracks muteadas. Ver
    12b, es el bug más caro de esta sesión y NO se nota mirando el
    `.blend` en Blender (solo comparando contra el `.glb` exportado).
10. Exportar `.glb`, decodificar el JSON del glTF resultante y verificar
    a mano que cada material tiene `baseColorTexture`/
    `metallicRoughnessTexture`/`normalTexture` reales y no un fallback
    plano sospechoso.
10b. **Verificación de posición obligatoria**: comparar, para cada arma,
    la posición mundial calculada directamente en el `.blend` fuente
    contra la misma malla reabierta desde el `.glb` recién exportado en
    una escena de Blender nueva — diferencia media esperada < 0.1
    unidades. Ver la receta completa en 12b. NO fiarse de que "en
    Blender se ve bien" — ese es precisamente el síntoma del bug 12b.
10c. **Verificación de nombres obligatoria**: contar cuántos nodos del
    `.glb` exportado tienen un nombre que empieza por el prefijo de arma
    (`chrMdlWeap_<Chasis>`) y comprobar que coincide EXACTAMENTE con el
    número real de armas montadas — un múltiplo (×2, ×3...) es la firma
    del bug de la sección "BUG CRÍTICO Nº2" más abajo (el wrapper-mini-
    armature de cada arma comparte el prefijo con su malla).
11. Medir luminancia de cada textura de color final y compararla con el
    Body ya calibrado, en vez de ajustar a ojo.
12. Sincronizar `mech_templates` para todas las variantes reales del
    chasis, y confirmar que HexMap/FirstPersonView reciben `mechs`.
12b. **Probar CADA variante real del chasis en MechLab, no solo la
    primera** (Annihilator tiene 12 variantes ANH-1A…C-2, todas con
    loadouts distintos) — un nombre de arma real del catálogo
    (`app/systems/battletech/weapons.py`) sin entrada exacta en
    `WEAPON_VISUAL_BUCKETS` (`Mech3D.tsx`) deja ESE mount concreto
    siempre oculto/en blanco sin avisar, pero solo se nota si esa
    variante concreta se prueba. Extraer el set de nombres de arma
    reales que usa el chasis nuevo (consultar `mech_templates` en
    `mesarpg.db`) y cruzarlo contra las claves de `WEAPON_VISUAL_BUCKETS`
    ANTES de dar el chasis por terminado, no confiar en probar una sola
    variante al azar.
13. Si el chasis trae animaciones propias, revisar la sección 12
    (Animaciones) antes de darlas por conectadas.
14. **Minificar el `.glb` antes de darlo por terminado** (sección 14) —
    el export en crudo de Blender ronda 90MB+, inservible para el juego
    tal cual. Guardar backup del `.blend`/`.glb` sin comprimir primero.

## 12. Animaciones — convención de nombres y cómo se conectan

Bushwacker fue también el primer chasis en traer sus propias 84
animaciones reales (Idle/Walk/Run/Turn/Cojera/Salto/Hit/Aim/Puñetazo...),
en vez de heredar las prestadas de Atlas. La app las resuelve por NOMBRE,
no por índice — `MW5_CLIP_SUFFIXES` en `Mech3D.tsx` mapea cada nombre de
bookkeeping interno (`Idle`, `Walk`, `HitZone*`, `ArmLeftAim*`...) a un
sufijo real, y `resolveClipKeyForSuffix` busca qué clip del chasis termina
en ese sufijo.

**Convención real verificada en Bushwacker**: `<PREFIJO>_<Acción>_ANI`
(ej. `BSW_WalkForward_Straight_ANI`), donde `<PREFIJO>` es un código corto
del chasis (`BSW`, no "Bushwacker"). Un chasis nuevo casi seguro trae su
propio prefijo distinto — no hay que tocar `MW5_CLIP_SUFFIXES` para eso
(el matching es por sufijo, el prefijo da igual), solo verificar que la
PARTE DESPUÉS del prefijo sigue el mismo patrón de nombres. Si no
coincide, no resuelve nada — sin crash, sin regresión, el chasis
simplemente se queda sin esa animación concreta (mismo contrato "best
effort" que el resto de este pipeline).

**Trampas ya encontradas, a comprobar en el siguiente chasis antes de
asumir que "ya funciona":**

- **Colisión con primera persona**: los clips `_FP_*` (ej.
  `BSW_FP_WalkForward_Straight_ANI`) casi siempre TERMINAN en el mismo
  sufijo que su gemelo de tercera persona (`BSW_WalkForward_Straight_ANI`)
  — `resolveClipKeyForSuffix` ya excluye cualquier clip con `_FP_` en el
  nombre, pero si el chasis nuevo usa OTRA marca para primera persona (no
  `_FP_`), hay que ampliar esa exclusión o el sistema puede escoger el
  clip equivocado según el orden de iteración, no según intención.
- **Huecos de despegue/aterrizaje de salto**: Bushwacker solo trae UNA
  pose de salto (`Jumpjetting_Neutral_ANI`), sin clip propio de
  despegue/aterrizaje — sin gestionarlo, el mech se queda congelado en su
  pose anterior durante el despegue y clavado en la pose de vuelo después
  de aterrizar (bug real, encontrado en producción). Ver el fallback de
  `Despegar`/`Aterrizar` hacia `Saltar` en el propio `sync()` de
  `Mech3D.tsx` — comprobar si el chasis nuevo SÍ trae clips dedicados
  (entonces no hace falta el fallback) antes de asumir que hace falta el
  mismo parche.
- **Inconsistencias de mayúsculas/orden de palabras dentro del MISMO
  chasis**: Bushwacker tiene `BSW_ArmLeft_AimUp_ANI` pero
  `BSW_Armleft_AimLeft_ANI` (con "l" minúscula, un typo real de
  exportación) y `BSW_LeftArm_AimNeutral_Montage` (orden de palabras
  invertido Y sufijo `_Montage` en vez de `_ANI`) — no dar por hecho que
  los ~80 nombres de un chasis siguen el patrón de forma perfectamente
  uniforme; verificar la lista completa antes de generar sufijos por
  fórmula.
- **Reacciones a impacto por zona**: si existen, siguen el patrón
  `Hit<Zona>_<Eje><Signo>_ANI` con zonas tipo `Torso`/`Hips`/`LeftLeg`/
  `RightLeg` (no las 8 localizaciones del juego) y ejes `Pitch`/`Roll`/
  `Yaw` — comprobar qué zonas/ejes trae realmente el chasis nuevo antes de
  asumir que cubre las mismas combinaciones que Bushwacker (Bushwacker no
  tiene reacción de impacto para brazos, por ejemplo).

### 12b. BUG CRÍTICO: importar animaciones deja el esqueleto "congelado" en una pose intermedia — resetear a rest ANTES de exportar

**El bug más caro encontrado en toda la sesión de Annihilator** (horas de
investigación equivocada: se sospechó primero de un problema de
texturas/slots de material, luego de la jerarquía de huesos internos del
arma, luego de un bug de exportación de skinning — ninguna de las tres
era la causa real).

**Síntoma real**: las armas se ven bien colocadas en el propio `.blend`
(Blender evalúa la pose EN VIVO y el resultado parece perfecto), pero al
exportar a `.glb` y volver a abrirlo (en Blender limpio, en three.js, en
MechLab — da igual el visor) las armas aparecen desplazadas varios
metros de su sitio real, peor cuanto más lejos esté su hueso de montaje
del `Root` en la cadena cinemática (brazos ~12 unidades mal, torso ~2
unidades mal, con un chasis de referencia de ~12 unidades de ancho —
un desplazamiento MASIVO, no un matiz).

**Causa real**: `armature.animation_data.action = None` (usado tras
importar cada `.ueanim` para no pisar la siguiente animación —
ver punto 12/sección de animaciones) **detiene la evaluación** de esa
acción pero **NO resetea los valores de pose** de los huesos
(`pose_bone.location` / `pose_bone.rotation_quaternion`) a la identidad.
Importar ~87 animaciones una detrás de otra, cada una dejando el hueso en
el último frame que tocó, termina con el esqueleto "congelado" en una
pose intermedia real (rodillas dobladas, cadera rotada — confirmado con
huesos de PIERNA con rotación de pose no nula, que no tienen nada que
ver con brazos/armas, prueba de que es un problema del esqueleto entero,
no de las armas en sí). Mutear los NLA tracks (`track.mute = True`,
igual que hace el script de Bushwacker) **NO arregla esto** — el
problema no es qué track está activo, es que los VALORES de pose de cada
hueso individual quedaron sucios independientemente de las NLA tracks.

El cuerpo (skinned mesh) se ve idéntico en `.blend` y `.glb` a pesar de
esto porque el skinning siempre resuelve correctamente contra la bind
pose, sea cual sea la pose actual — el bug solo afecta a objetos
bone-parented de forma zero-offset (las armas), cuya posición final SÍ
depende de qué pose tenga el hueso destino en el momento de
evaluar/exportar.

**Fix aplicado** (una sola vez, tras montar TODAS las armas y TODAS las
animaciones, justo antes de exportar):
```python
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")
```
Verificar con 0 huesos de pose no-identidad antes de exportar (recorrer
`armature.pose.bones`, comprobar `location`/`rotation_quaternion` contra
identidad).

**Para el siguiente chasis**: añadir este paso al script de importación
ESTÁNDAR, inmediatamente después del bloque de importación de
animaciones (punto 4b del pipeline) y antes de guardar/exportar — no
esperar a que aparezca el síntoma. Si alguna corrección manual de
posición de arma (tipo la del hardpoint de cabeza, ver más abajo) se
calculó ANTES de este reset usando `pose_bone.matrix` (pose actual, no
rest), hay que recalcularla DESPUÉS del reset, contra la pose ya limpia
— si no, esa corrección concreta queda desfasada por el mismo tipo de
error a menor escala.

**Cómo verificar que NO está pasando** (antes de dar un chasis por
exportado): comparar la posición mundial de cada malla de arma calculada
DIRECTAMENTE en el `.blend` contra la misma malla reabierta desde el
`.glb` recién exportado en una escena de Blender limpia — deben coincidir
casi exactamente (diferencia media < 0.1 unidades en este pipeline). Si
hay una discrepancia sistemática que crece con la distancia del hueso al
Root, es este bug. Confiar en el propio `.blend` como "se ve bien" NO es
suficiente — el bug es precisamente que el `.blend` se ve bien y el
`.glb` no.

## 13. Cristal de la cabina (`_CockpitGlass`) — por qué NO se renderiza y qué hacer con el siguiente chasis

Bushwacker fue el primer chasis con su propio mesh de cristal de cabina
(`<Prefijo>_Cockpitglass_STM`). Tras una sesión entera intentando que se
viera bien, la decisión final fue **ocultarlo por completo**
(`obj.visible = false` en `normalizeMechInstance`, `Mech3D.tsx`, genérico
por nombre de material `/glass/i` — no hace falta tocar nada por chasis,
cualquier `_CockpitGlass` futuro se oculta solo). Documentado aquí para
no volver a perder horas con el mismo problema.

### El material real no es transparente — es un visor metálico opaco

Decodificando el material compartido real de MW5 (FModel, no algo que se
pueda adivinar por el nombre de archivo):
`Output/.../Objects/Mechs/_common/Material/Cockpit_Window_TP_MTI.json` es
el `MaterialInstanceConstant` PADRE que usa el `_CockpitGlass` de
CUALQUIER chasis. Sus parámetros reales:

- `BlendMode: BLEND_Masked` (corte opaco/invisible por píxel — **nunca
  transparencia real**, ni de lejos lo que sugiere "ventana de cristal").
- `Metalluc Window: 1.0` — completamente metálico.
- `window_roughness: 0.1` — casi espejo.
- `window_albedo` ≈ melocotón cálido (`#FFC5A5`), `window frame albedo` ≈
  gris oscuro (`#5B5B5B`) — dos colores planos, no una textura.

Es decir: el diseño real es un visor tintado y reflectante (como un
casco de soldador), no una ventana transparente. Con `metalness=1` y sin
`scene.environment` en NINGUNO de los visores de esta app (ver sección
8), un material así se ve NEGRO PLANO salvo en el ángulo exacto donde
pega un highlight especular directo — se lee como "desaparece al mirarlo
perpendicular", que es justo el reporte real que motivó investigar esto.

### La textura `_Window_MSK` del chasis no es el color — es la máscara cristal/marco

El único parámetro de textura que el material padre expone para
sobreescribir por chasis es `"WindowNormal+Mask"` (emparejado con el
`_Window_NRM` del chasis) — la propia `_Window_MSK` (textura DXT1, con
forma de islas UV con centro brillante y borde oscuro) casi seguro es esa
máscara: mezcla entre `window frame albedo` (marco) y `window_albedo`
(cristal) por píxel, NO una textura de color base. El export ingenuo de
Blender (`_Window_MSK` conectado directo a Base Color) es lo que produce
el look de manchas rojo/naranja brillante si se intenta usar tal cual.
Confirmado en vivo aislando cada lado con colores planos: los blobs
brillantes de la máscara caen sobre los LISTONES del marco, el fondo
negro cae sobre el HUECO de cristal — justo al revés de lo que parece a
simple vista.

### Bug real de exportación: el mesh del cristal sale con la rotación mal, aunque en Blender esté bien

Confirmado con un script de Blender headless
(`bpy`, ver `matrix_basis`/`matrix_world` del objeto): en Blender,
`<Prefijo>_Cockpitglass_STM` tiene **transformación local CERO** — está
parentado directamente al HUESO `Cockpit` (`parent_type: 'BONE'`, NO
skinning/deform), y toda su orientación viene del rest-pose de ese hueso.
El mesh interior de la cabina (que sí se ve bien) usa el mecanismo
correcto (`Armature` deform con vertex groups, igual que todo lo demás
del chasis). El exportador glTF oficial de Blender **no traduce bien**
un objeto parented-a-hueso (a diferencia del deform propiamente dicho):
lo exportado terminó con una rotación de 90° espuria en el nodo del
cristal más otra de 90° en su nodo padre "Cockpit" — ninguna de las dos
coincide con la orientación real del hueso. Por eso ajustar el ángulo a
mano en three.js nunca convergía (no era un desalineamiento de un ángulo
fijo, era una jerarquía de nodos completamente distinta a la que Blender
muestra).

**Fix verificado que SÍ funciona** (si el siguiente chasis necesita
mostrar su cristal de verdad): en Blender, re-parentar el objeto de
cristal de "Object → Bone" a un modifier `Armature` + vertex group con
el nombre EXACTO del hueso (`Cockpit` en este caso) al 100% de peso,
preservando `matrix_world` antes/después del cambio para no mover la
malla. Reexportado así, el nodo del cristal sale con transformación local
IDÉNTICA A CERO y `skin` real (`JOINTS_0`/`WEIGHTS_0`) — mismo mecanismo
que el resto del chasis, sin rotación espuria. Ver
`models/Bushwacker_glassfix.blend` como referencia del resultado
(archivo de trabajo, no el `.blend` de producción).

### Qué hacer con el siguiente chasis

1. Antes de exportar, comprobar en Blender el `parent_type` del objeto
   `_CockpitGlass`: si es `'BONE'` (no `'ARMATURE'` + modifier), aplicar
   el fix de re-parenting de arriba PRIMERO, o el cristal saldrá mal
   orientado en el glTF aunque en Blender se vea perfecto.
2. Si se decide intentar mostrarlo (en vez de ocultarlo como Bushwacker):
   usar los valores reales de `Cockpit_Window_TP_MTI` (metalness 1.0,
   roughness 0.1, `window_albedo`/`window frame albedo` como color plano
   mezclado por la máscara — NO como textura de color base) en vez de
   confiar en lo que exporta Blender directamente, y considerar añadir
   un `scene.environment` ligero a los visores de esta app si de verdad
   hace falta que un metal así se vea bien sin depender de un único
   ángulo de luz directa.
3. Si no compensa el esfuerzo (fue el caso de Bushwacker), simplemente
   ocultarlo — ya está resuelto de forma genérica por nombre de material,
   no hace falta ni tocar código para el siguiente chasis.

## 14. Minificar el `.glb` final — obligatorio antes de dar un chasis por terminado

El `.glb` que exporta Blender es **inservible tal cual para el juego**:
Bushwacker salió a 94MB. Casi todo ese peso (~74MB, >80%) son las
texturas — PNG sin comprimir a 4096×4096/2048×2048, varias por material
(baseColor + normal + ORM, ×9 materiales). La geometría/animaciones son
solo ~16MB del total. **Minificar SIEMPRE por texturas primero** — es
donde está el peso real, y donde el margen de mejora es mayor.

### Qué SÍ se puede tocar sin miedo (y qué NO)

La app carga cada mech con `useGLTF` de `@react-three/drei`
(`node_modules/@react-three/drei/core/Gltf.js`), que activa **Draco Y
Meshopt por defecto en TODAS las llamadas** (`useDraco`/`useMeshopt`
son `true` si no se pasan explícitamente, y ningún sitio de esta app los
pasa) — comprimir geometría/animación con `EXT_meshopt_compression` es
seguro sin tocar ni una línea del loader.

Lo que **NO** se puede tocar porque el sistema de visibilidad de armas
(`assignWeaponMountMeshes`, `WEAPON_VISUAL_BUCKETS`), la detección de
boca de cañón (`computeWeaponMuzzlePoints`), y la clasificación de zona
PBR (`mechPbrZoneOfMaterial`) dependen de nombres reales de mesh/material
sobreviviendo intactos:

- **NO fusionar mallas** (`--join`/`--flatten` en `gltf-transform
  optimize`) — cada arma es su propio mesh nombrado, mostrado/ocultado
  por nombre según el loadout. Fusionar mallas rompe ese sistema entero.
- **NO crear paletas de materiales** (`--palette`) — la clasificación de
  zona PBR y la máscara cristal/marco leen `mat.name` literal.
  Fusionar materiales en un atlas destruye esos nombres.
- **NO simplificar geometría** (`--simplify`) — el detector de boca de
  cañón necesita las posiciones de vértice reales, no una aproximación.
- **Instancing** (`--instance`) tampoco hace falta — ninguna malla de un
  mech se repite lo bastante (mínimo 5 instancias idénticas) para que
  aplique.

### Receta que SÍ funcionó (Bushwacker: 94MB → 12.4MB, verificado en vivo)

**`gltf-transform optimize` con `--texture-compress webp` falla** en
este equipo — bug real de compatibilidad entre `@gltf-transform/
functions` y `sharp@0.34.5` (`colourspace: parameter space not set`,
reproducible incluso sin redimensionar). En vez de perseguir ese bug,
mejor procesar las texturas a mano con `@gltf-transform/core` + `sharp`
directamente (ambos funcionan bien por separado, confirmado) y dejar
solo la compresión de geometría/animación al `meshopt()` de
`@gltf-transform/functions`:

```js
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, weld, resample, prune, meshopt } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'

await MeshoptEncoder.ready
await MeshoptDecoder.ready

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  // Sin esto, escribir el .glb revienta con "Cannot read properties of
  // undefined (reading 'encodeFilterExp')" — el encoder de meshopt hay
  // que registrarlo como dependencia del propio IO, no solo pasarlo al
  // transform.
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

const doc = await io.read(inPath)
await doc.transform(dedup(), weld(), resample(), prune(), meshopt({ encoder: MeshoptEncoder }))

// Texturas a mano, PNG/JPEG -> WebP, redimensionando solo lo que exceda maxSize.
for (const tex of doc.getRoot().listTextures()) {
  const image = tex.getImage()
  const mime = tex.getMimeType()
  if (!image || (mime !== 'image/png' && mime !== 'image/jpeg')) continue
  let pipeline = sharp(Buffer.from(image))
  const meta = await pipeline.metadata()
  if (meta.width > maxSize || meta.height > maxSize) {
    pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  }
  const outBuf = await pipeline.webp({ quality: 82, effort: 4 }).toBuffer()
  tex.setImage(outBuf)
  tex.setMimeType('image/webp')
}

await io.write(outPath, doc)
```

`maxSize = 2048` fue suficiente (ninguna textura de origen pasaba de
4096, así que ya es como mínimo un recorte a la mitad de resolución en
las más grandes). Con Bushwacker esto dio: texturas 71MB → 4.1MB,
total del `.glb` 94.4MB → 12.4MB (×7.6), sin ningún error de consola ni
regresión visible tras verificar en vivo (Playwright): render normal,
detección de boca de cañón funcionando (lee vértices reales, prueba de
que la geometría cuantizada sigue siendo fiel), y la pestaña "Ver rig"
mostrando el esqueleto/85 clips de animación con normalidad.

**Nota real sobre el log de `prune`**: durante `meshopt()` apareció
`prune: Removed types... Skin (100), Accessor (515)` — sonaba a que
había roto el esqueleto de 100 mallas de arma, pero era una
DEDUPLICACIÓN segura (muchas armas en distintos mounts comparten
exactamente los mismos joints/inverseBindMatrices, así que `dedup()`
las fusiona en un único `Skin` compartido) — confirmado leyendo el
`.glb` resultante: cada mesh sigue teniendo sus propios `JOINTS_0`/
`WEIGHTS_0` intactos. Si este log aparece con un número MUY distinto al
número de mallas de arma del chasis, mirar dos veces antes de asumir
que es inofensivo.

### Instalación de las dependencias (no van en el `package.json` del proyecto)

Este script es una herramienta de pipeline, no una dependencia del
juego — instalar en un directorio de trabajo aparte (scratch), no en
`rewrite/frontend`:

```bash
npm install sharp @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer --no-save
```

Instalar TODO junto en un solo comando — instalar en pasos separados con
`--no-save` hace que npm pode como "extraneous" lo instalado en el paso
anterior (bug real encontrado esta sesión, perdió tiempo real).

### Antes de dar un chasis por terminado

1. Correr el script de arriba sobre el `.glb` recién exportado.
2. Guardar backup del `.blend` + `.glb` original SIN comprimir en
   `backups/<Chasis>_pre_optimization_<fecha>/` antes de sobrescribir
   el `.glb` que sirve la app — la compresión es la última puerta antes
   de dar el chasis por listo, y si algo sale mal más adelante hay que
   poder volver al original sin re-exportar desde Blender.
3. Verificar en vivo (Playwright o a mano): render normal, "Detectar
   todos los cañones" sigue encontrando puntos razonables, pestaña "Ver
   rig" carga el esqueleto y la lista de animaciones sin errores de
   consola.

## 15. Segundo chasis (Annihilator): qué confirma que el pipeline es repetible, y qué hay que vigilar

Annihilator fue el primer chasis que repitió el pipeline completo desde
cero después de Bushwacker, expresamente para comprobar que la receta
documentada no era una solución ad-hoc de un solo chasis. Resultado:
repetible tal cual, con estas puntualizaciones nuevas.

### El parenteo de armas es SIEMPRE zero-offset — "Keep Transform" es la trampa equivocada

El punto 3 ("Montaje de armas") ya describe el parenteo correcto
(`parent_type="BONE"`, sin tocar nada más), pero merece decirlo
explícito porque es fácil caer en la trampa: **NO** calcular
`matrix_parent_inverse` para "conservar la posición de mundo actual del
arma" (la operación estándar "Keep Transform" de Blender). Se probó
directamente en Annihilator y colapsa TODAS las armas a
aproximadamente el origen del mundo tras guardar y recargar el archivo
(funciona de forma engañosa en la MISMA sesión por el caché del grafo de
dependencias, y falla solo al reabrir — fácil de no detectar si no se
verifica con guardar+reabrir).

La razón real: la malla de cada arma NO trae su posición ya en espacio
de mundo del mech completo — la trae relativa a su propio punto de
montaje (offsets pequeños tipo "el hueso `Fire00` está unos metros de su
propio origen de objeto"). Parentear con el offset a CERO (matriz
inversa identidad, el comportamiento por defecto de Blender al
parentear) hace que ese offset pequeño se SUME a la posición real del
hueso destino — que es exactamente lo que se necesita. Confirmado
midiendo directamente el bounding box de los vértices del arma montada
contra la posición del propio hueso destino.

### Huesos de montaje que NO son un `_Weapon` dedicado necesitan corrección manual por eje

Los huesos `*_Weapon` (`Forearm_Left_Weapon`, `Torso_Weapon`, etc.) están
diseñados para que el parenteo zero-offset caiga exactamente en su
sitio. Pero no todos los hardpoints tienen uno — Annihilator no tiene
`Head_Weapon`, así que sus armas de cabeza se montaron en `Torso_Head`,
que es un hueso esquelético normal (una articulación real, no un punto
de montaje pensado para esto). Resultado: las armas de cabeza aparecían
flotando lejos del modelo.

Técnica que funcionó (repetible para el próximo caso similar):
1. Medir la malla del cuerpo cerca de la zona real donde debería estar
   el arma (ej. los vértices con Z más alta para la cabeza) y comparar
   contra la posición sin corregir del arma — la diferencia por eje es
   el offset a aplicar.
2. Aplicar la corrección en ESPACIO DE MUNDO, no escribiendo directo a
   `.location` (que está en espacio de la cola del hueso, no de mundo):
   ```python
   bone_world = armature.matrix_world @ pose_bone.matrix
   desired_world = root_obj.matrix_world.copy()
   desired_world.translation.z += offset_z  # etc, por eje
   root_obj.matrix_basis = bone_world.inverted() @ desired_world
   ```
3. **Corregir un eje a la vez cuando el usuario da feedback direccional
   específico** ("está a la altura correcta pero desplazado a un lado").
   Recalcular los dos ejes desde cero en ese punto arriesga romper el eje
   que ya estaba bien — aislar y tocar solo el eje señalado.
4. Verificar con render ortográfico frontal Y lateral, no solo
   comprobación numérica — un offset "numéricamente plausible" salió
   visualmente mal en un primer intento aquí.

### El material del slot `Weapons` SIEMPRE necesita la receta real de MetalID — nunca un valor plano

Repitiendo lo del punto 7: el slot `Weapons` de cada arma no es "gris
metálico genérico" — es el mismo material compartido
`Clan_Generic_MetalID.png` + `Weapon_Clan_MTI.json` de siempre (ver
punto 4). La primera pasada de Annihilator usó un valor plano
(`roughness=0.45, metallic=0.85` fijos) como atajo "por ahora" — quedó
visualmente sin ningún detalle/variación y no coincidía con el propio
material `Bushwacker_Weapon` ya construido con la receta real. Se
corrigió reconstruyendo el nodo con el mismo patrón exacto que
Bushwacker (`SeparateColor` sobre `Clan_Generic_MetalID` → dos
`ShaderNodeMath` de tipo `MULTIPLY_ADD` para Roughness/Metallic,
LERP(Gun Metal, Black Metal) y LERP(Black Metal, Base Metal)
respectivamente, + `Clan_Generic_Wear_MSK` sumando un poco de rugosidad,
+ `Clan_Generic_NRM` para el normal) — **usando solo nodos `Math`
después de `SeparateColor`, nunca un `Mix`**, porque un `Mix` en esa
cadena hace que el auto-bake de Roughness/Metallic de `io_scene_gltf2`
caiga en silencio al textura original sin mezclar (confirmado ya con
Bushwacker, se repite aquí). Verificado tras exportar: el material
`Annihilator_Weapons` resultante SÍ trae un `metallicRoughnessTexture`
real (`Clan_Generic_MetalID`, factores en 1.0 = "usar la textura tal
cual"), no un valor plano.

**Regla para el checklist del punto 11**: si al montar armas de un
chasis nuevo se toma un atajo de material "por ahora, ya lo afino
después", NO dar el chasis por terminado sin volver a por ese atajo —
es fácil que se quede así permanentemente si no se compara
explícitamente contra el material ya construido de un chasis anterior.

### Sin `MetalID` real para Body/Variant no significa "roughness/metallic planos" — derivar uno del propio RGBPaintMask

Corrección importante al punto siguiente: que un chasis no traiga un
`_metalID` real para Body/Variant (caso real, ver más abajo) NO es
excusa para dejar Roughness/Metallic en un valor plano único para TODA
la malla — eso es exactamente lo que hizo la primera pasada de
Annihilator (roughness=0.6/metallic=0.3 fijos) y es la diferencia
visual más obvia con Bushwacker (que sí tiene su propio
`Bushwacker_body_metalID.png` real, wireado directo a Roughness/
Metallic — confirmado inspeccionando el `.blend` de Bushwacker
directamente: `bsdf.inputs['Roughness'].is_linked == True`, NO un
valor por defecto). El resultado plano se nota inmediatamente al lado
del otro chasis — sin variación de brillo entre pintura y metal
desnudo, todo con la misma respuesta especular.

Fix real (sin datos MetalID que usar): reutilizar el mismo
`RGBPaintMask` que ya construye el color (R/G/B = Primary/Secondary/
Tertiary, sobrante = metal genérico) para generar TAMBIÉN un mapa de
Roughness y otro de Metallic, asignando un valor distinto por región —
pintura más mate (roughness alto, metallic bajo), sobrante de metal
más brillante (roughness bajo, metallic más alto). No reproduce los
datos reales de MW5 (que no existen para este chasis), pero da
variación real por región en vez de un valor uniforme, y usa exactamente
las mismas fronteras de máscara que el color ya usa — consistente por
construcción. Aplicar a Body Y Variant por igual.

**Para el siguiente chasis**: comprobar SIEMPRE si `Roughness`/
`Metallic` del `Body`/`Variant` del chasis de referencia (Bushwacker)
están linkeados a una textura real o son un valor por defecto, antes de
decidir si el chasis nuevo necesita esta receta de respaldo — si el
chasis nuevo SÍ trae su propio MetalID real, usar ese en vez de
derivarlo del PaintMask.

**Trampa real al derivar el mapa de Metallic — CONFLICTO sin solución limpia todavía**:
la app usa el propio VALOR del canal Metallic ya horneado como señal
de "maskWeight" para sus sliders "Textura" en vivo
(`applyMechPbrMaskPatch` en `Mech3D.tsx` — `mix(pintado, metalDesnudo,
maskWeight)`, maskWeight = metalness muestreado). Esto crea una
tensión real sin solución limpia: el MISMO canal sirve a la vez de (a)
valor de render real (determina cuánto brilla ese texel) y (b) señal
de qué slider debería controlarlo.

- Un primer intento usó Metallic demasiado JUNTO entre región pintada
  y sobrante (0.15 vs 0.55) — el "maskWeight" nunca llegaba a un
  extremo limpio en ningún texel, así que los sliders "Cuerpo general"
  y "fuera de máscara" se mezclaban en TODAS partes en vez de
  controlar zonas separadas (reportado: "los sliders... editan la
  misma zona").
- El intento de arreglarlo separando mucho los extremos (0.04 / 0.92,
  imitando el contraste casi binario del MetalID real de Bushwacker)
  **reventó a blanco plano regiones grandes del cuerpo** (hombros,
  pecho, botas) bajo la iluminación plana de la app — la MISMA causa
  raíz que el reventón de las armas (metalicidad alta sin mapa de
  entorno), solo que esta vez en Body/Variant. Reportado: "esta peor
  imposible".
- Se revirtió a un rango estrecho y seguro (0.10–0.35) — visualmente
  correcto, SIN el reventón, pero vuelve a dejar el "maskWeight" poco
  diferenciado (mismo problema que el primer intento, sliders
  probablemente se solapan de nuevo). **Sacrificado a propósito**:
  prioridad real > separación de sliders del panel de desarrollo.

**Para el siguiente chasis, si aparece el mismo dilema**: no hay
todavía una single-texture-channel que resuelva ambos objetivos a la
vez. Posibles vías a explorar (ninguna probada en este pipeline
todavía): (1) mantener Metallic en rango seguro para el render y NO
intentar separar los sliders vía este canal — aceptar que "fuera de
máscara" no será perfectamente independiente en chasis sin MetalID
real; (2) revisar si `applyMechPbrMaskPatch` podría leer una señal de
máscara de OTRO canal (ej. el alpha del mismo PNG, o un canal de la
textura de Roughness) en vez de depender de Metallic — cambio de
código en `Mech3D.tsx`, no solo de datos, fuera del alcance de este
pipeline de importación. Verificar SIEMPRE en vivo en MechLab tras
cualquier cambio a este mapa — el render de Blender no predice de
forma fiable el reventón (ver la nota de verificación más abajo).

### `_Default_SKN.json` sin `MetalID` para Body/Variant es un caso real, no un error de export

Annihilator no tiene ni el parámetro `MetalID` en su SKN ni el archivo
en disco para Body/Variant (a diferencia de Bushwacker, que sí lo
tenía). Sí tiene `EMS` (emissive), que Bushwacker no usó. La receta de
Body/Variant (punto 4: RGBPaintMask + 3 colores + sobrante a metal
genérico + Wear) no depende de MetalID para nada, así que no hace falta
ningún cambio — simplemente no hay un canal de rugosidad/metal por zona
que ajustar más allá del roughness/metallic fijo del material final.
Confirmar con el SKN real de cada chasis nuevo qué parámetros trae antes
de asumir que todos tienen los mismos.

### Bake numpy (Patrón B) necesita aplicar sRGB a mano — Cycles ya lo hace solo

Al hornear con Cycles (`bpy.ops.object.bake(type='EMIT')` + `.save()`)
el PNG de 8 bits sale con la codificación sRGB aplicada automáticamente.
Escribir píxeles directamente con
`image.pixels.foreach_set()` + `.save()` (el Patrón B para materiales
compartidos entre muchas mallas con UVs distintos, ver punto 5) **NO**
hace esa conversión — un valor lineal `0.2117` de entrada sale
literalmente `0.2117` en el PNG guardado, sin más. Si los dos patrones
se usan en el mismo chasis (Body horneado con Cycles, Variant horneado
con numpy, como en Annihilator) y no se corrige, el resultado numpy sale
visiblemente más oscuro/apagado que el resultado Cycles aunque partan
de los mismos colores de entrada. Corrección: aplicar la curva OETF
sRGB estándar a mano antes de escribir:
```python
def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1/2.4) - 0.055)
```

### Objeto `Cube` por defecto de Blender colándose en la exportación

Al crear un `.blend` nuevo desde cero (`bpy.ops.wm.save_as_mainfile` sin
partir de un archivo existente), la escena de arranque trae su propio
cubo por defecto (`Cube`) que sobrevive a todos los imports posteriores
si no se borra explícitamente — apareció como una malla suelta más en
el glTF exportado. Revisar `bpy.data.objects` en busca de objetos
huérfanos del setup por defecto (`Cube`, `Light`, `Camera` si el propio
script no los creó) antes del export final, no solo confiar en que el
import los habrá sustituido.

### El orden real de los slots de material de un arma varía por arma — leer `MaterialSlotName` del JSON, nunca asumir por índice

Cada `_SKM.json` de arma trae `SkeletalMaterials[i].MaterialSlotName`
con el nombre REAL de cada slot (`"Body"`, `"Variant"`, `"Weapons"`,
`"MissileHead"`, más sus gemelos `_LOD` que no generan slot propio en
Blender al importar LOD0 — filtrar cualquier nombre que termine en
`_LOD` y el recuento restante coincide exactamente con
`len(mesh.material_slots)`). Asumir "slot 0 siempre es
Variant/pintura, slot 1 siempre es Weapons/metal" (lo que hizo la
primera pasada de Annihilator) es **falso en general**: hay armas con
UN solo slot que es `"Weapons"` puro (sin zona pintada), con dos slots
en el orden `Variant, Weapons` o al revés, con `Body, Variant`, y con
`Variant, MissileHead` (la cabeza del misil, sin textura propia — se
trató igual que `Weapons`, metal desnudo genérico, ya que siempre
aparece junto a `Variant` y nunca sola). Asignar por índice fijo pinta
el metal desnudo con la textura de camuflaje (o viceversa) en cualquier
arma cuyo orden real no coincida con la suposición — sale plano/blanco
sin textura reconocible. Recorrer el JSON real de cada arma y mapear por
NOMBRE es la única forma fiable; ver el recuento de combinaciones reales
en Annihilator (`Weapons` sola, `Variant+Weapons`, `Body+Variant`,
`Variant+MissileHead`, `Body` sola) para dimensionar cuántos casos hay
que cubrir.

### BUG CRÍTICO Nº2: el wrapper-armature de cada arma NUNCA debe llevar el prefijo `chrMdlWeap_` — solo la malla

**El segundo bug más caro de la sesión**, encontrado DESPUÉS de arreglar
12b (pose congelada) — con la posición ya arreglada, los modelos seguían
sin mostrar NINGÚN arma en MechLab a pesar de que la ficha lateral
(datos del backend, `getMechImport`) listaba el loadout real
perfectamente. Sospechar primero de un mismatch de nombres de arma
reales (`WEAPON_VISUAL_BUCKETS`, ver el hallazgo de `Light AC/2` más
abajo) es razonable pero NO es esto — un mismatch de bucket deja el
mount sin reclamar (se queda en su "blank"/tapa por defecto, las DEMÁS
armas equipadas siguen mostrándose bien). Esto es distinto: **NINGÚN**
arma se mostraba, en NINGÚN modelo.

**Causa real**: cada arma en Blender son DOS objetos — el wrapper
(la mini-armature, importada como raíz sin padre) y su malla hija. La
convención de nombres (`chrMdlWeap_<chasis>_<localización>_<visual>_
<slot>`) debe ir SOLO en uno de los dos (a criterio, Bushwacker lo pone
en la malla), y el otro debe llevar un nombre que la app NO reconozca en
absoluto. Un intento de arreglo intermedio en Annihilator renombró el
wrapper a `chrMdlWeap_..._rig` — el sufijo `_rig` NO evita que seguía
EMPEZANDO por `chrMdlWeap_`, así que `weaponMountOfMesh` (que hace
`tokens.find(t => knownVisuals.has(t))`, no exige que el nombre termine
justo ahí) lo seguía reconociendo como una entrada de arma válida, con
el token de slot contaminado (`"eh1_rig"` en vez de `"eh1"`). Resultado:
**cada arma registraba DOS entradas en el mapa de mounts** (una limpia
en la malla, una contaminada en el wrapper) — verificado directamente
contando nodos `chrMdlWeap_*` en el `.glb` exportado: **432 en vez de
216** (2 por arma). El slot contaminado (`"eh1_rig"`) nunca lo reclama
ningún arma real del loadout (ese slot no existe), así que
`applyMechCombatVisibility` lo deja siempre en su estado por defecto
`'blank'` → **oculta el wrapper**. Y como el wrapper es el PADRE de la
malla real en la jerarquía de three.js, ocultar el padre oculta la malla
hija con él, **sin importar que el propio `.visible` de la malla se
hubiera puesto correctamente a `true` por su propia entrada limpia** —
three.js no vuelve a mostrar un hijo cuyo ancestro está oculto.

**Sequía de pistas falsas que causó esto**: el síntoma ("no se ve nada")
es indistinguible a simple vista de un problema de posición/material, y
la ficha lateral (que lee datos del backend, no del `.glb`) seguía
mostrando el loadout real perfectamente — hace parecer que "la app sabe
qué armas hay" cuando en realidad los dos sistemas (datos de loadout vs.
geometría 3D) son totalmente independientes y uno puede estar bien
mientras el otro está roto.

**Fix**: el wrapper NUNCA debe compartir el prefijo reconocido por
`weaponMountOfMesh`/`WEAPON_VISUAL_BUCKETS`. Renombrarlo a algo
completamente ajeno a la convención (ej. `WeaponRig_<lo que sea>`, o
simplemente dejarlo con su nombre de importación crudo sin tocar, que es
lo que hace Bushwacker) — nunca una variación del propio nombre
reconocido.

**Cómo verificar que NO está pasando, ANTES de dar un chasis por
exportado** (paso obligatorio nuevo del checklist, punto 11): contar
cuántos nodos del `.glb` exportado tienen un nombre que empieza por el
prefijo `chrMdlWeap_` (o el que use el chasis) y comprobar que coincide
EXACTAMENTE con el número de armas montadas (216 en Annihilator, no
432, no ningún otro múltiplo). Un múltiplo exacto (×2, ×3...) es la
firma de este bug — cada objeto extra en la jerarquía de un arma que
también matchea el patrón de nombre cuenta como una entrada fantasma
más.

```python
# en Node/gltf-transform, contar nodos por prefijo:
weaponNodes = [n for n in doc.getRoot().listNodes() if n.getName().startswith('chrMdlWeap')]
assert len(weaponNodes) == NUMERO_REAL_DE_ARMAS_MONTADAS
```

### El `Clan_Generic_MetalID` real tiene 6 presets, no 4 — y los TRES canales R/G/B son máscaras de región independientes

Corrección a los puntos 4/7 y a la sección 15: el recuento inicial
("Black Metal", "Gun Metal", "Steel", "Base Metal") estaba incompleto.
El `Weapon_Clan_MTI.json` real trae AL MENOS 7 presets con
Roughness/Metallic propios: `Base Metal` (Metallic 0.95), `Black Metal`
(Roughness 0.7, Metallic 0.06 — el único con metalicidad baja), `Gun
Metal` (Roughness 0.31 — el más brillante), `Steel` (Roughness 2,
Metallic 0.95 — clampea a rugosidad máxima), `Matte` (Metallic 0.95),
`Aluminum` (Roughness 1.6, Metallic 0.95 — también clampea a máxima
rugosidad), `Anodized` (Metallic 0.95, con su propio `Anodized Color`
cobrizo). Casi todos rondan Metallic≈0.95 EXCEPTO Black Metal — la
diferencia visual real entre presets está sobre todo en ROUGHNESS, no
en metalicidad.

Histograma real de `Clan_Generic_MetalID.png` confirmado: **los TRES
canales R, G Y B** son máscaras binarias de región (no solo R como se
asumió en la primera pasada) — el pipeline solo usó el canal R
(LERP entre 2 de los 7 presets reales), ignorando G y B por completo.
Un chasis nuevo que necesite reproducir el material de armas con más
fidelidad tendría que leer los 3 canales y mapear cada uno a su preset
real correspondiente — no implementado todavía en ningún chasis de este
pipeline (Bushwacker y Annihilator ambos solo usan R).

### El "Gun Metal" real (R≈0, Roughness 0.31, Metallic 0.95) revienta a blanco plano en esta app — es un problema de ILUMINACIÓN, no de datos

Repitiendo el hallazgo del punto 8 pero con un caso concreto: la app
(`MechLabView.tsx`) solo tiene `ambientLight`+`directionalLight`, sin
mapa de entorno. Una región con Roughness bajo + Metallic alto (real,
no un bug del mask) actúa como un espejo casi perfecto con nada que
reflejar salvo la luz direccional — el resultado es un parche de
blanco plano ("sin textura") exactamente en los extremos de cañón de
varias armas de brazo (AC/10, PPC, Gauss, LB 10-X AC, Ultra AC/10 — el
extremo de cañón cae, por coincidencia de UV, en la región `R≈0` "Gun
Metal" del mask compartido). El mismo síntoma en Bushwacker se
manifestaba como CASI NEGRO en vez de blanco — son las dos caras de la
misma causa (metalicidad alta sin entorno que reflejar); cuál de las
dos se ve depende del ángulo de la luz direccional sobre esa geometría
concreta.

**Intentos que NO bastaron (documentados para no repetirlos a ciegas)**:
1. Clamp de Metallic con un `MULTIPLY ×0.5` posterior a todo el rango —
   apaga TAMBIÉN las zonas que ya se veían bien (metal realmente oscuro
   se queda demasiado plano), y no bajó lo suficiente el pico de 0.95
   en la zona conflictiva. Reportado por el usuario como "has roto
   armas que estaban bien, y las que estaban mal, siguen mal".
2. Floor de Roughness (`MULTIPLY_ADD ×0.6 +0.25`, la misma fórmula que
   sí funcionó en Bushwacker) sin tocar Metallic — insuficiente él solo
   para esta chasis en concreto.
3. Los sliders en vivo de MechLab ("Textura" → Rugosidad/Metalicidad
   "(metal desnudo)", ver `MECH_PBR_DEFAULTS.weapons` en `Mech3D.tsx`)
   NO tuvieron el mismo efecto que en Bushwacker — hipótesis de trabajo
   (no confirmada): esos sliders solo escalan la parte del material que
   NO tiene un mapa metallicRoughness real (`hasRealMetalness`/
   `hasRealRoughness` en `useMechPbr`), y el material de armas de este
   pipeline usa `Clan_Generic_MetalID` como textura real en TODA la
   malla — no hay "fuera de máscara" que esos sliders puedan alcanzar.
   Si esto se confirma, la implicación es que estos sliders solo sirven
   para chasis cuyo material de armas NO esté 100% controlado por un
   mapa por-texel — a verificar la próxima vez que aparezca este bug.

**Lo que sí redujo el problema** (capar los propios extremos del LERP
en vez de escalar el resultado después):
```python
# antes: roughness = R*0.39 + 0.31   (rango real 0.31-0.70)
#        metallic  = R*-0.89 + 0.95  (rango real 0.06-0.95)
# después: mismos presets, extremos capados
roughness = R*0.25 + 0.55   # rango 0.55-0.80 (antes 0.31-0.70)
metallic  = R*-0.45 + 0.55  # rango 0.10-0.55 (antes 0.06-0.95)
```
**Sin verificar en vivo por el usuario al cierre de esta sesión** — el
render en Blender no reproduce fielmente el ángulo/iluminación exacto
donde se ve el problema en MechLab, así que la única verificación
fiable es en la propia app. Si el próximo chasis presenta el mismo
síntoma: probar esta receta de extremos-capados primero (más quirúrgica
que clamp/floor posteriores), y verificar SIEMPRE en MechLab en vivo,
nunca solo con un render de Blender — el render de Blender no reprodujo
el bug aunque los datos subyacentes eran idénticos.

### Lección de verificación: un Playwright fresco puede seguir sin ver lo que el usuario ve

Varias veces esta sesión un test automatizado (browser Chromium recién
lanzado, sin caché) mostró el modelo correcto mientras el usuario, en
su propia pestaña ya abierta, seguía viendo el bug — en un caso real
era caché/HMR de Vite desincronizado tras muchos re-exports seguidos
del mismo `.glb` (confirmado: cerrar y reabrir la pestaña lo arregló),
pero en otro caso el "test automatizado limpio" resultó ser el que
tenía razón y el problema real (el bug del wrapper `chrMdlWeap_..._rig`,
ver más arriba) solo se confirmó comparando directamente el `.glb`
exportado contra el `.blend` fuente — NO fiarse de "mi test en un
browser limpio lo ve bien" como prueba definitiva de que no hay bug;
es evidencia a favor, no una prueba. Cuando el usuario reporta algo que
un test limpio no reproduce: (1) pedir que cierren la pestaña entera
(no solo refrescar) antes de descartar caché, pero (2) SIEMPRE verificar
también con una comparación directa de datos (contar nodos, diffear
posiciones `.blend` vs `.glb`) antes de concluir "es tu sesión" — la
combinación de ambas señales es la única forma fiable de saber cuál de
las dos es la causa real.

### Los `.blend` finales y los scripts del pipeline se guardan SIEMPRE en el proyecto, nunca solo en el scratchpad temporal

Regla obligatoria, no opcional: cada `.blend` final de un chasis
(`models/<Chasis>_new.blend` o equivalente) se copia a
`backups/<chasis>_<fecha>/` DENTRO del repo en cuanto queda estable —
no basta con dejarlo en `models/` (gitignored, pero al menos vive en
el proyecto) ni, mucho peor, dejar los SCRIPTS que lo construyeron
solo en el directorio de scratchpad temporal de la sesión (se pierden
al cerrarla). Ver `mw5_pipeline_scripts/` en la raíz del repo — ahí
viven los scripts reales (Python de Blender + el minificador de
Node) que de verdad funcionaron para Archer y Assassin, no solo la
prosa de este documento. Para cada chasis nuevo: guardar copia de sus
propios scripts finales ahí (o reutilizar los de un chasis ya
plantilla, editando solo lo específico) antes de darlo por terminado.

### El lote completo de `activos/`: pipeline genérico (`mw5_pipeline_scripts/build_chassis.py`) para 60 chasis + Atlas II aparte

Tras Wolverine confirmar que el pipeline de Archer/Assassin era
repetible, se generalizó a un único script parametrizado
(`build_chassis.py -- <Chasis> <Prefijo>`) que aplica TODO lo de este
documento (pose reset, wrapper sin colisión de nombre, material por
slot real, metallic capado, centrado por malla con skin) a partir solo
del nombre del chasis y el prefijo de archivo. Se corrió contra los 65
chasis de `modelsmw5/activos/` en 8 lotes de 8 (más Atlas II aparte),
verificando cada uno con: conteo de nodos `chrMdlWeap_` exportados vs.
armas montadas (detecta el bug del wrapper), consulta a `mech_templates`
para el catálogo real de armas de cada chasis (detecta huecos en
`WEAPON_VISUAL_BUCKETS`), y un screenshot Playwright en vivo por chasis
antes de dar el lote por bueno. Resultado: 60 chasis por el pipeline
genérico + Atlas II por un pipeline dedicado (ver más abajo) = 64 de
los 65 (Executioner, MistLynx y Nova no tienen NINGÚN catálogo real en
`mech_templates` — confirmado, no hay ni una variante jugable — así que
construirlos no serviría de nada hasta que esos datos existan).

**Bugs reales del script genérico encontrados y arreglados durante el
lote** (todos ya en `build_chassis.py`, no hace falta repetirlos a
mano en el siguiente chasis):

- **`--factory-startup` deja el Cube/Camera/Light por defecto de
  Blender en la escena, y se importan DESPUÉS de ellos** — el primer
  intento cogía `bpy.data.objects` filtrado por `type=="MESH"` y se
  quedaba con el Cube por error (Wolverine). Fix: limpiar la escena
  por defecto ANTES de importar, no después.
- **Hardpoints con nombre de hueso distinto según el chasis**:
  `Clavicle_Left/Right`, `Upperarm_Left/Right` (huesos reales,
  confirmado via introspección de bones), `Missile_Left/Right`
  (Highlander, sin hueso propio → cae a `Torso_Weapon`),
  `Shoulder_Left/Right` (Hunchback, sin hueso propio → cae a
  `Clavicle_*_Weapon`), `Arm_Left/Right` (Shadow Hawk, alias corto de
  `Forearm_*`). Todos añadidos a `KNOWN_LOCATION_TOKENS`/
  `BONE_BY_LOCATION`.
- **Esqueletos asimétricos**: Crusader tiene `Clavicle_Left_Weapon`
  pero NO `Clavicle_Right_Weapon` (confirmado, aunque sus loadouts
  reales SÍ usan ese lado) — `BONE_FALLBACK` intenta el hueso hermano
  más cercano (`Torso_Weapon` para Clavicle, `Forearm_*_Weapon` para
  Upperarm) en vez de perder el arma.
- **Nombres de slot de material con variantes reales**: además de
  `Weapons`/`MissileHead`/`MIssileHead` (typo original), aparecieron
  `Missilehead` (minúscula), `Arrow`/`ArrowMech`/`ArrowMech_MTI`
  (Arrow IV), `Geo`, `Missiles` — todos mapeados a la misma
  `weapons_mat`. Y un slot `"None"` literal (string, no null) que hay
  que filtrar igual que `_LOD`.
- **Cuando el JSON de un arma lista MÁS slots de los que el mesh LOD0
  realmente tiene** (visto en Marauder: `['Weapons','Variant']` pero
  solo 1 slot real, en cualquier orden), el truncamiento a ciegas daba
  resultados aleatorios según el arma. Fix: priorizar `"Weapons"` si
  está presente antes de truncar — el look metálico acierta casi
  siempre más que la pintura de cuerpo para un cañón de arma.
- **Carpeta de texturas variable**: la mayoría de chasis usan
  `Body/Materials/Textures/`, pero Kodiak, JennerIIC, ShadowHawkIIC y
  Viper (confirmados) usan `Body/Textures/` directamente — el script
  ahora prueba ambas rutas y usa la que exista.
- **Resolución de máscara inconsistente dentro del mismo chasis**:
  Rifleman tiene `Variant_Default_MSK` a 128×128 pero
  `Variant_Wear_MSK` a 2048×2048 (confirmado); Atlas II tiene su propio
  `MetalID` a 2048×2048 pero `wear_MSK`/`NRM` a 4096×4096 en las 4
  regiones. `load_pixels()` ahora acepta un `size` de referencia y
  reescala con `image.scale()` antes de extraer píxeles en vez de
  fallar con `ValueError` de broadcast de numpy.
- **Kodiak no tiene `Variant_Default_MSK` en absoluto** — solo un
  `variant_metalID` real (sin máscara de pintura por región). El
  script cae de vuelta a la máscara del `Body` para construir el
  material `Variant` en vez de fallar con `FileNotFoundError`.
- **Catálogo de armas con typos y alias reales confirmados vía
  `mech_templates`**, no inventados: `"PP Cp"` (Griffin, debería ser
  PPC), `"LBXAC 10"` (Hatamoto-Chi, debería ser LB 10-X AC),
  `"AC/10p"` (Orion). `WEAPON_VISUAL_BUCKETS` los mapea tal cual en vez
  de tocar los datos de origen.
- **Muchas familias de armas sin mesh propio** reutilizan la mecánica
  ya establecida con Plasma Rifle/MML 5/Light AC/2 (mismo lanzador
  físico, solo diferencia de stats): HVAC/10→ac10, Light AC/5→ac5,
  HAG/20 y HAG/30→gauss, Blazer Cannon→laser, Magshot→mg, Long Tom
  Cannon→ac20, y varios tamaños de misil nuevos (missile3/9/30) cuando
  existe un mesh real con ese número de tubos en al menos un chasis.
- **Ganancia real de nombrar bien el chasis en `READY_CHASSIS`**: el
  nombre canónico real en `mech_templates` a veces difiere del nombre
  de carpeta en `activos/` (ej. carpeta `Blackknight` → nombre real
  `"Black Knight"`, con espacio). `mechAssets.ts` ya tenía esto bien
  resuelto en sus entradas pre-existentes (con comentario explicándolo)
  — el bug estaba en `READY_CHASSIS`, que usé mal la primera vez.
  Lección: copiar el nombre EXACTO de `mechAssets.ts` cuando ya existe
  esa entrada, nunca rederivarlo del nombre de carpeta.

### Atlas II: un pipeline dedicado (`mw5_pipeline_scripts/build_atlas2.py`)

Atlas II (`AS7II`) es un Omnimech Clan de verdad, estructuralmente
distinto de los otros 60 chasis:

- **Cuerpo en un archivo con nombre de prefijo**, no `<Chasis>_SKM`:
  `AS7II.uemodel` directamente en `Model/Body/` (confirmado: mesh
  completo de 184.440 vértices con el mismo esqueleto estándar, no un
  fragmento).
- **4 slots de material por región** (`AS_TORSO`/`AS_LEG`/`AS_HIP`/
  `AS_ARM`), cada uno con su propio `MetalID` real + `MSK` + `NRM` +
  `wear_MSK`, en vez del par compartido `Body`/`Variant`.
- **Sin color de pintura real que aplicar**: las 2 skins disponibles
  (`Metal`, `StarLeague`) sobreescriben `RGBPaintMask` a una textura
  `Flat_Black` y no definen ningún `PaintColorPrimary/Secondary/
  Tertiary` — confirmado en el JSON de ambas. La receta honesta es
  metal genérico uniforme + roughness/metallic real desde el
  `MetalID` propio de cada región (misma fórmula segura ya probada
  para el material `Weapons`) + tinte de suciedad real desde el
  `wear_MSK` propio — sin la mezcla de 3 colores por máscara RGB que
  usan los demás chasis.
- **Armas en hardpoints genéricos, no una malla por tipo**: en vez de
  `Weapon_Mech_AS7II_<loc>_<slot>_<Arma>_SKM`, los archivos son
  `<loc>_Energy_EH1/EH2` (mismo mesh genérico para CUALQUIER arma de
  energía) y `<loc>_Ballistic` (ídem, un solo mesh sin ni siquiera
  número de slot). Confirmado vía el catálogo real completo en
  `mech_templates` (solo 4 variantes, 9 armas distintas): el mismo
  mesh se duplica una vez por cada arma real que puede ocupar ese
  hardpoint (mismos datos de malla vía `mesh.data = base_mesh_data`,
  objetos distintos con nombre `chrMdlWeap_..._<token>_<slot>`), y el
  sistema de visibilidad ya existente (que empareja por nombre) elige
  la copia correcta según el loadout de cada variante — verificado en
  vivo comparando AS7-D-H (2× ER Large Laser en el mismo brazo) contra
  AS7-D-H2 (ER PPC en vez de Laser, mismo hardpoint). Las mallas de
  `Missile<N>`/`Narc` sí son directas (un mesh real por tamaño, igual
  que en el pipeline genérico) y usan el slot `MissileHead` normal;
  solo las de Energy/Ballistic usan el slot `AS_ARM` del propio cuerpo
  (confirmado en su JSON), no un material `Weapons` aparte.
