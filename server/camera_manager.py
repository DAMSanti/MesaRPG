"""
MesaRPG - Camera Manager
Gestiona la cámara cenital para tracking de miniaturas
"""

import asyncio
import base64
import json
from datetime import datetime
from typing import Optional, Dict, List, Tuple, Callable, Any
from dataclasses import dataclass, field
from enum import Enum
import threading
import time

# OpenCV es opcional - solo necesario si se usa cámara local
try:
    import cv2
    import numpy as np
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    cv2 = None
    np = None
    print("⚠️ OpenCV no disponible - funcionalidad de cámara deshabilitada")


class CameraState(str, Enum):
    """Estados de la cámara"""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    STREAMING = "streaming"
    ERROR = "error"
    CALIBRATING = "calibrating"


class DetectionMode(str, Enum):
    """Modos de detección"""
    ARUCO = "aruco"           # Marcadores ArUco
    COLOR = "color"           # Detección por color
    CONTOUR = "contour"       # Detección por contorno
    YOLO = "yolo"             # YOLO para objetos genéricos


@dataclass
class TrackedMiniature:
    """Representa una miniatura detectada y trackeada"""
    marker_id: int
    player_id: Optional[str] = None
    player_name: Optional[str] = None
    character_name: Optional[str] = None
    
    # Posición actual (en coordenadas de juego/hex)
    x: float = 0.0
    y: float = 0.0
    rotation: float = 0.0
    
    # Posición en píxeles (para debug/visualización)
    pixel_x: float = 0.0
    pixel_y: float = 0.0
    
    # Historial de posiciones para suavizado
    position_history: List[Tuple[float, float]] = field(default_factory=list)
    
    # Timestamps
    last_seen: datetime = field(default_factory=datetime.now)
    first_seen: datetime = field(default_factory=datetime.now)
    
    # Estado
    is_visible: bool = True
    confidence: float = 1.0
    
    def update_position(self, x: float, y: float, rotation: float, 
                       pixel_x: float, pixel_y: float, smoothing: int = 5):
        """Actualiza la posición con suavizado"""
        self.position_history.append((x, y))
        if len(self.position_history) > smoothing:
            self.position_history = self.position_history[-smoothing:]
        
        # Calcular posición suavizada
        if len(self.position_history) >= 2:
            avg_x = sum(p[0] for p in self.position_history) / len(self.position_history)
            avg_y = sum(p[1] for p in self.position_history) / len(self.position_history)
            self.x = avg_x
            self.y = avg_y
        else:
            self.x = x
            self.y = y
        
        self.rotation = rotation
        self.pixel_x = pixel_x
        self.pixel_y = pixel_y
        self.last_seen = datetime.now()
        self.is_visible = True
    
    def to_dict(self) -> dict:
        """Convierte a diccionario para JSON"""
        return {
            "marker_id": self.marker_id,
            "player_id": self.player_id,
            "player_name": self.player_name,
            "character_name": self.character_name,
            "x": round(self.x, 2),
            "y": round(self.y, 2),
            "rotation": round(self.rotation, 1),
            "pixel_x": round(self.pixel_x, 1),
            "pixel_y": round(self.pixel_y, 1),
            "is_visible": self.is_visible,
            "confidence": round(self.confidence, 2),
            "last_seen": self.last_seen.isoformat()
        }


