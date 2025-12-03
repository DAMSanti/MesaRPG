"""
MesaRPG - Test de Cámara Simple
Prueba la conexión de cámara y detección de marcadores ArUco

USO:
  python camera_test.py                    # Webcam por defecto (ID 0)
  python camera_test.py --camera 1         # Webcam secundaria
  python camera_test.py --url http://192.168.1.100:4747/video  # DroidCam/IP Webcam

CONTROLES:
  Q - Salir
  S - Guardar captura
  C - Calibrar (4 esquinas)
"""

import cv2
import numpy as np
import argparse
import sys

def main():
    parser = argparse.ArgumentParser(description='Test de cámara MesaRPG')
    parser.add_argument('--camera', type=int, default=0, help='ID de cámara USB (default: 0)')
    parser.add_argument('--url', type=str, default=None, help='URL de cámara IP (ej: http://192.168.1.100:4747/video)')
    parser.add_argument('--width', type=int, default=1280, help='Ancho de captura')
    parser.add_argument('--height', type=int, default=720, help='Alto de captura')
    args = parser.parse_args()
    
    # Configurar ArUco
    aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    aruco_params = cv2.aruco.DetectorParameters()
    detector = cv2.aruco.ArucoDetector(aruco_dict, aruco_params)
    
    # Abrir cámara
    if args.url:
        print(f"📱 Conectando a cámara IP: {args.url}")
        cap = cv2.VideoCapture(args.url)
    else:
        print(f"📷 Abriendo cámara USB ID: {args.camera}")
        cap = cv2.VideoCapture(args.camera)
    
    if not cap.isOpened():
        print("❌ No se pudo abrir la cámara")
        print("\nSoluciones:")
        print("  - Verifica que la cámara esté conectada")
        print("  - Prueba con otro ID: --camera 1")
        print("  - Para móvil, usa: --url http://IP:PUERTO/video")
        sys.exit(1)
    
    # Configurar resolución
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"✅ Cámara abierta: {width}x{height}")
    print("\nControles: Q=Salir, S=Guardar captura")
    print("\n🔍 Buscando marcadores ArUco 4x4...")
    
    frame_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            print("⚠️ Error leyendo frame")
            continue
        
        frame_count += 1
        
        # Convertir a escala de grises para detección
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Detectar marcadores
        corners, ids, rejected = detector.detectMarkers(gray)
        
        # Dibujar marcadores detectados
        if ids is not None:
            cv2.aruco.drawDetectedMarkers(frame, corners, ids)
            
            for i, marker_id in enumerate(ids.flatten()):
                # Calcular centro del marcador
                c = corners[i][0]
                cx = int(np.mean(c[:, 0]))
                cy = int(np.mean(c[:, 1]))
                
                # Calcular rotación
                dx = c[1][0] - c[0][0]
                dy = c[1][1] - c[0][1]
                angle = np.degrees(np.arctan2(dy, dx))
                
                # Mostrar info
                text = f"ID:{marker_id} ({cx},{cy}) {angle:.0f}°"
                cv2.putText(frame, text, (cx - 50, cy - 60), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                
                # Dibujar centro
                cv2.circle(frame, (cx, cy), 8, (0, 0, 255), -1)
        
        # Info en pantalla
        info = f"Frame: {frame_count} | Marcadores: {len(ids) if ids is not None else 0}"
        cv2.putText(frame, info, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        cv2.putText(frame, "Q=Salir S=Guardar", (10, height - 20), 
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)
        
        # Mostrar
        cv2.imshow('MesaRPG - Test de Camara', frame)
        
        # Teclas
        key = cv2.waitKey(1) & 0xFF
        if key == ord('q'):
            break
        elif key == ord('s'):
            filename = f"captura_{frame_count}.jpg"
            cv2.imwrite(filename, frame)
            print(f"📸 Guardado: {filename}")
    
    cap.release()
    cv2.destroyAllWindows()
    print("👋 Fin")

if __name__ == "__main__":
    main()
