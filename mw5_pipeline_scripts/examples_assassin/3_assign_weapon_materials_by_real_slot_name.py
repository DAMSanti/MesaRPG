import bpy
import os
import json
import re

IN_PATH = OUT_PATH = r"D:\Portfolio\mesa\MesaRPG\models\Assassin_new.blend"
WEAPONS_DIR = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\activos\Assassin\Model\Weapons"

bpy.ops.wm.open_mainfile(filepath=IN_PATH)

NAME_TO_MATERIAL = {
    "Variant": "Assassin_Variant",
    "Body": "Assassin_Variant",
    "Weapons": "Assassin_Weapons",
    "MissileHead": "Assassin_Weapons",
    "MIssileHead": "Assassin_Weapons",  # real typo found in 2 source files
}
variant_mat = bpy.data.materials["Assassin_Variant"]
weapons_mat = bpy.data.materials["Assassin_Weapons"]

fixed = 0
mismatches = []
for o in list(bpy.data.objects):
    if not o.name.startswith("WeaponRig_"):
        continue
    mesh_obj = next((c for c in o.children if c.type == "MESH"), None)
    if mesh_obj is None:
        continue
    mesh_data_name = mesh_obj.data.name
    m = re.match(r"^(.*_SKM)_LOD\d+$", mesh_data_name)
    base = m.group(1) if m else mesh_data_name
    json_path = os.path.join(WEAPONS_DIR, base + ".json")
    if not os.path.exists(json_path):
        mismatches.append(f"NO_JSON: {mesh_data_name}")
        continue
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    slot_names = [s["MaterialSlotName"] for s in data[0]["SkeletalMaterials"] if not s["MaterialSlotName"].endswith("_LOD")]
    seen = []
    for n in slot_names:
        if n not in seen:
            seen.append(n)
    slot_names = seen

    n_slots = len(mesh_obj.material_slots)
    if len(slot_names) != n_slots:
        mismatches.append(f"SLOT_COUNT_MISMATCH: {mesh_data_name} json={slot_names} blender_n={n_slots}")
        if len(slot_names) < n_slots:
            slot_names = slot_names + [slot_names[-1]] * (n_slots - len(slot_names))
        else:
            slot_names = slot_names[:n_slots]

    for i, name in enumerate(slot_names):
        mat_name = NAME_TO_MATERIAL.get(name)
        if mat_name is None:
            mismatches.append(f"UNKNOWN_SLOT_NAME: {mesh_data_name} slot={name}")
            continue
        mesh_obj.data.materials[i] = variant_mat if mat_name == "Assassin_Variant" else weapons_mat
    fixed += 1

print(f"Fixed material slots on {fixed} weapon meshes")
print(f"Mismatches/warnings: {len(mismatches)}")
for msg in mismatches[:20]:
    print("  ", msg)
print(f"Variant material users: {variant_mat.users}")
print(f"Weapons material users: {weapons_mat.users}")

bpy.ops.wm.save_as_mainfile(filepath=OUT_PATH)
print("SAVED", OUT_PATH)
