# Scripts reales del pipeline MW5 → MesaRPG

Scripts REALES (no solo prosa) que funcionaron de principio a fin para
Archer y Assassin — ver `MW5_MECH_TEXTURING_PIPELINE.md` (raíz del
proyecto) para el porqué de cada paso, sus trampas y bugs ya
encontrados. Esto es la referencia ejecutable; ese documento es la
referencia explicada.

## Para el siguiente chasis

1. Copiar `examples_archer/` (o `examples_assassin/` si el chasis
   nuevo tiene armas en la cabeza) a una carpeta nueva.
2. Sustituir: nombre del chasis, prefijo de archivo (`ARC`/`ASN`/...),
   ruta de `modelsmw5/activos/<Chasis>/`, tokens de localización de
   armas (comprobar con `ls .../Weapons | sed ...`, ver el propio
   `1_import_*.py`), y los colores Primary/Secondary/Tertiary reales
   (leer del propio `<Chasis>_Default_SKN.json`, o de
   `_Common/Material/BaseMech_MTI.json` si el SKN no los sobreescribe
   — Archer y Assassin ambos usaron el compartido).
3. Ejecutar en orden: `1_import_*` → `2_build_*` → `3_assign_*` →
   render de verificación → `4_export_*` → `minify_glb.mjs` →
   backup a `backups/<chasis>_<fecha>/`.
4. Si el chasis tiene armas en `Head` sin hueso `Head_Weapon` propio:
   medir y corregir con la técnica de horneado a nivel de vértice (ver
   la sección de Assassin en el pipeline doc, punto de la cabeza) —
   NUNCA con `matrix_basis`, no sobrevive la exportación.

## `minify_glb.mjs`

Uso: `node minify_glb.mjs <entrada.glb> <salida.glb> [maxSize=2048] [quality=82]`

Requiere las dependencias instaladas junto (ver sección 14 del
pipeline doc): `npm install sharp @gltf-transform/core
@gltf-transform/functions @gltf-transform/extensions meshoptimizer
--no-save` en un directorio de trabajo aparte.

## Checklist rápido antes de dar un chasis por terminado

- [ ] Reset a rest pose ANTES de exportar (punto 12b del pipeline doc)
- [ ] El wrapper-armature de cada arma NO lleva el prefijo `chrMdlWeap_`
      (solo la malla) — contar nodos exportados == armas montadas
- [ ] Material de armas asignado por `MaterialSlotName` real del JSON,
      nunca por índice fijo
- [ ] Metallic del material de armas capado (~0.10–0.55), nunca cerca
      de 0.95 real — revienta a blanco sin mapa de entorno
- [ ] Verificar en MechLab en vivo, no solo con un render de Blender
- [ ] `WEAPON_VISUAL_BUCKETS` (`Mech3D.tsx`) cubre todos los nombres
      reales de arma del catálogo de este chasis (consultar
      `mech_templates` en `mesarpg.db`)
- [ ] Backup del `.blend` final en `backups/<chasis>_<fecha>/`
