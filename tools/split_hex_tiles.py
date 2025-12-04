#!/usr/bin/env python3
"""
Script para dividir imágenes de tiles multi-hex en tiles individuales.
Detecta la grid hexagonal y corta cada hexágono por separado.
"""

import os
import sys
from PIL import Image
import math

# Directorio de tiles
TILES_DIR = "assets/tiles/battletech"

# Tamaño de referencia de un hex individual (del tile 61.png que es 1 hex)
# 223x194 para flat-top hex
REF_HEX_WIDTH = 223
REF_HEX_HEIGHT = 194

# Para flat-top hex:
# - width = 2 * size (de punta a punta horizontal)
# - height = sqrt(3) * size (de lado plano a lado plano)
# - horiz_spacing = width * 0.75 (porque se superponen 25%)
# - vert_spacing = height

HORIZ_SPACING = int(REF_HEX_WIDTH * 0.75)  # ~167
VERT_SPACING = REF_HEX_HEIGHT  # 194


def estimate_grid_size(img_width, img_height):
    """Estima cuántas columnas y filas de hexes hay en la imagen."""
    # Para el ancho: primera columna usa width completo, las siguientes usan spacing
    # width = REF_HEX_WIDTH + (cols - 1) * HORIZ_SPACING
    # cols = (width - REF_HEX_WIDTH) / HORIZ_SPACING + 1
    
    cols = max(1, round((img_width - REF_HEX_WIDTH) / HORIZ_SPACING + 1))
    
    # Para el alto: considerando el offset de columnas impares (medio hex)
    # height = rows * VERT_SPACING + VERT_SPACING/2 (para el offset)
    rows = max(1, round(img_height / VERT_SPACING))
    
    return cols, rows


def get_hex_center(col, row, img_width, img_height, total_cols, total_rows):
    """Calcula el centro de un hexágono en la imagen."""
    # Calcular el tamaño real del hex en esta imagen
    if total_cols > 1:
        actual_horiz_spacing = (img_width - REF_HEX_WIDTH) / (total_cols - 1)
    else:
        actual_horiz_spacing = HORIZ_SPACING
    
    actual_hex_width = actual_horiz_spacing / 0.75
    actual_hex_height = actual_hex_width * (REF_HEX_HEIGHT / REF_HEX_WIDTH)
    
    # Centro X
    cx = actual_hex_width / 2 + col * actual_horiz_spacing
    
    # Centro Y - columnas impares están desplazadas hacia abajo
    offset_y = (actual_hex_height / 2) if (col % 2 == 1) else 0
    cy = actual_hex_height / 2 + row * actual_hex_height + offset_y
    
    return cx, cy, actual_hex_width, actual_hex_height


def create_hex_mask(size, hex_width, hex_height):
    """Crea una máscara hexagonal flat-top."""
    from PIL import Image, ImageDraw
    
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    
    cx, cy = size // 2, size // 2
    radius = min(hex_width, hex_height) // 2
    
    # Puntos del hexágono flat-top (empezando desde la derecha, ángulo 0)
    points = []
    for i in range(6):
        angle = math.pi / 3 * i  # 60 grados entre cada punto
        px = cx + radius * math.cos(angle)
        py = cy + radius * math.sin(angle)
        points.append((px, py))
    
    draw.polygon(points, fill=255)
    return mask


def extract_hex(img, cx, cy, hex_width, hex_height):
    """Extrae un hexágono de la imagen."""
    # Tamaño del recorte (cuadrado que contiene el hex)
    size = int(max(hex_width, hex_height) * 1.1)
    half = size // 2
    
    # Coordenadas de recorte
    left = int(cx - half)
    top = int(cy - half)
    right = int(cx + half)
    bottom = int(cy + half)
    
    # Asegurarse de que está dentro de los límites
    img_width, img_height = img.size
    left = max(0, left)
    top = max(0, top)
    right = min(img_width, right)
    bottom = min(img_height, bottom)
    
    # Recortar
    cropped = img.crop((left, top, right, bottom))
    
    return cropped


