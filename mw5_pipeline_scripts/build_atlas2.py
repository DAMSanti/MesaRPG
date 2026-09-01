"""Atlas II (AS7II) dedicated pipeline. A genuine Clan OmniMech, structurally
different from every other chassis this pipeline has handled so far -- see
MW5_MECH_TEXTURING_PIPELINE.md for the full investigation. Two real
differences from build_chassis.py's generic assumptions:

1. Body texture layout: 4 separate per-region material slots (AS_TORSO,
   AS_LEG, AS_HIP, AS_ARM), each with its own real per-pixel MetalID +
   MSK + NRM + wear_MSK, instead of one shared Body/Variant pair. The
   only 2 available skins (Metal, StarLeague) both override RGBPaintMask
   to a flat-black texture and define no PaintColorPrimary/Secondary/
   Tertiary VectorParameters at all -- confirmed via both skins' own JSON
   -- so there is no real painted-region color to derive here; the honest
   recipe is a uniform metal base tinted by real per-pixel dirt/roughness/
   metallic, not the RGBPaintMask 3-color mix every other chassis uses.

2. Weapon mounting: generic Omnimech pod hardpoints instead of one mesh
   per weapon type. Confirmed via the real per-variant loadout query
   against mech_templates (only 4 real variants, 9 distinct weapons
   total): Forearm_Left and Torso_Left each carry 2 numbered "Energy"
   pod meshes (EH1/EH2, one generic mesh regardless of which energy
   weapon is equipped), Forearm_Right carries 1 "Ballistic" pod mesh
   (same idea), and Torso_Left/Right each carry their own numbered
   Missile<N>/Narc files mounted directly like every other chassis. The
   Energy/Ballistic meshes need to be duplicated once per real weapon
   token that can appear at that mount (same underlying mesh data,
   different chrMdlWeap_ name) so the existing show/hide-by-name system
   picks the right one -- confirmed via each weapon file's own JSON that
   these generic pod meshes use the AS_ARM body-region material slot
   directly, not a separate Weapons material at all.

Run: blender --background --factory-startup --python build_atlas2.py
"""
import bpy
import os
import math
import json
import numpy as np

MESA_ROOT = r"D:\Portfolio\mesa\MesaRPG"
COMMON_TEX = MESA_ROOT + r"\modelsmw5\_Common\Textures" + os.sep
CHASSIS = "AtlasII"
ROOT = MESA_ROOT + rf"\modelsmw5\activos\{CHASSIS}\Model"
BODY_DIR = ROOT + r"\Body" + os.sep
WEAPONS_DIR = ROOT + r"\Weapons" + os.sep
ANIM_DIR = MESA_ROOT + rf"\modelsmw5\activos\{CHASSIS}\Animation" + os.sep
TEX_DIR = ROOT + r"\Body\Textures" + os.sep
OUT_BLEND = MESA_ROOT + rf"\models\{CHASSIS}_new.blend"
OUT_GLB = MESA_ROOT + rf"\rewrite\frontend\public\models\mechs\{CHASSIS}.glb"

METAL_GENERIC = (0.2117, 0.2117, 0.2117, 1.0)
DIRT_TINT = (0.10, 0.085, 0.065)

bpy.ops.preferences.addon_enable(module="io_scene_ueformat")
for name in ("Cube", "Camera", "Light"):
    obj = bpy.data.objects.get(name)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

# --- 1. Import body (real filename is the prefix, not "<Chassis>_SKM") ---
bpy.ops.uf.import_uemodel(directory=BODY_DIR, files=[{"name": "AS7II.uemodel"}])
armature = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
body_mesh = [o for o in bpy.data.objects if o.type == "MESH"][0]
print(f"Body armature: {armature.name}, mesh: {body_mesh.name}, bones: {len(armature.data.bones)}")

bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
body_mesh.select_set(True)
bpy.context.view_layer.objects.active = armature
armature.rotation_euler[2] = math.radians(-90)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bone_names = set(b.name for b in armature.data.bones)

# --- 2. Weapon mounting ---
BONE_BY_LOCATION = {
    "Forearm_Left": "Forearm_Left_Weapon", "Forearm_Right": "Forearm_Right_Weapon",
    "Torso_Left": "Torso_Weapon", "Torso_Right": "Torso_Weapon",
}
LOCATION_HINT = {
    "Forearm_Left": "left_arm", "Forearm_Right": "right_arm",
    "Torso_Left": "left_torso", "Torso_Right": "right_torso",
}


