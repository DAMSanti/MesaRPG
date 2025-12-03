"""
MesaRPG - Detector YOLO para Figuritas
Detecta objetos/figuritas usando YOLO (máxima precisión)

USO:
  python yolo_detector.py                           # Webcam por defecto
  python yolo_detector.py --camera 1                # Webcam secundaria  
  python yolo_detector.py --url http://IP:8080/video  # Cámara IP
  python yolo_detector.py --server ws://IP/ws/camera  # Enviar al servidor

MODOS:
  --mode detect         # Detección de objetos (bounding boxes)
  --mode segment        # Segmentación (contornos exactos)
  --mode track          # Tracking con IDs persistentes
  --mode pose           # Estimación de pose (esqueleto)
  --mode obb            # Oriented Bounding Boxes (cajas rotadas)
  --mode track-segment  # Tracking + Segmentación
  --mode track-pose     # Tracking + Pose
  --mode track-obb      # Tracking + OBB

CONTROLES:
  Q - Salir
  S - Guardar captura
  C - Calibrar área de juego
  R - Reset tracking IDs
"""

import cv2
import numpy as np
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

# Verificar ultralytics
try:
    from ultralytics import YOLO
except ImportError:
    print("❌ Ultralytics no instalado. Ejecuta: pip install ultralytics")
    sys.exit(1)

# WebSocket opcional
try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False
    print("⚠️ websockets no instalado. No se enviará al servidor.")


