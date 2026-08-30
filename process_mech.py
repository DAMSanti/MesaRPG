import bpy
import os
import re

MODELS_ROOT = r"D:\Portfolio\mesa\MesaRPG\models"

# Mapeo ubicacion -> hueso, confirmado empiricamente (mismo esqueleto compartido entre mechs).
# "head" se probo con j_Pitch (hueso de cabeceo) pero no se anima en los clips de movimiento
# -> las armas de cabeza no seguian el rig. Usamos j_Spine2 (torso) igual que el resto.
LOCATION_BONE_MAP = {
    "leftarm": "j_LForearm",
    "rightarm": "j_RForearm",
    "lefttorso": "j_Spine2",
    "righttorso": "j_Spine2",
    "centertorso": "j_Spine2",
    "head": "j_Spine2",
}

WEAP_RE = re.compile(r"^chrPrfWeap_([a-zA-Z0-9]+)_([a-z]+)_(.+)$", re.IGNORECASE)


def find_mech_armature():
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not armatures:
        raise RuntimeError("No hay ningun Armature en la escena. Importa primero el cuerpo del mech (File > Import > FBX).")
    if len(armatures) > 1:
        print(f"AVISO: hay {len(armatures)} armatures, uso el primero: {armatures[0].name}")
    return armatures[0]


def guess_mech_name(armature):
    # Busca en las mallas hijas del armature un nombre tipo chrPrfMech_<nombre>Base... o chrPrfComp_<nombre>_...
    candidates = [armature] + list(armature.children)
    for obj in bpy.data.objects:
        m = re.match(r"^chrPrfMech_([a-zA-Z0-9]+?)(Base|base)", obj.name)
        if m:
            return m.group(1)
    for obj in bpy.data.objects:
        m = re.match(r"^chrPrfComp_([a-zA-Z0-9]+?)_", obj.name)
        if m:
            return m.group(1)
    raise RuntimeError("No pude adivinar el nombre del mech a partir de los objetos de la escena. Renombra o dime el nombre manualmente.")


def find_models_folder(mech_name):
    for entry in os.listdir(MODELS_ROOT):
        full = os.path.join(MODELS_ROOT, entry)
        if os.path.isdir(full) and entry.lower() == mech_name.lower():
            return full
    raise RuntimeError(f"No encuentro carpeta en {MODELS_ROOT} que coincida con '{mech_name}'")


def verify_rig(armature):
    print("\n--- Verificacion de rig ---")
    ok = True
    meshes = [o for o in armature.children if o.type == 'MESH']
    if not meshes:
        # a veces las mallas no son hijas directas del armature sino que solo tienen el modifier
        meshes = [o for o in bpy.data.objects if o.type == 'MESH' and any(
            m.type == 'ARMATURE' and m.object == armature for m in o.modifiers)]
    if not meshes:
        print("AVISO: no encuentro mallas asociadas a este armature.")
        ok = False
    for mesh_obj in meshes:
        arm_mods = [m for m in mesh_obj.modifiers if m.type == 'ARMATURE']
        if not arm_mods:
            print(f"  [FALTA MODIFIER] {mesh_obj.name}: sin modifier Armature")
            ok = False
            continue
        if arm_mods[0].object != armature:
            print(f"  [MODIFIER MAL APUNTADO] {mesh_obj.name}: apunta a {arm_mods[0].object}")
            ok = False
        vg_count = len(mesh_obj.vertex_groups)
        if vg_count == 0:
            print(f"  [SIN VERTEX GROUPS] {mesh_obj.name}: 0 vertex groups, no se va a deformar")
            ok = False
        else:
            print(f"  [OK] {mesh_obj.name}: modifier ok, {vg_count} vertex groups")
    return ok


def import_and_mount_weapons(armature, weapons_root, mech_name):
    fbx_files = []
    for dirpath, dirnames, filenames in os.walk(weapons_root):
        base = os.path.basename(dirpath)
        m = re.match(rf"^chrPrfWeap_{re.escape(mech_name)}_([a-z]+)_(.+)$", base, re.IGNORECASE)
        if not m:
            continue
        location = m.group(1).lower()
        for f in filenames:
            if f.lower().endswith(".fbx"):
                fbx_files.append((location, os.path.join(dirpath, f)))

    print(f"\n--- Montando armas ({len(fbx_files)} encontradas) ---")

    mounted = 0
    unmapped_locations = set()
    failed = []

    for location, path in fbx_files:
        bone_name = LOCATION_BONE_MAP.get(location)
        if bone_name is None:
            unmapped_locations.add(location)
            continue
        if bone_name not in armature.data.bones:
            unmapped_locations.add(f"{location} (hueso '{bone_name}' no existe en este mech)")
            continue
        try:
            existing = set(o.name for o in bpy.data.objects)
            bpy.ops.import_scene.fbx(filepath=path)
            imported = [o for o in bpy.data.objects if o.name not in existing]
            roots = [o for o in imported if o.parent is None]
            for root in roots:
                root.parent = armature
                root.parent_type = 'BONE'
                root.parent_bone = bone_name
                # dejamos matrix_parent_inverse tal cual (Identidad, por ser un objeto recien
                # importado sin padre previo) para que caiga limpio en la punta del hueso.
                root.location = (0.0, 0.0, 0.0)
                root.rotation_euler = (0.0, 0.0, 0.0)
                root.scale = (1.0, 1.0, 1.0)
            mounted += 1
        except Exception as e:
            failed.append((os.path.basename(path), str(e)))
            print(f"  FALLO: {path} -> {e}")

    print(f"\nMontadas: {mounted}")
    if unmapped_locations:
        print(f"Ubicaciones sin mapear o sin hueso (revisar a mano): {sorted(unmapped_locations)}")
    if failed:
        print(f"Fallidas: {len(failed)}")
        for f, err in failed:
            print(f"  - {f}: {err}")


