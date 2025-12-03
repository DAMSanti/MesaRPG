"""
MesaRPG - Generador de Tokens para D&D y BattleTech
Genera tokens visuales para representar personajes y mechs en el juego
"""

from pathlib import Path
import math


def generate_dnd_token_svg(name: str, icon: str, color1: str, color2: str, border_color: str) -> str:
    """Genera un token SVG circular para D&D"""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bg_{name}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:{color1}"/>
            <stop offset="100%" style="stop-color:{color2}"/>
        </linearGradient>
        <filter id="shadow_{name}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.5"/>
        </filter>
    </defs>
    
    <!-- Token base -->
    <circle cx="64" cy="64" r="58" fill="url(#bg_{name})" 
            stroke="{border_color}" stroke-width="4" filter="url(#shadow_{name})"/>
    
    <!-- Inner ring -->
    <circle cx="64" cy="64" r="48" fill="none" 
            stroke="{border_color}" stroke-width="2" opacity="0.5"/>
    
    <!-- Class icon -->
    <text x="64" y="58" font-size="40" text-anchor="middle" 
          dominant-baseline="middle" fill="white" opacity="0.9">{icon}</text>
    
    <!-- Class name -->
    <text x="64" y="100" font-family="Arial, sans-serif" font-size="12" font-weight="bold"
          text-anchor="middle" fill="white">{name.upper()}</text>
</svg>'''


def generate_battletech_token_svg(name: str, icon: str, color1: str, color2: str, 
                                   border_color: str, tonnage: int) -> str:
    """Genera un token SVG hexagonal para BattleTech mechs"""
    # Hexagon points for a 128x128 viewbox
    hex_points = "64,4 118,34 118,94 64,124 10,94 10,34"
    
    # Weight class indicator
    if tonnage <= 35:
        weight_class = "L"  # Light
        weight_color = "#4CAF50"
    elif tonnage <= 55:
        weight_class = "M"  # Medium
        weight_color = "#2196F3"
    elif tonnage <= 75:
        weight_class = "H"  # Heavy
        weight_color = "#FF9800"
    else:
        weight_class = "A"  # Assault
        weight_color = "#f44336"
    
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bg_{name}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:{color1}"/>
            <stop offset="100%" style="stop-color:{color2}"/>
        </linearGradient>
        <linearGradient id="metal_{name}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:#666"/>
            <stop offset="50%" style="stop-color:#444"/>
            <stop offset="100%" style="stop-color:#222"/>
        </linearGradient>
        <filter id="shadow_{name}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.5"/>
        </filter>
    </defs>
    
    <!-- Token base (hexagon) -->
    <polygon points="{hex_points}" fill="url(#bg_{name})" 
             stroke="{border_color}" stroke-width="4" filter="url(#shadow_{name})"/>
    
    <!-- Inner hexagon -->
    <polygon points="64,14 108,39 108,89 64,114 20,89 20,39" 
             fill="none" stroke="{border_color}" stroke-width="2" opacity="0.5"/>
    
    <!-- Mech silhouette/icon -->
    <text x="64" y="55" font-size="36" text-anchor="middle" 
          dominant-baseline="middle" fill="white" opacity="0.9">{icon}</text>
    
    <!-- Mech name -->
    <text x="64" y="85" font-family="Arial, sans-serif" font-size="10" font-weight="bold"
          text-anchor="middle" fill="white">{name.upper()}</text>
    
    <!-- Weight class indicator -->
    <circle cx="100" cy="20" r="12" fill="{weight_color}" stroke="#fff" stroke-width="1"/>
    <text x="100" y="20" font-family="Arial, sans-serif" font-size="12" font-weight="bold"
          text-anchor="middle" dominant-baseline="middle" fill="white">{weight_class}</text>
    
    <!-- Tonnage -->
    <text x="100" y="108" font-family="Arial, sans-serif" font-size="9" font-weight="bold"
          text-anchor="middle" fill="{weight_color}">{tonnage}T</text>
</svg>'''


