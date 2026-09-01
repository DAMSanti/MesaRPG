import bpy
import os
import re
import math

bpy.ops.preferences.addon_enable(module="io_scene_ueformat")

ROOT = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\activos\Assassin\Model"
BODY_DIR = ROOT + r"\Body" + os.sep
WEAPONS_DIR = ROOT + r"\Weapons" + os.sep
ANIM_DIR = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\activos\Assassin\Animation" + os.sep
OUT_PATH = r"D:\Portfolio\mesa\MesaRPG\models\Assassin_new.blend"

# --- 1. Import body ---
bpy.ops.uf.import_uemodel(directory=BODY_DIR, files=[{"name": "Assassin_SKM.uemodel"}])
armature = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
body_mesh = [o for o in bpy.data.objects if o.type == "MESH"][0]
print(f"Body armature: {armature.name}, mesh: {body_mesh.name}, bones: {len(armature.data.bones)}")

# --- 2. Rotation: proven Bushwacker convention (absolute -90 on Z) ---
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
body_mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
armature.rotation_euler[2] = math.radians(-90)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
print(f"After rotate+apply: armature rot={tuple(armature.rotation_euler)}")

bone_names = set(b.name for b in armature.data.bones)
print("Has Torso_Weapon:", "Torso_Weapon" in bone_names)
print("Has Forearm_Right_Weapon:", "Forearm_Right_Weapon" in bone_names)
print("Has Head_Weapon:", "Head_Weapon" in bone_names)
print("Has Torso_Head:", "Torso_Head" in bone_names)

# --- 3. Cockpit: SKIPPED (matches Annihilator/Archer's proven simpler approach) ---

# --- 4. Weapon mounting ---
BONE_BY_LOCATION = {
    "Forearm_Right": "Forearm_Right_Weapon",
    "Torso_Left": "Torso_Weapon",
    "Torso_Right": "Torso_Weapon",
    "Head": "Head_Weapon" if "Head_Weapon" in bone_names else "Torso_Head",
}
LOCATION_HINT = {
    "Forearm_Right": "right_arm",
    "Torso_Left": "left_torso",
    "Torso_Right": "right_torso",
    "Head": "head",
}

FILENAME_RE = re.compile(r"^Weapon_Mech_ASN_(.+)_SKM\.uemodel$", re.IGNORECASE)
LOCATIONS_SORTED = sorted(BONE_BY_LOCATION.keys(), key=len, reverse=True)

weapon_files = sorted(f for f in os.listdir(WEAPONS_DIR) if f.lower().endswith("_skm.uemodel"))
print(f"Total weapon files: {len(weapon_files)}")

mounted = 0
errors = []
head_weapon_names = []

for fname in weapon_files:
    m = FILENAME_RE.match(fname)
    if not m:
        errors.append(f"NO_MATCH: {fname}")
        continue
    rest = m.group(1)
    location = None
    for loc in LOCATIONS_SORTED:
        if rest.startswith(loc + "_"):
            location = loc
            remainder = rest[len(loc) + 1:]
            break
    if location is None:
        errors.append(f"NO_LOCATION: {fname}")
        continue
    parts = remainder.split("_")
    if len(parts) < 2:
        errors.append(f"BAD_REMAINDER: {fname} -> {remainder}")
        continue
    slot = parts[0]
    visual_raw = "_".join(parts[1:])
    visual = visual_raw.lower()

    target_bone = BONE_BY_LOCATION[location]
    if target_bone not in bone_names:
        errors.append(f"MISSING_BONE {target_bone} for {fname}")
        continue

    before = set(o.name for o in bpy.data.objects)
    bpy.ops.uf.import_uemodel(directory=WEAPONS_DIR, files=[{"name": fname}])
    after = set(o.name for o in bpy.data.objects)
    new_objs = [bpy.data.objects[n] for n in (after - before)]
    root_obj = next((o for o in new_objs if o.parent is None and o.type == "ARMATURE"), None)
    if root_obj is None:
        errors.append(f"NO_ROOT_ARMATURE: {fname}")
        continue

    root_obj.parent = armature
    root_obj.parent_type = "BONE"
    root_obj.parent_bone = target_bone

    hint = LOCATION_HINT[location]
    new_name = f"chrMdlWeap_Assassin_{hint}_{visual}_{slot.lower()}"
    mesh_child = next((c for c in root_obj.children if c.type == "MESH"), None)
    root_obj.name = f"WeaponRig_{hint}_{visual}_{slot.lower()}"
    if mesh_child:
        mesh_child.name = new_name
    if location == "Head":
        head_weapon_names.append(new_name)
    mounted += 1

print(f"\nMounted: {mounted} / {len(weapon_files)}")
print(f"Errors: {len(errors)}")
for e in errors:
    print("  ", e)
print("Head weapons mounted:", head_weapon_names)

# --- 4b. Animations -> muted NLA tracks ---
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
anim_files = sorted(f for f in os.listdir(ANIM_DIR) if f.lower().endswith(".ueanim"))
print(f"\nTotal animation files: {len(anim_files)}")
anim_count = 0
anim_errors = []
if not armature.animation_data:
    armature.animation_data_create()
for fname in anim_files:
    try:
        bpy.ops.uf.import_ueanim(directory=ANIM_DIR, files=[{"name": fname}])
    except Exception as e:
        anim_errors.append(f"{fname}: {e}")
        continue
    action = armature.animation_data.action if armature.animation_data else None
    if action is None:
        anim_errors.append(f"{fname}: no action created")
        continue
    track = armature.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, int(action.frame_range[0]), action)
    track.mute = True
    armature.animation_data.action = None
    anim_count += 1

print(f"Animations pushed to NLA: {anim_count} / {len(anim_files)}")
for e in anim_errors:
    print("  ANIM_ERROR", e)

# --- 5. Reset pose to TRUE rest before saving/exporting ---
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")
nonzero = 0
for b in armature.pose.bones:
    loc = b.location
    rot = b.rotation_quaternion
    if abs(loc.x) > 0.001 or abs(loc.y) > 0.001 or abs(loc.z) > 0.001:
        nonzero += 1
    elif abs(rot.w - 1.0) > 0.001 or abs(rot.x) > 0.001 or abs(rot.y) > 0.001 or abs(rot.z) > 0.001:
        nonzero += 1
print(f"Bones with non-identity pose after clear: {nonzero}")

# --- 6. Cleanup default Cube/Light/Camera ---
for name in ("Cube", "Camera", "Light"):
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

# --- 7. Save ---
bpy.ops.wm.save_as_mainfile(filepath=OUT_PATH)
print(f"\nSaved: {OUT_PATH}")
