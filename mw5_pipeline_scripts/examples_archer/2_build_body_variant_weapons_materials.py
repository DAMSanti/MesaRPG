import bpy
import os
import numpy as np

IN_PATH = OUT_PATH = r"D:\Portfolio\mesa\MesaRPG\models\Archer_new.blend"
TEX_DIR = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\activos\Archer\Model\Body\Materials\Textures" + os.sep
COMMON_TEX = r"D:\Portfolio\mesa\MesaRPG\modelsmw5\_Common\Textures"

bpy.ops.wm.open_mainfile(filepath=IN_PATH)

# Real default colors (Archer's own SKN had no override, base shared
# material's own defaults apply): PaintColorPrimary/Secondary/Tertiary
# from _Common/Material/BaseMech_MTI.json.
PRIMARY = (0.028325, 0.062928, 0.078125, 1.0)
SECONDARY = (0.333333, 0.065163, 0.008481, 1.0)
TERTIARY = (0.588542, 0.571195, 0.570151, 1.0)
METAL_GENERIC = (0.2117, 0.2117, 0.2117, 1.0)
DIRT_TINT_LINEAR = np.array([0.10, 0.085, 0.065])

# ============ BODY: Cycles bake (Pattern A) ============
body_mesh = next(o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Archer"))
mat = body_mesh.data.materials[0] if body_mesh.data.materials else None
if mat is None:
    mat = bpy.data.materials.new(name="Archer_Body")
    body_mesh.data.materials.append(mat)
mat.name = "Archer_Body"
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)


def load_img(name, colorspace="sRGB"):
    img = bpy.data.images.load(TEX_DIR + name, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


paint_mask_img = load_img("Archer_Body_Default_MSK.png")
wear_img = load_img("Archer_Body_Wear_MSK.png", colorspace="Non-Color")
nrm_img = load_img("Archer_Body_NRM.png", colorspace="Non-Color")

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

bake_img = bpy.data.images.new("Archer_Body_Baked", width=2048, height=2048, alpha=False)
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

bake_path = TEX_DIR + "Archer_Body_Baked.png"
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
print("Body material rebuilt (simple, export-safe)")

bpy.ops.wm.save_as_mainfile(filepath=OUT_PATH)
print("SAVED (body pass)", OUT_PATH)