def import_weapon(fname):
    before = set(o.name for o in bpy.data.objects)
    bpy.ops.uf.import_uemodel(directory=WEAPONS_DIR, files=[{"name": fname}])
    after = set(o.name for o in bpy.data.objects)
    new_objs = [bpy.data.objects[n] for n in (after - before)]
    root_obj = next((o for o in new_objs if o.parent is None and o.type == "ARMATURE"), None)
    mesh_obj = next((c for c in root_obj.children if c.type == "MESH"), None)
    return root_obj, mesh_obj


def mount(root_obj, location, hint):
    target_bone = BONE_BY_LOCATION[location]
    if target_bone not in bone_names:
        print(f"  MISSING_BONE {target_bone} for {location}")
        return False
    root_obj.parent = armature
    root_obj.parent_type = "BONE"
    root_obj.parent_bone = target_bone
    return True


mounted, errors = 0, 0

# Missile<N>/Narc files: mount directly like the standard pipeline, one
# real mesh per size, own visual token, single "mh1" slot per location.
for location in ("Torso_Left", "Torso_Right"):
    hint = LOCATION_HINT[location]
    files = sorted(f for f in os.listdir(WEAPONS_DIR)
                    if f.startswith(f"Weapon_Mech_AS7II_{location}_") and f.endswith("_SKM.uemodel")
                    and ("Missile" in f or "Narc" in f))
    for fname in files:
        token = fname[len(f"Weapon_Mech_AS7II_{location}_"):-len("_SKM.uemodel")].lower()
        root_obj, mesh_obj = import_weapon(fname)
        if root_obj is None or not mount(root_obj, location, hint):
            errors += 1
            continue
        root_obj.name = f"WeaponRig_{hint}_{token}_mh1"
        if mesh_obj:
            mesh_obj.name = f"chrMdlWeap_{CHASSIS}_{hint}_{token}_mh1"
        mounted += 1
print(f"Missile/Narc mounted: {mounted}, errors so far: {errors}")

# Energy pod (Forearm_Left EH1/EH2, Torso_Left EH1/EH2): one generic mesh
# per slot, duplicated once per real weapon token that catalog data shows
# can occupy that mount (see this file's own doc comment for the query).
ENERGY_TOKENS_BY_LOCATION = {
    "Forearm_Left": ["laser", "ppc"],   # ER Large Laser, ER PPC
    "Torso_Left": ["laser"],            # ER Medium Laser / Medium Pulse Laser (same bucket)
}
for location, tokens in ENERGY_TOKENS_BY_LOCATION.items():
    hint = LOCATION_HINT[location]
    for slot in ("EH1", "EH2"):
        fname = f"Weapon_Mech_AS7II_{location}_Energy_{slot}_SKM.uemodel"
        if not os.path.exists(WEAPONS_DIR + fname):
            continue
        root_obj, mesh_obj = import_weapon(fname)
        if root_obj is None or not mount(root_obj, location, hint):
            errors += 1
            continue
        base_mesh_data = mesh_obj.data if mesh_obj else None
        base_name = mesh_obj.name if mesh_obj else None
        for i, token in enumerate(tokens):
            if i == 0:
                dup_root, dup_mesh = root_obj, mesh_obj
            else:
                dup_root = root_obj.copy()
                dup_root.name = f"WeaponRig_dup_{hint}_{token}_{slot.lower()}"
                bpy.context.collection.objects.link(dup_root)
                dup_mesh = mesh_obj.copy()
                dup_mesh.data = base_mesh_data
                dup_mesh.parent = dup_root
                bpy.context.collection.objects.link(dup_mesh)
            dup_root.name = f"WeaponRig_{hint}_{token}_{slot.lower()}"
            if dup_mesh:
                dup_mesh.name = f"chrMdlWeap_{CHASSIS}_{hint}_{token}_{slot.lower()}"
            mounted += 1
print(f"+ Energy mounted, total: {mounted}, errors so far: {errors}")

