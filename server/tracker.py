"""
MesaRPG - Sistema de Tracking Ligero
SORT tracker + detección de orientación sin ML pesado
"""

import numpy as np
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, field
from collections import deque
import time


@dataclass
class TrackedObject:
    """Objeto trackeado con historial de posiciones"""
    id: int
    class_name: str
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    center: Tuple[int, int]
    confidence: float
    orientation: float = 0.0  # Ángulo en grados (0-360)
    
    # Historial para suavizado y predicción
    position_history: deque = field(default_factory=lambda: deque(maxlen=10))
    orientation_history: deque = field(default_factory=lambda: deque(maxlen=5))
    
    # Timestamps
    last_seen: float = field(default_factory=time.time)
    first_seen: float = field(default_factory=time.time)
    frames_tracked: int = 0
    frames_missing: int = 0
    
    # Estado
    is_active: bool = True
    velocity: Tuple[float, float] = (0.0, 0.0)
    
    def update(self, bbox: Tuple[int, int, int, int], confidence: float, orientation: float = None):
        """Actualiza la posición del objeto"""
        old_center = self.center
        
        self.bbox = bbox
        x1, y1, x2, y2 = bbox
        self.center = ((x1 + x2) // 2, (y1 + y2) // 2)
        self.confidence = confidence
        self.last_seen = time.time()
        self.frames_tracked += 1
        self.frames_missing = 0
        self.is_active = True
        
        # Historial de posiciones
        self.position_history.append(self.center)
        
        # Calcular velocidad
        if len(self.position_history) >= 2:
            prev = self.position_history[-2]
            self.velocity = (self.center[0] - prev[0], self.center[1] - prev[1])
        
        # Orientación con suavizado
        if orientation is not None:
            self.orientation_history.append(orientation)
            # Promedio circular para ángulos
            self.orientation = self._circular_mean(list(self.orientation_history))
    
    def predict_position(self) -> Tuple[int, int]:
        """Predice la siguiente posición basándose en velocidad"""
        return (
            int(self.center[0] + self.velocity[0]),
            int(self.center[1] + self.velocity[1])
        )
    
    def mark_missing(self):
        """Marca el objeto como no visto en este frame"""
        self.frames_missing += 1
        if self.frames_missing > 10:  # 10 frames sin ver = inactivo
            self.is_active = False
    
    def _circular_mean(self, angles: List[float]) -> float:
        """Calcula la media circular de ángulos"""
        if not angles:
            return 0.0
        sins = sum(np.sin(np.radians(a)) for a in angles)
        coss = sum(np.cos(np.radians(a)) for a in angles)
        return np.degrees(np.arctan2(sins / len(angles), coss / len(angles))) % 360
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "class": self.class_name,
            "bbox": {"x1": self.bbox[0], "y1": self.bbox[1], "x2": self.bbox[2], "y2": self.bbox[3]},
            "center": {"x": self.center[0], "y": self.center[1]},
            "confidence": round(self.confidence, 2),
            "orientation": round(self.orientation, 1),
            "velocity": {"x": round(self.velocity[0], 1), "y": round(self.velocity[1], 1)},
            "frames_tracked": self.frames_tracked,
            "is_active": self.is_active
        }


