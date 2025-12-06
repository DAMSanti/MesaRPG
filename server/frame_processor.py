"""
MesaRPG - Procesador de Frames con YOLO (Optimizado)
Procesa frames de forma no bloqueante con skip de frames
Incluye tracking SORT y detección de orientación
"""

import base64
import numpy as np
from typing import Dict, List, Tuple, Optional
from pathlib import Path
import threading
import time

# Importar tracker local
try:
    from .tracker import SORTTracker, OrientationDetector, TrackedObject
except ImportError:
    from tracker import SORTTracker, OrientationDetector, TrackedObject

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
    """Procesa frames de video con YOLO + SORT tracking + orientación"""
    
    def __init__(self, model_path: str = "yolov8n.pt", confidence: float = 0.4):
        self.model = None
        self.confidence = confidence
        self.model_path = model_path
        self.is_ready = False
        self.last_detections: List[Dict] = []
        self.last_processed_frame: Optional[str] = None
        self.last_tracks: List[Dict] = []
        
        # Tracker SORT para seguimiento continuo
        self.tracker = SORTTracker(max_age=15, min_hits=2, iou_threshold=0.3)
        self.orientation_detector = OrientationDetector()
        
        # Configurar marcador rojo como indicador frontal
        # HSV para rojo: (0-10, 100-255, 100-255) y (170-180, 100-255, 100-255)
        self.orientation_detector.set_front_marker_color((0, 100, 100), (10, 255, 255))
        
        # Para procesamiento no bloqueante
        self._processing = False
        self._lock = threading.Lock()
        self._frame_count = 0
        self._process_count = 0
        self._skip_count = 0
        self._last_fps_time = time.time()
        self._fps = 0
        self._last_frame = None  # Guardar último frame para tracking sin YOLO
        
        # Cargar modelo si está disponible
        if YOLO_AVAILABLE:
            self._load_model()
    
    def _load_model(self):
        """Carga el modelo YOLO - preferir modelos ligeros"""
        try:
            # Preferir modelos más ligeros primero
            paths_to_try = [
                # Modelo nano (más rápido, ~6MB)
                Path(__file__).parent.parent / "yolov8n.pt",
                Path("yolov8n.pt"),
                # Modelo small (~22MB)  
                Path(__file__).parent.parent / "yolov8s.pt",
                # Modelos más pesados
                Path(__file__).parent.parent / "yolov8m.pt",
                Path(__file__).parent.parent / "yolov8x.pt",
            ]
            
            for path in paths_to_try:
                if path.exists():
                    print(f"📦 Cargando modelo YOLO: {path.name}")
                    self.model = YOLO(str(path))
                    self.is_ready = True
                    print(f"✅ Modelo {path.name} cargado")
                    return
            
            # Descargar nano si no hay ninguno
            print(f"⚠️ Descargando YOLOv8n (modelo ligero)...")
            self.model = YOLO("yolov8n.pt")
            self.is_ready = True
            print(f"✅ YOLOv8n listo")
                
        except Exception as e:
            print(f"❌ Error cargando YOLO: {e}")
            self.is_ready = False
    
    def process_frame(self, frame_base64: str) -> Tuple[str, List[Dict]]:
        """
        Procesa un frame. Si ya está procesando, devuelve el último resultado.
        Esto evita acumular frames y mantiene el sistema responsive.
        """
        self._frame_count += 1
        
        # Si ya estamos procesando, devolver último resultado (skip frame)
        with self._lock:
            if self._processing:
                self._skip_count += 1
                if self.last_processed_frame:
                    return self.last_processed_frame, self.last_detections
                return frame_base64, []
            self._processing = True
        
        try:
            result = self._process_sync(frame_base64)
            
            with self._lock:
                self.last_processed_frame = result[0]
                self.last_detections = result[1]
                self._process_count += 1
                
                # Calcular FPS
                now = time.time()
                elapsed = now - self._last_fps_time
                if elapsed >= 2.0:
                    self._fps = self._process_count / elapsed
                    print(f"📊 YOLO: {self._fps:.1f} FPS, {self._skip_count} frames saltados")
                    self._process_count = 0
                    self._skip_count = 0
                    self._last_fps_time = now
                
                self._processing = False
            
            return result
            
        except Exception as e:
            print(f"Error: {e}")
            with self._lock:
                self._processing = False
            return frame_base64, []
    
    def _process_sync(self, frame_base64: str) -> Tuple[str, List[Dict]]:
        """Procesamiento síncrono del frame"""
        if not CV2_AVAILABLE:
            return frame_base64, []
        
        # Decodificar
        frame_bytes = base64.b64decode(frame_base64)
        nparr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return frame_base64, []
        
        h, w = frame.shape[:2]
        detections = []
        
        if self.is_ready and self.model:
            # Reducir tamaño para procesamiento rápido
            max_size = 320  # Muy pequeño = muy rápido
            scale = min(max_size / w, max_size / h, 1.0)
            
            if scale < 1:
                small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
            else:
                small = frame
                scale = 1.0
            
            # Inferencia rápida
            results = self.model(
                small,
                conf=self.confidence,
                verbose=False,
                imgsz=320,
                max_det=20  # Limitar detecciones
            )
            
            for result in results:
                if result.boxes is None:
                    continue
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    # Escalar de vuelta
                    x1, y1, x2, y2 = int(x1/scale), int(y1/scale), int(x2/scale), int(y2/scale)
                    conf = float(box.conf[0])
                    cls = int(box.cls[0])
                    name = result.names[cls]
                    
                    # Detectar orientación
                    orientation = self.orientation_detector.detect_orientation(
                        frame, (x1, y1, x2, y2)
                    )
                    
                    detections.append({
                        "class": name,
                        "confidence": round(conf, 2),
                        "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                        "center": {"x": (x1+x2)//2, "y": (y1+y2)//2},
                        "orientation": round(orientation, 1)
                    })
        
        # Actualizar tracker con detecciones
        tracked_objects = self.tracker.update(detections)
        self.last_tracks = [t.to_dict() for t in tracked_objects]
        
        # Dibujar tracks en el frame
        for track in tracked_objects:
            x1, y1, x2, y2 = track.bbox
            color = self._get_color(track.id)
            
            # Bounding box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            
            # ID y clase
            label = f"#{track.id} {track.class_name}"
            cv2.putText(frame, label, (x1, y1-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            # Flecha de orientación
            cx, cy = track.center
            angle_rad = np.radians(90 - track.orientation)  # Convertir a coordenadas de imagen
            arrow_len = min(x2-x1, y2-y1) // 2
            end_x = int(cx + arrow_len * np.cos(angle_rad))
            end_y = int(cy - arrow_len * np.sin(angle_rad))
            cv2.arrowedLine(frame, (cx, cy), (end_x, end_y), (0, 255, 255), 2, tipLength=0.3)
        
        if not self.is_ready:
            cv2.putText(frame, "YOLO no disponible", (10, 30), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        
        # Overlay info
        info = f"Tracks: {len(tracked_objects)} | YOLO: {self._fps:.1f} fps"
        cv2.putText(frame, info, (10, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        
        # Codificar
        _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return base64.b64encode(buf).decode('utf-8'), self.last_tracks
    
    def get_tracks(self) -> List[Dict]:
        """Retorna los tracks actuales"""
        return self.last_tracks
    
    def _get_color(self, id_or_cls: int) -> Tuple[int, int, int]:
        colors = [(0,255,0), (255,0,0), (0,0,255), (255,255,0), 
                  (255,0,255), (0,255,255), (128,0,255), (255,128,0),
                  (0,128,255), (255,0,128), (128,255,0), (0,255,128)]
        return colors[id_or_cls % len(colors)]
    
    def get_status(self) -> Dict:
        return {
            "cv2_available": CV2_AVAILABLE,
            "yolo_available": YOLO_AVAILABLE,
            "model_ready": self.is_ready,
            "fps": round(self._fps, 1),
            "frames_received": self._frame_count,
            "active_tracks": len(self.last_tracks),
            "last_detection_count": len(self.last_detections)
        }


# Instancia global
frame_processor = FrameProcessor()