# Ballistic pod (Forearm_Right only, no numbered slot): one generic mesh,
# duplicated once per real weapon token (Gauss Rifle, LB 10-X AC, Rotary
# AC/5 all share this one physical mount across AtlasII's 4 variants).
BALLISTIC_TOKENS = ["gauss", "lbx10", "rac5"]
fname = "Weapon_Mech_AS7II_Forearm_Right_Ballistic_SKM.uemodel"
root_obj, mesh_obj = import_weapon(fname)
if root_obj is not None and mount(root_obj, "Forearm_Right", "right_arm"):
    base_mesh_data = mesh_obj.data if mesh_obj else None
    for i, token in enumerate(BALLISTIC_TOKENS):
        if i == 0:
            dup_root, dup_mesh = root_obj, mesh_obj
        else:
            dup_root = root_obj.copy()
            bpy.context.collection.objects.link(dup_root)
            dup_mesh = mesh_obj.copy()
            dup_mesh.data = base_mesh_data
            dup_mesh.parent = dup_root
            bpy.context.collection.objects.link(dup_mesh)
        dup_root.name = f"WeaponRig_right_arm_{token}_bh1"
        if dup_mesh:
            dup_mesh.name = f"chrMdlWeap_{CHASSIS}_right_arm_{token}_bh1"
        mounted += 1
else:
    errors += 1
print(f"+ Ballistic mounted, total: {mounted}, errors: {errors}")

# --- 3. Animations -> muted NLA tracks ---
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

# --- 4. Reset pose to TRUE rest ---
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")

# =====================================================================
# MATERIALS -- 4 real per-region materials (uniform metal + real MetalID
# roughness/metallic + real dirt, no RGBPaintMask color mix -- see this
# file's own doc comment for why).
# =====================================================================


def load_pixels(path, size=None):
    # AtlasII's own region textures mismatch resolution within a single
    # region (MetalID at 2048x2048, wear_MSK/NRM at 4096x4096, confirmed
    # for all 4 regions) -- resize to the caller's reference size first.
    img = bpy.data.images.load(path, check_existing=True)
    if size is not None and tuple(img.size) != tuple(size):
        img.scale(size[0], size[1])
    w, h = img.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    return arr.reshape(h, w, 4), img


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


REGIONS = ["AS_TORSO", "AS_LEG", "AS_HIP", "AS_ARM"]
region_materials = {}
for region in REGIONS:
    metal_arr, _ = load_pixels(TEX_DIR + f"{region}_MetalID.png")
    wear_arr, _ = load_pixels(TEX_DIR + f"{region}_wear_MSK.png", size=metal_arr.shape[1::-1])
    R = metal_arr[..., 0]
    h, w = R.shape
    wear_amount = np.maximum(wear_arr[..., 1], wear_arr[..., 2]) * 0.5
    base = np.array(METAL_GENERIC[:3])
    dirt = np.array(DIRT_TINT)
    color = base[None, None, :] * (1 - wear_amount[..., None]) + dirt[None, None, :] * wear_amount[..., None]
    color = linear_to_srgb(color)
    color_rgba = np.ones((h, w, 4), dtype=np.float32)
    color_rgba[..., :3] = color
    color_img = bpy.data.images.new(f"{region}_Baked", width=w, height=h, alpha=False)
    color_img.pixels.foreach_set(color_rgba.ravel())
    color_img.filepath_raw = TEX_DIR + f"{region}_Baked.png"
    color_img.file_format = "PNG"
    color_img.save()

    # Same safe capped LERP already proven for the Weapons material
    # elsewhere in the pipeline (0.10-0.55 metallic, 0.31-0.70 roughness
    # base before the wear bump) -- real per-pixel MetalID here plays the
    # exact same role as Clan_Generic_MetalID does for weapon barrels.
    roughness = R * 0.39 + 0.31 + wear_amount * 0.25
    roughness = np.clip(roughness, 0.0, 1.0)
    metallic = np.clip(R * -0.45 + 0.55, 0.0, 1.0)
    rm_rgba = np.ones((h, w, 4), dtype=np.float32)
    rm_rgba[..., 0] = roughness
    rough_img = bpy.data.images.new(f"{region}_Roughness", width=w, height=h, alpha=False)
    rough_img.pixels.foreach_set(rm_rgba.ravel())
    rough_img.filepath_raw = TEX_DIR + f"{region}_Roughness.png"
    rough_img.file_format = "PNG"
    rough_img.save()
    rm_rgba[..., 0] = metallic
    metal_img = bpy.data.images.new(f"{region}_Metallic", width=w, height=h, alpha=False)
    metal_img.pixels.foreach_set(rm_rgba.ravel())
    metal_img.filepath_raw = TEX_DIR + f"{region}_Metallic.png"
    metal_img.file_format = "PNG"
    metal_img.save()

    mat = bpy.data.materials.new(name=f"{CHASSIS}_{region}")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    color_node = nt.nodes.new("ShaderNodeTexImage"); color_node.image = color_img
    nt.links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])
    r_node = nt.nodes.new("ShaderNodeTexImage"); r_node.image = rough_img
    r_node.image.colorspace_settings.name = "Non-Color"
    nt.links.new(r_node.outputs["Color"], bsdf.inputs["Roughness"])
    m_node = nt.nodes.new("ShaderNodeTexImage"); m_node.image = metal_img
    m_node.image.colorspace_settings.name = "Non-Color"
    nt.links.new(m_node.outputs["Color"], bsdf.inputs["Metallic"])
    nrm_path = TEX_DIR + f"{region}_NRM.png"
    if os.path.exists(nrm_path):
        nrm_img = bpy.data.images.load(nrm_path, check_existing=True)
        nrm_img.colorspace_settings.name = "Non-Color"
        nrm_node = nt.nodes.new("ShaderNodeTexImage"); nrm_node.image = nrm_img
        normal_map = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nrm_node.outputs["Color"], normal_map.inputs["Color"])
        nt.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    mat.use_fake_user = True
    region_materials[region] = mat
