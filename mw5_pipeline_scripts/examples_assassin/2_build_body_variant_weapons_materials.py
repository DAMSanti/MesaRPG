import bpy
import os
import numpy as np

IN_PATH = OUT_PATH = r"D:\Portfolio\mesa\MesaRPG\models\Assassin_new.blend"
TEX_DIR = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\activos\Assassin\Model\Body\Materials\Textures" + os.sep
COMMON_TEX = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\_Common\Textures" + os.sep

bpy.ops.wm.open_mainfile(filepath=IN_PATH)

PRIMARY = (0.028325, 0.062928, 0.078125, 1.0)
SECONDARY = (0.333333, 0.065163, 0.008481, 1.0)
TERTIARY = (0.588542, 0.571195, 0.570151, 1.0)
METAL_GENERIC = (0.2117, 0.2117, 0.2117, 1.0)

# ============ BODY: Cycles bake (Pattern A) ============
body_mesh = next(o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Assassin"))
mat = body_mesh.data.materials[0] if body_mesh.data.materials else None
if mat is None:
    mat = bpy.data.materials.new(name="Assassin_Body")
    body_mesh.data.materials.append(mat)
mat.name = "Assassin_Body"
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)


def load_img(name, colorspace="sRGB"):
    img = bpy.data.images.load(TEX_DIR + name, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


paint_mask_img = load_img("Assassin_Body_Default_MSK.png")
wear_img = load_img("Assassin_Body_Wear_MSK.png", colorspace="Non-Color")
nrm_img = load_img("Assassin_Body_NRM.png", colorspace="Non-Color")

tex_mask = nt.nodes.new("ShaderNodeTexImage"); tex_mask.image = paint_mask_img; tex_mask.location = (-1200, 400)
sep_mask = nt.nodes.new("ShaderNodeSeparateColor"); sep_mask.location = (-1000, 400)
nt.links.new(tex_mask.outputs["Color"], sep_mask.inputs["Color"])

tex_wear = nt.nodes.new("ShaderNodeTexImage"); tex_wear.image = wear_img; tex_wear.location = (-1200, 0)
sep_wear = nt.nodes.new("ShaderNodeSeparateColor"); sep_wear.location = (-1000, 0)
nt.links.new(tex_wear.outputs["Color"], sep_wear.inputs["Color"])

sub1 = nt.nodes.new("ShaderNodeMath"); sub1.operation = "SUBTRACT"; sub1.inputs[0].default_value = 1.0; sub1.location = (-800, 500)
nt.links.new(sep_mask.outputs["Red"], sub1.inputs[1])
sub2 = nt.nodes.new("ShaderNodeMath"); sub2.operation = "SUBTRACT"; sub2.location = (-650, 500)
nt.links.new(sub1.outputs[0], sub2.inputs[0]); nt.links.new(sep_mask.outputs["Green"], sub2.inputs[1])
sub3 = nt.nodes.new("ShaderNodeMath"); sub3.operation = "SUBTRACT"; sub3.location = (-500, 500)
nt.links.new(sub2.outputs[0], sub3.inputs[0]); nt.links.new(sep_mask.outputs["Blue"], sub3.inputs[1])
clamp_rem = nt.nodes.new("ShaderNodeMath"); clamp_rem.operation = "MAXIMUM"; clamp_rem.inputs[1].default_value = 0.0; clamp_rem.location = (-350, 500)
nt.links.new(sub3.outputs[0], clamp_rem.inputs[0])

mix1 = nt.nodes.new("ShaderNodeMix"); mix1.data_type = "RGBA"; mix1.blend_type = "MIX"; mix1.location = (-200, 400)
mix1.inputs["A"].default_value = (0, 0, 0, 1); mix1.inputs["B"].default_value = PRIMARY
nt.links.new(sep_mask.outputs["Red"], mix1.inputs["Factor"])
mix2 = nt.nodes.new("ShaderNodeMix"); mix2.data_type = "RGBA"; mix2.blend_type = "MIX"; mix2.location = (0, 400)
nt.links.new(mix1.outputs["Result"], mix2.inputs["A"]); mix2.inputs["B"].default_value = SECONDARY
nt.links.new(sep_mask.outputs["Green"], mix2.inputs["Factor"])
mix3 = nt.nodes.new("ShaderNodeMix"); mix3.data_type = "RGBA"; mix3.blend_type = "MIX"; mix3.location = (200, 400)
nt.links.new(mix2.outputs["Result"], mix3.inputs["A"]); mix3.inputs["B"].default_value = TERTIARY
nt.links.new(sep_mask.outputs["Blue"], mix3.inputs["Factor"])
mix4 = nt.nodes.new("ShaderNodeMix"); mix4.data_type = "RGBA"; mix4.blend_type = "MIX"; mix4.location = (400, 400)
nt.links.new(mix3.outputs["Result"], mix4.inputs["A"]); mix4.inputs["B"].default_value = METAL_GENERIC
nt.links.new(clamp_rem.outputs[0], mix4.inputs["Factor"])

wear_amount = nt.nodes.new("ShaderNodeMath"); wear_amount.operation = "MAXIMUM"; wear_amount.location = (-800, 100)
nt.links.new(sep_wear.outputs["Green"], wear_amount.inputs[0]); nt.links.new(sep_wear.outputs["Blue"], wear_amount.inputs[1])
wear_factor = nt.nodes.new("ShaderNodeMath"); wear_factor.operation = "MULTIPLY"; wear_factor.inputs[1].default_value = 0.5; wear_factor.location = (-650, 100)
nt.links.new(wear_amount.outputs[0], wear_factor.inputs[0])
dirt_tint = nt.nodes.new("ShaderNodeRGB"); dirt_tint.outputs[0].default_value = (0.10, 0.085, 0.065, 1.0); dirt_tint.location = (400, 150)
mix5 = nt.nodes.new("ShaderNodeMix"); mix5.data_type = "RGBA"; mix5.blend_type = "MIX"; mix5.location = (600, 400)
nt.links.new(wear_factor.outputs[0], mix5.inputs["Factor"])
nt.links.new(mix4.outputs["Result"], mix5.inputs["A"])
nt.links.new(dirt_tint.outputs[0], mix5.inputs["B"])

emission = nt.nodes.new("ShaderNodeEmission"); emission.location = (800, 400)
nt.links.new(mix5.outputs["Result"], emission.inputs["Color"])
output = nt.nodes.new("ShaderNodeOutputMaterial"); output.location = (1000, 400)
nt.links.new(emission.outputs["Emission"], output.inputs["Surface"])

bake_img = bpy.data.images.new("Assassin_Body_Baked", width=2048, height=2048, alpha=False)
bake_node = nt.nodes.new("ShaderNodeTexImage"); bake_node.image = bake_img; bake_node.location = (800, 700)
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

bake_path = TEX_DIR + "Assassin_Body_Baked.png"
bake_img.filepath_raw = bake_path
bake_img.file_format = "PNG"
bake_img.save()
print(f"BAKED: {bake_path}")

for n in list(nt.nodes):
    nt.nodes.remove(n)
bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled"); bsdf.location = (0, 0)
tex_base = nt.nodes.new("ShaderNodeTexImage"); tex_base.image = bake_img; tex_base.location = (-400, 200)
nt.links.new(tex_base.outputs["Color"], bsdf.inputs["Base Color"])
tex_nrm2 = nt.nodes.new("ShaderNodeTexImage"); tex_nrm2.image = nrm_img; tex_nrm2.location = (-400, -200)
normal_map2 = nt.nodes.new("ShaderNodeNormalMap"); normal_map2.location = (-200, -200)
nt.links.new(tex_nrm2.outputs["Color"], normal_map2.inputs["Color"])
nt.links.new(normal_map2.outputs["Normal"], bsdf.inputs["Normal"])
out2 = nt.nodes.new("ShaderNodeOutputMaterial"); out2.location = (300, 0)
nt.links.new(bsdf.outputs["BSDF"], out2.inputs["Surface"])
print("Body material rebuilt")

# ============ VARIANT: numpy bake (Pattern B) with dirt-tint ============
DIRT_TINT = np.array([0.10, 0.085, 0.065])


def srgb_to_linear(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, np.power((c + 0.055) / 1.055, 2.4))


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def load_pixels(path):
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    return arr.reshape(h, w, 4), img


PRIMARY_N = np.array([0.028325, 0.062928, 0.078125])
SECONDARY_N = np.array([0.333333, 0.065163, 0.008481])
TERTIARY_N = np.array([0.588542, 0.571195, 0.570151])
METAL_N = np.array([0.2117, 0.2117, 0.2117])

mask_arr, _ = load_pixels(TEX_DIR + "Assassin_Variant_Default_MSK.png")
wear_arr, _ = load_pixels(TEX_DIR + "Assassin_Variant_Wear_MSK.png")
R = mask_arr[..., 0]; G = mask_arr[..., 1]; B = mask_arr[..., 2]
remainder = np.clip(1.0 - R - G - B, 0.0, 1.0)
h, w = R.shape

result = np.zeros((h, w, 3), dtype=np.float32)
for i in range(3):
    result[..., i] = R * PRIMARY_N[i] + G * SECONDARY_N[i] + B * TERTIARY_N[i] + remainder * METAL_N[i]

wear_amount_v = np.maximum(wear_arr[..., 1], wear_arr[..., 2]) * 0.5
result = result * (1 - wear_amount_v[..., None]) + DIRT_TINT[None, None, :] * wear_amount_v[..., None]
result = linear_to_srgb(result)

out = np.ones((h, w, 4), dtype=np.float32)
out[..., :3] = result
out_img = bpy.data.images.new("Assassin_Variant_Baked", width=w, height=h, alpha=False)
out_img.pixels.foreach_set(out.ravel())
out_img.filepath_raw = TEX_DIR + "Assassin_Variant_Baked.png"
out_img.file_format = "PNG"
out_img.save()
print("SAVED Variant baked color")

# Safe (narrow) per-region roughness/metallic derived from the same paint mask
for prefix in ["Body", "Variant"]:
    mask_arr2, _ = load_pixels(TEX_DIR + f"Assassin_{prefix}_Default_MSK.png")
    R2 = mask_arr2[..., 0]; G2 = mask_arr2[..., 1]; B2 = mask_arr2[..., 2]
    rem2 = np.clip(1.0 - R2 - G2 - B2, 0.0, 1.0)
    metallic = R2 * 0.10 + G2 * 0.10 + B2 * 0.10 + rem2 * 0.35
    roughness = R2 * 0.65 + G2 * 0.60 + B2 * 0.70 + rem2 * 0.35
    h2, w2 = R2.shape
    for kind, arr in [("Metallic", metallic), ("Roughness", roughness)]:
        rgb = np.ones((h2, w2, 4), dtype=np.float32)
        rgb[..., 0] = arr; rgb[..., 1] = arr; rgb[..., 2] = arr
        img = bpy.data.images.new(f"Assassin_{prefix}_{kind}", width=w2, height=h2, alpha=False)
        img.pixels.foreach_set(rgb.ravel())
        img.filepath_raw = TEX_DIR + f"Assassin_{prefix}_{kind}.png"
        img.file_format = "PNG"
        img.save()
    print(f"SAVED {prefix} roughness/metallic maps")

bnt = mat.node_tree
bbsdf = next(n for n in bnt.nodes if n.type == "BSDF_PRINCIPLED")
r_img = bpy.data.images.load(TEX_DIR + "Assassin_Body_Roughness.png", check_existing=True); r_img.colorspace_settings.name = "Non-Color"
r_node = bnt.nodes.new("ShaderNodeTexImage"); r_node.image = r_img
bnt.links.new(r_node.outputs["Color"], bbsdf.inputs["Roughness"])
m_img = bpy.data.images.load(TEX_DIR + "Assassin_Body_Metallic.png", check_existing=True); m_img.colorspace_settings.name = "Non-Color"
m_node = bnt.nodes.new("ShaderNodeTexImage"); m_node.image = m_img
bnt.links.new(m_node.outputs["Color"], bbsdf.inputs["Metallic"])

variant_mat = bpy.data.materials.new(name="Assassin_Variant")
variant_mat.use_nodes = True
vnt = variant_mat.node_tree
for n in list(vnt.nodes):
    vnt.nodes.remove(n)
vbsdf = vnt.nodes.new("ShaderNodeBsdfPrincipled")
vtex = vnt.nodes.new("ShaderNodeTexImage"); vtex.image = out_img
vnt.links.new(vtex.outputs["Color"], vbsdf.inputs["Base Color"])
v_nrm_img = bpy.data.images.load(TEX_DIR + "Assassin_Variant_NRM.png", check_existing=True); v_nrm_img.colorspace_settings.name = "Non-Color"
v_nrm_node = vnt.nodes.new("ShaderNodeTexImage"); v_nrm_node.image = v_nrm_img
v_normal_map = vnt.nodes.new("ShaderNodeNormalMap")
vnt.links.new(v_nrm_node.outputs["Color"], v_normal_map.inputs["Color"])
vnt.links.new(v_normal_map.outputs["Normal"], vbsdf.inputs["Normal"])
vr_img = bpy.data.images.load(TEX_DIR + "Assassin_Variant_Roughness.png", check_existing=True); vr_img.colorspace_settings.name = "Non-Color"
vr_node = vnt.nodes.new("ShaderNodeTexImage"); vr_node.image = vr_img
vnt.links.new(vr_node.outputs["Color"], vbsdf.inputs["Roughness"])
vm_img = bpy.data.images.load(TEX_DIR + "Assassin_Variant_Metallic.png", check_existing=True); vm_img.colorspace_settings.name = "Non-Color"
vm_node = vnt.nodes.new("ShaderNodeTexImage"); vm_node.image = vm_img
vnt.links.new(vm_node.outputs["Color"], vbsdf.inputs["Metallic"])
vout = vnt.nodes.new("ShaderNodeOutputMaterial")
vnt.links.new(vbsdf.outputs["BSDF"], vout.inputs["Surface"])
print("Body/Variant materials wired")

# ============ WEAPONS material: real MetalID recipe, safe capped metallic ============
weapons_mat = bpy.data.materials.new(name="Assassin_Weapons")
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
print("Assassin_Weapons material built")

variant_mat.use_fake_user = True
weapons_mat.use_fake_user = True

bpy.ops.wm.save_as_mainfile(filepath=OUT_PATH)
print("SAVED (all materials)", OUT_PATH)
