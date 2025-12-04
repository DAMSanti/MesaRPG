#!/usr/bin/env python3
"""
Extrae tiles simples (1-3 hex) y los corta en hexágonos individuales.
Cada hex se guarda como imagen separada con fondo transparente.
"""

import os
import shutil
import math
from PIL import Image, ImageDraw

TILES_DIR = "assets/tiles/battletech"
OUTPUT_DIR = "assets/tiles/battletech_singles"

# Tamaño de referencia de un hex individual (tile 61.png)
REF_HEX_WIDTH = 223
REF_HEX_HEIGHT = 194

# Definición de tiles simples
TILE_DEFINITIONS = {
    # Tiles individuales (1 hex)
    "single": [11, 27, 28, 29, 30, 40, 41, 42, 43, 44, 45, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75],
    
    # Tiles de 2 hex vertical (arriba + abajo, misma columna)
    "v2": [13, 14, 46],
    
    # Tiles de 2 hex: arriba-izquierda + abajo-derecha (diagonal)
    "diag_br": [22, 31, 32, 47, 48, 49],
    
    # Tiles de 3 hex vertical
    "v3": [15],
    
    # Tiles de 3 hex (derecha + arriba-izq + abajo-izq)
    "left2": [16, 35, 50],
    
    # Tiles de 3 hex (izquierda + arriba-der + abajo-der)
    "right2": [23, 36],
    
    # Tiles de 3 hex diagonal derecha (sube hacia arriba-derecha)
    "diag3_r": [33],
    
    # Tiles de 3 hex: 2 vertical + 1 arriba-derecha
    "v2_topright": [34],
    
    # Tiles de 4 hex: 2x2, columna izquierda más abajo
    "h2v2_left_down": [17],
    
    # Tiles de 4 hex: 2x2, columna derecha más abajo
    "h2v2_right_down": [37],
    
    # Tiles de 4 hex: cruz (centro + arriba + abajo + izq + der... no, es 2v + 2h)
    "cross4": [51],
    
    # Tiles de 4 hex vertical
    "v4": [38, 39],
    
    # Tiles de 5 hex: 2 columnas (izq 3, der 2)
    "col3_col2": [18],
    
    # Tiles de 7 hex: mega (centro + 6 alrededor)
    "mega7": [12, 19, 20, 24, 25, 52, 53, 54, 55, 56, 57],
    
    # Tiles de 9 hex: 3x3 (centro elevado)
    "mega9": [21],
    
    # Tiles de 23 hex: 5 columnas (4/5/5/5/4)
    "mega23": [26],
    
    # Tiles de 11 hex: mega7 + cross4 juntos
    "mega11": [58],
}


def create_hex_mask(width, height):
    """Crea una máscara hexagonal flat-top con aspect ratio correcto."""
    mask = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(mask)
    
    cx, cy = width / 2, height / 2
    
    # Para flat-top hex el aspect ratio es width:height = 2:sqrt(3) ≈ 1.155
    # Calculamos el radio que mejor se ajuste al rectángulo
    # manteniendo la proporción del hexágono
    
    # El hex flat-top tiene:
    # - Ancho = 2 * r (de punta a punta)
    # - Alto = sqrt(3) * r (de lado plano a lado plano)
    
    # Usamos el menor de los dos para que quepa
    r_from_width = width / 2
    r_from_height = height / math.sqrt(3)
    r = min(r_from_width, r_from_height) * 0.98
    
    # Puntos del hexágono flat-top con proporciones correctas
    points = []
    for i in range(6):
        angle = math.pi / 3 * i  # 0, 60, 120, 180, 240, 300 grados
        px = cx + r * math.cos(angle)
        py = cy + r * math.sin(angle) 
        points.append((px, py))
    
    draw.polygon(points, fill=255)
    return mask


