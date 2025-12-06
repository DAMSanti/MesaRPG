#!/usr/bin/env python3
"""
Exportar modelo YOLO a OpenVINO para inferencia acelerada en CPU
Ejecutar antes de deploy a DigitalOcean
"""

import sys
from pathlib import Path

# Añadir directorio padre al path
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from ultralytics import YOLO
except ImportError:
    print("❌ Ultralytics no instalado. Ejecuta: pip install ultralytics")
    sys.exit(1)


def export_to_openvino(model_path: str, half: bool = False):
    """Exporta un modelo YOLO a formato OpenVINO"""
    path = Path(model_path)
    
    if not path.exists():
        print(f"❌ Modelo no encontrado: {path}")
        return None
    
    print(f"\n📦 Cargando modelo: {path.name}")
    model = YOLO(str(path))
    
    print(f"🔄 Exportando a OpenVINO (half={half})...")
    export_path = model.export(format="openvino", half=half)
    
    print(f"✅ Modelo exportado: {export_path}")
    return export_path


def main():
    base_dir = Path(__file__).parent.parent
    
    # Modelos a exportar
    models = [
        base_dir / "miniatures_pose.pt",
        base_dir / "miniatures_obb.pt",
    ]
    
    exported = []
    
    for model_path in models:
        if model_path.exists():
            print(f"\n{'='*50}")
            result = export_to_openvino(str(model_path), half=False)
            if result:
                exported.append(result)
        else:
            print(f"⚠️ Modelo no encontrado: {model_path.name}")
    
    print(f"\n{'='*50}")
    print(f"✅ Exportados {len(exported)} modelos a OpenVINO")
    
    if exported:
        print("\n📋 Archivos generados (añadir a git):")
        for exp_path in exported:
            print(f"   - {exp_path}")
        
        print("\n💡 Para subir los modelos OpenVINO al servidor:")
        print("   git add *_openvino/")
        print("   git commit -m 'Add OpenVINO models'")
        print("   git push")


if __name__ == "__main__":
    main()
