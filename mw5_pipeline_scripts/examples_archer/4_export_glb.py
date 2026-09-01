import bpy

bpy.ops.wm.open_mainfile(filepath=r"D:\Portfolio\mesa\MesaRPG\models\Archer_new.blend")

out_path = r"D:\Portfolio\mesa\MesaRPG\rewrite\frontend\public\models\mechs\Archer.glb"

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    use_selection=False,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_skins=True,
    export_apply=False,
)
print("EXPORTED TO", out_path)

import os
print("size bytes:", os.path.getsize(out_path))
