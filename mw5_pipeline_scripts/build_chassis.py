"""Generic MW5 -> MesaRPG chassis pipeline. Run standalone with Blender:

    blender --background --factory-startup --python build_chassis.py -- <ChassisName> <FilePrefix>

Example: --python build_chassis.py -- Warhammer WHM

Does the FULL pipeline in one pass: import body, rotate, mount every
weapon (plain zero-offset bone-parent), import every animation to a
muted NLA track, reset pose to true rest, bake Body/Variant materials
(real RGBPaintMask + dirt-tint + safe per-region roughness/metallic
derived from the same mask), build a Weapons material with the real
MetalID recipe (capped, safe roughness/metallic range), assign every
weapon's real material slots by name (never by index), save the
.blend, export the .glb. See MW5_MECH_TEXTURING_PIPELINE.md at the
project root for the reasoning behind every one of these steps and the
real bugs each one fixes.

Known gaps this generic script does NOT handle (flag and skip, don't
force): a Head-mounted weapon on a chassis with no dedicated
Head_Weapon bone needs a manual vertex-baked offset correction (see
the pipeline doc's Assassin section) -- this script mounts it at
zero-offset like everything else and prints a warning; fix it in a
follow-up pass, same technique as Archer/Assassin. A skin whose own
SKN DOES override Primary/Secondary/Tertiary needs those values swapped
in below (checked automatically, see get_skn_colors()).
"""
import bpy
import os
import re
import math
import sys
import json
import numpy as np

MESA_ROOT = r"D:\Portfolio\mesa\MesaRPG"
COMMON_TEX = MESA_ROOT + r"\modelsmw5\_Common\Textures" + os.sep

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    raise SystemExit("Usage: blender --background --python build_chassis.py -- <ChassisName> <FilePrefix>")
CHASSIS = argv[0]
PREFIX = argv[1]  # e.g. WHM for Warhammer, ARC for Archer

ROOT = MESA_ROOT + rf"\modelsmw5\activos\{CHASSIS}\Model"
BODY_DIR = ROOT + r"\Body" + os.sep
WEAPONS_DIR = ROOT + r"\Weapons" + os.sep
ANIM_DIR = MESA_ROOT + rf"\modelsmw5\activos\{CHASSIS}\Animation" + os.sep
# Most chassis put their textures under Body\Materials\Textures, but some
# (Kodiak, JennerIIC, ShadowHawkIIC, Viper confirmed so far) use the
# shorter Body\Textures instead -- detect whichever one actually exists.
_TEX_DIR_CANDIDATES = [ROOT + r"\Body\Materials\Textures", ROOT + r"\Body\Textures"]
TEX_DIR = next((p for p in _TEX_DIR_CANDIDATES if os.path.isdir(p)), _TEX_DIR_CANDIDATES[0]) + os.sep
OUT_BLEND = MESA_ROOT + rf"\models\{CHASSIS}_new.blend"
OUT_GLB = MESA_ROOT + rf"\rewrite\frontend\public\models\mechs\{CHASSIS}.glb"

DEFAULT_PRIMARY = (0.028325, 0.062928, 0.078125, 1.0)
DEFAULT_SECONDARY = (0.333333, 0.065163, 0.008481, 1.0)
DEFAULT_TERTIARY = (0.588542, 0.571195, 0.570151, 1.0)
METAL_GENERIC = (0.2117, 0.2117, 0.2117, 1.0)


