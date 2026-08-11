"""
MesaRPG - Script de Inicio del Servidor
Inicia todos los componentes necesarios
"""

import subprocess
import sys
import os
import webbrowser
from pathlib import Path

# Este archivo vive en la raíz del proyecto (junto a server/, admin/, etc.)
PROJECT_ROOT = Path(__file__).parent

# Puerto por defecto. Cambia SERVER_PORT en tu entorno si este también está
# ocupado (ej. `set SERVER_PORT=8030` en Windows antes de lanzar start.bat).
DEFAULT_PORT = 8020


def check_dependencies():
    """Verifica que las dependencias estén instaladas"""
    print("🔍 Verificando dependencias...")

    required = ['fastapi', 'uvicorn', 'opencv-python', 'websockets', 'pydantic']
    missing = []

    for package in required:
        try:
            __import__(package.replace('-', '_'))
        except ImportError:
            missing.append(package)

    if missing:
        print(f"❌ Faltan dependencias: {', '.join(missing)}")
        print()
        print("Instalando dependencias...")
        subprocess.check_call([
            sys.executable, '-m', 'pip', 'install', '-r',
            str(PROJECT_ROOT / 'server' / 'requirements.txt')
        ])
        print("✅ Dependencias instaladas")
    else:
        print("✅ Todas las dependencias están instaladas")

    return True


def start_server(host='0.0.0.0', port=DEFAULT_PORT):
    """Inicia el servidor FastAPI"""
    print(f"\n🚀 Iniciando servidor en http://{host}:{port}")
    print("   Presiona Ctrl+C para detener")
    print()

    # Importante: se ejecuta como "server.main:app" (no "main:app") y con cwd
    # en la raíz del proyecto (no dentro de server/), porque main.py usa imports
    # relativos (`from .models import ...`) que solo funcionan si "server" se
    # importa como paquete. Ejecutar uvicorn desde dentro de server/ con
    # "main:app" revienta con "ImportError: attempted relative import with no
    # known parent package".
    subprocess.run([
        sys.executable, '-m', 'uvicorn',
        'server.main:app',
        '--host', host,
        '--port', str(port),
        '--reload'
    ], cwd=str(PROJECT_ROOT))


def main():
    print()
    print("╔══════════════════════════════════════════════════╗")
    print("║          MesaRPG - Sistema de Mesa RPG           ║")
    print("║        Interactive Tabletop RPG System           ║")
    print("╚══════════════════════════════════════════════════╝")
    print()

    port = int(os.environ.get('SERVER_PORT', DEFAULT_PORT))
    host = os.environ.get('SERVER_HOST', '0.0.0.0')

    # Obtener la IP local
    import socket
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)

    print(f"📍 IP Local: {local_ip}")
    print()

    # Verificar dependencias
    if not check_dependencies():
        return

    # Mostrar URLs
    print()
    print("═" * 50)
    print("📺 PANTALLA PRINCIPAL (Display)")
    print(f"   http://localhost:{port}/display/")
    print(f"   http://{local_ip}:{port}/display/")
    print()
    print("📱 APP MÓVIL (Jugadores)")
    print(f"   http://{local_ip}:{port}/mobile/")
    print()
    print("📖 DOCUMENTACIÓN API")
    print(f"   http://localhost:{port}/docs")
    print("═" * 50)
    print()

    # Preguntar si abrir navegador
    try:
        response = input("¿Abrir display en navegador? (s/N): ").strip().lower()
        if response == 's':
            webbrowser.open(f'http://localhost:{port}/display/')
    except:
        pass

    # Iniciar servidor
    start_server(host=host, port=port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n👋 Servidor detenido. ¡Hasta la próxima aventura!")
