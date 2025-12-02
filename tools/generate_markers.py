"""
MesaRPG - Generador de Marcadores
Script de conveniencia para generar marcadores ArUco
"""

import sys
import os

# Añadir el directorio vision al path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'vision'))

from marker_generator import generate_markers, generate_reference_sheet
from pathlib import Path


def main():
    print("=" * 50)
    print("MesaRPG - Generador de Marcadores ArUco")
    print("=" * 50)
    print()
    
    # Directorio de salida
    output_dir = Path(__file__).parent.parent / "assets" / "markers"
    
    print(f"📁 Directorio de salida: {output_dir}")
    print()
    
    # Preguntar configuración
    try:
        print("¿Cuántos marcadores generar? (default: 20): ", end="")
        num_input = input().strip()
        num_markers = int(num_input) if num_input else 20
        
        print("¿Tamaño en píxeles? (default: 200): ", end="")
        size_input = input().strip()
        marker_size = int(size_input) if size_input else 200
        
    except:
        num_markers = 20
        marker_size = 200
    
    print()
    print(f"Generando {num_markers} marcadores de {marker_size}px...")
    print()
    
    # Generar
    generate_markers(
        output_dir=str(output_dir),
        num_markers=num_markers,
        marker_size_px=marker_size
    )
    
    generate_reference_sheet(output_dir, num_markers)
    
    print()
    print("=" * 50)
    print("✨ Generación completada")
    print()
    print("Próximos pasos:")
    print(f"  1. Imprime: {output_dir / 'print_page.png'}")
    print("  2. Recorta los marcadores")
    print("  3. Pégalos en las bases de tus figuritas")
    print(f"  4. Edita: config/characters.json")
    print()


if __name__ == "__main__":
    main()