class YOLODetector:
    def __init__(self, model_name="yolov8x.pt", mode="detect", confidence=0.5):
        """
        Inicializa el detector YOLO
        
        Args:
            model_name: Modelo a usar (yolov8n/s/m/l/x.pt o custom)
            mode: detect, segment, track, pose, obb, track-segment, track-pose, track-obb
            confidence: Umbral de confianza (0-1)
        """
        self.mode = mode
        self.confidence = confidence
        self.calibration = None
        self.track_history = {}
        
        # Determinar tipo de modelo según modo
        base_model = model_name.replace(".pt", "")
        
        # Modelos especiales solo disponibles en yolov8
        # yolo11 y yolo12 no tienen pose/obb/seg en todos los casos
        pose_obb_base = "yolov8x"  # Fallback para pose/obb si no existe
        
        print(f"🔄 Cargando modelo para modo '{mode}'...")
        
        if "segment" in mode:
            # Modelo de segmentación
            model_file = f"{base_model}-seg.pt"
            try:
                self.model = YOLO(model_file)
                print(f"✅ Modelo de segmentación: {model_file}")
            except:
                model_file = f"{pose_obb_base}-seg.pt"
                self.model = YOLO(model_file)
                print(f"⚠️ Fallback a: {model_file}")
        elif "pose" in mode:
            # Modelo de pose - solo yolov8 tiene pose estable
            model_file = f"{base_model}-pose.pt"
            try:
                self.model = YOLO(model_file)
                print(f"✅ Modelo de pose: {model_file}")
            except:
                model_file = f"{pose_obb_base}-pose.pt"
                self.model = YOLO(model_file)
                print(f"⚠️ Fallback a: {model_file}")
        elif "obb" in mode:
            # Modelo OBB (oriented bounding boxes)
            model_file = f"{base_model}-obb.pt"
            try:
                self.model = YOLO(model_file)
                print(f"✅ Modelo OBB: {model_file}")
            except:
                model_file = f"{pose_obb_base}-obb.pt"
                self.model = YOLO(model_file)
                print(f"⚠️ Fallback a: {model_file}")
        else:
            # Modelo de detección estándar
            self.model = YOLO(model_name)
            print(f"✅ Modelo cargado: {model_name}")
        
        # Modo "figuritas": ignorar clase YOLO, solo tracking de objetos
        self.figurine_mode = False  # Desactivado - mostrar clase real
        self.figurine_names = {}  # ID -> nombre asignado
        self.next_figurine_num = 1
        
        # Clases a IGNORAR (fondo, cosas grandes que no son figuritas)
        self.ignore_classes = {
            56: "chair", 57: "couch", 58: "potted plant", 59: "bed",
            60: "dining table", 61: "toilet", 62: "tv", 63: "laptop",
            64: "mouse", 65: "remote", 66: "keyboard", 72: "refrigerator"
        }
        
        # Colores para visualización
        self.colors = {}
        
    def detect(self, frame):
        """
        Detecta objetos en un frame
        
        Returns:
            List of detections: [{id, class, name, x, y, w, h, confidence, center}]
        """
        detections = []
        
        # Determinar si usar tracking
        use_tracking = "track" in self.mode
        
        if use_tracking:
            # Tracking con IDs persistentes
            results = self.model.track(
                frame, 
                persist=True, 
                conf=self.confidence,
                verbose=False
            )
        else:
            # Detección simple
            results = self.model(
                frame, 
                conf=self.confidence,
                verbose=False
            )
        
        if not results or len(results) == 0:
            return detections, frame
        
        result = results[0]
        annotated_frame = frame.copy()
        
        # Procesar detecciones
        if result.boxes is not None:
            boxes = result.boxes
            
            for i, box in enumerate(boxes):
                # Coordenadas
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                x, y, w, h = int(x1), int(y1), int(x2-x1), int(y2-y1)
                center_x = int(x1 + (x2 - x1) / 2)
                center_y = int(y1 + (y2 - y1) / 2)
                
                # Clase y confianza
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                cls_name = self.model.names[cls_id]
                
                # Ignorar clases no deseadas (muebles, etc)
                if cls_id in self.ignore_classes:
                    continue
                
                # ID de tracking (si está disponible)
                track_id = None
                if hasattr(box, 'id') and box.id is not None:
                    track_id = int(box.id[0])
                
                # En modo figuritas, asignar nombre simple
                if self.figurine_mode and track_id:
                    if track_id not in self.figurine_names:
                        self.figurine_names[track_id] = f"Figurita {self.next_figurine_num}"
                        self.next_figurine_num += 1
                    display_name = self.figurine_names[track_id]
                else:
                    display_name = cls_name
                
                # Añadir detección
                detection = {
                    "id": track_id if track_id else i,
                    "class_id": cls_id,
                    "class_name": display_name,
                    "original_class": cls_name,
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "center_x": center_x,
                    "center_y": center_y,
                    "confidence": round(conf, 3)
                }
                
                # Aplicar calibración si existe
                if self.calibration:
                    norm_x, norm_y = self.apply_calibration(center_x, center_y)
                    detection["normalized_x"] = norm_x
                    detection["normalized_y"] = norm_y
                
                detections.append(detection)
                
                # Dibujar en frame
                color = self.get_color(track_id if track_id else cls_id)
                
                # Rectángulo
                cv2.rectangle(annotated_frame, (x, y), (x+w, y+h), color, 2)
                
                # Etiqueta - mostrar nombre de figurita, no clase YOLO
                if self.figurine_mode:
                    label = display_name
                    if track_id:
                        label = f"[{track_id}] {display_name}"
                else:
                    label = f"{cls_name}"
                    if track_id:
                        label = f"ID:{track_id} {cls_name}"
                label += f" {conf:.0%}"
                
                # Fondo de etiqueta
                (label_w, label_h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
                cv2.rectangle(annotated_frame, (x, y-25), (x+label_w+10, y), color, -1)
                cv2.putText(annotated_frame, label, (x+5, y-8), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255,255,255), 2)
                
                # Centro
                cv2.circle(annotated_frame, (center_x, center_y), 5, color, -1)
        
        # Segmentación (máscaras)
        if "segment" in self.mode and result.masks is not None:
            masks = result.masks.data.cpu().numpy()
            for i, mask in enumerate(masks):
                color = self.get_color(i)
                mask_resized = cv2.resize(mask, (frame.shape[1], frame.shape[0]))
                colored_mask = np.zeros_like(annotated_frame)
                colored_mask[mask_resized > 0.5] = color
                annotated_frame = cv2.addWeighted(annotated_frame, 1, colored_mask, 0.4, 0)
        
        # Pose (keypoints/esqueleto)
        if "pose" in self.mode and result.keypoints is not None:
            keypoints = result.keypoints
            # Dibujar esqueletos
            for kp in keypoints:
                if kp.xy is not None:
                    points = kp.xy[0].cpu().numpy()
                    conf = kp.conf[0].cpu().numpy() if kp.conf is not None else None
                    
                    # Conexiones del esqueleto (COCO format)
                    skeleton = [
                        (0, 1), (0, 2), (1, 3), (2, 4),  # Cabeza
                        (5, 6), (5, 7), (7, 9), (6, 8), (8, 10),  # Brazos
                        (5, 11), (6, 12), (11, 12),  # Torso
                        (11, 13), (13, 15), (12, 14), (14, 16)  # Piernas
                    ]
                    
                    # Dibujar puntos
                    for i, (px, py) in enumerate(points):
                        if px > 0 and py > 0:
                            c = conf[i] if conf is not None else 1.0
                            if c > 0.5:
                                cv2.circle(annotated_frame, (int(px), int(py)), 4, (0, 255, 0), -1)
                    
                    # Dibujar líneas del esqueleto
                    for i, j in skeleton:
                        if i < len(points) and j < len(points):
                            p1, p2 = points[i], points[j]
                            if p1[0] > 0 and p1[1] > 0 and p2[0] > 0 and p2[1] > 0:
                                cv2.line(annotated_frame, 
                                        (int(p1[0]), int(p1[1])), 
                                        (int(p2[0]), int(p2[1])), 
                                        (0, 255, 255), 2)
        
        # OBB (Oriented Bounding Boxes)
        if "obb" in self.mode and result.obb is not None:
            for obb in result.obb:
                # OBB tiene formato: x_center, y_center, width, height, rotation
                if obb.xyxyxyxy is not None:
                    # Obtener los 4 puntos del rectángulo rotado
                    points = obb.xyxyxyxy[0].cpu().numpy().astype(int)
                    color = self.get_color(int(obb.cls[0]) if obb.cls is not None else 0)
                    
                    # Dibujar polígono
                    cv2.polylines(annotated_frame, [points], True, color, 2)
                    
                    # Centro
                    center = points.mean(axis=0).astype(int)
                    cv2.circle(annotated_frame, tuple(center), 5, color, -1)
                    
                    # Etiqueta
                    if obb.cls is not None:
                        cls_name = self.model.names[int(obb.cls[0])]
                        conf = float(obb.conf[0]) if obb.conf is not None else 0
                        label = f"{cls_name} {conf:.0%}"
                        cv2.putText(annotated_frame, label, 
                                   (center[0], center[1] - 10),
                                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        
        return detections, annotated_frame
    
    def get_color(self, id):
        """Genera un color consistente para un ID"""
        if id not in self.colors:
            np.random.seed(id * 42)
            self.colors[id] = tuple(map(int, np.random.randint(50, 255, 3)))
        return self.colors[id]
    
    def set_calibration(self, points):
        """
        Configura calibración con 4 puntos de esquina
        points: [(x1,y1), (x2,y2), (x3,y3), (x4,y4)] - esquinas del área de juego
        """
        if len(points) == 4:
            self.calibration = {
                "points": points,
                "min_x": min(p[0] for p in points),
                "max_x": max(p[0] for p in points),
                "min_y": min(p[1] for p in points),
                "max_y": max(p[1] for p in points)
            }
            print(f"✅ Calibración configurada: {self.calibration}")
    
    def apply_calibration(self, x, y):
        """Convierte coordenadas de píxel a normalizadas (0-1)"""
        if not self.calibration:
            return x, y
        
        cal = self.calibration
        norm_x = (x - cal["min_x"]) / (cal["max_x"] - cal["min_x"])
        norm_y = (y - cal["min_y"]) / (cal["max_y"] - cal["min_y"])
        
        return round(max(0, min(1, norm_x)), 4), round(max(0, min(1, norm_y)), 4)


async def run_detector(args):
    """Loop principal del detector"""
    
    # Inicializar detector
    detector = YOLODetector(
        model_name=args.model,
        mode=args.mode,
        confidence=args.confidence
    )
    
    # Abrir cámara
    if args.url:
        print(f"📱 Conectando a cámara IP: {args.url}")
        cap = cv2.VideoCapture(args.url)
    else:
        print(f"📷 Abriendo cámara USB ID: {args.camera}")
        cap = cv2.VideoCapture(args.camera)
    
    if not cap.isOpened():
        print("❌ No se pudo abrir la cámara")
        return
    
    # Configurar resolución
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"📷 Cámara iniciada: {width}x{height}")
    
    # Conectar al servidor WebSocket
    ws = None
    if args.server and HAS_WEBSOCKETS:
        try:
            ws = await websockets.connect(args.server)
            print(f"🔗 Conectado al servidor: {args.server}")
        except Exception as e:
            print(f"⚠️ No se pudo conectar al servidor: {e}")
    
    print(f"\n🎯 Detector YOLO iniciado (modo: {args.mode})")
    print("Controles: Q=Salir, S=Guardar, C=Calibrar, R=Reset tracking")
    
    # Variables para calibración
    calibration_points = []
    calibrating = False
    
    # FPS counter
    fps_time = time.time()
    fps_count = 0
    fps = 0
    
    def mouse_callback(event, x, y, flags, param):
        nonlocal calibration_points, calibrating
        if calibrating and event == cv2.EVENT_LBUTTONDOWN:
            calibration_points.append((x, y))
            print(f"  Punto {len(calibration_points)}: ({x}, {y})")
            if len(calibration_points) >= 4:
                detector.set_calibration(calibration_points)
                calibrating = False
                calibration_points = []
    
    cv2.namedWindow("YOLO Detector")
    cv2.setMouseCallback("YOLO Detector", mouse_callback)
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("⚠️ Error leyendo frame")
                await asyncio.sleep(0.1)
                continue
            
            # Detectar
            detections, annotated_frame = detector.detect(frame)
            
            # Calcular FPS
            fps_count += 1
            if time.time() - fps_time >= 1:
                fps = fps_count
                fps_count = 0
                fps_time = time.time()
            
            # Mostrar info
            info_text = f"FPS: {fps} | Detectados: {len(detections)} | Modo: {args.mode}"
            cv2.putText(annotated_frame, info_text, (10, 30), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            
            # Mostrar calibración en progreso
            if calibrating:
                cv2.putText(annotated_frame, f"CALIBRANDO: Click en esquina {len(calibration_points)+1}/4", 
                           (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
                for i, pt in enumerate(calibration_points):
                    cv2.circle(annotated_frame, pt, 10, (0, 255, 255), -1)
                    cv2.putText(annotated_frame, str(i+1), (pt[0]+15, pt[1]), 
                               cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            
            # Dibujar área calibrada
            if detector.calibration:
                pts = np.array(detector.calibration["points"], np.int32)
                cv2.polylines(annotated_frame, [pts], True, (0, 255, 255), 2)
            
            # Mostrar
            cv2.imshow("YOLO Detector", annotated_frame)
            
            # Enviar al servidor
            if ws and detections:
                try:
                    message = {
                        "type": "yolo_detections",
                        "detections": detections,
                        "timestamp": time.time()
                    }
                    await ws.send(json.dumps(message))
                except Exception as e:
                    print(f"⚠️ Error enviando: {e}")
                    ws = None
            
            # Controles
            key = cv2.waitKey(1) & 0xFF
            
            if key == ord('q'):
                break
            elif key == ord('s'):
                filename = f"capture_{int(time.time())}.jpg"
                cv2.imwrite(filename, annotated_frame)
                print(f"📸 Guardado: {filename}")
            elif key == ord('c'):
                print("\n🎯 Modo calibración: Haz click en las 4 esquinas del área de juego")
                calibrating = True
                calibration_points = []
            elif key == ord('r'):
                print("🔄 Reset tracking IDs")
                detector.model.predictor.trackers[0].reset() if hasattr(detector.model, 'predictor') else None
            
            await asyncio.sleep(0.001)  # Yield para async
            
    except KeyboardInterrupt:
        print("\n⏹️ Detenido por usuario")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        if ws:
            await ws.close()


def main():
    parser = argparse.ArgumentParser(description='MesaRPG - Detector YOLO')
    
    # Cámara
    parser.add_argument('--camera', type=int, default=0, 
                       help='ID de cámara USB (default: 0)')
    parser.add_argument('--url', type=str, default=None, 
                       help='URL de cámara IP')
    parser.add_argument('--width', type=int, default=1280, 
                       help='Ancho de captura')
    parser.add_argument('--height', type=int, default=720, 
                       help='Alto de captura')
    
    # YOLO
    parser.add_argument('--model', type=str, default='yolov8x.pt',
                       help='Modelo YOLO (yolov8n/s/m/l/x.pt, yolo11x.pt, yolo12x.pt o custom)')
    parser.add_argument('--mode', type=str, default='detect',
                       choices=['detect', 'segment', 'track', 'pose', 'obb', 
                                'track-segment', 'track-pose', 'track-obb'],
                       help='Modo de detección')
    parser.add_argument('--confidence', type=float, default=0.5,
                       help='Umbral de confianza (0-1)')
    
    # Servidor
    parser.add_argument('--server', type=str, default=None,
                       help='WebSocket server URL')
    
    args = parser.parse_args()
    
    print("=" * 50)
    print("🎮 MesaRPG - Detector YOLO")
    print("=" * 50)
    
    asyncio.run(run_detector(args))


if __name__ == "__main__":
    main()
