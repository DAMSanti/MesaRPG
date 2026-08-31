# Pipeline de texturizado de mechs MW5 → MesaRPG

Documentado tras el proceso completo con el Bushwacker (primer chasis MW5
llevado a producción, sustituyendo el placeholder HBS). Estos modelos van
a sustituir a los actuales; esto es la referencia para repetir el proceso
en el resto del roster sin volver a descubrir todo esto por las bravas.

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
10. Exportar `.glb`, decodificar el JSON del glTF resultante y verificar
    a mano que cada material tiene `baseColorTexture`/
    `metallicRoughnessTexture`/`normalTexture` reales y no un fallback
    plano sospechoso.
11. Medir luminancia de cada textura de color final y compararla con el
    Body ya calibrado, en vez de ajustar a ojo.
12. Sincronizar `mech_templates` para todas las variantes reales del
    chasis, y confirmar que HexMap/FirstPersonView reciben `mechs`.
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