def split_tile(tile_path, output_dir):
    """Divide un tile multi-hex en tiles individuales."""
    img = Image.open(tile_path)
    img_width, img_height = img.size
    
    # Si es un tile pequeño (1 hex), no hacer nada
    if img_width <= REF_HEX_WIDTH * 1.2 and img_height <= REF_HEX_HEIGHT * 1.2:
        print(f"  → Tile individual, saltando")
        return []
    
    cols, rows = estimate_grid_size(img_width, img_height)
    print(f"  → Detectado: {cols} columnas x {rows} filas")
    
    tile_name = os.path.splitext(os.path.basename(tile_path))[0]
    extracted = []
    
    for col in range(cols):
        for row in range(rows):
            cx, cy, hex_w, hex_h = get_hex_center(col, row, img_width, img_height, cols, rows)
            
            # Verificar que el centro está dentro de la imagen
            if cx < 0 or cx >= img_width or cy < 0 or cy >= img_height:
                continue
            
            hex_img = extract_hex(img, cx, cy, hex_w, hex_h)
            
            # Guardar
            out_name = f"{tile_name}_c{col}_r{row}.png"
            out_path = os.path.join(output_dir, out_name)
            hex_img.save(out_path)
            extracted.append(out_path)
            print(f"    Extraído: {out_name}")
    
    return extracted


def analyze_tiles():
    """Analiza todos los tiles y muestra información."""
    print("Analizando tiles...\n")
    
    tiles = []
    for f in os.listdir(TILES_DIR):
        if f.endswith('.png') and not f.startswith('thumb'):
            path = os.path.join(TILES_DIR, f)
            try:
                img = Image.open(path)
                w, h = img.size
                cols, rows = estimate_grid_size(w, h)
                tiles.append({
                    'file': f,
                    'size': (w, h),
                    'cols': cols,
                    'rows': rows,
                    'total_hexes': cols * rows
                })
            except Exception as e:
                print(f"Error con {f}: {e}")
    
    # Ordenar por número de archivo
    tiles.sort(key=lambda x: int(x['file'].replace('.png', '')))
    
    print(f"{'Archivo':<12} {'Tamaño':<12} {'Cols':<5} {'Rows':<5} {'Hexes':<6}")
    print("-" * 45)
    
    multi_tiles = []
    for t in tiles:
        print(f"{t['file']:<12} {str(t['size']):<12} {t['cols']:<5} {t['rows']:<5} {t['total_hexes']:<6}")
        if t['total_hexes'] > 1:
            multi_tiles.append(t)
    
    print(f"\nTotal tiles: {len(tiles)}")
    print(f"Multi-tiles (>1 hex): {len(multi_tiles)}")
    
    return multi_tiles


def main():
    if len(sys.argv) < 2:
        print("Uso:")
        print("  python split_hex_tiles.py analyze     - Analiza los tiles")
        print("  python split_hex_tiles.py split <n>   - Divide el tile n.png")
        print("  python split_hex_tiles.py split all   - Divide todos los multi-tiles")
        return
    
    command = sys.argv[1]
    
    if command == "analyze":
        analyze_tiles()
    
    elif command == "split":
        if len(sys.argv) < 3:
            print("Especifica el número de tile o 'all'")
            return
        
        # Crear directorio de salida
        output_dir = os.path.join(TILES_DIR, "split")
        os.makedirs(output_dir, exist_ok=True)
        
        target = sys.argv[2]
        
        if target == "all":
            multi_tiles = analyze_tiles()
            print("\n" + "="*50)
            print("Dividiendo multi-tiles...")
            print("="*50 + "\n")
            
            for t in multi_tiles:
                path = os.path.join(TILES_DIR, t['file'])
                print(f"\nProcesando {t['file']}...")
                split_tile(path, output_dir)
        else:
            path = os.path.join(TILES_DIR, f"{target}.png")
            if not os.path.exists(path):
                print(f"No existe: {path}")
                return
            
            print(f"Procesando {target}.png...")
            split_tile(path, output_dir)
        
        print(f"\nTiles guardados en: {output_dir}")


if __name__ == "__main__":
    main()