def extract_single_hex(img, cx, cy, hex_w, hex_h):
    """Extrae un único hexágono de la imagen con máscara."""
    out_w = int(hex_w)
    out_h = int(hex_h)
    
    # Crear imagen de salida con transparencia
    result = Image.new('RGBA', (out_w, out_h), (0, 0, 0, 0))
    
    # Calcular área a copiar de la imagen original
    src_left = int(cx - hex_w / 2)
    src_top = int(cy - hex_h / 2)
    src_right = int(cx + hex_w / 2)
    src_bottom = int(cy + hex_h / 2)
    
    # Ajustar destino si origen está fuera de límites
    dst_left = max(0, -src_left)
    dst_top = max(0, -src_top)
    
    src_left = max(0, src_left)
    src_top = max(0, src_top)
    src_right = min(img.width, src_right)
    src_bottom = min(img.height, src_bottom)
    
    # Copiar región
    region = img.crop((src_left, src_top, src_right, src_bottom))
    if region.mode != 'RGBA':
        region = region.convert('RGBA')
    
    result.paste(region, (dst_left, dst_top))
    
    # Aplicar máscara hexagonal
    mask = create_hex_mask(out_w, out_h)
    
    # Combinar con máscara
    r, g, b, a = result.split()
    new_alpha = Image.composite(a, Image.new('L', (out_w, out_h), 0), mask)
    result = Image.merge('RGBA', (r, g, b, new_alpha))
    
    return result


