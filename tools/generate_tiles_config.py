#!/usr/bin/env python3
"""Genera tiles_battletech.json con los tiles individuales extraídos"""

import os
import json
from pathlib import Path

SINGLES_DIR = Path("assets/tiles/battletech_singles")
OUTPUT = Path("config/tiles_battletech.json")

# Info de cada tile base
TILE_INFO = {
    11: ("Llanura", "terrain", 1, 0),
    12: ("Llanura Mega", "terrain", 1, 0),
    13: ("Bosque 1", "woods", 2, 1),
    14: ("Bosque 2", "woods", 2, 1),
    15: ("Bosque Denso 1", "woods", 3, 2),
    16: ("Bosque 3", "woods", 2, 1),
    17: ("Bosque Denso 2", "woods", 3, 2),
    18: ("Bosque Denso 3", "woods", 3, 2),
    19: ("Bosque 4", "woods", 2, 1),
    20: ("Bosque 5", "woods", 2, 1),
    21: ("Bosque Denso 4", "woods", 3, 2),
    22: ("Lago 1", "water", 4, 0),
    23: ("Lago 2", "water", 4, 0),
    24: ("Lago 3", "water", 4, 0),
    25: ("Lago 4", "water", 4, 0),
    27: ("Río 1", "water", 3, 0),
    28: ("Río 2", "water", 3, 0),
    29: ("Río 3", "water", 3, 0),
    30: ("Río 4", "water", 3, 0),
    31: ("Río 5", "water", 3, 0),
    32: ("Río 6", "water", 3, 0),
    33: ("Río 7", "water", 3, 0),
    34: ("Río 8", "water", 3, 0),
    35: ("Río 9", "water", 3, 0),
    36: ("Río 10", "water", 3, 0),
    37: ("Río 11", "water", 3, 0),
    38: ("Río Largo 1", "water", 3, 0),
    39: ("Río Largo 2", "water", 3, 0),
    40: ("Edificio 1", "urban", 999, 3),
    41: ("Edificio 2", "urban", 999, 3),
    42: ("Edificio 3", "urban", 999, 3),
    43: ("Edificio 4", "urban", 999, 3),
    44: ("Edificio 5", "urban", 999, 3),
    45: ("Búnker", "urban", 999, 4),
    46: ("Edificio Medio 1", "urban", 999, 3),
    47: ("Edificio Medio 2", "urban", 999, 3),
    48: ("Edificio Medio 3", "urban", 999, 3),
    49: ("Edificio Medio 4", "urban", 999, 3),
    50: ("Edificio Medio 5", "urban", 999, 3),
    51: ("Edificio Grande 1", "urban", 999, 4),
    52: ("Edificio Grande 2", "urban", 999, 4),
    53: ("Edificio Grande 3", "urban", 999, 4),
    54: ("Edificio Grande 4", "urban", 999, 4),
    55: ("Edificio Grande 5", "urban", 999, 4),
    56: ("Edificio Grande 6", "urban", 999, 4),
    57: ("Edificio Grande 7", "urban", 999, 4),
    59: ("Rocoso", "rough", 2, 1),
    60: ("Terreno Difícil", "rough", 2, 1),
    61: ("Rough 1", "rough", 2, 1),
    62: ("Rough 2", "rough", 2, 1),
    63: ("Rough 3", "rough", 2, 1),
    64: ("Rough 4", "rough", 2, 1),
    65: ("Rough 5", "rough", 2, 1),
    66: ("Rough 6", "rough", 2, 1),
    67: ("Escombros 1", "rubble", 2, 1),
    68: ("Escombros 2", "rubble", 2, 1),
    69: ("Escombros LR 1", "rubble", 2, 1),
    70: ("Escombros LR 2", "rubble", 2, 1),
    71: ("Minas Vibra", "hazards", 1, 0),
    72: ("Minas Detonación", "hazards", 1, 0),
    73: ("Minas Convencional", "hazards", 1, 0),
    74: ("Humo", "hazards", 1, 1),
}

config = {
    "system": "battletech",
    "name": "BattleTech Singles",
    "gridType": "hex",
    "hexSize": 84,
    "categories": {
        "terrain": {"name": "Terreno", "icon": "🌿", "color": "#4a7c23"},
        "woods": {"name": "Bosques", "icon": "🌲", "color": "#2e7d32"},
        "water": {"name": "Agua", "icon": "💧", "color": "#1976d2"},
        "urban": {"name": "Urbano", "icon": "🏢", "color": "#757575"},
        "rough": {"name": "Rocoso", "icon": "🪨", "color": "#8d6e63"},
        "rubble": {"name": "Escombros", "icon": "🧱", "color": "#a1887f"},
        "hazards": {"name": "Peligros", "icon": "⚠️", "color": "#f44336"},
    },
    "tiles": {}
}

# Escanear archivos PNG
for f in sorted(SINGLES_DIR.glob("*.png")):
    name = f.stem  # ej: "12_0" o "11"
    
    # Determinar tile base
    if "_" in name:
        base_num = int(name.split("_")[0])
        idx = name.split("_")[1]
    else:
        base_num = int(name)
        idx = None
    
    if base_num not in TILE_INFO:
        continue
    
    info = TILE_INFO[base_num]
    tile_name = info[0]
    if idx is not None:
        tile_name += f" #{idx}"
    
    tile_id = f"bt_{name}"
    config["tiles"][tile_id] = {
        "id": tile_id,
        "name": tile_name,
        "category": info[1],
        "file": f"/assets/tiles/battletech_singles/{name}.png",
        "movementCost": info[2],
        "defenseBonus": info[3],
        "group": str(base_num) if idx else None
    }

# Guardar
with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"✅ Generado {OUTPUT} con {len(config['tiles'])} tiles")
