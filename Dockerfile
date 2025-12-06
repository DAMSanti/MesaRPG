# MesaRPG Dockerfile
# Imagen para ejecutar el servidor web con YOLO + OpenVINO

FROM python:3.11-slim

# Metadatos
LABEL maintainer="MesaRPG Project"
LABEL description="Interactive Tabletop RPG System"
LABEL version="1.0"

# Variables de entorno
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DEBIAN_FRONTEND=noninteractive
# OpenVINO optimizations
ENV OV_DEVICE=CPU
ENV OMP_NUM_THREADS=1
ENV OV_CPU_THREADS_NUM=1

# Dependencias del sistema para OpenCV, YOLO y OpenVINO
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar requirements primero para aprovechar cache
COPY server/requirements.txt .

# Instalar dependencias Python
RUN pip install --no-cache-dir -r requirements.txt

# Copiar modelos YOLO (cambian poco, bueno para caché)
COPY miniatures_pose.pt miniatures_obb.pt ./
COPY miniatures_pose_openvino_model/ ./miniatures_pose_openvino_model/

# Copiar código del servidor (cambia frecuentemente)
COPY server/ ./server/

# Copiar assets y config
COPY config/ ./config/
COPY assets/ ./assets/
COPY admin/ ./admin/
COPY display/ ./display/
COPY mobile/ ./mobile/

# Crear directorios necesarios
RUN mkdir -p /app/data /app/assets/markers /app/assets/maps

# Exponer puerto
EXPOSE 8000

# Directorio de datos como volumen
VOLUME ["/app/data", "/app/config", "/app/assets"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/api/state || exit 1

# Comando de inicio (sin reload para producción)
# --proxy-headers para funcionar detrás de nginx
# --ws websockets para mejor soporte de WebSocket
CMD ["python", "-m", "uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