def get_hex_params(shape, img_width, img_height):
    """
    Devuelve los centros (cx, cy) de cada hex y el tamaño del hex.
    Mantiene el aspect ratio correcto del hex.
    """
    centers = []
    
    if shape == "single":
        # El hex ocupa toda la imagen
        hex_w = img_width
        hex_h = img_height
        centers = [(img_width / 2, img_height / 2)]
        
    elif shape == "v2":
        # 2 hex vertical: mismo ancho, altura dividida
        hex_w = img_width
        hex_h = img_height / 2
        centers = [
            (hex_w / 2, hex_h / 2),           # Arriba
            (hex_w / 2, hex_h * 1.5),         # Abajo
        ]
        
    elif shape == "v3":
        # 3 hex vertical
        hex_w = img_width
        hex_h = img_height / 3
        centers = [
            (hex_w / 2, hex_h * 0.5),   # Arriba
            (hex_w / 2, hex_h * 1.5),   # Centro
            (hex_w / 2, hex_h * 2.5),   # Abajo
        ]
        
    elif shape == "diag_br":
        # 2 hex: arriba-izquierda y centro-abajo-derecha
        # En flat-top, el spacing horizontal es 75% del ancho
        # El hex de abajo-derecha está desplazado hacia abajo medio hex
        hex_w = img_width * 0.60   # Cada hex ocupa ~60% del ancho
        hex_h = img_height * 0.65  # Cada hex ocupa ~65% del alto
        
        # Hex 0: arriba-izquierda
        # Hex 1: abajo-derecha (desplazado 0.5 hex hacia abajo)
        centers = [
            (hex_w * 0.50, hex_h * 0.50),                    # Arriba-izq
            (img_width - hex_w * 0.50, img_height - hex_h * 0.50),  # Abajo-der
        ]
        
    elif shape == "left2":
        # Hex central a la derecha + 2 hexes a la izquierda (arriba y abajo)
        hex_w = img_width * 0.58
        hex_h = img_height * 0.52
        
        centers = [
            (img_width - hex_w * 0.50, img_height / 2),     # Centro (derecha)
            (hex_w * 0.45, hex_h * 0.50),                    # Arriba-izq
            (hex_w * 0.45, img_height - hex_h * 0.50),       # Abajo-izq
        ]
        
    elif shape == "right2":
        # Hex central a la izquierda + 2 hexes a la derecha (arriba y abajo)
        hex_w = img_width * 0.58
        hex_h = img_height * 0.52
        
        centers = [
            (hex_w * 0.50, img_height / 2),                  # Centro (izquierda)
            (img_width - hex_w * 0.45, hex_h * 0.50),        # Arriba-der
            (img_width - hex_w * 0.45, img_height - hex_h * 0.50),  # Abajo-der
        ]
    
    elif shape == "diag3_r":
        # 3 hex diagonal arriba-izq -> centro -> abajo-der (como 31/32 pero de 3)
        # Imagen 1105x768: 2.5 columnas x 2 filas
        hex_w = img_width / 2.5
        hex_h = img_height / 2
        
        col_spacing = hex_w * 0.75
        cx = img_width / 2
        
        centers = [
            (cx - col_spacing, hex_h * 0.5),                 # Arriba-izq
            (cx, img_height * 0.5),                          # Centro
            (cx + col_spacing, img_height - hex_h * 0.5),    # Abajo-der
        ]
    
    elif shape == "v2_topright":
        # 2 vertical + 1 arriba-derecha
        # Imagen 776x958: 2 columnas (1.75 hex ancho), ~2.5 filas
        hex_w = img_width / 1.75
        hex_h = img_height / 2.5
        
        col_spacing = hex_w * 0.75
        left_x = img_width / 2 - col_spacing / 2
        right_x = img_width / 2 + col_spacing / 2
        
        centers = [
            (left_x, hex_h * 0.75),                          # Arriba-izq
            (left_x, hex_h * 0.75 + hex_h),                  # Abajo-izq
            (right_x, hex_h * 0.25),                         # Arriba-der (más arriba)
        ]
    
    elif shape == "h2v2_left_down":
        # 2x2: columna izquierda más abajo que la derecha
        # Imagen 776x958: 2 columnas, 2.5 filas
        hex_w = img_width / 1.75
        hex_h = img_height / 2.5
        
        col_spacing = hex_w * 0.75
        left_x = img_width / 2 - col_spacing / 2
        right_x = img_width / 2 + col_spacing / 2
        
        # Columna izq más abajo (offset 0.5 hex)
        centers = [
            (left_x, hex_h * 1.0),                            # Arriba-izq
            (left_x, hex_h * 2.0),                            # Abajo-izq
            (right_x, hex_h * 0.5),                           # Arriba-der
            (right_x, hex_h * 1.5),                           # Abajo-der
        ]
    
    elif shape == "h2v2_right_down":
        # 2x2: columna derecha más abajo que la izquierda
        # Imagen 776x959: 2 columnas, 2.5 filas
        hex_w = img_width / 1.75
        hex_h = img_height / 2.5
        
        col_spacing = hex_w * 0.75
        left_x = img_width / 2 - col_spacing / 2
        right_x = img_width / 2 + col_spacing / 2
        
        # Columna der más abajo (offset 0.5 hex)
        centers = [
            (left_x, hex_h * 0.5),                            # Arriba-izq
            (left_x, hex_h * 1.5),                            # Abajo-izq
            (right_x, hex_h * 1.0),                           # Arriba-der
            (right_x, hex_h * 2.0),                           # Abajo-der
        ]
    
    elif shape == "cross4":
        # Cruz: 2 vertical + 2 horizontal (4 hexes total)
        # Imagen 1103x765, layout similar a mega7 pero sin centro ni diagonales
        # 2.5 columnas x 2 filas
        hex_w = img_width / 2.5
        hex_h = img_height / 2
        
        col_spacing = hex_w * 0.75
        cx, cy = img_width / 2, img_height / 2
        
        centers = [
            (cx, cy - hex_h * 0.5),                          # Arriba
            (cx, cy + hex_h * 0.5),                          # Abajo
            (cx - col_spacing, cy),                          # Izquierda
            (cx + col_spacing, cy),                          # Derecha
        ]
    
    elif shape == "mega7":
        # 7 hexes: centro + 6 alrededor
        # Layout: 3 columnas (izq 2 hex, centro 3 hex, der 2 hex)
        # Imagen ~1105x1148, son 2.5 columnas x 3 filas
        
        hex_w = img_width / 2.5
        hex_h = img_height / 3
        
        cx, cy = img_width / 2, img_height / 2
        
        # Espaciado entre centros de columnas adyacentes (flat-top)
        col_spacing = hex_w * 0.75
        
        centers = [
            (cx, cy),                                        # Centro
            (cx, hex_h * 0.5),                               # Arriba (fila 0)
            (cx, hex_h * 2.5),                               # Abajo (fila 2)
            (cx - col_spacing, cy - hex_h * 0.5),            # Arriba-izq
            (cx - col_spacing, cy + hex_h * 0.5),            # Abajo-izq
            (cx + col_spacing, cy - hex_h * 0.5),            # Arriba-der
            (cx + col_spacing, cy + hex_h * 0.5),            # Abajo-der
        ]
    
    elif shape == "v4":
        # 4 hex vertical
        # Imagen 446x1528: 1 columna x 4 filas
        hex_w = img_width
        hex_h = img_height / 4
        
        centers = [
            (hex_w / 2, hex_h * 0.5),
            (hex_w / 2, hex_h * 1.5),
            (hex_w / 2, hex_h * 2.5),
            (hex_w / 2, hex_h * 3.5),
        ]
    
    elif shape == "col3_col2":
        # 5 hex: columna izq 3, columna der 2
        # Imagen 776x1148: 2 columnas, 3 filas
        hex_w = img_width / 1.75
        hex_h = img_height / 3
        
        col_spacing = hex_w * 0.75
        left_x = img_width / 2 - col_spacing / 2
        right_x = img_width / 2 + col_spacing / 2
        
        centers = [
            (left_x, hex_h * 0.5),                           # Izq arriba
            (left_x, hex_h * 1.5),                           # Izq centro
            (left_x, hex_h * 2.5),                           # Izq abajo
            (right_x, hex_h * 1.0),                          # Der arriba
            (right_x, hex_h * 2.0),                          # Der abajo
        ]
    
    elif shape == "mega9":
        # 9 hex: 3 columnas de 3 cada una, centro elevado
        # Imagen 1106x1338: 2.5 columnas x 3.5 filas
        hex_w = img_width / 2.5
        hex_h = img_height / 3.5
        
        col_spacing = hex_w * 0.75
        cx = img_width / 2
        left_x = cx - col_spacing
        right_x = cx + col_spacing
        
        # Col izq y der: filas 1, 2, 3 (más abajo)
        # Col centro: filas 0.5, 1.5, 2.5 (elevada)
        centers = [
            (left_x, hex_h * 1.0),                           # Izq arriba
            (left_x, hex_h * 2.0),                           # Izq centro
            (left_x, hex_h * 3.0),                           # Izq abajo
            (cx, hex_h * 0.5),                               # Centro arriba
            (cx, hex_h * 1.5),                               # Centro centro
            (cx, hex_h * 2.5),                               # Centro abajo
            (right_x, hex_h * 1.0),                          # Der arriba
            (right_x, hex_h * 2.0),                          # Der centro
            (right_x, hex_h * 3.0),                          # Der abajo
        ]
    
    elif shape == "mega23":
        # 23 hex: 5 columnas con 4/5/5/5/4 hexes
        # Imagen 1764x2288
        # 5 columnas con overlap 0.75: ancho = hex_w * (1 + 4*0.75) = hex_w * 4
        # 6 filas (5 + offset 0.5 arriba y abajo)
        
        hex_w = img_width / 4.0  # 441
        hex_h = img_height / 6.0  # 381.33
        col_spacing = hex_w * 0.75  # 330.75
        
        start_x = hex_w / 2  # Primera columna en x = 220.5
        
        centers = []
        
        # Columna 0: 4 hexes (offset abajo: filas 1,2,3,4)
        col_x = start_x
        for row in range(4):
            centers.append((col_x, hex_h * (row + 1.5)))
        
        # Columna 1: 5 hexes (offset arriba: filas 0.5,1.5,2.5,3.5,4.5)
        col_x += col_spacing
        for row in range(5):
            centers.append((col_x, hex_h * (row + 1.0)))
        
        # Columna 2: 5 hexes (offset abajo: filas 1,2,3,4,5)
        col_x += col_spacing
        for row in range(5):
            centers.append((col_x, hex_h * (row + 1.5)))
        
        # Columna 3: 5 hexes (offset arriba: filas 0.5,1.5,2.5,3.5,4.5)
        col_x += col_spacing
        for row in range(5):
            centers.append((col_x, hex_h * (row + 1.0)))
        
        # Columna 4: 4 hexes (offset abajo: filas 1,2,3,4)
        col_x += col_spacing
        for row in range(4):
            centers.append((col_x, hex_h * (row + 1.5)))
    
    elif shape == "mega11":
        # Imagen 2092x1145
        # 5 columnas con 2+3+2+3+1 = 11 hexes
        # 3.5 filas (3 + offset 0.5)
        
        hex_w = img_width / 4.0  # 523
        hex_h = img_height / 3.5  # 327
        col_spacing = hex_w * 0.75  # 392
        
        start_x = hex_w / 2
        
        centers = []
        
        # Columna 0: 2 hexes (offset abajo: filas 1, 2)
        col_x = start_x
        centers.append((col_x, hex_h * 1.5))  # 0
        centers.append((col_x, hex_h * 2.5))  # 1
        
        # Columna 1: 3 hexes (offset arriba: filas 0.5, 1.5, 2.5)
        col_x += col_spacing
        centers.append((col_x, hex_h * 1.0))  # 2
        centers.append((col_x, hex_h * 2.0))  # 3
        centers.append((col_x, hex_h * 3.0))  # 4
        
        # Columna 2: 2 hexes (offset abajo)
        col_x += col_spacing
        centers.append((col_x, hex_h * 1.5))  # 5
        centers.append((col_x, hex_h * 2.5))  # 6
        
        # Columna 3: 3 hexes (offset arriba)
        col_x += col_spacing
        centers.append((col_x, hex_h * 1.0))  # 7
        centers.append((col_x, hex_h * 2.0))  # 8
        centers.append((col_x, hex_h * 3.0))  # 9
        
        # Columna 4: 1 hex (offset abajo, centro)
        col_x += col_spacing
        centers.append((col_x, hex_h * 2.0))  # 10
    
    return centers, hex_w, hex_h