def animations_to_nla(armature):
    print("\n--- Pasando animaciones a NLA ---")
    if armature.animation_data is None:
        armature.animation_data_create()

    existing_action = armature.animation_data.action
    actions = list(bpy.data.actions)
    if not actions:
        print("No hay acciones/animaciones para convertir.")
        return

    track_names = {t.name for t in armature.animation_data.nla_tracks}
    count = 0
    for action in actions:
        if action.name in track_names:
            continue
        track = armature.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, start=1, action=action)
        track.mute = True  # evita que todas las animaciones se mezclen sobre la pose actual
        count += 1

    armature.animation_data.action = None
    print(f"{count} animaciones pasadas a NLA tracks (de {len(actions)} encontradas).")


def fix_materials():
    # IMPORTANTE: el exportador glTF de Blender NO mira mat.blend_method ni
    # mat.surface_render_method para decidir alphaMode - inspecciona el grafo de
    # nodos y comprueba si el socket "Alpha" del Principled BSDF resuelve a la
    # constante 1 (io_scene_gltf2/blender/exp/material/search_node_tree.py,
    # gather_alpha_info -> alpha_nav.get_constant() == 1 => OPAQUE). Si esta
    # conectado a la textura (el bug real: alpha channel enlazado sin querer)
    # exporta BLEND o MASK aunque blend_method diga Opaque en la UI.
    print("\n--- Arreglando materiales (Alpha desconectado + Emission) ---")
    fixed_alpha = 0
    fixed_emission = 0
    skipped_textured_emission = []

    for mat in bpy.data.materials:
        # deja el material tambien coherente en el viewport de Blender
        mat.blend_method = 'OPAQUE'
        mat.surface_render_method = 'DITHERED'

        if not mat.use_nodes or mat.node_tree is None:
            continue

        for node in mat.node_tree.nodes:
            if node.type != 'BSDF_PRINCIPLED':
                continue

            alpha_input = node.inputs.get('Alpha')
            if alpha_input is not None and alpha_input.is_linked:
                for link in list(alpha_input.links):
                    mat.node_tree.links.remove(link)
                alpha_input.default_value = 1.0
                fixed_alpha += 1

            emis_input = node.inputs.get('Emission Strength')
            if emis_input is None:
                continue
            if emis_input.is_linked:
                # viene de una textura/nodo, no es el bug del valor fijo baked - lo dejamos
                # pero avisamos por si acaso hay que revisarlo a mano.
                skipped_textured_emission.append(mat.name)
                continue
            if emis_input.default_value > 0.0:
                emis_input.default_value = 0.0
                fixed_emission += 1

    print(f"Materiales con Alpha desconectado de la textura y puesto a 1.0: {fixed_alpha}")
    print(f"Materiales con Emission Strength baked puesta a 0: {fixed_emission}")
    if skipped_textured_emission:
        print(f"Materiales con emission conectada a un nodo (no tocados, revisar a mano si hace falta): {len(skipped_textured_emission)}")
        for n in skipped_textured_emission:
            print(f"  - {n}")


def main():
    armature = find_mech_armature()
    mech_name = guess_mech_name(armature)
    print(f"Mech detectado: {mech_name}  (armature: {armature.name})")

    rig_ok = verify_rig(armature)
    if not rig_ok:
        print("\nAVISO: el rig tiene problemas (ver arriba). Sigo de todas formas, pero revisalo.")

    weapons_root = find_models_folder(mech_name)
    print(f"Carpeta de modelos: {weapons_root}")

    import_and_mount_weapons(armature, weapons_root, mech_name)
    animations_to_nla(armature)
    fix_materials()

    save_path = os.path.join(MODELS_ROOT, f"{mech_name.capitalize()}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=save_path)
    print(f"\nGuardado en: {save_path}")
    print("Ahora coloca las armas a mano y vuelve a guardar (Ctrl+S).")


main()
