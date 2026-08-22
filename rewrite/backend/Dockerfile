# MesaRPG rewrite — backend (FastAPI + SQLite). En el servidor compartido, el nginx del
# propio host (sprinta-web) enruta rpgvision.duckdns.org: /api/ y /ws/ hacia este
# contenedor, el resto hacia el contenedor del frontend — ver ../deploy/docker-compose.oracle.yml.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY scripts/ ./scripts/

EXPOSE 8124

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8124/api/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8124"]
