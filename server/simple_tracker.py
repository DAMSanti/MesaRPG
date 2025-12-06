"""
MesaRPG - Sistema de Tracking Simple
Tracker simplificado para miniaturas con detección OBB
"""

import numpy as np
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, field
from collections import deque
import time


@dataclass
class TrackedMini:
    """Miniatura trackeada"""
    id: int
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    center: Tuple[int, int]
    orientation: float = 0.0
    confidence: float = 0.0
    
    # Historial para suavizado
    orientation_history: deque = field(default_factory=lambda: deque(maxlen=10))
    
    last_seen: float = field(default_factory=time.time)
    frames_missing: int = 0
    
    def update(self, bbox, orientation, confidence):
        self.bbox = bbox
        x1, y1, x2, y2 = bbox
        self.center = ((x1 + x2) // 2, (y1 + y2) // 2)
        self.confidence = confidence
        self.last_seen = time.time()
        self.frames_missing = 0
        
        # Suavizar orientación
        self.orientation_history.append(orientation)
        self.orientation = self._smooth_angle()
    
    def _smooth_angle(self) -> float:
        """Media circular de ángulos"""
        if not self.orientation_history:
            return 0.0
        angles = list(self.orientation_history)
        sins = sum(np.sin(np.radians(a)) for a in angles)
        coss = sum(np.cos(np.radians(a)) for a in angles)
        return np.degrees(np.arctan2(sins, coss)) % 360
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "class": "miniatura",
            "bbox": {"x1": self.bbox[0], "y1": self.bbox[1], "x2": self.bbox[2], "y2": self.bbox[3]},
            "center": {"x": self.center[0], "y": self.center[1]},
            "confidence": round(self.confidence, 2),
            "orientation": round(self.orientation, 1),
        }


class SimpleTracker:
    """
    Tracker simple basado en distancia de centros.
    Ideal para pocas miniaturas que se mueven lentamente.
    """
    
    def __init__(self, max_distance: float = 100, max_missing: int = 30):
        self.max_distance = max_distance  # Distancia máxima para match (pixels)
        self.max_missing = max_missing    # Frames sin ver antes de eliminar
        self.tracks: Dict[int, TrackedMini] = {}
        self.next_id = 1
    
    def update(self, detections: List[dict]) -> List[TrackedMini]:
        """
        Actualiza tracks con nuevas detecciones.
        Usa matching simple por distancia de centros.
        """
        # Incrementar missing count de todos los tracks
        for track in self.tracks.values():
            track.frames_missing += 1
        
        # Si no hay detecciones, limpiar y retornar
        if not detections:
            self._cleanup()
            return list(self.tracks.values())
        
        # Para cada detección, buscar el track más cercano
        used_tracks = set()
        
        for det in detections:
            cx = det["center"]["x"]
            cy = det["center"]["y"]
            bbox = (det["bbox"]["x1"], det["bbox"]["y1"], det["bbox"]["x2"], det["bbox"]["y2"])
            orientation = det.get("orientation", 0.0)
            confidence = det.get("confidence", 1.0)
            
            # Buscar track más cercano
            best_track_id = None
            best_distance = float('inf')
            
            for tid, track in self.tracks.items():
                if tid in used_tracks:
                    continue
                
                dist = np.sqrt((cx - track.center[0])**2 + (cy - track.center[1])**2)
                if dist < best_distance and dist < self.max_distance:
                    best_distance = dist
                    best_track_id = tid
            
            if best_track_id is not None:
                # Actualizar track existente
                self.tracks[best_track_id].update(bbox, orientation, confidence)
                used_tracks.add(best_track_id)
            else:
                # Crear nuevo track
                new_track = TrackedMini(
                    id=self.next_id,
                    bbox=bbox,
                    center=(cx, cy),
                    orientation=orientation,
                    confidence=confidence
                )
                self.tracks[self.next_id] = new_track
                used_tracks.add(self.next_id)
                self.next_id += 1
        
        # Limpiar tracks antiguos
        self._cleanup()
        
        return list(self.tracks.values())
    
    def _cleanup(self):
        """Elimina tracks que no se han visto en mucho tiempo"""
        to_remove = [
            tid for tid, track in self.tracks.items()
            if track.frames_missing > self.max_missing
        ]
        for tid in to_remove:
            del self.tracks[tid]
    
    def reset(self):
        """Reinicia el tracker"""
        self.tracks.clear()
        self.next_id = 1
