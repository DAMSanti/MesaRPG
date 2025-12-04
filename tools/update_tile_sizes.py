#!/usr/bin/env python3
"""
Script para actualizar tiles_battletech.json con información de tamaño de tiles
basado en las dimensiones de las imágenes
"""

import json
import os
from PIL import Image

# Configuración
TILES_DIR = r"G:\mesa\MesaRPG\assets\tiles\battletech"
CONFIG_FILE = r"G:\mesa\MesaRPG\config\tiles_battletech.json"

# Tamaños de referencia (basados en dimensiones de imagen)
# Un hex básico es aproximadamente 223x194 (pequeño) o 445x386 (grande)
# Usamos el ancho como referencia principal
TILE_SIZES = {
    # (min_width, max_width): (hexCount, shape)
    (0, 250): (1, "single"),           # 223x194 - 1 hex pequeño
    (251, 500): (1, "single"),         # 445x386 - 1 hex grande
    (501, 800): (2, "horizontal"),     # 776x578 - 2 hex
    (801, 1150): (7, "mega"),          # 1105x1147 - 7 hex (mega)
    (1151, 1800): (13, "mega13"),      # 1764x2288 - 13 hex
    (1801, 2200): (19, "mega19"),      # 2092x1145 - 19 hex
}

# Información adicional basada en altura para tiles verticales
def get_hex_count(width, height):
    """Determina el número de hexes basado en dimensiones"""
    
    # Hex básico pequeño
    if width <= 250 and height <= 220:
        return 1, "single"
    
    # Hex básico grande
    if 400 <= width <= 500 and 350 <= height <= 450:
        return 1, "single"
    
    # 2 hex horizontal
    if 700 <= width <= 800 and 500 <= height <= 600:
        return 2, "h2"
    
    # 2 hex vertical (como Woods 4 - 447x767)
    if 400 <= width <= 500 and 700 <= height <= 800:
        return 2, "v2"
    
    # 3 hex (triángulo hacia abajo como Woods 2 - 777x766)
    if 700 <= width <= 800 and 700 <= height <= 800:
        return 3, "tri_down"
    
    # 4 hex (como Woods 9 - 776x958)
    if 700 <= width <= 800 and 900 <= height <= 1000:
        return 4, "h2v2"
    
    # 4 hex vertical largo (como River 12 - 446x1528)
    if 400 <= width <= 500 and 1400 <= height <= 1600:
        return 4, "v4"
    
    # 5 hex (como Woods 6 - 776x1148)
    if 700 <= width <= 800 and 1100 <= height <= 1200:
        return 5, "h2v3"
    
    # 6 hex (como Woods 8 - 1106x1338)
    if 1050 <= width <= 1150 and 1300 <= height <= 1400:
        return 6, "h3v2"
    
    # 7 hex mega (1105x1147)
    if 1050 <= width <= 1150 and 1100 <= height <= 1200:
        return 7, "mega"
    
    # 7 hex mega (alternativo - Woods 1 - 1105x1147)
    if 1100 <= width <= 1120 and 1140 <= height <= 1160:
        return 7, "mega"
    
    # 10 hex (como Building 1 - 1103x765)
    if 1050 <= width <= 1150 and 700 <= height <= 800:
        return 4, "h3"  # 3-4 hex horizontal
    
    # 13 hex (Lake 12 - 1764x2288)
    if 1700 <= width <= 1850 and 2200 <= height <= 2400:
        return 13, "mega13"
    
    # 19 hex (Building 5 - 2092x1145)
    if 2000 <= width <= 2200 and 1100 <= height <= 1200:
        return 10, "h5"  # línea de 5 hex horizontal
    
    # Fallback: calcular aproximado
    base_hex_area = 223 * 194
    img_area = width * height
    estimated = max(1, round(img_area / base_hex_area / 4))  # /4 porque las imágenes son 2x
    return estimated, "unknown"


def main():
    # Cargar JSON actual
    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    tiles = config.get('tiles', {})
    
    print("Analizando tiles...")
    print("-" * 60)
    
    # Analizar cada tile
    for tile_id, tile_data in tiles.items():
        file_path = tile_data.get('file', '')
        if not file_path:
            continue
            
        # Extraer nombre de archivo
        filename = os.path.basename(file_path)
        img_path = os.path.join(TILES_DIR, filename)
        
        if not os.path.exists(img_path):
            print(f"⚠️  {tile_id}: archivo no encontrado: {img_path}")
            continue
        
        # Obtener dimensiones
        with Image.open(img_path) as img:
            width, height = img.size
        
        hex_count, shape = get_hex_count(width, height)
        
        # Actualizar tile data
        if hex_count > 1:
            tile_data['hexCount'] = hex_count
            tile_data['shape'] = shape
            print(f"✅ {tile_id} ({tile_data['name']}): {width}x{height} -> {hex_count} hex ({shape})")
        else:
            # Eliminar campos de multihex si existen
            tile_data.pop('hexCount', None)
            tile_data.pop('shape', None)
            tile_data.pop('size', None)
            print(f"   {tile_id} ({tile_data['name']}): {width}x{height} -> 1 hex")
    
    # Guardar JSON actualizado
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    
    print("-" * 60)
    print(f"✅ Configuración guardada en {CONFIG_FILE}")


if __name__ == '__main__':
    main()
