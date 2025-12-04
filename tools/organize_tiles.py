#!/usr/bin/env python3
"""
Organiza los tiles de BattleTech y genera configuración compatible con el editor
"""

import os
import shutil
import json
from pathlib import Path

SOURCE_DIR = Path(__file__).parent.parent / "assets" / "markers" / "extraidos" / "Mech Hex Tiles"
OUTPUT_DIR = Path(__file__).parent.parent / "assets" / "tiles" / "battletech"
CONFIG_PATH = Path(__file__).parent.parent / "config" / "tiles.json"

# Mapeo completo según el CSV
TILE_INFO = {
    # Grass
    11: {"name": "Llanura", "category": "terrain", "movement_cost": 1, "defense_bonus": 0},
    12: {"name": "Llanura (Mega)", "category": "terrain", "movement_cost": 1, "defense_bonus": 0, "size": "mega"},
    
    # Woods
    13: {"name": "Bosque 1", "category": "woods", "movement_cost": 2, "defense_bonus": 1},
    14: {"name": "Bosque 2", "category": "woods", "movement_cost": 2, "defense_bonus": 1},
    15: {"name": "Bosque Denso 1", "category": "woods", "movement_cost": 3, "defense_bonus": 2, "blocksLOS": True},
    16: {"name": "Bosque 3", "category": "woods", "movement_cost": 2, "defense_bonus": 1},
    17: {"name": "Bosque Denso 2", "category": "woods", "movement_cost": 3, "defense_bonus": 2, "blocksLOS": True},
    18: {"name": "Bosque Denso 3", "category": "woods", "movement_cost": 3, "defense_bonus": 2, "blocksLOS": True},
    19: {"name": "Bosque 4", "category": "woods", "movement_cost": 2, "defense_bonus": 1},
    20: {"name": "Bosque 5", "category": "woods", "movement_cost": 2, "defense_bonus": 1},
    21: {"name": "Bosque Denso 4", "category": "woods", "movement_cost": 3, "defense_bonus": 2, "blocksLOS": True},
    
    # Lakes
    22: {"name": "Lago 1", "category": "water", "movement_cost": 4, "defense_bonus": 0},
    23: {"name": "Lago 2", "category": "water", "movement_cost": 4, "defense_bonus": 0},
    24: {"name": "Lago 3", "category": "water", "movement_cost": 4, "defense_bonus": 0},
    25: {"name": "Lago 4", "category": "water", "movement_cost": 4, "defense_bonus": 0},
    26: {"name": "Lago Grande", "category": "water", "movement_cost": 4, "defense_bonus": 0, "size": "large"},
    
    # Rivers
    27: {"name": "Río 1", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    28: {"name": "Río 2", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    29: {"name": "Río 3", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    30: {"name": "Río 4", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    31: {"name": "Río 5", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    32: {"name": "Río 6", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    33: {"name": "Río 7", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    34: {"name": "Río 8", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    35: {"name": "Río 9", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    36: {"name": "Río 10", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    37: {"name": "Río 11", "category": "water", "movement_cost": 3, "defense_bonus": 0},
    38: {"name": "Río Largo 1", "category": "water", "movement_cost": 3, "defense_bonus": 0, "size": "long"},
    39: {"name": "Río Largo 2", "category": "water", "movement_cost": 3, "defense_bonus": 0, "size": "long"},
    
    # Buildings
    40: {"name": "Edificio 1", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    41: {"name": "Edificio 2", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    42: {"name": "Edificio 3", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    43: {"name": "Edificio 4", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    44: {"name": "Edificio 5", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    45: {"name": "Búnker", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    46: {"name": "Edificio Medio 1", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    47: {"name": "Edificio Medio 2", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    48: {"name": "Edificio Medio 3", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    49: {"name": "Edificio Medio 4", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    50: {"name": "Edificio Medio 5", "category": "urban", "movement_cost": 999, "defense_bonus": 3, "blocksLOS": True},
    51: {"name": "Edificio Grande 1", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    52: {"name": "Edificio Grande 2", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    53: {"name": "Edificio Grande 3", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    54: {"name": "Edificio Grande 4", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    55: {"name": "Edificio Grande 5", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    56: {"name": "Edificio Grande 6", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    57: {"name": "Edificio Grande 7", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True},
    58: {"name": "Complejo Industrial", "category": "urban", "movement_cost": 999, "defense_bonus": 4, "blocksLOS": True, "size": "mega"},
    
    # Rough terrain
    59: {"name": "Rocoso", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    60: {"name": "Terreno Difícil", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    61: {"name": "Rough 1", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    62: {"name": "Rough 2", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    63: {"name": "Rough 3", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    64: {"name": "Rough 4", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    65: {"name": "Rough 5", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    66: {"name": "Rough 6", "category": "rough", "movement_cost": 2, "defense_bonus": 1},
    
    # Rubble
    67: {"name": "Escombros 1", "category": "rubble", "movement_cost": 2, "defense_bonus": 1},
    68: {"name": "Escombros 2", "category": "rubble", "movement_cost": 2, "defense_bonus": 1},
    69: {"name": "Escombros LR 1", "category": "rubble", "movement_cost": 2, "defense_bonus": 1},
    70: {"name": "Escombros LR 2", "category": "rubble", "movement_cost": 2, "defense_bonus": 1},
    
    # Hazards
    71: {"name": "Minas Vibra", "category": "hazards", "movement_cost": 1, "defense_bonus": 0, "special": "mine_vibra"},
    72: {"name": "Minas Detonación", "category": "hazards", "movement_cost": 1, "defense_bonus": 0, "special": "mine_command"},
    73: {"name": "Minas Convencional", "category": "hazards", "movement_cost": 1, "defense_bonus": 0, "special": "mine_conv"},
    74: {"name": "Humo", "category": "hazards", "movement_cost": 1, "defense_bonus": 1, "blocksLOS": True},
    75: {"name": "Fuego", "category": "hazards", "movement_cost": 2, "defense_bonus": 0, "special": "fire"},
}

# Thumbnails (76-140) mapeo a tiles originales
THUMBNAIL_MAP = {
    76: 11, 77: 12,  # Grass
    78: 13, 79: 14, 80: 15, 81: 16, 82: 17, 83: 18, 84: 19, 85: 20, 86: 21,  # Woods
    87: 22, 88: 23, 89: 24, 90: 25, 91: 26,  # Lakes
    92: 27, 93: 28, 94: 29, 95: 30, 96: 31, 97: 32, 98: 33, 99: 34, 100: 35, 101: 36, 102: 37, 103: 38, 104: 39,  # Rivers
    105: 40, 106: 41, 107: 42, 108: 43, 109: 44, 110: 45, 111: 46, 112: 47, 113: 48, 114: 49, 115: 50,  # Buildings
    116: 51, 117: 52, 118: 53, 119: 54, 120: 55, 121: 56, 122: 57, 123: 58,  # Large buildings
    124: 59, 125: 60, 126: 61, 127: 62, 128: 63, 129: 64, 130: 65, 131: 66,  # Rough
    132: 67, 133: 68, 134: 69, 135: 70,  # Rubble
    136: 71, 137: 72, 138: 73, 139: 74, 140: 75,  # Hazards
}

CATEGORY_INFO = {
    "terrain": {"name": "Terreno", "icon": "🌿", "color": "#4a7c23"},
    "woods": {"name": "Bosques", "icon": "🌲", "color": "#2e7d32"},
    "water": {"name": "Agua", "icon": "💧", "color": "#1976d2"},
    "urban": {"name": "Urbano", "icon": "🏢", "color": "#757575"},
    "rough": {"name": "Rocoso", "icon": "🪨", "color": "#8d6e63"},
    "rubble": {"name": "Escombros", "icon": "🧱", "color": "#a1887f"},
    "hazards": {"name": "Peligros", "icon": "⚠️", "color": "#f44336"},
}

def organize_tiles():
    """Organiza los tiles en la estructura correcta"""
    
    # Crear directorio de salida
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    print("🗂️ Organizando tiles de BattleTech...")
    
    # Copiar tiles principales (11-75)
    copied = 0
    for tile_num in range(11, 76):
        src = SOURCE_DIR / f"{tile_num}.png"
        if src.exists():
            dest = OUTPUT_DIR / f"{tile_num}.png"
            shutil.copy2(src, dest)
            copied += 1
    
    # Copiar thumbnails (76-140)
    thumb_dir = OUTPUT_DIR / "thumbnails"
    thumb_dir.mkdir(exist_ok=True)
    
    for thumb_num in range(76, 141):
        src = SOURCE_DIR / f"{thumb_num}.png"
        if src.exists():
            dest = thumb_dir / f"{thumb_num}.png"
            shutil.copy2(src, dest)
            copied += 1
    
    print(f"   ✅ {copied} archivos copiados")
    
    # Generar configuración
    generate_config()

def generate_config():
    """Genera el archivo de configuración compatible con el editor"""
    
    config = {
        "system": "battletech",
        "name": "BattleTech",
        "gridType": "hex",
        "hexSize": 84,
        "categories": {},
        "tiles": {}
    }
    
    # Construir categorías
    for cat_id, cat_info in CATEGORY_INFO.items():
        config["categories"][cat_id] = {
            "name": cat_info["name"],
            "icon": cat_info["icon"],
            "color": cat_info["color"]
        }
    
    # Construir tiles
    for tile_num, info in TILE_INFO.items():
        tile_id = f"tile_{tile_num}"
        
        # Buscar thumbnail correspondiente
        thumb_num = None
        for th, orig in THUMBNAIL_MAP.items():
            if orig == tile_num:
                thumb_num = th
                break
        
        tile_data = {
            "id": tile_id,
            "name": info["name"],
            "category": info["category"],
            "file": f"/assets/tiles/battletech/{tile_num}.png",
            "thumbnail": f"/assets/tiles/battletech/thumbnails/{thumb_num}.png" if thumb_num else None,
            "movementCost": info["movement_cost"],
            "defenseBonus": info["defense_bonus"],
            "color": CATEGORY_INFO[info["category"]]["color"],
            "icon": CATEGORY_INFO[info["category"]]["icon"]
        }
        
        # Añadir propiedades especiales
        if info.get("blocksLOS"):
            tile_data["blocksLOS"] = True
            tile_data["blocksVision"] = True
        if info.get("special"):
            tile_data["special"] = info["special"]
        if info.get("size"):
            tile_data["size"] = info["size"]
        
        config["tiles"][tile_id] = tile_data
    
    # Guardar
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    
    print(f"   📄 Configuración guardada en {CONFIG_PATH}")
    print(f"      - {len(config['categories'])} categorías")
    print(f"      - {len(config['tiles'])} tiles")

if __name__ == "__main__":
    organize_tiles()
    print("\n✨ ¡Tiles organizados correctamente!")