def process_tiles():
    """Procesa todos los tiles definidos."""
    # Crear directorio si no existe (no borrar los existentes)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    processed = []
    
    for shape, tile_nums in TILE_DEFINITIONS.items():
        for tile_num in tile_nums:
            src_path = os.path.join(TILES_DIR, f"{tile_num}.png")
            
            if not os.path.exists(src_path):
                print(f"⚠ No existe: {tile_num}.png")
                continue
            
            img = Image.open(src_path)
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            
            centers, hex_w, hex_h = get_hex_params(shape, img.width, img.height)
            
            # Extraer cada hex
            for idx, (cx, cy) in enumerate(centers):
                hex_img = extract_single_hex(img, cx, cy, hex_w, hex_h)
                
                if len(centers) == 1:
                    dst_name = f"{tile_num}.png"
                else:
                    dst_name = f"{tile_num}_{idx}.png"
                
                dst_path = os.path.join(OUTPUT_DIR, dst_name)
                hex_img.save(dst_path)
            
            if len(centers) == 1:
                print(f"✓ {tile_num}.png ({shape})")
            else:
                print(f"✓ {tile_num}.png ({shape}) -> {len(centers)} hexes")
            
            processed.append(tile_num)
    
    print(f"\n{'='*50}")
    print(f"Procesados: {len(processed)} tiles")
    print(f"Guardados en: {OUTPUT_DIR}")
    
    # Mostrar tiles que quedan sin procesar
    all_tiles = set()
    for f in os.listdir(TILES_DIR):
        if f.endswith('.png') and not f.startswith('thumb'):
            try:
                num = int(f.replace('.png', ''))
                all_tiles.add(num)
            except:
                pass
    
    remaining = sorted(all_tiles - set(processed))
    print(f"\nTiles restantes (multi-hex complejos): {remaining}")


if __name__ == "__main__":
    process_tiles()


if __name__ == "__main__":
    process_tiles()