def get_skn_colors():
    """Real per-chassis override if the Default SKN's own Body/Variant
    InstanceSkinParameters carry VectorParameters -- falls back to the
    shared BaseMech_MTI defaults otherwise (confirmed real behavior for
    both Archer and Assassin, neither had an override)."""
    skn_path = MESA_ROOT + rf"\modelsmw5\activos\{CHASSIS}\Skins\{CHASSIS}_Default_SKN.json"
    if not os.path.exists(skn_path):
        return DEFAULT_PRIMARY, DEFAULT_SECONDARY, DEFAULT_TERTIARY
    with open(skn_path, encoding="utf-8") as f:
        data = json.load(f)
    mats = data[0]["Properties"]["UnitSkin"]["MechMaterialInstances"]
    for m in mats:
        if m["MaterialSlotName"] == "Body":
            vecs = m["InstanceSkinParameters"]["VectorParameters"]
            found = {v["ParameterName"]: v["ParameterValue"] for v in vecs}
            if "PaintColorPrimary" in found:
                def rgba(v):
                    return (v["R"], v["G"], v["B"], 1.0)
                return (
                    rgba(found.get("PaintColorPrimary", {"R": DEFAULT_PRIMARY[0], "G": DEFAULT_PRIMARY[1], "B": DEFAULT_PRIMARY[2]})),
                    rgba(found.get("PaintColorSecondary", {"R": DEFAULT_SECONDARY[0], "G": DEFAULT_SECONDARY[1], "B": DEFAULT_SECONDARY[2]})),
                    rgba(found.get("PaintColorTertiary", {"R": DEFAULT_TERTIARY[0], "G": DEFAULT_TERTIARY[1], "B": DEFAULT_TERTIARY[2]})),
                )
    return DEFAULT_PRIMARY, DEFAULT_SECONDARY, DEFAULT_TERTIARY


PRIMARY, SECONDARY, TERTIARY = get_skn_colors()
print(f"Colors for {CHASSIS}: Primary={PRIMARY} Secondary={SECONDARY} Tertiary={TERTIARY}")

bpy.ops.preferences.addon_enable(module="io_scene_ueformat")

# --- 0. Clear factory-startup default scene (Cube/Camera/Light) BEFORE
# import -- otherwise the default Cube is the first MESH object in
# bpy.data.objects and gets mistaken for the real body mesh below.
for name in ("Cube", "Camera", "Light"):
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

# --- 1. Import body ---
bpy.ops.uf.import_uemodel(directory=BODY_DIR, files=[{"name": f"{CHASSIS}_SKM.uemodel"}])
armature = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
body_mesh = [o for o in bpy.data.objects if o.type == "MESH"][0]
print(f"Body armature: {armature.name}, mesh: {body_mesh.name}, bones: {len(armature.data.bones)}")

# --- 2. Rotation: proven Bushwacker convention ---
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
body_mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
armature.rotation_euler[2] = math.radians(-90)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bone_names = set(b.name for b in armature.data.bones)

# --- 3. Cockpit: skipped by default (proven simpler approach) ---

# --- 4. Weapon mounting: auto-detect location tokens from filenames ---
weapon_files = sorted(f for f in os.listdir(WEAPONS_DIR) if f.lower().endswith("_skm.uemodel"))
FILENAME_RE = re.compile(rf"^Weapon_Mech_{PREFIX}_(.+)_SKM\.uemodel$", re.IGNORECASE)