print("Region materials built:", list(region_materials.keys()))

# Assign to the body mesh's 4 real slots (confirmed order via AS7II.json:
# AS_TORSO, AS_LEG, AS_HIP, AS_ARM).
for i, region in enumerate(REGIONS):
    if i < len(body_mesh.data.materials):
        body_mesh.data.materials[i] = region_materials[region]
    else:
        body_mesh.data.materials.append(region_materials[region])

# --- Weapons material for the Missile/Narc "MissileHead" slot family --
# identical recipe to every other chassis' Weapons material.
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
wnt.links.new(roughness_mix.outputs[0], wbsdf.inputs["Roughness"])
metallic_mix = wnt.nodes.new("ShaderNodeMath"); metallic_mix.operation = "MULTIPLY_ADD"; metallic_mix.use_clamp = True
metallic_mix.inputs[1].default_value = -0.45; metallic_mix.inputs[2].default_value = 0.55
wnt.links.new(sep.outputs["Red"], metallic_mix.inputs[0])
wnt.links.new(metallic_mix.outputs[0], wbsdf.inputs["Metallic"])
nrm_img2 = wnt.nodes.new("ShaderNodeTexImage")
nrm_img2.image = bpy.data.images.load(COMMON_TEX + "Clan_Generic_NRM.png", check_existing=True)
nrm_img2.image.colorspace_settings.name = "Non-Color"
normal_map2 = wnt.nodes.new("ShaderNodeNormalMap")
wnt.links.new(nrm_img2.outputs["Color"], normal_map2.inputs["Color"])
wnt.links.new(normal_map2.outputs["Normal"], wbsdf.inputs["Normal"])
wout = wnt.nodes.new("ShaderNodeOutputMaterial")
wnt.links.new(wbsdf.outputs["BSDF"], wout.inputs["Surface"])
weapons_mat.use_fake_user = True
print("Weapons material built")

# --- Assign weapon-mesh materials by real slot name ---
assigned, assign_errors = 0, []
for o in list(bpy.data.objects):
    if not o.name.startswith("WeaponRig_"):
        continue
    mesh_obj = next((c for c in o.children if c.type == "MESH"), None)
    if mesh_obj is None:
        continue
    if len(mesh_obj.material_slots) == 0:
        continue
    # AS_ARM-slot meshes (Energy/Ballistic pods) share the AS_ARM body
    # material directly -- confirmed via each weapon's own JSON. Missile/
    # Narc meshes use "MissileHead", same as every other chassis.
    for i in range(len(mesh_obj.data.materials)):
        mesh_obj.data.materials[i] = region_materials["AS_ARM"]
    assigned += 1

# Missile/Narc objects were named chrMdlWeap_..._mh1 and use MissileHead
# slot -- override those specifically to weapons_mat.
for o in list(bpy.data.objects):
    if not o.name.startswith("WeaponRig_"):
        continue
    mesh_obj = next((c for c in o.children if c.type == "MESH"), None)
    if mesh_obj is None or "missile" not in mesh_obj.name.lower() and "narc" not in mesh_obj.name.lower():
        continue
    for i in range(len(mesh_obj.data.materials)):
        mesh_obj.data.materials[i] = weapons_mat

print(f"Assigned material slots on {assigned} weapon meshes")

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
print(f"Saved: {OUT_BLEND}")

bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", use_selection=False,
    export_animations=True, export_animation_mode="NLA_TRACKS",
    export_skins=True, export_apply=False,
)
print(f"Exported: {OUT_GLB} ({os.path.getsize(OUT_GLB)} bytes)")
print(f"DONE {CHASSIS}: mounted={mounted} errors={errors} anim={anim_count}/{len(anim_files)}")
