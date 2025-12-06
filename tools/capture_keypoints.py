"""
Herramienta para capturar dataset con keypoints (orientación)
Clic izquierdo: esquina 1 del bbox
Clic izquierdo: esquina 2 del bbox  
Clic derecho: punto frontal de la figurita
Espacio: siguiente imagen
Q: salir y guardar
"""

import cv2
import os
import json
from datetime import datetime
from pathlib import Path

class KeypointCapture:
    def __init__(self, output_dir="dataset_keypoints"):
        self.output_dir = Path(output_dir)
        self.images_dir = self.output_dir / "images"
        self.labels_dir = self.output_dir / "labels"
        
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.labels_dir.mkdir(parents=True, exist_ok=True)
        
        self.current_annotations = []
        self.temp_bbox = []  # Para guardar los 2 clicks del bbox
        self.image_count = len(list(self.images_dir.glob("*.jpg")))
        
        self.current_frame = None
        self.display_frame = None
        
    def mouse_callback(self, event, x, y, flags, param):
        if self.current_frame is None:
            return
            
        if event == cv2.EVENT_LBUTTONDOWN:
            # Click izquierdo - puntos del bounding box
            self.temp_bbox.append((x, y))
            
            if len(self.temp_bbox) == 2:
                # Ya tenemos los 2 puntos del bbox, mostrar en pantalla
                self._redraw()
                print(f"  BBox definido. Clic DERECHO para marcar el FRENTE de la figurita")
                
        elif event == cv2.EVENT_RBUTTONDOWN:
            # Click derecho - punto frontal
            if len(self.temp_bbox) == 2:
                x1, y1 = self.temp_bbox[0]
                x2, y2 = self.temp_bbox[1]
                
                # Normalizar bbox
                bx1, bx2 = min(x1, x2), max(x1, x2)
                by1, by2 = min(y1, y2), max(y1, y2)
                
                self.current_annotations.append({
                    "bbox": (bx1, by1, bx2, by2),
                    "front": (x, y)
                })
                
                print(f"  ✓ Figurita {len(self.current_annotations)} anotada")
                self.temp_bbox = []
                self._redraw()
            else:
                print("  ⚠️ Primero define el bbox con 2 clics izquierdos")
                
        # Actualizar visualización
        self._redraw()
        if len(self.temp_bbox) == 1:
            cv2.circle(self.display_frame, self.temp_bbox[0], 5, (0, 255, 0), -1)
        cv2.imshow("Capture", self.display_frame)
    
    def _redraw(self):
        """Redibuja el frame con todas las anotaciones"""
        self.display_frame = self.current_frame.copy()
        
        # Dibujar anotaciones completadas
        for i, ann in enumerate(self.current_annotations):
            x1, y1, x2, y2 = ann["bbox"]
            fx, fy = ann["front"]
            
            # Bbox en verde
            cv2.rectangle(self.display_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            
            # Centro
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            
            # Flecha del centro al frente
            cv2.arrowedLine(self.display_frame, (cx, cy), (fx, fy), (0, 255, 255), 2, tipLength=0.3)
            
            # Punto frontal en amarillo
            cv2.circle(self.display_frame, (fx, fy), 5, (0, 255, 255), -1)
            
            # Número
            cv2.putText(self.display_frame, f"#{i+1}", (x1, y1-5), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        
        # Dibujar bbox temporal
        if len(self.temp_bbox) == 2:
            x1, y1 = self.temp_bbox[0]
            x2, y2 = self.temp_bbox[1]
            cv2.rectangle(self.display_frame, (x1, y1), (x2, y2), (255, 0, 0), 2)
            
        # Instrucciones
        h = self.display_frame.shape[0]
        cv2.putText(self.display_frame, "L-Click x2: BBox | R-Click: Front | SPACE: Save | Q: Quit", 
                   (10, h-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(self.display_frame, f"Image #{self.image_count} | Annotations: {len(self.current_annotations)}", 
                   (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    
    def save_current(self):
        """Guarda la imagen y labels actuales"""
        if self.current_frame is None or len(self.current_annotations) == 0:
            print("  ⚠️ No hay anotaciones para guardar")
            return False
            
        h, w = self.current_frame.shape[:2]
        
        # Guardar imagen
        img_name = f"img_{self.image_count:04d}.jpg"
        img_path = self.images_dir / img_name
        cv2.imwrite(str(img_path), self.current_frame)
        
        # Guardar labels en formato YOLO-Pose
        # Formato: class x_center y_center width height front_x front_y visibility
        label_path = self.labels_dir / f"img_{self.image_count:04d}.txt"
        
        with open(label_path, 'w') as f:
            for ann in self.current_annotations:
                x1, y1, x2, y2 = ann["bbox"]
                fx, fy = ann["front"]
                
                # Normalizar a 0-1
                cx = ((x1 + x2) / 2) / w
                cy = ((y1 + y2) / 2) / h
                bw = (x2 - x1) / w
                bh = (y2 - y1) / h
                
                # Keypoint normalizado
                kx = fx / w
                ky = fy / h
                
                # class cx cy w h kp_x kp_y visibility
                f.write(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f} {kx:.6f} {ky:.6f} 2\n")
        
        print(f"✅ Guardado: {img_name} con {len(self.current_annotations)} anotaciones")
        self.image_count += 1
        self.current_annotations = []
        self.temp_bbox = []
        return True
    
    def run(self, camera_index=0):
        """Ejecuta la captura"""
        cap = cv2.VideoCapture(camera_index)
        
        if not cap.isOpened():
            print("❌ No se pudo abrir la cámara")
            return
        
        # Configurar cámara
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        
        cv2.namedWindow("Capture")
        cv2.setMouseCallback("Capture", self.mouse_callback)
        
        print("\n" + "="*50)
        print("CAPTURA DE DATASET CON KEYPOINTS")
        print("="*50)
        print("1. Clic IZQUIERDO x2 para definir el bounding box")
        print("2. Clic DERECHO para marcar el FRENTE de la figurita")
        print("3. ESPACIO para guardar y pasar a siguiente imagen")
        print("4. R para resetear anotaciones actuales")
        print("5. Q para salir")
        print("="*50 + "\n")
        
        paused = False
        
        while True:
            if not paused:
                ret, frame = cap.read()
                if not ret:
                    break
                self.current_frame = frame.copy()
                self._redraw()
            
            cv2.imshow("Capture", self.display_frame)
            
            key = cv2.waitKey(30) & 0xFF
            
            if key == ord('q'):
                break
            elif key == ord(' '):
                # Guardar y continuar
                if self.save_current():
                    paused = False
                else:
                    paused = True  # Pausar para anotar
            elif key == ord('p'):
                paused = not paused
                print("  " + ("⏸️ Pausado" if paused else "▶️ Continuando"))
            elif key == ord('r'):
                self.current_annotations = []
                self.temp_bbox = []
                self._redraw()
                print("  🔄 Anotaciones reseteadas")
            elif key == ord('f'):
                # Congelar frame actual para anotar
                paused = True
                print("  📷 Frame congelado - anota las figuritas")
        
        cap.release()
        cv2.destroyAllWindows()
        
        # Crear data.yaml
        self._create_yaml()
        print(f"\n✅ Dataset guardado en: {self.output_dir}")
        print(f"   Total imágenes: {self.image_count}")
    
    def _create_yaml(self):
        """Crea el archivo de configuración para YOLO-Pose"""
        yaml_content = f"""# Dataset para YOLO-Pose (detección + keypoint de orientación)
path: {self.output_dir.absolute()}
train: images
val: images

# Keypoints
kpt_shape: [1, 3]  # 1 keypoint, 3 valores (x, y, visibility)

# Clases
names:
  0: miniature

# Flip no recomendado para orientación
flip_idx: []
"""
        yaml_path = self.output_dir / "data.yaml"
        with open(yaml_path, 'w') as f:
            f.write(yaml_content)
        print(f"  📄 Creado: {yaml_path}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--output", type=str, default="dataset_keypoints")
    args = parser.parse_args()
    
    capture = KeypointCapture(args.output)
    capture.run(args.camera)
