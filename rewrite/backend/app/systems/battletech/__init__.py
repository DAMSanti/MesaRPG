# Deliberately no eager `from . import turns` (or any other submodule)
# here — every real caller already does `from app.systems.battletech
# import X` explicitly (main.py, units.py, tests), and turns.py/
# movement.py both import `app.units` at module load time, which in
# turn imports `mechs` from this same package (units.py needs mech
# data to resolve a unit's display fields) — an eager import here would
# make importing THIS package's __init__ transitively re-enter
# app.units mid-load, a real circular-import trap this file avoids by
# just staying empty and letting each caller import exactly the
# submodule it needs.
