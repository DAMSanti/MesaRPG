#!/bin/bash
# MesaRPG - Script de inicio para Linux/Mac

echo ""
echo "========================================"
echo "   MesaRPG - Sistema de Mesa RPG"
echo "========================================"
echo ""

# Verificar Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python 3 no encontrado!"
    echo "Instala Python 3 desde tu gestor de paquetes"
    exit 1
fi

# Ir al directorio del script
cd "$(dirname "$0")"

# Ejecutar
python3 run_server.py
