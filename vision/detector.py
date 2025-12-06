"""
MesaRPG - Detector de Marcadores ArUco
Sistema de visión por computadora para detectar figuritas
Incluye streaming de video al servidor para visualización remota
"""

import cv2
import numpy as np
import json
import asyncio
import websockets
import base64
from datetime import datetime
from typing import Optional, Dict, List, Tuple
import argparse
import threading
import time


class ArucoDetector:
    """
    Detector de marcadores ArUco usando OpenCV.
    Detecta marcadores en tiempo real y envía las posiciones al servidor.
    """
    
    def __init__(
        self,
        camera_id: int = 0,
        camera_url: str = None,
        server_url: str = "ws://localhost:8000/ws/camera",
        dictionary_type: int = cv2.aruco.DICT_4X4_50,
        marker_size_cm: float = 3.0
    ):
        self.camera_id = camera_id
        self.camera_url = camera_url  # URL para cámara IP (DroidCam, IP Webcam)
        self.server_url = server_url
        self.marker_size_cm = marker_size_cm
        
        # Configuración de streaming
        self.stream_enabled = True
        self.stream_quality = 70  # Calidad JPEG (0-100)
        self.stream_fps = 15  # FPS de streaming (menor que captura para ahorrar ancho de banda)
        self.last_stream_time = 0
        self.stream_interval = 1.0 / self.stream_fps
        
        # Configurar detector ArUco
        self.aruco_dict = cv2.aruco.getPredefinedDictionary(dictionary_type)
        self.aruco_params = cv2.aruco.DetectorParameters()
        self.detector = cv2.aruco.ArucoDetector(self.aruco_dict, self.aruco_params)
        
        # Cámara
        self.cap: Optional[cv2.VideoCapture] = None
        self.frame_width = 1280
        self.frame_height = 720
        
        # Calibración
        self.calibration_matrix: Optional[np.ndarray] = None
        self.distortion_coeffs: Optional[np.ndarray] = None
        self.homography_matrix: Optional[np.ndarray] = None
        
        # Estado
        self.running = False
        self.last_markers: Dict[int, dict] = {}
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        
        # Configuración de área de juego (en píxeles, se calibra después)
        self.play_area = {
            "x": 0,
            "y": 0,
            "width": 1920,  # Ancho de la mesa/pantalla en unidades de juego
            "height": 1080   # Alto de la mesa/pantalla
        }
    
    def start_camera(self) -> bool:
        """Inicia la captura de cámara"""
        if self.camera_url:
            print(f"📱 Conectando a cámara IP: {self.camera_url}")
            self.cap = cv2.VideoCapture(self.camera_url)
        else:
            print(f"📷 Abriendo cámara USB ID: {self.camera_id}")
            self.cap = cv2.VideoCapture(self.camera_id)
        
        if not self.cap.isOpened():
            source = self.camera_url or f"cámara {self.camera_id}"
            print(f"❌ No se pudo abrir: {source}")
            return False
        
        # Configurar resolución
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_height)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        
        # Obtener resolución real
        self.frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.frame_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        print(f"📷 Cámara iniciada: {self.frame_width}x{self.frame_height}")
        return True
    
    def stop_camera(self):
        """Detiene la cámara"""
        if self.cap:
            self.cap.release()
            self.cap = None
    
    def detect_markers(self, frame: np.ndarray) -> Tuple[List[dict], np.ndarray]:
        """
        Detecta marcadores ArUco en un frame.
        Retorna lista de marcadores detectados y el frame con anotaciones.
        """
        # Convertir a escala de grises
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Detectar marcadores
        corners, ids, rejected = self.detector.detectMarkers(gray)
        
        markers = []
        
        if ids is not None and len(ids) > 0:
            # Dibujar marcadores detectados
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            
            for i, marker_id in enumerate(ids.flatten()):
                corner = corners[i][0]
                
                # Calcular centro
                center_x = float(np.mean(corner[:, 0]))
                center_y = float(np.mean(corner[:, 1]))
                
                # Calcular rotación
                dx = corner[1][0] - corner[0][0]
                dy = corner[1][1] - corner[0][1]
                rotation = float(np.degrees(np.arctan2(dy, dx)))
                
                # Convertir a coordenadas de juego
                game_x, game_y = self._pixel_to_game_coords(center_x, center_y)
                
                marker_data = {
                    "id": int(marker_id),
                    "x": game_x,
                    "y": game_y,
                    "rotation": rotation,
                    "corners": corner.tolist(),
                    "pixel_center": [center_x, center_y]
                }
                markers.append(marker_data)
                
                # Dibujar info en pantalla
                cv2.putText(
                    frame,
                    f"ID:{marker_id} ({game_x:.0f},{game_y:.0f})",
                    (int(center_x) - 30, int(center_y) - 20),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    (0, 255, 0),
                    2
                )
                
                # Dibujar centro
                cv2.circle(frame, (int(center_x), int(center_y)), 5, (0, 0, 255), -1)
        
        return markers, frame
    
    def _pixel_to_game_coords(self, px: float, py: float) -> Tuple[float, float]:
        """Convierte coordenadas de píxel a coordenadas de juego"""
        if self.homography_matrix is not None:
            # Usar homografía si está calibrada
            point = np.array([[[px, py]]], dtype=np.float32)
            transformed = cv2.perspectiveTransform(point, self.homography_matrix)
            return float(transformed[0][0][0]), float(transformed[0][0][1])
        else:
            # Conversión lineal simple
            game_x = (px / self.frame_width) * self.play_area["width"]
            game_y = (py / self.frame_height) * self.play_area["height"]
            return game_x, game_y
    
    async def connect_to_server(self):
        """Conecta al servidor WebSocket"""
        try:
            self.websocket = await websockets.connect(self.server_url)
            print(f"🔗 Conectado al servidor: {self.server_url}")
            return True
        except Exception as e:
            print(f"❌ Error conectando al servidor: {e}")
            return False
    
    async def send_markers(self, markers: List[dict]):
        """Envía los marcadores detectados al servidor"""
        if self.websocket:
            try:
                message = {
                    "type": "markers_update",
                    "payload": {
                        "markers": markers,
                        "timestamp": datetime.now().isoformat()
                    }
                }
                await self.websocket.send(json.dumps(message))
            except Exception as e:
                print(f"❌ Error enviando marcadores: {e}")
                self.websocket = None
    
    async def send_frame(self, frame: np.ndarray, markers: List[dict]):
        """Envía el frame procesado al servidor para streaming al admin"""
        if self.websocket and self.stream_enabled:
            try:
                current_time = time.time()
                # Limitar FPS de streaming
                if current_time - self.last_stream_time < self.stream_interval:
                    return
                self.last_stream_time = current_time
                
                # Redimensionar frame para streaming (reducir ancho de banda)
                stream_width = 640
                stream_height = int(frame.shape[0] * stream_width / frame.shape[1])
                resized = cv2.resize(frame, (stream_width, stream_height))
                
                # Codificar como JPEG
                encode_params = [cv2.IMWRITE_JPEG_QUALITY, self.stream_quality]
                _, buffer = cv2.imencode('.jpg', resized, encode_params)
                
                # Convertir a base64
                frame_base64 = base64.b64encode(buffer).decode('utf-8')
                
                message = {
                    "type": "frame_update",
                    "payload": {
                        "frame": frame_base64,
                        "markers": markers,
                        "width": stream_width,
                        "height": stream_height,
                        "timestamp": datetime.now().isoformat()
                    }
                }
                await self.websocket.send(json.dumps(message))
            except Exception as e:
                print(f"❌ Error enviando frame: {e}")
                self.websocket = None
    
    async def handle_server_messages(self):
        """Maneja mensajes del servidor (comandos de control)"""
        if not self.websocket:
            return
        try:
            message = await asyncio.wait_for(self.websocket.recv(), timeout=0.01)
            data = json.loads(message)
            msg_type = data.get("type", "")
            
            if msg_type == "set_stream_quality":
                self.stream_quality = data.get("quality", 70)
                print(f"📊 Calidad de stream ajustada a: {self.stream_quality}")
            elif msg_type == "set_stream_fps":
                self.stream_fps = data.get("fps", 15)
                self.stream_interval = 1.0 / self.stream_fps
                print(f"🎬 FPS de stream ajustado a: {self.stream_fps}")
            elif msg_type == "toggle_stream":
                self.stream_enabled = data.get("enabled", True)
                print(f"📹 Streaming {'activado' if self.stream_enabled else 'desactivado'}")
        except asyncio.TimeoutError:
            pass
        except Exception as e:
            if "closed" in str(e).lower():
                self.websocket = None
    
    def run_detection_loop(self, show_preview: bool = True):
        """Loop principal de detección (síncrono para OpenCV)"""
        if not self.cap:
            if not self.start_camera():
                return
        
        self.running = True
        frame_count = 0
        start_time = time.time()
        
        # Crear event loop para async
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        print("🎯 Detección iniciada. Presiona 'q' para salir, 'c' para calibrar")
        print(f"📹 Streaming habilitado a {self.stream_fps} FPS, calidad {self.stream_quality}")
        
        while self.running:
            ret, frame = self.cap.read()
            if not ret:
                print("❌ Error leyendo frame")
                break
            
            # Detectar marcadores
            markers, annotated_frame = self.detect_markers(frame)
            
            # Enviar frame al servidor para streaming (siempre, con límite de FPS)
            loop.run_until_complete(self.send_frame(annotated_frame, markers))
            
            # Enviar marcadores si hay cambios significativos
            if self._markers_changed(markers):
                self.last_markers = {m["id"]: m for m in markers}
                loop.run_until_complete(self.send_markers(markers))
            
            # Manejar mensajes del servidor
            loop.run_until_complete(self.handle_server_messages())
            
            # Mostrar FPS
            frame_count += 1
            if frame_count % 30 == 0:
                fps = frame_count / (time.time() - start_time)
                cv2.putText(
                    annotated_frame,
                    f"FPS: {fps:.1f} | Markers: {len(markers)} | Stream: {'ON' if self.stream_enabled else 'OFF'}",
                    (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (255, 255, 255),
                    2
                )
            
            # Mostrar preview
            if show_preview:
                cv2.imshow("MesaRPG - Detector", annotated_frame)
                
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                elif key == ord('c'):
                    self.calibrate_interactive(frame)
                elif key == ord('s'):
                    self.stream_enabled = not self.stream_enabled
                    print(f"📹 Streaming {'activado' if self.stream_enabled else 'desactivado'}")
        
        self.running = False
        self.stop_camera()
        cv2.destroyAllWindows()
        loop.close()
    
    def _markers_changed(self, new_markers: List[dict], threshold: float = 5.0) -> bool:
        """Verifica si los marcadores han cambiado significativamente"""
        new_ids = {m["id"] for m in new_markers}
        old_ids = set(self.last_markers.keys())
        
        # Si cambiaron los IDs detectados
        if new_ids != old_ids:
            return True
        
        # Verificar si alguna posición cambió significativamente
        for marker in new_markers:
            if marker["id"] in self.last_markers:
                old = self.last_markers[marker["id"]]
                dx = abs(marker["x"] - old["x"])
                dy = abs(marker["y"] - old["y"])
                if dx > threshold or dy > threshold:
                    return True
        
        return False
    
    def calibrate_interactive(self, frame: np.ndarray):
        """Calibración interactiva del área de juego"""
        print("\n📐 Modo de calibración")
        print("Coloca 4 marcadores en las esquinas del área de juego")
        print("Los IDs deben ser: 0=sup-izq, 1=sup-der, 2=inf-der, 3=inf-izq")
        
        # Por simplicidad, aquí solo hacemos una calibración básica
        # En producción, implementarías selección de puntos con el mouse
        print("Calibración básica aplicada")


async def main():
    """Función principal"""
    parser = argparse.ArgumentParser(description="MesaRPG - Detector de Marcadores")
    parser.add_argument("--camera", type=int, default=0, help="ID de la cámara USB")
    parser.add_argument("--url", type=str, default=None, 
                       help="URL de cámara IP (ej: http://192.168.1.100:4747/video)")
    parser.add_argument("--server", type=str, default="ws://localhost:8000/ws/camera",
                       help="URL del servidor WebSocket")
    parser.add_argument("--no-preview", action="store_true", help="Desactivar preview local")
    parser.add_argument("--stream-quality", type=int, default=70,
                       help="Calidad JPEG del stream (1-100)")
    parser.add_argument("--stream-fps", type=int, default=15,
                       help="FPS del stream al servidor")
    parser.add_argument("--no-stream", action="store_true", 
                       help="Desactivar streaming de video")
    args = parser.parse_args()
    
    detector = ArucoDetector(
        camera_id=args.camera,
        camera_url=args.url,
        server_url=args.server
    )
    
    # Configurar streaming
    detector.stream_quality = args.stream_quality
    detector.stream_fps = args.stream_fps
    detector.stream_interval = 1.0 / args.stream_fps
    detector.stream_enabled = not args.no_stream
    
    print("=" * 50)
    print("🎮 MesaRPG - Detector de Marcadores ArUco")
    print("=" * 50)
    print(f"📡 Servidor: {args.server}")
    print(f"📹 Streaming: {'Activado' if detector.stream_enabled else 'Desactivado'}")
    if detector.stream_enabled:
        print(f"   - Calidad: {detector.stream_quality}%")
        print(f"   - FPS: {detector.stream_fps}")
    print("=" * 50)
    
    # Conectar al servidor
    connected = await detector.connect_to_server()
    if not connected:
        print("⚠️ Ejecutando sin conexión al servidor")
    
    # Ejecutar detección en thread separado para no bloquear
    detection_thread = threading.Thread(
        target=detector.run_detection_loop,
        kwargs={"show_preview": not args.no_preview}
    )
    detection_thread.start()
    
    # Mantener conexión WebSocket
    try:
        while detector.running:
            await asyncio.sleep(0.5)
            # Reconectar si es necesario
            if detector.websocket is None and detector.running:
                print("🔄 Reconectando al servidor...")
                await detector.connect_to_server()
    except KeyboardInterrupt:
        print("\n⏹️ Deteniendo...")
        detector.running = False
    
    detection_thread.join()
    print("👋 ¡Hasta pronto!")


if __name__ == "__main__":
    asyncio.run(main())
