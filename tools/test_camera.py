"""
MesaRPG - Camera tests and helpers

This module provides a small pytest-friendly camera test and a few helpers
for manual testing. In CI or headless environments the tests will be skipped
when no camera device is available.
"""

import cv2
import sys
import pytest


def test_camera(camera_id: int = 0):
    """Prueba una cámara específica.

    Skips the test if no camera is present (common on CI or headless servers).
    """
    print(f"🎥 Probando cámara {camera_id}...")

    cap = cv2.VideoCapture(camera_id)

    # If there's no camera device, skip the test rather than failing.
    if not cap.isOpened():
        pytest.skip(f"No camera available at index {camera_id}")

    # Obtener propiedades
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)

    print(f"✅ Cámara {camera_id} detectada")
    print(f"   Resolución: {width}x{height}")
    print(f"   FPS: {fps}")

    # Intentar capturar un frame
    ret, frame = cap.read()
    if not ret:
        cap.release()
        pytest.skip("No frame captured from camera")

    print(f"   ✅ Captura de frame exitosa")

    cap.release()


def find_cameras(max_cameras: int = 10):
    """Busca todas las cámaras disponibles y devuelve una lista de dicts."""
    print("🔍 Buscando cámaras disponibles...")
    print("-" * 40)

    found = []

    for i in range(max_cameras):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            found.append({
                "id": i,
                "resolution": f"{width}x{height}"
            })
            cap.release()

    print("-" * 40)

    if not found:
        print("❌ No se encontraron cámaras")
        return []

    print(f"✅ Se encontraron {len(found)} cámara(s):")
    for cam in found:
        print(f"   - Cámara {cam['id']}: {cam['resolution']}")

    return found


def preview_camera(camera_id: int = 0):
    """Muestra preview de la cámara (interactivo)."""
    print(f"\n📹 Abriendo preview de cámara {camera_id}...")
    print("Presiona 'q' para salir")

    cap = cv2.VideoCapture(camera_id)

    if not cap.isOpened():
        print(f"❌ No se pudo abrir la cámara {camera_id}")
        return

    # Configurar resolución (intento)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Error leyendo frame")
            break

        # Añadir texto informativo
        cv2.putText(
            frame,
            f"Camara {camera_id} - Presiona 'q' para salir",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 0),
            2,
        )

        cv2.imshow("Test Camera - MesaRPG", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    print("✅ Preview cerrado")


def main():
    print("=" * 50)
    print("MesaRPG - Test de Cámara")
    print("=" * 50)
    print()

    # Buscar cámaras
    cameras = find_cameras()

    if not cameras:
        print("\n💡 Sugerencias:")
        print("   1. Verifica que la cámara está conectada")
        print("   2. Prueba otro puerto USB")
        print("   3. Revisa los drivers de la cámara")
        sys.exit(1)

    # Preguntar si quiere preview
    print("\n¿Quieres ver el preview de la cámara? (s/n): ", end="")
    try:
        response = input().strip().lower()
        if response == "s":
            camera_id = 0
            if len(cameras) > 1:
                print(f"Ingresa el ID de la cámara (0-{len(cameras)-1}): ", end="")
                camera_id = int(input().strip())
            preview_camera(camera_id)
    except Exception:
        pass

    print("\n✨ Test completado")


if __name__ == "__main__":
    main()
