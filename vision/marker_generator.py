"""
MesaRPG - Generador de Marcadores ArUco
Genera marcadores para pegar en las bases de las figuritas
"""

import cv2
import numpy as np
from pathlib import Path
import argparse


def generate_markers(
    output_dir: str = "../assets/markers",
    num_markers: int = 20,
    marker_size_px: int = 200,
    border_bits: int = 1,
    dictionary_type: int = cv2.aruco.DICT_4X4_50,
    include_labels: bool = True
):
    """
    Genera marcadores ArUco y los guarda como imágenes.
    
    Args:
        output_dir: Directorio de salida
        num_markers: Número de marcadores a generar
        marker_size_px: Tamaño del marcador en píxeles
        border_bits: Grosor del borde en bits
        dictionary_type: Tipo de diccionario ArUco
        include_labels: Si incluir etiquetas con el ID
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Crear diccionario ArUco
    aruco_dict = cv2.aruco.getPredefinedDictionary(dictionary_type)
    
    print(f"🎨 Generando {num_markers} marcadores ArUco...")
    print(f"📁 Directorio: {output_path.absolute()}")
    
    # Generar cada marcador
    for marker_id in range(num_markers):
        # Generar imagen del marcador
        marker_img = cv2.aruco.generateImageMarker(
            aruco_dict,
            marker_id,
            marker_size_px
        )
        
        if include_labels:
            # Añadir borde blanco y etiqueta
            border_size = 40
            labeled_img = np.ones(
                (marker_size_px + border_size * 2, marker_size_px + border_size * 2),
                dtype=np.uint8
            ) * 255
            
            # Colocar marcador centrado
            labeled_img[border_size:border_size+marker_size_px, 
                       border_size:border_size+marker_size_px] = marker_img
            
            # Añadir texto con ID
            cv2.putText(
                labeled_img,
                f"ID: {marker_id}",
                (border_size, marker_size_px + border_size + 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                0,
                2
            )
            
            marker_img = labeled_img
        
        # Guardar
        filename = output_path / f"marker_{marker_id:02d}.png"
        cv2.imwrite(str(filename), marker_img)
        print(f"  ✅ Marcador {marker_id} guardado")
    
    # Generar página para imprimir (varios marcadores por página)
    generate_print_page(output_path, num_markers, aruco_dict, marker_size_px)
    
    print(f"\n✨ Generación completa!")
    print(f"📄 Página para imprimir: {output_path / 'print_page.png'}")


def generate_print_page(
    output_path: Path,
    num_markers: int,
    aruco_dict,
    marker_size_px: int,
    page_width: int = 2480,  # A4 a 300 DPI
    page_height: int = 3508,
    markers_per_row: int = 4,
    margin: int = 100
):
    """Genera una página con varios marcadores para imprimir"""
    
    marker_with_border = marker_size_px + 80
    spacing = (page_width - 2 * margin) // markers_per_row
    
    # Crear página blanca
    page = np.ones((page_height, page_width), dtype=np.uint8) * 255
    
    # Título
    cv2.putText(
        page,
        "MesaRPG - Marcadores ArUco",
        (margin, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        2,
        0,
        3
    )
    cv2.putText(
        page,
        "Recortar y pegar en la base de las figuritas",
        (margin, 140),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        100,
        2
    )
    
    y_offset = 200
    
    for marker_id in range(min(num_markers, 20)):
        row = marker_id // markers_per_row
        col = marker_id % markers_per_row
        
        x = margin + col * spacing
        y = y_offset + row * (marker_with_border + 40)
        
        if y + marker_with_border > page_height - margin:
            break
        
        # Generar marcador
        marker_img = cv2.aruco.generateImageMarker(
            aruco_dict,
            marker_id,
            marker_size_px
        )
        
        # Colocar en la página
        page[y:y+marker_size_px, x:x+marker_size_px] = marker_img
        
        # Etiqueta
        cv2.putText(
            page,
            f"ID: {marker_id}",
            (x, y + marker_size_px + 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            0,
            2
        )
        
        # Líneas de corte
        cv2.rectangle(
            page,
            (x - 10, y - 10),
            (x + marker_size_px + 10, y + marker_size_px + 10),
            150,
            1
        )
    
    # Guardar página
    cv2.imwrite(str(output_path / "print_page.png"), page)


def generate_reference_sheet(output_path: Path, num_markers: int = 20):
    """Genera una hoja de referencia con todos los IDs"""
    
    content = """# MesaRPG - Referencia de Marcadores

## Asignación de Marcadores a Personajes

| Marcador ID | Personaje | Clase | Notas |
|-------------|-----------|-------|-------|
"""
    
    for i in range(num_markers):
        content += f"| {i} | | | |\n"
    
    content += """
## Instrucciones

1. Imprime la página `print_page.png` en papel normal o cartulina
2. Recorta cada marcador por las líneas de puntos
3. Pega el marcador en la base de cada figurita
4. Asegúrate de que el marcador esté visible desde arriba
5. Rellena esta tabla para recordar qué marcador corresponde a cada personaje
6. Edita `config/characters.json` con la misma asignación

## Consejos

- Los marcadores deben tener al menos 2x2 cm para una detección fiable
- Evita marcadores arrugados o con reflejos
- La iluminación uniforme mejora la detección
- Si un marcador no se detecta, prueba a imprimirlo más grande
"""
    
    with open(output_path / "MARKERS_REFERENCE.md", "w", encoding="utf-8") as f:
        f.write(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generar marcadores ArUco")
    parser.add_argument("--output", "-o", type=str, default="../assets/markers",
                       help="Directorio de salida")
    parser.add_argument("--num", "-n", type=int, default=20,
                       help="Número de marcadores")
    parser.add_argument("--size", "-s", type=int, default=200,
                       help="Tamaño en píxeles")
    args = parser.parse_args()
    
    generate_markers(
        output_dir=args.output,
        num_markers=args.num,
        marker_size_px=args.size
    )
    
    generate_reference_sheet(Path(args.output), args.num)
