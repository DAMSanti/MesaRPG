#!/usr/bin/env python3
"""
Analiza los tiles extraídos y genera un reporte HTML para revisarlos visualmente
"""

import os
from pathlib import Path

TILES_DIR = Path(__file__).parent.parent / "assets" / "markers" / "extraidos" / "Mech Hex Tiles"
OUTPUT_DIR = Path(__file__).parent.parent / "assets" / "tiles" / "battletech"
REPORT_PATH = Path(__file__).parent.parent / "assets" / "markers" / "extraidos" / "tile_report.html"

def generate_report():
    """Genera un HTML con todos los tiles para revisar visualmente"""
    
    tiles = sorted([f for f in os.listdir(TILES_DIR) if f.endswith('.png')], 
                   key=lambda x: int(x.replace('.png', '')) if x.replace('.png', '').isdigit() else 999)
    
    html = '''<!DOCTYPE html>
<html>
<head>
    <title>BattleTech Tiles - Revisión</title>
    <style>
        body { 
            background: #1a1a2e; 
            color: white; 
            font-family: Arial; 
            padding: 20px;
        }
        h1 { color: #4ecdc4; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 10px;
        }
        .tile {
            background: #2d2d44;
            border-radius: 8px;
            padding: 10px;
            text-align: center;
        }
        .tile img {
            max-width: 120px;
            max-height: 120px;
            border: 2px solid #333;
        }
        .tile .name {
            margin-top: 5px;
            font-size: 14px;
            color: #888;
        }
        .tile input {
            margin-top: 5px;
        }
        .categories {
            margin-bottom: 20px;
            padding: 15px;
            background: #2d2d44;
            border-radius: 8px;
        }
        .categories label {
            margin-right: 15px;
        }
    </style>
</head>
<body>
    <h1>🎯 BattleTech Hex Tiles - Revisión</h1>
    <p>Total: ''' + str(len(tiles)) + ''' tiles encontrados</p>
    
    <div class="categories">
        <h3>Categorías sugeridas:</h3>
        <p>🌿 Llanura | 🌲 Bosque Ligero | 🌳 Bosque Denso | 💧 Agua | 🏔️ Colinas | ⛰️ Montaña</p>
        <p>🏢 Edificio | 🛤️ Carretera | 🔥 Fuego | 💨 Humo | 🧱 Escombros | ❄️ Hielo/Nieve</p>
    </div>
    
    <div class="grid">
'''
    
    for tile in tiles:
        tile_num = tile.replace('.png', '')
        html += f'''
        <div class="tile">
            <img src="Mech Hex Tiles/{tile}" alt="{tile}">
            <div class="name">{tile_num}</div>
        </div>
'''
    
    html += '''
    </div>
    
    <script>
        // Click en imagen para marcarla
        document.querySelectorAll('.tile img').forEach(img => {
            img.onclick = () => {
                img.style.border = img.style.border === '2px solid lime' ? '2px solid #333' : '2px solid lime';
            };
        });
    </script>
</body>
</html>
'''
    
    with open(REPORT_PATH, 'w', encoding='utf-8') as f:
        f.write(html)
    
    print(f"✅ Reporte generado: {REPORT_PATH}")
    print(f"   Abre el archivo en un navegador para revisar los {len(tiles)} tiles")

if __name__ == "__main__":
    generate_report()
