"""
MesaRPG - Script de Inicio del Servidor
Inicia todos los componentes necesarios
"""

import subprocess
import sys
import os
import time
import webbrowser
from pathlib import Path


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
            str(Path(__file__).parent.parent / 'server' / 'requirements.txt')
        ])
        print("✅ Dependencias instaladas")
    else:
        print("✅ Todas las dependencias están instaladas")
    
    return True


def start_server(host='0.0.0.0', port=8000):
    """Inicia el servidor FastAPI"""
    server_dir = Path(__file__).parent.parent / 'server'
    
    print(f"\n🚀 Iniciando servidor en http://{host}:{port}")
    print("   Presiona Ctrl+C para detener")
    print()
    
    # Cambiar al directorio del servidor
    os.chdir(server_dir)
    
    # Iniciar uvicorn
    subprocess.run([
        sys.executable, '-m', 'uvicorn',
        'main:app',
        '--host', host,
        '--port', str(port),
        '--reload'
    ])


def main():
    print()
    print("╔══════════════════════════════════════════════════╗")
    print("║          MesaRPG - Sistema de Mesa RPG           ║")
    print("║        Interactive Tabletop RPG System           ║")
    print("╚══════════════════════════════════════════════════╝")
    print()
    
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
    print(f"   http://localhost:8000/display/")
    print(f"   http://{local_ip}:8000/display/")
    print()
    print("📱 APP MÓVIL (Jugadores)")
    print(f"   http://{local_ip}:8000/mobile/")
    print()
    print("📖 DOCUMENTACIÓN API")
    print(f"   http://localhost:8000/docs")
    print("═" * 50)
    print()
    
    # Preguntar si abrir navegador
    try:
        response = input("¿Abrir display en navegador? (s/N): ").strip().lower()
        if response == 's':
            webbrowser.open(f'http://localhost:8000/display/')
    except:
        pass
    
    # Iniciar servidor
    start_server()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n👋 Servidor detenido. ¡Hasta la próxima aventura!")
