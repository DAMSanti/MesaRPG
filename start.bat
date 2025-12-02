@echo off
title MesaRPG - Interactive Tabletop RPG
echo.
echo ========================================
echo    MesaRPG - Sistema de Mesa RPG
echo ========================================
echo.

REM Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python no encontrado!
    echo Instala Python desde https://python.org
    pause
    exit /b 1
)

REM Ir al directorio del proyecto
cd /d "%~dp0"

REM Ejecutar el script de inicio
python run_server.py

pause
