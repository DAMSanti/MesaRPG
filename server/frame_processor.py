"""
MesaRPG - Procesador de Frames con YOLO (Optimizado)
Procesa frames de forma no bloqueante con skip de frames
Incluye tracking SORT y detección de orientación
Soporte para OpenVINO para inferencia acelerada
"""

import base64
import numpy as np
from typing import Dict, List, Tuple, Optional
from pathlib import Path
import time
import os

# Importar tracker simple
try:
    from .simple_tracker import SimpleTracker
except ImportError:
    from simple_tracker import SimpleTracker

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

# Verificar disponibilidad de OpenVINO
OPENVINO_AVAILABLE = False
try:
    import openvino
    OPENVINO_AVAILABLE = True
    print(f"✅ OpenVINO {openvino.__version__} disponible")
except ImportError:
    print("ℹ️ OpenVINO no instalado - usando inferencia estándar")


class FrameProcessor:
    """Procesa frames de video con YOLO + SORT tracking + orientación"""
    
    def __init__(self, model_path: str = "yolov8n.pt", confidence: float = 0.4, 
                 use_openvino: bool = True):
        self.model = None
        self.confidence = confidence
        self.model_path = model_path
        self.is_ready = False
        self.is_pose_model = False
        self.is_obb_model = False
        self.use_openvino = use_openvino and OPENVINO_AVAILABLE
        self.last_detections: List[Dict] = []
        self.last_processed_frame: Optional[str] = None
        self.last_tracks: List[Dict] = []
        
        # Tracker simple para seguimiento - solo por distancia de centros
        self.tracker = SimpleTracker(
            max_distance=150,    # 150px de tolerancia para match
            max_missing=30       # 30 frames sin ver = eliminar
        )
        
        # Para estadísticas
        self._frame_count = 0
        self._process_count = 0
        self._last_fps_time = time.time()
        self._fps = 0
        
        # Cargar modelo si está disponible
        if YOLO_AVAILABLE:
            self._load_model()
    
    def _get_openvino_model_path(self, pt_path: Path) -> Optional[Path]:
        """Obtiene la ruta del modelo OpenVINO pre-exportado"""
        # Buscar modelo pre-exportado (nombre_openvino_model/)
        openvino_dir = pt_path.parent / f"{pt_path.stem}_openvino_model"
        openvino_model = openvino_dir / f"{pt_path.stem}.xml"
        
        if openvino_model.exists():
            print(f"✅ Encontrado modelo OpenVINO pre-exportado: {openvino_dir}")
            return openvino_dir
        
        # Formato alternativo (nombre_openvino/)
        openvino_dir_alt = pt_path.parent / f"{pt_path.stem}_openvino"
        openvino_model_alt = openvino_dir_alt / f"{pt_path.stem}.xml"
        
        if openvino_model_alt.exists():
            print(f"✅ Encontrado modelo OpenVINO: {openvino_dir_alt}")
            return openvino_dir_alt
        
        # No exportar en runtime - usar modelo pre-exportado
        print(f"ℹ️ No hay modelo OpenVINO para {pt_path.name}")
        return None
    
    def _load_model(self):
        """Carga el modelo YOLO - preferir modelo Pose con keypoints"""
        try:
            # Prioridad: modelo Pose con keypoint de orientación
            paths_to_try = [
                # Modelo Pose entrenado para miniaturas (PRIORIDAD)
                Path(__file__).parent.parent / "miniatures_pose.pt",
                # Modelo OBB (legacy)
                Path(__file__).parent.parent / "miniatures_obb.pt",
                # Modelo nano genérico (fallback)
                Path(__file__).parent.parent / "yolov8n.pt",
                Path("yolov8n.pt"),
            ]
            
            for path in paths_to_try:
                if path.exists():
                    self.is_pose_model = "pose" in path.name.lower()
                    self.is_obb_model = "obb" in path.name.lower()
                    
                    # Intentar cargar versión OpenVINO si está disponible
                    if self.use_openvino and not self.is_obb_model:
                        # OBB no soporta bien OpenVINO por ahora
                        openvino_path = self._get_openvino_model_path(path)
                        if openvino_path:
                            print(f"📦 Cargando modelo OpenVINO: {openvino_path}")
                            self.model = YOLO(str(openvino_path))
                            self.is_ready = True
                            model_type = "(Pose+OpenVINO)" if self.is_pose_model else "(OpenVINO)"
                            print(f"✅ Modelo {path.name} cargado {model_type}")
                            return
                    
                    # Fallback a modelo PyTorch normal
                    print(f"📦 Cargando modelo YOLO: {path.name}")
                    self.model = YOLO(str(path))
                    self.is_ready = True
                    model_type = "(Pose)" if self.is_pose_model else "(OBB)" if self.is_obb_model else ""
                    print(f"✅ Modelo {path.name} cargado {model_type}")
                    return
            
            # Descargar nano si no hay ninguno
            print(f"⚠️ Descargando YOLOv8n (modelo ligero)...")
            self.model = YOLO("yolov8n.pt")
            self.is_ready = True
            self.is_pose_model = False
            self.is_obb_model = False
            print(f"✅ YOLOv8n listo")
                
        except Exception as e:
            print(f"❌ Error cargando YOLO: {e}")
            self.is_ready = False
            self.is_obb_model = False
    
    def process_frame(self, frame_base64: str) -> Tuple[str, List[Dict]]:
        """
        Procesa un frame con YOLO + tracking.
        El skip de frames se maneja ahora en el servidor (main.py) con buffer único.
        """
        self._frame_count += 1
        
        try:
            result = self._process_sync(frame_base64)
            
            self.last_processed_frame = result[0]
            self.last_detections = result[1]
            self._process_count += 1
            
            # Calcular FPS
            now = time.time()
            elapsed = now - self._last_fps_time
            if elapsed >= 2.0:
                self._fps = self._process_count / elapsed
                print(f"📊 YOLO: {self._fps:.1f} FPS procesados")
                self._process_count = 0
                self._last_fps_time = now
            
            return result
            
        except Exception as e:
            print(f"Error procesando frame: {e}")
            return frame_base64, []
    
    def _process_sync(self, frame_base64: str) -> Tuple[str, List[Dict]]:
        """Procesamiento síncrono del frame - optimizado para velocidad"""
        if not CV2_AVAILABLE:
            print("⚠️ OpenCV no disponible")
            return frame_base64, []
        
        # Decodificar
        try:
            frame_bytes = base64.b64decode(frame_base64)
            nparr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        except Exception as e:
            print(f"❌ Error decodificando frame: {e}")
            return frame_base64, []
        
        if frame is None:
            print("⚠️ Frame decodificado es None")
            return frame_base64, []
        
        h, w = frame.shape[:2]
        detections = []
        
        # Info de debug en frame
        model_status = "LISTO" if self.is_ready else "NO CARGADO"
        model_type = "Pose" if self.is_pose_model else "OBB" if self.is_obb_model else "Normal"
        
        if self.is_ready and self.model:
            # Reducir tamaño para procesamiento rápido (320 es más rápido que 416)
            max_size = 320
            scale = min(max_size / w, max_size / h, 1.0)
            
            if scale < 1:
                small = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
            else:
                small = frame
                scale = 1.0
            
            # Inferencia optimizada
            results = self.model(
                small,
                conf=self.confidence,
                verbose=False,
                imgsz=320,
                max_det=10,      # Menos detecciones = más rápido
                half=False,      # True si tienes GPU con FP16
            )
            
            for result in results:
                # Procesar Pose (keypoints) - PRIORIDAD
                if hasattr(result, 'keypoints') and result.keypoints is not None and len(result.boxes):
                    for i, (box, kpts) in enumerate(zip(result.boxes, result.keypoints.xy)):
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        x1, y1, x2, y2 = int(x1/scale), int(y1/scale), int(x2/scale), int(y2/scale)
                        
                        conf = float(box.conf[0])
                        cls = int(box.cls[0])
                        name = result.names[cls]
                        
                        # Centro del bbox
                        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                        
                        # Keypoint de orientación (punto frontal)
                        orientation = 0.0
                        front_point = None
                        if len(kpts) > 0:
                            fx, fy = float(kpts[0][0]) / scale, float(kpts[0][1]) / scale
                            if fx > 0 and fy > 0:  # Keypoint válido
                                front_point = {"x": int(fx), "y": int(fy)}
                                # Calcular ángulo desde centro hacia keypoint
                                dx = fx - cx
                                dy = fy - cy
                                orientation = float(np.degrees(np.arctan2(dy, dx)))
                        
                        detections.append({
                            "class": name,
                            "confidence": round(conf, 2),
                            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                            "center": {"x": cx, "y": cy},
                            "orientation": round(orientation, 1),
                            "front_point": front_point,
                            "is_pose": True
                        })
                
                # Procesar OBB (Oriented Bounding Boxes)
                elif hasattr(result, 'obb') and result.obb is not None and len(result.obb):
                    for i in range(len(result.obb)):
                        xywhr = result.obb.xywhr[i].cpu().numpy()
                        cx, cy, bw, bh, rotation = xywhr
                        cx, cy, bw, bh = cx/scale, cy/scale, bw/scale, bh/scale
                        angle_deg = float(rotation) * 180 / np.pi
                        
                        conf = float(result.obb.conf[i])
                        cls = int(result.obb.cls[i])
                        name = result.names[cls]
                        
                        x1 = int(cx - bw/2)
                        y1 = int(cy - bh/2)
                        x2 = int(cx + bw/2)
                        y2 = int(cy + bh/2)
                        
                        detections.append({
                            "class": name,
                            "confidence": round(conf, 2),
                            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                            "center": {"x": int(cx), "y": int(cy)},
                            "orientation": round(angle_deg, 1),
                            "is_obb": True
                        })
                
                # Fallback: detección normal (boxes) - sin orientación
                elif hasattr(result, 'boxes') and result.boxes is not None:
                    for box in result.boxes:
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        x1, y1, x2, y2 = int(x1/scale), int(y1/scale), int(x2/scale), int(y2/scale)
                        conf = float(box.conf[0])
                        cls = int(box.cls[0])
                        name = result.names[cls]
                        
                        # Sin OBB, orientación es 0
                        detections.append({
                            "class": name,
                            "confidence": round(conf, 2),
                            "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                            "center": {"x": (x1+x2)//2, "y": (y1+y2)//2},
                            "orientation": 0.0,
                            "is_obb": False
                        })
        
        # Eliminar detecciones duplicadas (NMS manual)
        detections = self._remove_duplicates(detections)
        
        # Actualizar tracker con detecciones
        tracked_objects = self.tracker.update(detections)
        self.last_tracks = [t.to_dict() for t in tracked_objects]
        
        # Dibujar tracks en el frame
        for track in tracked_objects:
            x1, y1, x2, y2 = track.bbox
            color = self._get_color(track.id)
            
            # Bounding box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            
            # ID 
            label = f"#{track.id}"
            cv2.putText(frame, label, (x1, y1-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
            # Flecha de orientación - OBB usa ángulo directo del modelo
            cx, cy = track.center
            # El ángulo OBB viene en radianes convertido a grados, 0 = horizontal derecha
            angle_rad = np.radians(track.orientation)
            arrow_len = max(30, min(x2-x1, y2-y1) // 2)
            end_x = int(cx + arrow_len * np.cos(angle_rad))
            end_y = int(cy + arrow_len * np.sin(angle_rad))
            cv2.arrowedLine(frame, (cx, cy), (end_x, end_y), (0, 255, 255), 2, tipLength=0.3)
            
            # Mostrar ángulo
            angle_text = f"{track.orientation:.0f}°"
            cv2.putText(frame, angle_text, (x2+5, y1+15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
        
        if not self.is_ready:
            cv2.putText(frame, f"YOLO: {model_status}", (10, 30), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
        
        # Overlay info - SIEMPRE mostrar
        info = f"Tracks: {len(tracked_objects)} | YOLO: {self._fps:.1f} fps | {model_type}"
        cv2.putText(frame, info, (10, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        
        # Mostrar estado del modelo arriba a la derecha
        status_color = (0, 255, 0) if self.is_ready else (0, 0, 255)
        cv2.putText(frame, model_status, (w - 100, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.5, status_color, 2)
        
        # Codificar (calidad reducida para velocidad)
        _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
        return base64.b64encode(buf).decode('utf-8'), self.last_tracks
    
    def get_tracks(self) -> List[Dict]:
        """Retorna los tracks actuales"""
        return self.last_tracks
    
    def _remove_duplicates(self, detections: List[Dict], iou_threshold: float = 0.5) -> List[Dict]:
        """
        Elimina detecciones duplicadas usando IoU.
        Mantiene la de mayor confianza.
        """
        if len(detections) <= 1:
            return detections
        
        # Ordenar por confianza descendente
        detections = sorted(detections, key=lambda x: x.get("confidence", 0), reverse=True)
        
        keep = []
        for det in detections:
            is_duplicate = False
            b1 = det["bbox"]
            
            for kept in keep:
                b2 = kept["bbox"]
                
                # Calcular IoU
                x1 = max(b1["x1"], b2["x1"])
                y1 = max(b1["y1"], b2["y1"])
                x2 = min(b1["x2"], b2["x2"])
                y2 = min(b1["y2"], b2["y2"])
                
                inter = max(0, x2 - x1) * max(0, y2 - y1)
                area1 = (b1["x2"] - b1["x1"]) * (b1["y2"] - b1["y1"])
                area2 = (b2["x2"] - b2["x1"]) * (b2["y2"] - b2["y1"])
                union = area1 + area2 - inter
                
                iou = inter / union if union > 0 else 0
                
                if iou > iou_threshold:
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                keep.append(det)
        
        return keep
    
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
