#!/usr/bin/env python3
"""
Script para remover texto blanco de las imágenes de tiles de BattleTech.
El texto aparece como píxeles blancos/casi blancos que forman caracteres.

Ejecutar en el servidor:
  pip install pillow numpy
  python tools/remove_tile_text.py
"""

import os
from pathlib import Path
from PIL import Image
import numpy as np

def is_white_or_near_white(pixel, threshold=240):
    """Verifica si un pixel es blanco o casi blanco."""
    if len(pixel) >= 3:
        r, g, b = pixel[:3]
        return r > threshold and g > threshold and b > threshold
    return False

def remove_white_text_simple(img, threshold=240):
    """
    Método simple: reemplaza píxeles blancos con el color promedio de los vecinos.
    """
    # Convertir a numpy array
    arr = np.array(img)
    
    if len(arr.shape) == 2:  # Escala de grises
        return img
    
    height, width = arr.shape[:2]
    has_alpha = arr.shape[2] == 4
    
    # Crear máscara de píxeles blancos
    if has_alpha:
        white_mask = (arr[:,:,0] > threshold) & (arr[:,:,1] > threshold) & (arr[:,:,2] > threshold)
    else:
        white_mask = (arr[:,:,0] > threshold) & (arr[:,:,1] > threshold) & (arr[:,:,2] > threshold)
    
    # Para cada píxel blanco, reemplazar con el promedio de vecinos no-blancos
    result = arr.copy()
    
    # Encontrar coordenadas de píxeles blancos
    white_coords = np.where(white_mask)
    
    for i in range(len(white_coords[0])):
        y, x = white_coords[0][i], white_coords[1][i]
        
        # Obtener vecinos en un radio de 3
        neighbors = []
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                ny, nx = y + dy, x + dx
                if 0 <= ny < height and 0 <= nx < width:
                    if not white_mask[ny, nx]:  # Solo vecinos no-blancos
                        neighbors.append(arr[ny, nx])
        
        if neighbors:
            # Promediar vecinos
            avg = np.mean(neighbors, axis=0).astype(np.uint8)
            result[y, x] = avg
    
    return Image.fromarray(result)

def remove_white_text_inpaint(img, threshold=220):
    """
    Método con inpainting: detecta regiones blancas y las rellena.
    Requiere opencv-python: pip install opencv-python
    """
    try:
        import cv2
    except ImportError:
        print("OpenCV no disponible, usando método simple")
        return remove_white_text_simple(img, threshold)
    
    # Convertir a numpy
    arr = np.array(img)
    
    if len(arr.shape) == 2:
        return img
    
    has_alpha = arr.shape[2] == 4
    
    if has_alpha:
        # Separar alpha
        rgb = arr[:,:,:3]
        alpha = arr[:,:,3]
    else:
        rgb = arr
        alpha = None
    
    # Convertir a BGR para OpenCV
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    
    # Crear máscara de píxeles blancos (texto) - más agresivo
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)
    
    # También detectar píxeles muy claros que no son completamente blancos
    # Buscar píxeles donde R, G, B son todos altos y similares (gris claro/blanco)
    high_values = (rgb[:,:,0] > threshold) & (rgb[:,:,1] > threshold) & (rgb[:,:,2] > threshold)
    mask2 = (high_values * 255).astype(np.uint8)
    mask = cv2.bitwise_or(mask, mask2)
    
    # Dilatar la máscara más agresivamente para cubrir bordes del texto
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=2)
    
    # Aplicar inpainting con radio mayor
    inpainted = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA)
    
    # Convertir de vuelta a RGB
    rgb_result = cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB)
    
    if has_alpha:
        # Reconstruir con alpha
        result = np.dstack((rgb_result, alpha))
        return Image.fromarray(result, 'RGBA')
    else:
        return Image.fromarray(rgb_result, 'RGB')

def process_tile(input_path, output_path, method='inpaint', threshold=245):
    """Procesa una imagen de tile para remover texto blanco."""
    try:
        img = Image.open(input_path)
        
        # Preservar el modo original
        original_mode = img.mode
        
        # Convertir a RGBA para procesamiento uniforme
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        
        if method == 'inpaint':
            result = remove_white_text_inpaint(img, threshold)
        else:
            result = remove_white_text_simple(img, threshold)
        
        # Guardar
        result.save(output_path)
        return True
    except Exception as e:
        print(f"Error procesando {input_path}: {e}")
        return False

def main():
    # Directorio de tiles
    tiles_dir = Path(__file__).parent.parent / 'assets' / 'tiles' / 'battletech'
    
    if not tiles_dir.exists():
        print(f"Directorio no encontrado: {tiles_dir}")
        return
    
    # Crear backup
    backup_dir = tiles_dir / 'backup_original'
    backup_dir.mkdir(exist_ok=True)
    
    # Procesar cada imagen
    processed = 0
    errors = 0
    
    for img_file in tiles_dir.glob('*.png'):
        if img_file.is_file():
            print(f"Procesando: {img_file.name}")
            
            # Backup
            backup_path = backup_dir / img_file.name
            if not backup_path.exists():
                import shutil
                shutil.copy2(img_file, backup_path)
            
            # Procesar desde backup para tener imagen original
            source = backup_path if backup_path.exists() else img_file
            if process_tile(source, img_file, method='inpaint', threshold=210):
                processed += 1
            else:
                errors += 1
    
    print(f"\n✅ Procesados: {processed}")
    print(f"❌ Errores: {errors}")
    print(f"📁 Backups en: {backup_dir}")

if __name__ == '__main__':
    main()
