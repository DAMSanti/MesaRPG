"""
MesaRPG - Generador de Marcadores ArUco
Genera marcadores para imprimir y pegar en las figuritas

USO:
  python generate_markers.py              # Genera 10 marcadores
  python generate_markers.py --count 20   # Genera 20 marcadores
  python generate_markers.py --size 200   # Marcadores de 200px
"""

import cv2
import numpy as np
import os
import argparse

def generate_markers(count=10, size=150, output_dir="markers"):
    """Genera marcadores ArUco para imprimir"""
    
    # Crear directorio
    os.makedirs(output_dir, exist_ok=True)
    
    # Diccionario ArUco 4x4 (50 marcadores posibles)
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    
    print(f"📝 Generando {count} marcadores ArUco...")
    print(f"   Tamaño: {size}x{size} píxeles")
    print(f"   Directorio: {output_dir}/")
    
    # Nombres de personajes para los marcadores
    names = [
        "Guerrero", "Mago", "Arquera", "Clérigo", "Pícaro",
        "Druida", "Paladín", "Bardo", "Monje", "Brujo",
        "Bárbaro", "Hechicero", "Explorador", "Nigromante", "Alquimista",
        "Caballero", "Asesino", "Chamán", "Elemental", "Invocador"
    ]
    
    for marker_id in range(count):
        # Generar imagen del marcador
        marker_img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, size)
        
        # Añadir borde blanco
        border = 20
        bordered = cv2.copyMakeBorder(marker_img, border, border, border, border,
                                       cv2.BORDER_CONSTANT, value=255)
        
        # Añadir texto con ID y nombre
        h, w = bordered.shape
        final = np.ones((h + 40, w), dtype=np.uint8) * 255
        final[:h, :] = bordered
        
        name = names[marker_id] if marker_id < len(names) else f"Personaje {marker_id}"
        text = f"ID:{marker_id} - {name}"
        cv2.putText(final, text, (10, h + 25), cv2.FONT_HERSHEY_SIMPLEX, 0.5, 0, 1)
        
        # Guardar
        filename = f"{output_dir}/marker_{marker_id:02d}_{name.lower()}.png"
        cv2.imwrite(filename, final)
        print(f"  ✅ {filename}")
    
    # Crear página con todos los marcadores para imprimir
    create_print_sheet(count, size, output_dir, aruco_dict, names)
    
    print(f"\n✅ Marcadores generados en {output_dir}/")
    print(f"📄 Hoja para imprimir: {output_dir}/print_sheet.png")

def create_print_sheet(count, size, output_dir, aruco_dict, names):
    """Crea una hoja A4 con todos los marcadores para imprimir"""
    
    # Tamaño A4 a 150 DPI aproximado
    page_w, page_h = 1240, 1754
    margin = 50
    spacing = 20
    
    # Tamaño de cada marcador en la hoja
    marker_size = 120
    border = 10
    cell_size = marker_size + border * 2 + 30  # +30 para texto
    
    # Calcular cuántos caben
    cols = (page_w - margin * 2) // (cell_size + spacing)
    rows = (page_h - margin * 2) // (cell_size + spacing)
    
    # Crear página blanca
    page = np.ones((page_h, page_w), dtype=np.uint8) * 255
    
    marker_id = 0
    for row in range(rows):
        for col in range(cols):
            if marker_id >= count:
                break
            
            # Posición
            x = margin + col * (cell_size + spacing)
            y = margin + row * (cell_size + spacing)
            
            # Generar marcador
            marker_img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, marker_size)
            
            # Añadir borde
            bordered = cv2.copyMakeBorder(marker_img, border, border, border, border,
                                          cv2.BORDER_CONSTANT, value=255)
            
            # Colocar en página
            h, w = bordered.shape
            page[y:y+h, x:x+w] = bordered
            
            # Añadir texto
            name = names[marker_id] if marker_id < len(names) else f"P{marker_id}"
            cv2.putText(page, f"{marker_id}:{name[:8]}", (x, y + h + 15), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.35, 0, 1)
            
            marker_id += 1
    
    # Título
    cv2.putText(page, "MesaRPG - Marcadores ArUco", (margin, 30), 
               cv2.FONT_HERSHEY_SIMPLEX, 0.8, 0, 2)
    
    cv2.imwrite(f"{output_dir}/print_sheet.png", page)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Generar marcadores ArUco')
    parser.add_argument('--count', type=int, default=10, help='Número de marcadores')
    parser.add_argument('--size', type=int, default=150, help='Tamaño en píxeles')
    parser.add_argument('--output', type=str, default='markers', help='Directorio de salida')
    args = parser.parse_args()
    
    generate_markers(args.count, args.size, args.output)
