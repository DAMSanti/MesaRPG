"""
MesaRPG - Procesador de Frames con YOLO
Procesa frames recibidos del admin y devuelve detecciones
"""

import base64
import numpy as np
from typing import Dict, List, Tuple, Optional, Any
from pathlib import Path
import asyncio

# Intentar importar dependencias opcionales
try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    print("⚠️ OpenCV no disponible - procesamiento de frames desactivado")

try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    print("⚠️ YOLO no disponible - detección desactivada")


class FrameProcessor:
    """Procesa frames de video con YOLO para detectar objetos"""
    
    def __init__(self, model_path: str = "yolov8x.pt", confidence: float = 0.5):
        self.model = None
        self.confidence = confidence
        self.model_path = model_path
        self.is_ready = False
        self.last_detections: List[Dict] = []
        
        # Cargar modelo si está disponible
        if YOLO_AVAILABLE:
            try:
                # Buscar modelo en varias ubicaciones
                paths_to_try = [
                    Path(model_path),
                    Path(__file__).parent.parent / model_path,
                    Path(__file__).parent.parent / "yolov8x.pt",
                    Path(__file__).parent.parent / "yolo12x.pt",
                ]
                
                for path in paths_to_try:
                    if path.exists():
                        print(f"📦 Cargando modelo YOLO: {path}")
                        self.model = YOLO(str(path))
                        self.is_ready = True
                        print(f"✅ Modelo YOLO cargado correctamente")
                        break
                
                if not self.is_ready:
                    print(f"⚠️ No se encontró modelo YOLO, intentando descargar {model_path}...")
                    self.model = YOLO(model_path)
                    self.is_ready = True
                    
            except Exception as e:
                print(f"❌ Error cargando modelo YOLO: {e}")
                self.is_ready = False
    
    def process_frame(self, frame_base64: str) -> Tuple[str, List[Dict]]:
        """
        Procesa un frame y devuelve el frame con bounding boxes y las detecciones
        
        Args:
            frame_base64: Frame codificado en base64 (JPEG)
            
        Returns:
            Tuple[str, List[Dict]]: (frame_procesado_base64, lista_de_detecciones)
        """
        if not CV2_AVAILABLE:
            return frame_base64, []
        
        try:
            # Decodificar frame
            frame_bytes = base64.b64decode(frame_base64)
            nparr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                print("⚠️ Frame decode failed")
                return frame_base64, []
            
            # Guardar dimensiones originales
            original_height, original_width = frame.shape[:2]
            
            # Log dimensiones para debug (solo cada 100 frames para no saturar)
            if not hasattr(self, '_frame_count'):
                self._frame_count = 0
            self._frame_count += 1
            if self._frame_count % 100 == 1:
                print(f"📐 Frame recibido: {original_width}x{original_height}")
            
            detections = []
            
            # Procesar con YOLO si está disponible
            if self.is_ready and self.model:
                # YOLO procesa internamente pero devuelve coords en escala original
                results = self.model(frame, conf=self.confidence, verbose=False)
                
                for result in results:
                    boxes = result.boxes
                    if boxes is not None:
                        for box in boxes:
                            # Obtener coordenadas
                            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                            conf = float(box.conf[0].cpu().numpy())
                            cls = int(box.cls[0].cpu().numpy())
                            class_name = result.names[cls]
                            
                            # Agregar a detecciones
                            detections.append({
                                "class": class_name,
                                "confidence": round(conf, 2),
                                "bbox": {
                                    "x1": int(x1),
                                    "y1": int(y1),
                                    "x2": int(x2),
                                    "y2": int(y2)
                                },
                                "center": {
                                    "x": int((x1 + x2) / 2),
                                    "y": int((y1 + y2) / 2)
                                }
                            })
                            
                            # Dibujar bounding box
                            color = self._get_color_for_class(cls)
                            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                            
                            # Dibujar etiqueta
                            label = f"{class_name} {conf:.2f}"
                            label_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 2)
                            cv2.rectangle(frame, (int(x1), int(y1) - label_size[1] - 10), 
                                        (int(x1) + label_size[0], int(y1)), color, -1)
                            cv2.putText(frame, label, (int(x1), int(y1) - 5), 
                                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
            
            else:
                # Sin YOLO, solo agregar texto informativo
                cv2.putText(frame, "YOLO no disponible", (10, 30), 
                           cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
            
            # Agregar contador de detecciones
            cv2.putText(frame, f"Detectados: {len(detections)}", (10, frame.shape[0] - 10),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            
            # Codificar frame procesado
            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            processed_base64 = base64.b64encode(buffer).decode('utf-8')
            
            self.last_detections = detections
            return processed_base64, detections
            
        except Exception as e:
            print(f"Error procesando frame: {e}")
            return frame_base64, []
    
    def _get_color_for_class(self, class_id: int) -> Tuple[int, int, int]:
        """Devuelve un color consistente para cada clase"""
        colors = [
            (0, 255, 0),    # Verde
            (255, 0, 0),    # Azul
            (0, 0, 255),    # Rojo
            (255, 255, 0),  # Cyan
            (255, 0, 255),  # Magenta
            (0, 255, 255),  # Amarillo
            (128, 0, 255),  # Púrpura
            (255, 128, 0),  # Naranja
        ]
        return colors[class_id % len(colors)]
    
    def get_status(self) -> Dict:
        """Devuelve el estado del procesador"""
        return {
            "cv2_available": CV2_AVAILABLE,
            "yolo_available": YOLO_AVAILABLE,
            "model_ready": self.is_ready,
            "model_path": self.model_path,
            "confidence": self.confidence,
            "last_detection_count": len(self.last_detections)
        }


# Instancia global del procesador
frame_processor = FrameProcessor()
