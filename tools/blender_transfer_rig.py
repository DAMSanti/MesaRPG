# Real user request: "hay varios mechs que se parecen al que edite ayer
# el rig... puedes hacerme un script o algo que meta el esqueleto de ese
# mech en los otros, de manera que solo tenga que ajustar los huesos para
# que herede animaciones y todo?"
#
# Run INSIDE Blender (Scripting workspace -> new text -> paste this ->
# Run Script, or `blender --background yourfile.blend --python
# tools/blender_transfer_rig.py`), not with the app's own Python — this
# uses `bpy`, which only exists inside Blender's interpreter.
#
# What it does, per target mesh listed in TARGET_MESH_NAMES:
#   1. Duplicates SOURCE_ARMATURE_NAME (a real object duplicate, not a
#      linked one — so you can freely re-pose/re-scale each copy's bones
#      without it fighting the others). The duplicate's Actions stay
#      SHARED with the original (Blender only deep-copies action data if
#      you explicitly ask it to) — that sharing IS the inheritance this
#      was asked for: Idle/Idle2/WalkStart/WalkEnd/Walk keep working the
#      instant the new armature's bones land close enough to the old
#      poses to read right, no re-animating needed.
#   2. Moves the duplicated armature to the target mesh's own origin, so
#      you're not hunting for it across the scene.
#   3. Parents the target mesh to the new armature with an Armature
#      modifier and creates one EMPTY vertex group per bone — but does
#      NOT run Blender's Automatic Weights. That's deliberate: automatic
#      weighting already failed on this hard-surface geometry once this
#      session (documented from the Jenner rig work) — this hands you the
#      same manual box-select + Vertex Groups "Assign" workflow that
#      actually worked there, on every new mech, instead of quietly
#      reintroducing a step you already know doesn't work.
#
# Still entirely manual afterward, on purpose (this only transplants the
# RIG, not a fitted pose): in Edit Mode on each new armature, move/scale
# each bone to actually fit that mesh's real proportions, then weight-
# paint (or box-select + Assign, per bone) same as before.

import bpy

# ---- Configuration — edit these two before running ------------------

# The already-rigged mech's Armature object name, exactly as it appears
# in the Outliner (e.g. "Armature" or "Armature.Jenner" — whatever you
# actually named it).
SOURCE_ARMATURE_NAME = "Armature"

# One entry per mech you want the rig transplanted onto — the MESH
# object's name (not the armature), exactly as it appears in the
# Outliner. Leave the list with just the mechs you're doing in this pass;
# re-run with a different list any time.
TARGET_MESH_NAMES = [
    "Locust",
    "Commando",
]

# ---- Nothing below this line should need editing ---------------------


def transfer_rig(source_armature_name: str, target_mesh_names: list[str]) -> None:
    source = bpy.data.objects.get(source_armature_name)
    if source is None or source.type != "ARMATURE":
        raise RuntimeError(f"No armature object named {source_armature_name!r} found")

    for mesh_name in target_mesh_names:
        target_mesh = bpy.data.objects.get(mesh_name)
        if target_mesh is None or target_mesh.type != "MESH":
            print(f"[transfer_rig] skipping {mesh_name!r} — no mesh object with that name")
            continue

        # Real duplicate (object.duplicate, not duplicate_linked) — an
        # independent Armature object/mesh/pose-bone-transform data-block
        # per target, so adjusting one mech's bones never moves another's.
        # The two Actions referenced by pose bones stay the SAME
        # data-blocks though (that part is never copied unless you ask
        # for it) — that's the actual "inherit animations" part.
        bpy.ops.object.select_all(action="DESELECT")
        source.select_set(True)
        bpy.context.view_layer.objects.active = source
        bpy.ops.object.duplicate(linked=False)
        new_armature = bpy.context.view_layer.objects.active
        new_armature.name = f"Armature.{mesh_name}"

        # Recenter on the target mesh's own origin — the duplicate starts
        # out sitting exactly where the source was, which is almost never
        # where the new mesh actually is.
        new_armature.location = target_mesh.matrix_world.translation.copy()

        # Empty vertex groups (one per bone), armature-parented, no
        # weights assigned — sets up exactly the box-select + Vertex
        # Groups "Assign 1.0" per-bone workflow instead of Automatic
        # Weights (see the module docstring for why that's deliberate).
        target_mesh.vertex_groups.clear()
        for bone in new_armature.data.bones:
            target_mesh.vertex_groups.new(name=bone.name)

        target_mesh.parent = new_armature
        target_mesh.parent_type = "ARMATURE"
        has_armature_mod = any(m.type == "ARMATURE" for m in target_mesh.modifiers)
        if not has_armature_mod:
            mod = target_mesh.modifiers.new(name="Armature", type="ARMATURE")
            mod.object = new_armature

        print(f"[transfer_rig] {mesh_name}: rig transplanted as {new_armature.name!r} — "
              f"now move/scale its bones (Edit Mode) to fit, then weight-paint per bone.")


transfer_rig(SOURCE_ARMATURE_NAME, TARGET_MESH_NAMES)
