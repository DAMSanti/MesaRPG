"""
Capturador de imágenes para dataset de entrenamiento YOLO
Usa la cámara para capturar fotos de figuritas en el tablero.

Controles:
  ESPACIO - Capturar imagen
  R - Activar/desactivar captura automática (cada 2 segundos)
  Q - Salir
  + / - Ajustar brillo

Uso:
  python capture_dataset.py              # Usar webcam 0
  python capture_dataset.py 1            # Usar webcam 1
  python capture_dataset.py "http://..."  # Usar cámara IP
"""

import cv2
import os
import sys
from datetime import datetime
from pathlib import Path

# Crear carpeta para dataset
DATASET_DIR = Path(__file__).parent.parent / "dataset" / "images"
DATASET_DIR.mkdir(parents=True, exist_ok=True)

def main():
    # Obtener fuente de cámara
    source = 0
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        source = int(arg) if arg.isdigit() else arg
    
    print(f"🎥 Conectando a cámara: {source}")
    cap = cv2.VideoCapture(source)
    
    if not cap.isOpened():
        print("❌ No se pudo abrir la cámara")
        return
    
    # Configurar resolución
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    
    print(f"✅ Cámara conectada")
    print(f"📁 Guardando en: {DATASET_DIR}")
    print(f"\nControles:")
    print(f"  ESPACIO - Capturar imagen")
    print(f"  R - Auto-captura cada 2 seg")
    print(f"  Q - Salir")
    
    count = len(list(DATASET_DIR.glob("*.jpg")))
    auto_capture = False
    last_capture_time = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            print("Error leyendo frame")
            break
        
        # Mostrar info en frame
        display = frame.copy()
        status = f"Imagenes: {count} | Auto: {'ON' if auto_capture else 'OFF'}"
        cv2.putText(display, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.putText(display, "ESPACIO=capturar | R=auto | Q=salir", (10, 60), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        
        # Dibujar grid para referencia
        h, w = frame.shape[:2]
        for i in range(1, 4):
            cv2.line(display, (w*i//4, 0), (w*i//4, h), (100, 100, 100), 1)
            cv2.line(display, (0, h*i//4), (w, h*i//4), (100, 100, 100), 1)
        
        cv2.imshow("Captura Dataset - Figuritas", display)
        
        # Auto captura
        current_time = cv2.getTickCount() / cv2.getTickFrequency()
        if auto_capture and (current_time - last_capture_time) > 2.0:
            filename = f"mini_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{count:04d}.jpg"
            filepath = DATASET_DIR / filename
            cv2.imwrite(str(filepath), frame)
            print(f"📸 Auto-guardado: {filename}")
            count += 1
            last_capture_time = current_time
        
        # Controles
        key = cv2.waitKey(1) & 0xFF
        
        if key == ord('q'):
            break
        elif key == ord(' '):  # Espacio
            filename = f"mini_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{count:04d}.jpg"
            filepath = DATASET_DIR / filename
            cv2.imwrite(str(filepath), frame)
            print(f"📸 Guardado: {filename}")
            count += 1
            last_capture_time = current_time
        elif key == ord('r'):
            auto_capture = not auto_capture
            print(f"🔄 Auto-captura: {'ON' if auto_capture else 'OFF'}")
    
    cap.release()
    cv2.destroyAllWindows()
    print(f"\n✅ Dataset: {count} imágenes en {DATASET_DIR}")

if __name__ == "__main__":
    main()
