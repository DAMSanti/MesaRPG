"""
Script de entrenamiento YOLO-Pose desde terminal
Ejecutar: python train_pose_cli.py
"""

import shutil
import random
from pathlib import Path

def main():
    # Verificar CUDA
    import torch
    print(f"CUDA disponible: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)}")
    else:
        print("⚠️ Entrenando en CPU (será lento)")

    from ultralytics import YOLO

    # Configuración
    DATASET_PATH = Path("dataset_keypoints")
    MODEL_NAME = "yolov8n-pose"

    print(f"\nDataset: {DATASET_PATH.absolute()}")

    # Verificar dataset
    train_img = DATASET_PATH / "images" / "train"
    val_img = DATASET_PATH / "images" / "val"
    train_lbl = DATASET_PATH / "labels" / "train"
    val_lbl = DATASET_PATH / "labels" / "val"

    # Crear directorios
    for d in [train_img, val_img, train_lbl, val_lbl]:
        d.mkdir(exist_ok=True)

    # Dividir si hace falta
    root_images = [f for f in (DATASET_PATH / "images").glob("*.jpg") if f.is_file()]

    if root_images:
        print(f"Dividiendo {len(root_images)} imágenes...")
        random.shuffle(root_images)
        split = int(len(root_images) * 0.8)
        
        for img in root_images[:split]:
            lbl = DATASET_PATH / "labels" / f"{img.stem}.txt"
            shutil.move(str(img), train_img / img.name)
            if lbl.exists():
                shutil.move(str(lbl), train_lbl / lbl.name)
        
        for img in root_images[split:]:
            lbl = DATASET_PATH / "labels" / f"{img.stem}.txt"
            shutil.move(str(img), val_img / img.name)
            if lbl.exists():
                shutil.move(str(lbl), val_lbl / lbl.name)

    print(f"Train: {len(list(train_img.glob('*.jpg')))}")
    print(f"Val: {len(list(val_img.glob('*.jpg')))}")

    # Crear data.yaml
    yaml_content = f"""# Dataset YOLO-Pose para miniaturas
path: {DATASET_PATH.absolute()}
train: images/train
val: images/val

# 1 keypoint (frente), 3 valores: x, y, visibilidad
kpt_shape: [1, 3]

# Clases
names:
  0: miniature

# No flip horizontal (afecta orientación)
flip_idx: []
"""

    with open(DATASET_PATH / "data.yaml", 'w') as f:
        f.write(yaml_content)

    print("\n" + "="*50)
    print("INICIANDO ENTRENAMIENTO")
    print("="*50)

    # Entrenar
    model = YOLO(f"{MODEL_NAME}.pt")

    results = model.train(
        data=str(DATASET_PATH / "data.yaml"),
        epochs=100,
        imgsz=640,
        batch=8,
        device=0 if torch.cuda.is_available() else 'cpu',
        workers=0,  # En Windows usar 0 para evitar problemas de multiprocessing
        patience=20,
        save=True,
        project="runs/pose",
        name="miniatures_pose",
        exist_ok=True,
        fliplr=0.0,
        flipud=0.0,
        mosaic=0.5,
        degrees=180,
        scale=0.3,
    )

    # Copiar modelo
    results_dir = Path("runs/pose/miniatures_pose")
    src = results_dir / "weights" / "best.pt"
    dst = Path("..") / "miniatures_pose.pt"

    shutil.copy(src, dst)
    print(f"\n✅ Modelo guardado en: {dst.absolute()}")
    print(f"   Tamaño: {dst.stat().st_size / 1e6:.1f} MB")


if __name__ == '__main__':
    main()