KNOWN_LOCATION_TOKENS = [
    "Forearm_Left", "Forearm_Right", "Torso_Center", "Torso_Left", "Torso_Right", "Torso", "Head",
    "Clavicle_Left", "Clavicle_Right", "Upperarm_Left", "Upperarm_Right",
    "Missile_Left", "Missile_Right", "Shoulder_Left", "Shoulder_Right",
]
BONE_BY_LOCATION = {
    "Forearm_Left": "Forearm_Left_Weapon", "Forearm_Right": "Forearm_Right_Weapon",
    "Torso_Center": "Torso_Weapon", "Torso_Left": "Torso_Weapon", "Torso_Right": "Torso_Weapon",
    "Torso": "Torso_Weapon",
    "Head": "Head_Weapon" if "Head_Weapon" in bone_names else "Torso_Head",
    "Clavicle_Left": "Clavicle_Left_Weapon", "Clavicle_Right": "Clavicle_Right_Weapon",
    "Upperarm_Left": "Upperarm_Left_Weapon", "Upperarm_Right": "Upperarm_Right_Weapon",
    # Some chassis name their torso missile bay/shoulder mount differently
    # (Highlander: "Missile_Left" for its Narc; Hunchback: "Shoulder_Right"
    # for a Blank cover mesh) -- no dedicated bone exists for either under
    # that name, so route to the nearest real equivalent.
    "Missile_Left": "Torso_Weapon", "Missile_Right": "Torso_Weapon",
    "Shoulder_Left": "Clavicle_Left_Weapon", "Shoulder_Right": "Clavicle_Right_Weapon",
}
LOCATION_HINT = {
    "Forearm_Left": "left_arm", "Forearm_Right": "right_arm", "Torso_Center": "center_torso",
    "Torso_Left": "left_torso", "Torso_Right": "right_torso", "Torso": "center_torso", "Head": "head",
    "Clavicle_Left": "left_shoulder", "Clavicle_Right": "right_shoulder",
    "Missile_Left": "left_torso", "Missile_Right": "right_torso",
    "Shoulder_Left": "left_shoulder", "Shoulder_Right": "right_shoulder",
    "Upperarm_Left": "left_arm", "Upperarm_Right": "right_arm",
}
LOCATIONS_SORTED = sorted(BONE_BY_LOCATION.keys(), key=len, reverse=True)
BONE_FALLBACK = {
    "Clavicle_Left_Weapon": "Torso_Weapon", "Clavicle_Right_Weapon": "Torso_Weapon",
    "Upperarm_Left_Weapon": "Forearm_Left_Weapon", "Upperarm_Right_Weapon": "Forearm_Right_Weapon",
}

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
    visual = "_".join(parts[1:]).lower()
    target_bone = BONE_BY_LOCATION[location]
    if target_bone not in bone_names:
        # Some chassis skeletons are asymmetric (e.g. Crusader has
        # Clavicle_Left_Weapon but no Clavicle_Right_Weapon at all, even
        # though its real stock loadouts do mount a weapon there) --
        # falling back to the nearest real bone beats dropping the weapon.
        fallback_bone = BONE_FALLBACK.get(target_bone)
        if fallback_bone and fallback_bone in bone_names:
            target_bone = fallback_bone
        else:
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
    new_name = f"chrMdlWeap_{CHASSIS}_{hint}_{visual}_{slot.lower()}"
    mesh_child = next((c for c in root_obj.children if c.type == "MESH"), None)
    root_obj.name = f"WeaponRig_{hint}_{visual}_{slot.lower()}"
    if mesh_child:
        mesh_child.name = new_name
    if location == "Head":
        head_weapon_names.append(new_name)
    mounted += 1

print(f"Mounted: {mounted} / {len(weapon_files)}  Errors: {len(errors)}")
for e in errors:
    print("  ", e)
if head_weapon_names:
    print(f"WARNING: {len(head_weapon_names)} Head weapon(s) mounted at zero-offset, likely floating: {head_weapon_names}")
    print("  -> needs a manual vertex-bake correction pass, see pipeline doc Assassin section")

# --- 4b. Animations -> muted NLA tracks ---
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
anim_files = sorted(f for f in os.listdir(ANIM_DIR) if f.lower().endswith(".ueanim")) if os.path.isdir(ANIM_DIR) else []
anim_count = 0
if not armature.animation_data:
    armature.animation_data_create()
for fname in anim_files:
    try:
        bpy.ops.uf.import_ueanim(directory=ANIM_DIR, files=[{"name": fname}])
    except Exception as e:
        print(f"  ANIM_ERROR {fname}: {e}")
        continue
    action = armature.animation_data.action if armature.animation_data else None
    if action is None:
        continue
    track = armature.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, int(action.frame_range[0]), action)
    track.mute = True
    armature.animation_data.action = None
    anim_count += 1
print(f"Animations pushed to NLA: {anim_count} / {len(anim_files)}")

# --- 5. Reset pose to TRUE rest (critical, see pipeline doc 12b) ---
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")