@dataclass
class CalibrationData:
    """Datos de calibración de la cámara"""
    # Puntos de referencia en la imagen (4 esquinas)
    image_points: List[Tuple[float, float]] = field(default_factory=list)
    # Puntos correspondientes en el tablero de juego
    game_points: List[Tuple[float, float]] = field(default_factory=list)
    # Matriz de homografía calculada
    homography_matrix: Any = None  # np.ndarray cuando cv2 está disponible
    # Tamaño del área de juego
    game_width: float = 1920.0
    game_height: float = 1080.0
    # Calibrado?
    is_calibrated: bool = False
    
    def calculate_homography(self) -> bool:
        """Calcula la matriz de homografía a partir de los puntos"""
        if not CV2_AVAILABLE:
            return False
        if len(self.image_points) < 4 or len(self.game_points) < 4:
            return False
        
        try:
            src = np.array(self.image_points, dtype=np.float32)
            dst = np.array(self.game_points, dtype=np.float32)
            self.homography_matrix, _ = cv2.findHomography(src, dst)
            self.is_calibrated = self.homography_matrix is not None
            return self.is_calibrated
        except Exception as e:
            print(f"Error calculando homografía: {e}")
            return False
    
    def transform_point(self, px: float, py: float) -> Tuple[float, float]:
        """Transforma un punto de imagen a coordenadas de juego"""
        if not CV2_AVAILABLE:
            return px, py
        if self.homography_matrix is not None:
            point = np.array([[[px, py]]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point, self.homography_matrix)
            return float(transformed[0][0][0]), float(transformed[0][0][1])
        else:
            # Transformación lineal simple si no hay calibración
            return px, py


class CameraManager:
    """
    Gestor principal de la cámara cenital.
    Maneja la conexión, detección y tracking de miniaturas.
    """
    
    def __init__(self):
        # Estado
        self.state: CameraState = CameraState.DISCONNECTED
        self.error_message: Optional[str] = None
        
        # Verificar si cv2 está disponible
        self.cv2_available = CV2_AVAILABLE
        
        # Configuración de cámara
        self.camera_id: int = 0
        self.camera_url: Optional[str] = None  # Para cámaras IP
        self.cap = None  # cv2.VideoCapture cuando está disponible
        self.frame_width: int = 1280
        self.frame_height: int = 720
        self.fps: int = 30
        
        # Configuración de detección (solo si cv2 está disponible)
        self.detection_mode: DetectionMode = DetectionMode.ARUCO
        if CV2_AVAILABLE:
            self.aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
            self.aruco_params = cv2.aruco.DetectorParameters()
            self.aruco_detector = cv2.aruco.ArucoDetector(self.aruco_dict, self.aruco_params)
        else:
            self.aruco_dict = None
            self.aruco_params = None
            self.aruco_detector = None
        
        # Calibración
        self.calibration = CalibrationData()
        
        # Tracking
        self.tracked_miniatures: Dict[int, TrackedMiniature] = {}
        self.miniature_timeout: float = 5.0  # Segundos sin ver antes de marcar como no visible
        
        # Streaming
        self.is_streaming: bool = False
        self.stream_quality: int = 80  # JPEG quality
        self.stream_fps: int = 15
        self.last_frame: Optional[np.ndarray] = None
        self.last_frame_encoded: Optional[str] = None
        
        # IP Camera streaming
        self._ip_stream_active: bool = False
        
        # Threading
        self._capture_thread: Optional[threading.Thread] = None
        self._running: bool = False
        self._lock = threading.Lock()
        
        # Callbacks
        self._on_markers_detected: Optional[Callable[[List[dict]], None]] = None
        self._on_state_change: Optional[Callable[[CameraState], None]] = None
        
        # Estadísticas
        self.stats = {
            "frames_processed": 0,
            "markers_detected_total": 0,
            "last_detection_time": None,
            "avg_detection_time_ms": 0.0
        }
    
    def set_callbacks(self, 
                      on_markers_detected: Callable[[List[dict]], None] = None,
                      on_state_change: Callable[[CameraState], None] = None):
        """Configura los callbacks"""
        self._on_markers_detected = on_markers_detected
        self._on_state_change = on_state_change
    
    def stop_ip_stream(self):
        """Detiene el streaming de cámara IP"""
        self._ip_stream_active = False
    def _set_state(self, state: CameraState, error: str = None):
        """Cambia el estado y notifica"""
        self.state = state
        self.error_message = error
        if self._on_state_change:
            self._on_state_change(state)
    
    # === Gestión de cámara ===
    
    def connect(self, camera_id: int = 0, camera_url: str = None) -> bool:
        """Conecta a la cámara"""
        if not CV2_AVAILABLE:
            self._set_state(CameraState.ERROR, "OpenCV no disponible en este servidor")
            return False
            
        self._set_state(CameraState.CONNECTING)
        
        try:
            self.camera_id = camera_id
            self.camera_url = camera_url
            
            if camera_url:
                print(f"📱 Conectando a cámara IP: {camera_url}")
                self.cap = cv2.VideoCapture(camera_url)
            else:
                print(f"📷 Abriendo cámara USB ID: {camera_id}")
                self.cap = cv2.VideoCapture(camera_id)
            
            if not self.cap.isOpened():
                source = camera_url or f"cámara {camera_id}"
                self._set_state(CameraState.ERROR, f"No se pudo abrir: {source}")
                return False
            
            # Configurar resolución
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_height)
            self.cap.set(cv2.CAP_PROP_FPS, self.fps)
            
            # Obtener resolución real
            self.frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self.frame_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            actual_fps = int(self.cap.get(cv2.CAP_PROP_FPS))
            
            print(f"📷 Cámara conectada: {self.frame_width}x{self.frame_height} @ {actual_fps}fps")
            self._set_state(CameraState.CONNECTED)
            return True
            
        except Exception as e:
            self._set_state(CameraState.ERROR, str(e))
            return False
    
    def disconnect(self):
        """Desconecta la cámara"""
        self.stop_streaming()
        
        if self.cap:
            self.cap.release()
            self.cap = None
        
        self._set_state(CameraState.DISCONNECTED)
        print("📷 Cámara desconectada")
    
    def get_available_cameras(self) -> List[dict]:
        """Lista las cámaras disponibles"""
        if not CV2_AVAILABLE:
            return []
            
        cameras = []
        
        for i in range(10):  # Probar hasta 10 índices
            cap = cv2.VideoCapture(i)
            if cap.isOpened():
                cameras.append({
                    "id": i,
                    "name": f"Cámara {i}",
                    "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                    "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                })
                cap.release()
        
        return cameras
    
    # === Streaming ===
    
    def start_streaming(self):
        """Inicia el streaming de video con detección"""
        if not CV2_AVAILABLE:
            print("⚠️ OpenCV no disponible")
            return False
            
        if self.state != CameraState.CONNECTED:
            if not self.cap or not self.cap.isOpened():
                print("⚠️ Cámara no conectada")
                return False
        
        if self._running:
            return True  # Ya está corriendo
        
        self._running = True
        self.is_streaming = True
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._capture_thread.start()
        
        self._set_state(CameraState.STREAMING)
        print("🎥 Streaming iniciado")
        return True
    
    def stop_streaming(self):
        """Detiene el streaming"""
        self._running = False
        self.is_streaming = False
        
        if self._capture_thread:
            self._capture_thread.join(timeout=2.0)
            self._capture_thread = None
        
        if self.state == CameraState.STREAMING:
            self._set_state(CameraState.CONNECTED)
        print("🎥 Streaming detenido")
    
    def _capture_loop(self):
        """Loop de captura en thread separado"""
        frame_interval = 1.0 / self.stream_fps
        last_frame_time = 0
        
        while self._running and self.cap and self.cap.isOpened():
            current_time = time.time()
            
            ret, frame = self.cap.read()
            if not ret:
                continue
            
            # Detectar marcadores
            start_time = time.time()
            markers, annotated_frame = self._detect_markers(frame)
            detection_time = (time.time() - start_time) * 1000
            
            # Actualizar estadísticas
            self.stats["frames_processed"] += 1
            self.stats["markers_detected_total"] += len(markers)
            self.stats["last_detection_time"] = datetime.now().isoformat()
            self.stats["avg_detection_time_ms"] = (
                self.stats["avg_detection_time_ms"] * 0.9 + detection_time * 0.1
            )
            
            # Actualizar tracking
            self._update_tracking(markers)
            
            # Notificar detecciones
            if markers and self._on_markers_detected:
                try:
                    self._on_markers_detected(markers)
                except Exception as e:
                    print(f"Error en callback de marcadores: {e}")
            
            # Codificar frame para streaming (con rate limit)
            if current_time - last_frame_time >= frame_interval:
                with self._lock:
                    self.last_frame = annotated_frame.copy()
                    _, buffer = cv2.imencode('.jpg', annotated_frame, 
                                            [cv2.IMWRITE_JPEG_QUALITY, self.stream_quality])
                    self.last_frame_encoded = base64.b64encode(buffer).decode('utf-8')
                last_frame_time = current_time
            
            # Pequeña pausa para no saturar CPU
            time.sleep(0.001)
    
    def get_current_frame(self) -> Optional[str]:
        """Obtiene el frame actual codificado en base64"""
        with self._lock:
            return self.last_frame_encoded
    
    def capture_single_frame(self) -> Optional[str]:
        """Captura un único frame"""
        if not self.cap or not self.cap.isOpened():
            return None
        
        ret, frame = self.cap.read()
        if not ret:
            return None
        
        _, annotated = self._detect_markers(frame)
        _, buffer = cv2.imencode('.jpg', annotated, 
                                [cv2.IMWRITE_JPEG_QUALITY, self.stream_quality])
        return base64.b64encode(buffer).decode('utf-8')
    
    # === Detección ===
    
    def _detect_markers(self, frame: Any) -> Tuple[List[dict], Any]:
        """Detecta marcadores ArUco en el frame"""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, rejected = self.aruco_detector.detectMarkers(gray)
        
        markers = []
        annotated = frame.copy()
        
        if ids is not None and len(ids) > 0:
            cv2.aruco.drawDetectedMarkers(annotated, corners, ids)
            
            for i, marker_id in enumerate(ids.flatten()):
                corner = corners[i][0]
                
                # Centro en píxeles
                center_x = float(np.mean(corner[:, 0]))
                center_y = float(np.mean(corner[:, 1]))
                
                # Rotación
                dx = corner[1][0] - corner[0][0]
                dy = corner[1][1] - corner[0][1]
                rotation = float(np.degrees(np.arctan2(dy, dx)))
                
                # Convertir a coordenadas de juego
                game_x, game_y = self.calibration.transform_point(center_x, center_y)
                
                marker_data = {
                    "id": int(marker_id),
                    "x": game_x,
                    "y": game_y,
                    "rotation": rotation,
                    "pixel_x": center_x,
                    "pixel_y": center_y,
                    "corners": corner.tolist()
                }
                markers.append(marker_data)
                
                # Anotar en frame
                miniature = self.tracked_miniatures.get(marker_id)
                label = f"ID:{marker_id}"
                if miniature and miniature.player_name:
                    label = f"{miniature.player_name}"
                
                cv2.putText(annotated, label,
                           (int(center_x) - 30, int(center_y) - 20),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                cv2.circle(annotated, (int(center_x), int(center_y)), 5, (0, 0, 255), -1)
        
        # Dibujar info de tracking
        self._draw_tracking_overlay(annotated)
        
        return markers, annotated
    
    def _draw_tracking_overlay(self, frame: Any):
        """Dibuja información de overlay en el frame"""
        # Info de estado
        status_text = f"Estado: {self.state.value}"
        cv2.putText(frame, status_text, (10, 25), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        # Conteo de miniaturas
        visible = sum(1 for m in self.tracked_miniatures.values() if m.is_visible)
        total = len(self.tracked_miniatures)
        count_text = f"Miniaturas: {visible}/{total}"
        cv2.putText(frame, count_text, (10, 50),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        # FPS de procesamiento
        if self.stats["avg_detection_time_ms"] > 0:
            fps = 1000 / self.stats["avg_detection_time_ms"]
            fps_text = f"FPS: {fps:.1f}"
            cv2.putText(frame, fps_text, (10, 75),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    
    # === Tracking ===
    
    def _update_tracking(self, markers: List[dict]):
        """Actualiza el tracking de miniaturas"""
        seen_ids = set()
        
        for marker in markers:
            marker_id = marker["id"]
            seen_ids.add(marker_id)
            
            if marker_id not in self.tracked_miniatures:
                # Nueva miniatura detectada
                self.tracked_miniatures[marker_id] = TrackedMiniature(
                    marker_id=marker_id,
                    first_seen=datetime.now()
                )
            
            # Actualizar posición
            self.tracked_miniatures[marker_id].update_position(
                x=marker["x"],
                y=marker["y"],
                rotation=marker["rotation"],
                pixel_x=marker["pixel_x"],
                pixel_y=marker["pixel_y"]
            )
        
        # Marcar las no visibles
        now = datetime.now()
        for marker_id, miniature in self.tracked_miniatures.items():
            if marker_id not in seen_ids:
                time_since_seen = (now - miniature.last_seen).total_seconds()
                if time_since_seen > self.miniature_timeout:
                    miniature.is_visible = False
    
    def assign_player_to_miniature(self, marker_id: int, player_id: str, 
                                   player_name: str, character_name: str = None) -> bool:
        """Asigna un jugador a una miniatura"""
        if marker_id not in self.tracked_miniatures:
            # Crear entrada aunque no se haya visto todavía
            self.tracked_miniatures[marker_id] = TrackedMiniature(marker_id=marker_id)
        
        miniature = self.tracked_miniatures[marker_id]
        miniature.player_id = player_id
        miniature.player_name = player_name
        miniature.character_name = character_name
        
        print(f"✅ Miniatura {marker_id} asignada a {player_name}")
        return True
    
    def unassign_miniature(self, marker_id: int) -> bool:
        """Desasigna un jugador de una miniatura"""
        if marker_id in self.tracked_miniatures:
            miniature = self.tracked_miniatures[marker_id]
            miniature.player_id = None
            miniature.player_name = None
            miniature.character_name = None
            return True
        return False
    
    def get_miniature_for_player(self, player_id: str) -> Optional[TrackedMiniature]:
        """Obtiene la miniatura asignada a un jugador"""
        for miniature in self.tracked_miniatures.values():
            if miniature.player_id == player_id:
                return miniature
        return None
    
    def get_all_miniatures(self) -> List[dict]:
        """Obtiene todas las miniaturas trackeadas"""
        return [m.to_dict() for m in self.tracked_miniatures.values()]
    
    def get_visible_miniatures(self) -> List[dict]:
        """Obtiene solo las miniaturas visibles"""
        return [m.to_dict() for m in self.tracked_miniatures.values() if m.is_visible]
    
    # === Calibración ===
    
    def start_calibration(self):
        """Inicia el modo de calibración"""
        self.calibration = CalibrationData()
        self._set_state(CameraState.CALIBRATING)
    
    def add_calibration_point(self, image_x: float, image_y: float,
                              game_x: float, game_y: float) -> int:
        """Añade un punto de calibración"""
        self.calibration.image_points.append((image_x, image_y))
        self.calibration.game_points.append((game_x, game_y))
        return len(self.calibration.image_points)
    
    def finish_calibration(self) -> bool:
        """Finaliza la calibración calculando la homografía"""
        if self.calibration.calculate_homography():
            self._set_state(CameraState.CONNECTED if not self._running else CameraState.STREAMING)
            print("✅ Calibración completada")
            return True
        else:
            print("❌ Error en calibración")
            return False
    
    def set_simple_calibration(self, game_width: float, game_height: float):
        """Calibración simple: mapeo lineal de imagen a área de juego"""
        self.calibration.game_width = game_width
        self.calibration.game_height = game_height
        
        # Puntos de las 4 esquinas
        self.calibration.image_points = [
            (0, 0),
            (self.frame_width, 0),
            (self.frame_width, self.frame_height),
            (0, self.frame_height)
        ]
        self.calibration.game_points = [
            (0, 0),
            (game_width, 0),
            (game_width, game_height),
            (0, game_height)
        ]
        
        return self.calibration.calculate_homography()
    
    # === Estado ===
    
    def get_status(self) -> dict:
        """Obtiene el estado completo de la cámara"""
        return {
            "state": self.state.value,
            "error": self.error_message,
            "camera_id": self.camera_id,
            "camera_url": self.camera_url,
            "resolution": {
                "width": self.frame_width,
                "height": self.frame_height
            },
            "is_streaming": self.is_streaming,
            "detection_mode": self.detection_mode.value,
            "calibration": {
                "is_calibrated": self.calibration.is_calibrated,
                "points_count": len(self.calibration.image_points),
                "game_size": {
                    "width": self.calibration.game_width,
                    "height": self.calibration.game_height
                }
            },
            "tracking": {
                "total_miniatures": len(self.tracked_miniatures),
                "visible_miniatures": sum(1 for m in self.tracked_miniatures.values() if m.is_visible),
                "assigned_miniatures": sum(1 for m in self.tracked_miniatures.values() if m.player_id)
            },
            "stats": self.stats,
            "cv2_available": CV2_AVAILABLE
        }


# Instancia global del gestor de cámara
camera_manager = CameraManager()