def generate_generic_token_svg(name: str, color: str, number: int = None) -> str:
    """Genera un token genérico numerado"""
    display = str(number) if number else name[0].upper()
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <radialGradient id="bg_{name}" cx="30%" cy="30%" r="70%">
            <stop offset="0%" style="stop-color:{color}"/>
            <stop offset="100%" style="stop-color:#333"/>
        </radialGradient>
        <filter id="shadow_{name}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.5"/>
        </filter>
    </defs>
    
    <circle cx="64" cy="64" r="58" fill="url(#bg_{name})" 
            stroke="#ffd700" stroke-width="4" filter="url(#shadow_{name})"/>
    <circle cx="64" cy="64" r="48" fill="none" stroke="#ffd700" stroke-width="2" opacity="0.3"/>
    
    <text x="64" y="64" font-family="Arial Black, sans-serif" font-size="48" font-weight="bold"
          text-anchor="middle" dominant-baseline="middle" fill="white">{display}</text>
</svg>'''


# D&D Classes con iconos y colores temáticos
DND_TOKENS = [
    # (name, icon, color1, color2, border_color)
    ("barbarian", "⚔️", "#8B0000", "#4A0000", "#CD853F"),
    ("bard", "🎵", "#9932CC", "#4B0082", "#FFD700"),
    ("cleric", "✝️", "#FFD700", "#B8860B", "#FFFFFF"),
    ("druid", "🌿", "#228B22", "#006400", "#8FBC8F"),
    ("fighter", "🛡️", "#708090", "#2F4F4F", "#C0C0C0"),
    ("monk", "👊", "#DAA520", "#8B4513", "#FFE4B5"),
    ("paladin", "⚜️", "#4169E1", "#000080", "#FFD700"),
    ("ranger", "🏹", "#2E8B57", "#006400", "#8FBC8F"),
    ("rogue", "🗡️", "#2F2F2F", "#1A1A1A", "#696969"),
    ("sorcerer", "🔮", "#FF4500", "#8B0000", "#FF6347"),
    ("warlock", "👁️", "#4B0082", "#2F0040", "#9400D3"),
    ("wizard", "⭐", "#1E90FF", "#00008B", "#87CEEB"),
    # Razas comunes como tokens alternativos
    ("dwarf", "⛏️", "#8B4513", "#654321", "#CD853F"),
    ("elf", "🧝", "#00CED1", "#008B8B", "#E0FFFF"),
    ("human", "👤", "#D2691E", "#8B4513", "#DEB887"),
    ("halfling", "🍀", "#32CD32", "#228B22", "#98FB98"),
    ("dragonborn", "🐉", "#B22222", "#8B0000", "#FF6347"),
    ("tiefling", "😈", "#8B008B", "#4B0082", "#DA70D6"),
    # Monstruos/NPCs
    ("goblin", "👺", "#556B2F", "#2F4F2F", "#6B8E23"),
    ("orc", "👹", "#3CB371", "#2E8B57", "#90EE90"),
    ("skeleton", "💀", "#F5F5DC", "#D3D3D3", "#FFFFFF"),
    ("zombie", "🧟", "#4A5D23", "#2F4F2F", "#6B8E23"),
]

# BattleTech Mechs con iconos, colores y tonelaje
BATTLETECH_TOKENS = [
    # Light Mechs (20-35 tons)
    ("locust", "🦗", "#4CAF50", "#2E7D32", "#81C784", 20),
    ("commando", "🎯", "#66BB6A", "#388E3C", "#A5D6A7", 25),
    ("jenner", "⚡", "#43A047", "#2E7D32", "#81C784", 35),
    ("panther", "🐆", "#388E3C", "#1B5E20", "#66BB6A", 35),
    ("firestarter", "🔥", "#FF5722", "#E64A19", "#FF8A65", 35),
    
    # Medium Mechs (40-55 tons)
    ("cicada", "🦟", "#2196F3", "#1976D2", "#64B5F6", 40),
    ("hunchback", "💪", "#1E88E5", "#1565C0", "#42A5F5", 50),
    ("centurion", "🛡️", "#1976D2", "#0D47A1", "#2196F3", 50),
    ("wolverine", "🔱", "#0D47A1", "#0D47A1", "#1565C0", 55),
    ("shadowhawk", "🦅", "#1565C0", "#0D47A1", "#1976D2", 55),
    
    # Heavy Mechs (60-75 tons)
    ("dragon", "🐲", "#FF9800", "#F57C00", "#FFB74D", 60),
    ("quickdraw", "⚔️", "#FB8C00", "#EF6C00", "#FFA726", 60),
    ("catapult", "🚀", "#F57C00", "#E65100", "#FF9800", 65),
    ("thunderbolt", "⚡", "#EF6C00", "#E65100", "#FB8C00", 65),
    ("grasshopper", "🦗", "#E65100", "#BF360C", "#F57C00", 70),
    ("warhammer", "🔨", "#FF5722", "#E64A19", "#FF7043", 70),
    ("marauder", "👊", "#E64A19", "#BF360C", "#FF5722", 75),
    ("archer", "🏹", "#BF360C", "#BF360C", "#E64A19", 70),
    
    # Assault Mechs (80-100 tons)
    ("awesome", "💥", "#f44336", "#D32F2F", "#EF5350", 80),
    ("zeus", "⚡", "#E53935", "#C62828", "#EF5350", 80),
    ("battlemaster", "⭐", "#D32F2F", "#B71C1C", "#E53935", 85),
    ("stalker", "🎯", "#C62828", "#B71C1C", "#D32F2F", 85),
    ("banshee", "👻", "#B71C1C", "#B71C1C", "#C62828", 95),
    ("atlas", "💀", "#8B0000", "#5D0000", "#B71C1C", 100),
    ("king_crab", "🦀", "#A00000", "#6B0000", "#C62828", 100),
]

# Tokens genéricos numerados para jugadores
PLAYER_COLORS = [
    "#E53935",  # Rojo
    "#1E88E5",  # Azul
    "#43A047",  # Verde
    "#FB8C00",  # Naranja
    "#8E24AA",  # Púrpura
    "#00ACC1",  # Cyan
    "#FFB300",  # Amarillo
    "#6D4C41",  # Marrón
    "#546E7A",  # Gris azulado
    "#D81B60",  # Rosa
]


def main():
    base_dir = Path(__file__).parent.parent
    markers_dir = base_dir / "assets" / "markers"
    
    # Crear subdirectorios
    dnd_dir = markers_dir / "dnd"
    bt_dir = markers_dir / "battletech"
    generic_dir = markers_dir / "generic"
    
    dnd_dir.mkdir(parents=True, exist_ok=True)
    bt_dir.mkdir(parents=True, exist_ok=True)
    generic_dir.mkdir(parents=True, exist_ok=True)
    
    print("🎲 Generando tokens para MesaRPG...")
    print()
    
    # Generar tokens D&D
    print("⚔️ Generando tokens de D&D...")
    for name, icon, c1, c2, border in DND_TOKENS:
        svg = generate_dnd_token_svg(name, icon, c1, c2, border)
        path = dnd_dir / f"{name}.svg"
        path.write_text(svg, encoding='utf-8')
        print(f"   ✅ {name}.svg")
    
    print()
    
    # Generar tokens BattleTech
    print("🤖 Generando tokens de BattleTech...")
    for name, icon, c1, c2, border, tonnage in BATTLETECH_TOKENS:
        svg = generate_battletech_token_svg(name, icon, c1, c2, border, tonnage)
        path = bt_dir / f"{name}.svg"
        path.write_text(svg, encoding='utf-8')
        print(f"   ✅ {name}.svg ({tonnage}T)")
    
    print()
    
    # Generar tokens genéricos numerados
    print("🎯 Generando tokens genéricos...")
    for i, color in enumerate(PLAYER_COLORS, 1):
        svg = generate_generic_token_svg(f"player{i}", color, i)
        path = generic_dir / f"player{i}.svg"
        path.write_text(svg, encoding='utf-8')
        print(f"   ✅ player{i}.svg")
    
    print()
    print(f"✨ ¡Generación completada!")
    print(f"   📁 D&D tokens: {dnd_dir}")
    print(f"   📁 BattleTech tokens: {bt_dir}")
    print(f"   📁 Generic tokens: {generic_dir}")
    
    # Generar archivo de índice JSON para uso en el frontend
    token_index = {
        "dnd": [
            {"id": name, "name": name.replace("_", " ").title(), "icon": icon, "file": f"dnd/{name}.svg"}
            for name, icon, _, _, _ in DND_TOKENS
        ],
        "battletech": [
            {"id": name, "name": name.replace("_", " ").title(), "icon": icon, 
             "tonnage": tonnage, "file": f"battletech/{name}.svg"}
            for name, icon, _, _, _, tonnage in BATTLETECH_TOKENS
        ],
        "generic": [
            {"id": f"player{i}", "name": f"Player {i}", "number": i, "file": f"generic/player{i}.svg"}
            for i in range(1, len(PLAYER_COLORS) + 1)
        ]
    }
    
    import json
    index_path = markers_dir / "tokens.json"
    index_path.write_text(json.dumps(token_index, indent=2), encoding='utf-8')
    print(f"   📄 Index: {index_path}")


if __name__ == "__main__":
    main()