# =====================================================================
# MATERIALS
# =====================================================================


def load_pixels(path):
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    return arr.reshape(h, w, 4), img


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


# --- Body: Cycles bake (Pattern A) ---
mat = body_mesh.data.materials[0] if body_mesh.data.materials else None
if mat is None:
    mat = bpy.data.materials.new(name=f"{CHASSIS}_Body")
    body_mesh.data.materials.append(mat)
mat.name = f"{CHASSIS}_Body"
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)


def load_img(name, colorspace="sRGB"):
    img = bpy.data.images.load(TEX_DIR + name, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


paint_mask_img = load_img(f"{CHASSIS}_Body_Default_MSK.png")
wear_img = load_img(f"{CHASSIS}_Body_Wear_MSK.png", colorspace="Non-Color")
nrm_img = load_img(f"{CHASSIS}_Body_NRM.png", colorspace="Non-Color")

tex_mask = nt.nodes.new("ShaderNodeTexImage"); tex_mask.image = paint_mask_img
sep_mask = nt.nodes.new("ShaderNodeSeparateColor")
nt.links.new(tex_mask.outputs["Color"], sep_mask.inputs["Color"])
tex_wear = nt.nodes.new("ShaderNodeTexImage"); tex_wear.image = wear_img
sep_wear = nt.nodes.new("ShaderNodeSeparateColor")
nt.links.new(tex_wear.outputs["Color"], sep_wear.inputs["Color"])

sub1 = nt.nodes.new("ShaderNodeMath"); sub1.operation = "SUBTRACT"; sub1.inputs[0].default_value = 1.0
nt.links.new(sep_mask.outputs["Red"], sub1.inputs[1])
sub2 = nt.nodes.new("ShaderNodeMath"); sub2.operation = "SUBTRACT"
nt.links.new(sub1.outputs[0], sub2.inputs[0]); nt.links.new(sep_mask.outputs["Green"], sub2.inputs[1])
sub3 = nt.nodes.new("ShaderNodeMath"); sub3.operation = "SUBTRACT"
nt.links.new(sub2.outputs[0], sub3.inputs[0]); nt.links.new(sep_mask.outputs["Blue"], sub3.inputs[1])
clamp_rem = nt.nodes.new("ShaderNodeMath"); clamp_rem.operation = "MAXIMUM"; clamp_rem.inputs[1].default_value = 0.0
nt.links.new(sub3.outputs[0], clamp_rem.inputs[0])

mix1 = nt.nodes.new("ShaderNodeMix"); mix1.data_type = "RGBA"; mix1.blend_type = "MIX"
mix1.inputs["A"].default_value = (0, 0, 0, 1); mix1.inputs["B"].default_value = PRIMARY
nt.links.new(sep_mask.outputs["Red"], mix1.inputs["Factor"])
mix2 = nt.nodes.new("ShaderNodeMix"); mix2.data_type = "RGBA"; mix2.blend_type = "MIX"
nt.links.new(mix1.outputs["Result"], mix2.inputs["A"]); mix2.inputs["B"].default_value = SECONDARY
nt.links.new(sep_mask.outputs["Green"], mix2.inputs["Factor"])
mix3 = nt.nodes.new("ShaderNodeMix"); mix3.data_type = "RGBA"; mix3.blend_type = "MIX"
nt.links.new(mix2.outputs["Result"], mix3.inputs["A"]); mix3.inputs["B"].default_value = TERTIARY
nt.links.new(sep_mask.outputs["Blue"], mix3.inputs["Factor"])
mix4 = nt.nodes.new("ShaderNodeMix"); mix4.data_type = "RGBA"; mix4.blend_type = "MIX"
nt.links.new(mix3.outputs["Result"], mix4.inputs["A"]); mix4.inputs["B"].default_value = METAL_GENERIC
nt.links.new(clamp_rem.outputs[0], mix4.inputs["Factor"])

wear_amount = nt.nodes.new("ShaderNodeMath"); wear_amount.operation = "MAXIMUM"
nt.links.new(sep_wear.outputs["Green"], wear_amount.inputs[0]); nt.links.new(sep_wear.outputs["Blue"], wear_amount.inputs[1])
wear_factor = nt.nodes.new("ShaderNodeMath"); wear_factor.operation = "MULTIPLY"; wear_factor.inputs[1].default_value = 0.5
nt.links.new(wear_amount.outputs[0], wear_factor.inputs[0])
dirt_tint = nt.nodes.new("ShaderNodeRGB"); dirt_tint.outputs[0].default_value = (0.10, 0.085, 0.065, 1.0)
mix5 = nt.nodes.new("ShaderNodeMix"); mix5.data_type = "RGBA"; mix5.blend_type = "MIX"
nt.links.new(wear_factor.outputs[0], mix5.inputs["Factor"])
nt.links.new(mix4.outputs["Result"], mix5.inputs["A"])
nt.links.new(dirt_tint.outputs[0], mix5.inputs["B"])

emission = nt.nodes.new("ShaderNodeEmission")
nt.links.new(mix5.outputs["Result"], emission.inputs["Color"])
output = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(emission.outputs["Emission"], output.inputs["Surface"])

bake_img = bpy.data.images.new(f"{CHASSIS}_Body_Baked", width=2048, height=2048, alpha=False)
bake_node = nt.nodes.new("ShaderNodeTexImage"); bake_node.image = bake_img
for n in nt.nodes:
    n.select = False
bake_node.select = True
nt.nodes.active = bake_node

scene = bpy.context.scene
scene.render.engine = "CYCLES"
try:
    scene.cycles.device = "GPU"
except Exception:
    pass
bpy.ops.object.select_all(action="DESELECT")
body_mesh.select_set(True)
bpy.context.view_layer.objects.active = body_mesh
scene.render.bake.use_pass_direct = False
scene.render.bake.use_pass_indirect = False
bpy.ops.object.bake(type="EMIT")
bake_img.filepath_raw = TEX_DIR + f"{CHASSIS}_Body_Baked.png"
bake_img.file_format = "PNG"
bake_img.save()

for n in list(nt.nodes):
    nt.nodes.remove(n)
bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
tex_base = nt.nodes.new("ShaderNodeTexImage"); tex_base.image = bake_img
nt.links.new(tex_base.outputs["Color"], bsdf.inputs["Base Color"])
tex_nrm2 = nt.nodes.new("ShaderNodeTexImage"); tex_nrm2.image = nrm_img
normal_map2 = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(tex_nrm2.outputs["Color"], normal_map2.inputs["Color"])
nt.links.new(normal_map2.outputs["Normal"], bsdf.inputs["Normal"])
out2 = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(bsdf.outputs["BSDF"], out2.inputs["Surface"])
print("Body material baked+rebuilt")

# --- Variant: numpy bake (Pattern B) ---
mask_arr, _ = load_pixels(TEX_DIR + f"{CHASSIS}_Variant_Default_MSK.png")
wear_arr, _ = load_pixels(TEX_DIR + f"{CHASSIS}_Variant_Wear_MSK.png")
R = mask_arr[..., 0]; G = mask_arr[..., 1]; B = mask_arr[..., 2]
remainder = np.clip(1.0 - R - G - B, 0.0, 1.0)
h, w = R.shape
PRIMARY_N = np.array(PRIMARY[:3]); SECONDARY_N = np.array(SECONDARY[:3]); TERTIARY_N = np.array(TERTIARY[:3])
METAL_N = np.array(METAL_GENERIC[:3])
result = np.zeros((h, w, 3), dtype=np.float32)
for i in range(3):
    result[..., i] = R * PRIMARY_N[i] + G * SECONDARY_N[i] + B * TERTIARY_N[i] + remainder * METAL_N[i]
wear_amount_v = np.maximum(wear_arr[..., 1], wear_arr[..., 2]) * 0.5
DIRT_TINT = np.array([0.10, 0.085, 0.065])
result = result * (1 - wear_amount_v[..., None]) + DIRT_TINT[None, None, :] * wear_amount_v[..., None]
result = linear_to_srgb(result)
out = np.ones((h, w, 4), dtype=np.float32)
out[..., :3] = result
out_img = bpy.data.images.new(f"{CHASSIS}_Variant_Baked", width=w, height=h, alpha=False)
out_img.pixels.foreach_set(out.ravel())
out_img.filepath_raw = TEX_DIR + f"{CHASSIS}_Variant_Baked.png"
out_img.file_format = "PNG"
out_img.save()

# --- Safe per-region roughness/metallic for Body + Variant ---
for prefix in ["Body", "Variant"]:
    mask_arr2, _ = load_pixels(TEX_DIR + f"{CHASSIS}_{prefix}_Default_MSK.png")
    R2 = mask_arr2[..., 0]; G2 = mask_arr2[..., 1]; B2 = mask_arr2[..., 2]
    rem2 = np.clip(1.0 - R2 - G2 - B2, 0.0, 1.0)
    metallic = R2 * 0.10 + G2 * 0.10 + B2 * 0.10 + rem2 * 0.35
    roughness = R2 * 0.65 + G2 * 0.60 + B2 * 0.70 + rem2 * 0.35
    h2, w2 = R2.shape
    for kind, arr in [("Metallic", metallic), ("Roughness", roughness)]:
        rgb = np.ones((h2, w2, 4), dtype=np.float32)
        rgb[..., 0] = arr; rgb[..., 1] = arr; rgb[..., 2] = arr
        img = bpy.data.images.new(f"{CHASSIS}_{prefix}_{kind}", width=w2, height=h2, alpha=False)
        img.pixels.foreach_set(rgb.ravel())
        img.filepath_raw = TEX_DIR + f"{CHASSIS}_{prefix}_{kind}.png"
        img.file_format = "PNG"
        img.save()

bnt = mat.node_tree
bbsdf = next(n for n in bnt.nodes if n.type == "BSDF_PRINCIPLED")
r_img = bpy.data.images.load(TEX_DIR + f"{CHASSIS}_Body_Roughness.png", check_existing=True); r_img.colorspace_settings.name = "Non-Color"
r_node = bnt.nodes.new("ShaderNodeTexImage"); r_node.image = r_img
bnt.links.new(r_node.outputs["Color"], bbsdf.inputs["Roughness"])
m_img = bpy.data.images.load(TEX_DIR + f"{CHASSIS}_Body_Metallic.png", check_existing=True); m_img.colorspace_settings.name = "Non-Color"
m_node = bnt.nodes.new("ShaderNodeTexImage"); m_node.image = m_img
bnt.links.new(m_node.outputs["Color"], bbsdf.inputs["Metallic"])

variant_mat = bpy.data.materials.new(name=f"{CHASSIS}_Variant")
variant_mat.use_nodes = True
vnt = variant_mat.node_tree
for n in list(vnt.nodes):
    vnt.nodes.remove(n)
vbsdf = vnt.nodes.new("ShaderNodeBsdfPrincipled")
vtex = vnt.nodes.new("ShaderNodeTexImage"); vtex.image = out_img
vnt.links.new(vtex.outputs["Color"], vbsdf.inputs["Base Color"])
v_nrm_img = bpy.data.images.load(TEX_DIR + f"{CHASSIS}_Variant_NRM.png", check_existing=True); v_nrm_img.colorspace_settings.name = "Non-Color"
v_nrm_node = vnt.nodes.new("ShaderNodeTexImage"); v_nrm_node.image = v_nrm_img
v_normal_map = vnt.nodes.new("ShaderNodeNormalMap")
vnt.links.new(v_nrm_node.outputs["Color"], v_normal_map.inputs["Color"])
vnt.links.new(v_normal_map.outputs["Normal"], vbsdf.inputs["Normal"])
vr_img = bpy.data.images.load(TEX_DIR + f"{CHASSIS}_Variant_Roughness.png", check_existing=True); vr_img.colorspace_settings.name = "Non-Color"
vr_node = vnt.nodes.new("ShaderNodeTexImage"); vr_node.image = vr_img
vnt.links.new(vr_node.outputs["Color"], vbsdf.inputs["Roughness"])
vm_img = bpy.data.images.load(TEX_DIR + f"{CHASSIS}_Variant_Metallic.png", check_existing=True); vm_img.colorspace_settings.name = "Non-Color"
vm_node = vnt.nodes.new("ShaderNodeTexImage"); vm_node.image = vm_img
vnt.links.new(vm_node.outputs["Color"], vbsdf.inputs["Metallic"])
vout = vnt.nodes.new("ShaderNodeOutputMaterial")
vnt.links.new(vbsdf.outputs["BSDF"], vout.inputs["Surface"])
print("Body/Variant materials wired")

# --- Weapons: real MetalID recipe, SAFE capped roughness/metallic ---
weapons_mat = bpy.data.materials.new(name=f"{CHASSIS}_Weapons")
weapons_mat.use_nodes = True
wnt = weapons_mat.node_tree
for n in list(wnt.nodes):
    wnt.nodes.remove(n)
wbsdf = wnt.nodes.new("ShaderNodeBsdfPrincipled")
wbsdf.inputs["Base Color"].default_value = (0.23074, 0.23074, 0.23074, 1.0)
metal_id_img = bpy.data.images.load(COMMON_TEX + "Clan_Generic_MetalID.png", check_existing=True)
metal_id_img.colorspace_settings.name = "Non-Color"
metal_id_node = wnt.nodes.new("ShaderNodeTexImage"); metal_id_node.image = metal_id_img
sep = wnt.nodes.new("ShaderNodeSeparateColor")
wnt.links.new(metal_id_node.outputs["Color"], sep.inputs["Color"])
roughness_mix = wnt.nodes.new("ShaderNodeMath"); roughness_mix.operation = "MULTIPLY_ADD"
roughness_mix.inputs[1].default_value = 0.39; roughness_mix.inputs[2].default_value = 0.31
wnt.links.new(sep.outputs["Red"], roughness_mix.inputs[0])
wear_img2 = wnt.nodes.new("ShaderNodeTexImage")
wear_img2.image = bpy.data.images.load(COMMON_TEX + "Clan_Generic_Wear_MSK.png", check_existing=True)
wear_img2.image.colorspace_settings.name = "Non-Color"
wear_sep2 = wnt.nodes.new("ShaderNodeSeparateColor")
wnt.links.new(wear_img2.outputs["Color"], wear_sep2.inputs["Color"])
wear_amt2 = wnt.nodes.new("ShaderNodeMath"); wear_amt2.operation = "MAXIMUM"
wnt.links.new(wear_sep2.outputs["Green"], wear_amt2.inputs[0]); wnt.links.new(wear_sep2.outputs["Blue"], wear_amt2.inputs[1])
wear_scaled2 = wnt.nodes.new("ShaderNodeMath"); wear_scaled2.operation = "MULTIPLY"; wear_scaled2.inputs[1].default_value = 0.25
wnt.links.new(wear_amt2.outputs[0], wear_scaled2.inputs[0])
roughness_final2 = wnt.nodes.new("ShaderNodeMath"); roughness_final2.operation = "ADD"; roughness_final2.use_clamp = True
wnt.links.new(roughness_mix.outputs[0], roughness_final2.inputs[0])
wnt.links.new(wear_scaled2.outputs[0], roughness_final2.inputs[1])
wnt.links.new(roughness_final2.outputs[0], wbsdf.inputs["Roughness"])
metallic_mix = wnt.nodes.new("ShaderNodeMath"); metallic_mix.operation = "MULTIPLY_ADD"; metallic_mix.use_clamp = True
metallic_mix.inputs[1].default_value = -0.45; metallic_mix.inputs[2].default_value = 0.55
wnt.links.new(sep.outputs["Red"], metallic_mix.inputs[0])
wnt.links.new(metallic_mix.outputs[0], wbsdf.inputs["Metallic"])
nrm_img2 = wnt.nodes.new("ShaderNodeTexImage")
nrm_img2.image = bpy.data.images.load(COMMON_TEX + "Clan_Generic_NRM.png", check_existing=True)
nrm_img2.image.colorspace_settings.name = "Non-Color"
normal_map2b = wnt.nodes.new("ShaderNodeNormalMap")
wnt.links.new(nrm_img2.outputs["Color"], normal_map2b.inputs["Color"])
wnt.links.new(normal_map2b.outputs["Normal"], wbsdf.inputs["Normal"])
wout = wnt.nodes.new("ShaderNodeOutputMaterial")
wnt.links.new(wbsdf.outputs["BSDF"], wout.inputs["Surface"])
variant_mat.use_fake_user = True
weapons_mat.use_fake_user = True
print("Weapons material built")

# --- Assign every weapon's material slots by REAL name (never by index) ---
NAME_TO_MATERIAL = {
    "Variant": variant_mat, "Body": variant_mat,
    "Weapons": weapons_mat, "MissileHead": weapons_mat, "MIssileHead": weapons_mat, "Missilehead": weapons_mat,
    "Arrow": weapons_mat, "Geo": weapons_mat, "Missiles": weapons_mat,
}
assigned = 0
assign_errors = []
for o in list(bpy.data.objects):
    if not o.name.startswith("WeaponRig_"):
        continue
    mesh_obj = next((c for c in o.children if c.type == "MESH"), None)
    if mesh_obj is None:
        continue
    mesh_data_name = mesh_obj.data.name
    mm = re.match(r"^(.*_SKM)_LOD\d+$", mesh_data_name)
    base = mm.group(1) if mm else mesh_data_name
    json_path = os.path.join(WEAPONS_DIR, base + ".json")
    if not os.path.exists(json_path):
        assign_errors.append(f"NO_JSON: {mesh_data_name}")
        continue
    with open(json_path, encoding="utf-8") as f:
        wdata = json.load(f)
    slot_names = [s["MaterialSlotName"] for s in wdata[0]["SkeletalMaterials"] if not s["MaterialSlotName"].endswith("_LOD") and s["MaterialSlotName"] != "None"]
    seen = []
    for n in slot_names:
        if n not in seen:
            seen.append(n)
    slot_names = seen
    n_slots = len(mesh_obj.material_slots)
    if len(slot_names) != n_slots:
        assign_errors.append(f"SLOT_COUNT_MISMATCH: {mesh_data_name} json={slot_names} blender_n={n_slots}")
        if len(slot_names) < n_slots:
            slot_names = slot_names + [slot_names[-1]] * (n_slots - len(slot_names))
        else:
            slot_names = slot_names[:n_slots]
    for i, sname in enumerate(slot_names):
        target_mat = NAME_TO_MATERIAL.get(sname)
        if target_mat is None:
            assign_errors.append(f"UNKNOWN_SLOT_NAME: {mesh_data_name} slot={sname}")
            continue
        mesh_obj.data.materials[i] = target_mat
    assigned += 1

print(f"Assigned material slots on {assigned} weapon meshes, {len(assign_errors)} warnings")
for e in assign_errors[:20]:
    print("  ", e)

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
print(f"Saved: {OUT_BLEND}")

# --- Export ---
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", use_selection=False,
    export_animations=True, export_animation_mode="NLA_TRACKS",
    export_skins=True, export_apply=False,
)
print(f"Exported: {OUT_GLB} ({os.path.getsize(OUT_GLB)} bytes)")
print(f"DONE {CHASSIS}: mounted={mounted}/{len(weapon_files)} anim={anim_count}/{len(anim_files)} assign_errors={len(assign_errors)} head_weapons={len(head_weapon_names)}")