class SORTTracker:
    """
    Simple Online Realtime Tracker (SORT) - Implementación ligera
    Solo usa numpy, sin dependencias de ML
    Optimizado para miniaturas con detección OBB
    """
    
    def __init__(self, max_age: int = 30, min_hits: int = 1, iou_threshold: float = 0.15, distance_threshold: float = 100):
        """
        Args:
            max_age: Frames máximos sin detección antes de eliminar track
            min_hits: Detecciones mínimas antes de confirmar track
            iou_threshold: Umbral de IoU para matching
            distance_threshold: Distancia máxima en píxeles para matching por centro
        """
        self.max_age = max_age
        self.min_hits = min_hits
        self.iou_threshold = iou_threshold
        self.distance_threshold = distance_threshold
        
        self.tracks: Dict[int, TrackedObject] = {}
        self.next_id = 1
        self.frame_count = 0
    
    def update(self, detections: List[dict]) -> List[TrackedObject]:
        """
        Actualiza tracks con nuevas detecciones
        
        Args:
            detections: Lista de detecciones [{"bbox": {x1,y1,x2,y2}, "class": str, "confidence": float, "orientation": float}]
        
        Returns:
            Lista de objetos trackeados activos
        """
        self.frame_count += 1
        
        if not detections:
            # Marcar todos como missing
            for track in self.tracks.values():
                track.mark_missing()
            return self._get_active_tracks()
        
        # Convertir detecciones a formato numpy
        det_boxes = np.array([
            [d["bbox"]["x1"], d["bbox"]["y1"], d["bbox"]["x2"], d["bbox"]["y2"]]
            for d in detections
        ])
        
        if not self.tracks:
            # Primer frame o sin tracks - crear nuevos
            for det in detections:
                self._create_track(det)
            return self._get_active_tracks()
        
        # Obtener boxes de tracks existentes
        track_ids = list(self.tracks.keys())
        track_boxes = np.array([
            list(self.tracks[tid].bbox) for tid in track_ids
        ])
        
        # Calcular matriz de IoU
        iou_matrix = self._iou_batch(det_boxes, track_boxes)
        
        # También calcular distancia entre centros (para cuando IoU falla)
        det_centers = np.array([[(d["bbox"]["x1"]+d["bbox"]["x2"])/2, (d["bbox"]["y1"]+d["bbox"]["y2"])/2] for d in detections])
        trk_centers = np.array([[t.center[0], t.center[1]] for t in [self.tracks[tid] for tid in track_ids]])
        
        # Matriz de distancias (normalizada a 0-1, donde 0 es cerca)
        dist_matrix = np.zeros((len(detections), len(track_ids)))
        for i, dc in enumerate(det_centers):
            for j, tc in enumerate(trk_centers):
                dist = np.sqrt((dc[0]-tc[0])**2 + (dc[1]-tc[1])**2)
                # Convertir distancia a score (1 = cerca, 0 = lejos)
                dist_matrix[i, j] = max(0, 1 - dist / self.distance_threshold)
        
        # Combinar IoU y distancia (usar el mejor de los dos)
        combined_matrix = np.maximum(iou_matrix, dist_matrix * 0.5)
        
        # Hungarian matching (greedy para simplicidad)
        matched_det, matched_trk, unmatched_det, unmatched_trk = self._match(
            combined_matrix, track_ids, len(detections)
        )
        
        # Actualizar tracks matched
        for det_idx, trk_id in zip(matched_det, matched_trk):
            det = detections[det_idx]
            bbox = (det["bbox"]["x1"], det["bbox"]["y1"], det["bbox"]["x2"], det["bbox"]["y2"])
            self.tracks[trk_id].update(
                bbox=bbox,
                confidence=det.get("confidence", 1.0),
                orientation=det.get("orientation")
            )
        
        # Marcar unmatched tracks como missing
        for trk_id in unmatched_trk:
            self.tracks[trk_id].mark_missing()
        
        # Crear nuevos tracks para detecciones sin match
        for det_idx in unmatched_det:
            self._create_track(detections[det_idx])
        
        # Limpiar tracks inactivos
        self._cleanup()
        
        return self._get_active_tracks()
    
    def _create_track(self, detection: dict) -> int:
        """Crea un nuevo track"""
        bbox = (detection["bbox"]["x1"], detection["bbox"]["y1"], 
                detection["bbox"]["x2"], detection["bbox"]["y2"])
        center = ((bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2)
        
        track = TrackedObject(
            id=self.next_id,
            class_name=detection.get("class", "unknown"),
            bbox=bbox,
            center=center,
            confidence=detection.get("confidence", 1.0),
            orientation=detection.get("orientation", 0.0)
        )
        
        self.tracks[self.next_id] = track
        self.next_id += 1
        
        return track.id
    
    def _match(self, iou_matrix: np.ndarray, track_ids: List[int], num_det: int):
        """Matching greedy basado en IoU"""
        matched_det = []
        matched_trk = []
        unmatched_det = list(range(num_det))
        unmatched_trk = list(track_ids)
        
        if iou_matrix.size == 0:
            return matched_det, matched_trk, unmatched_det, unmatched_trk
        
        # Greedy matching - tomar el mejor IoU iterativamente
        while True:
            max_iou = np.max(iou_matrix)
            if max_iou < self.iou_threshold:
                break
            
            det_idx, trk_idx = np.unravel_index(np.argmax(iou_matrix), iou_matrix.shape)
            trk_id = track_ids[trk_idx]
            
            matched_det.append(det_idx)
            matched_trk.append(trk_id)
            
            if det_idx in unmatched_det:
                unmatched_det.remove(det_idx)
            if trk_id in unmatched_trk:
                unmatched_trk.remove(trk_id)
            
            # Invalidar fila y columna
            iou_matrix[det_idx, :] = 0
            iou_matrix[:, trk_idx] = 0
        
        return matched_det, matched_trk, unmatched_det, unmatched_trk
    
    def _iou_batch(self, boxes1: np.ndarray, boxes2: np.ndarray) -> np.ndarray:
        """Calcula IoU entre dos conjuntos de boxes"""
        # boxes: [N, 4] format: x1, y1, x2, y2
        n1, n2 = len(boxes1), len(boxes2)
        iou = np.zeros((n1, n2))
        
        for i, box1 in enumerate(boxes1):
            for j, box2 in enumerate(boxes2):
                iou[i, j] = self._iou(box1, box2)
        
        return iou
    
    def _iou(self, box1: np.ndarray, box2: np.ndarray) -> float:
        """Calcula IoU entre dos boxes"""
        x1 = max(box1[0], box2[0])
        y1 = max(box1[1], box2[1])
        x2 = min(box1[2], box2[2])
        y2 = min(box1[3], box2[3])
        
        inter = max(0, x2 - x1) * max(0, y2 - y1)
        
        area1 = (box1[2] - box1[0]) * (box1[3] - box1[1])
        area2 = (box2[2] - box2[0]) * (box2[3] - box2[1])
        
        union = area1 + area2 - inter
        
        return inter / union if union > 0 else 0
    
    def _cleanup(self):
        """Elimina tracks inactivos"""
        to_remove = [
            tid for tid, track in self.tracks.items()
            if not track.is_active or track.frames_missing > self.max_age
        ]
        for tid in to_remove:
            del self.tracks[tid]
    
    def _get_active_tracks(self) -> List[TrackedObject]:
        """Retorna tracks activos y confirmados"""
        return [
            track for track in self.tracks.values()
            if track.is_active and track.frames_tracked >= self.min_hits
        ]
    
    def get_all_tracks(self) -> List[TrackedObject]:
        """Retorna todos los tracks (incluso no confirmados)"""
        return list(self.tracks.values())
    
    def get_track(self, track_id: int) -> Optional[TrackedObject]:
        """Obtiene un track específico por ID"""
        return self.tracks.get(track_id)
    
    def reset(self):
        """Resetea el tracker"""
        self.tracks.clear()
        self.next_id = 1
        self.frame_count = 0


class OrientationDetector:
    """
    Detecta la orientación de miniaturas usando análisis de imagen
    Sin ML - usa características geométricas y de color
    """
    
    def __init__(self):
        self.front_color_hsv = None  # Color del marcador frontal (si se usa)
    
    def set_front_marker_color(self, hsv_lower: Tuple[int, int, int], hsv_upper: Tuple[int, int, int]):
        """Define el color del marcador frontal (ej: punto rojo en la base)"""
        self.front_color_hsv = (hsv_lower, hsv_upper)
    
    def detect_orientation(self, frame, bbox: Tuple[int, int, int, int]) -> float:
        """
        Detecta la orientación de un objeto en el bbox
        
        Args:
            frame: Frame completo (BGR)
            bbox: Bounding box (x1, y1, x2, y2)
        
        Returns:
            Ángulo en grados (0-360), donde 0 = arriba, 90 = derecha
        """
        try:
            import cv2
        except ImportError:
            return 0.0
        
        x1, y1, x2, y2 = bbox
        roi = frame[y1:y2, x1:x2]
        
        if roi.size == 0:
            return 0.0
        
        # Método 1: Buscar marcador de color frontal
        if self.front_color_hsv:
            angle = self._detect_by_color_marker(roi)
            if angle is not None:
                return angle
        
        # Método 2: Análisis de asimetría/forma
        return self._detect_by_shape(roi)
    
    def _detect_by_color_marker(self, roi) -> Optional[float]:
        """Detecta orientación por marcador de color"""
        import cv2
        
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        lower, upper = self.front_color_hsv
        mask = cv2.inRange(hsv, np.array(lower), np.array(upper))
        
        # Encontrar centroide del marcador
        moments = cv2.moments(mask)
        if moments["m00"] > 50:  # Área mínima
            cx = int(moments["m10"] / moments["m00"])
            cy = int(moments["m01"] / moments["m00"])
            
            # Centro del ROI
            h, w = roi.shape[:2]
            center_x, center_y = w // 2, h // 2
            
            # Calcular ángulo desde centro hacia marcador
            angle = np.degrees(np.arctan2(cy - center_y, cx - center_x))
            # Convertir a 0=arriba
            angle = (90 - angle) % 360
            return angle
        
        return None
    
    def _detect_by_shape(self, roi) -> float:
        """Detecta orientación por análisis de forma"""
        import cv2
        
        # Convertir a escala de grises
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        
        # Detectar bordes
        edges = cv2.Canny(gray, 50, 150)
        
        # Encontrar contornos
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return 0.0
        
        # Tomar el contorno más grande
        largest = max(contours, key=cv2.contourArea)
        
        if len(largest) < 5:
            return 0.0
        
        # Ajustar elipse
        try:
            ellipse = cv2.fitEllipse(largest)
            angle = ellipse[2]  # Ángulo de la elipse
            # Convertir a nuestro sistema (0=arriba)
            return (90 - angle) % 360
        except:
            return 0.0


# Instancia global del tracker
tracker = SORTTracker()
orientation_detector = OrientationDetector()

# Configurar marcador rojo como indicador frontal (opcional)
# orientation_detector.set_front_marker_color((0, 100, 100), (10, 255, 255))  # Rojo en HSV
