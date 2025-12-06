"""
Prepara el dataset de CVAT para entrenamiento YOLO OBB
Reorganiza la estructura de carpetas y crea split train/val
"""

import os
import shutil
import random
from pathlib import Path

# Rutas
DATASET_DIR = Path(__file__).parent.parent / "dataset"
IMAGES_SRC = DATASET_DIR / "images"
LABELS_SRC = DATASET_DIR / "labels" / "train"

# Destinos
TRAIN_IMAGES = DATASET_DIR / "images" / "train"
VAL_IMAGES = DATASET_DIR / "images" / "val"
TRAIN_LABELS = DATASET_DIR / "labels" / "train"
VAL_LABELS = DATASET_DIR / "labels" / "val"

# Crear carpetas
TRAIN_IMAGES.mkdir(parents=True, exist_ok=True)
VAL_IMAGES.mkdir(parents=True, exist_ok=True)
VAL_LABELS.mkdir(parents=True, exist_ok=True)

# Obtener lista de imágenes
images = [f for f in IMAGES_SRC.glob("*.jpg")]
print(f"📁 Encontradas {len(images)} imágenes")

# Shuffle y split 80/20
random.seed(42)
random.shuffle(images)
split_idx = int(len(images) * 0.8)
train_images = images[:split_idx]
val_images = images[split_idx:]

print(f"🔀 Split: {len(train_images)} train, {len(val_images)} val")

# Mover imágenes a train/
moved_train = 0
for img in train_images:
    dest = TRAIN_IMAGES / img.name
    if img != dest and img.exists():
        shutil.move(str(img), str(dest))
        moved_train += 1

# Mover imágenes a val/
moved_val = 0
for img in val_images:
    dest = VAL_IMAGES / img.name
    if img.exists():
        shutil.move(str(img), str(dest))
        moved_val += 1
        
        # También mover la etiqueta correspondiente
        label_name = img.stem + ".txt"
        label_src = TRAIN_LABELS / label_name
        label_dest = VAL_LABELS / label_name
        if label_src.exists():
            shutil.move(str(label_src), str(label_dest))

print(f"📦 Movidas: {moved_train} a train/, {moved_val} a val/")

# Actualizar data.yaml
data_yaml = f"""# Dataset para detección de miniaturas con orientación
path: {DATASET_DIR.absolute()}
train: images/train
val: images/val

names:
  0: miniatura
"""

with open(DATASET_DIR / "data.yaml", "w") as f:
    f.write(data_yaml)

print(f"✅ data.yaml actualizado")
print(f"\n📊 Dataset listo para entrenar!")
print(f"   Train: {len(list(TRAIN_IMAGES.glob('*.jpg')))} imágenes")
print(f"   Val: {len(list(VAL_IMAGES.glob('*.jpg')))} imágenes")
