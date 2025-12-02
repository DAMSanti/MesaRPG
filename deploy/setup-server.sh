#!/bin/bash
# MesaRPG - Script de configuración inicial para servidor limpio
# Ejecutar como root en un Droplet nuevo de DigitalOcean

set -e

echo "🎲 MesaRPG - Configuración Inicial del Servidor"
echo "================================================"

# Verificar que se ejecuta como root
if [ "$EUID" -ne 0 ]; then
    echo "Por favor, ejecuta este script como root"
    exit 1
fi

# 1. Actualizar sistema
echo "📦 Actualizando sistema..."
apt-get update && apt-get upgrade -y

# 2. Instalar dependencias básicas
echo "📦 Instalando dependencias..."
apt-get install -y \
    curl \
    git \
    ufw \
    fail2ban

# 3. Configurar firewall
echo "🔒 Configurando firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
ufw --force enable

# 4. Instalar Docker
echo "🐳 Instalando Docker..."
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
rm get-docker.sh

# 5. Instalar Docker Compose
echo "🐳 Instalando Docker Compose..."
apt-get install -y docker-compose-plugin

# 6. Crear directorio para MesaRPG
echo "📁 Preparando directorios..."
mkdir -p /opt/mesarpg
cd /opt/mesarpg

# 7. Configurar fail2ban básico
echo "🔒 Configurando fail2ban..."
systemctl enable fail2ban
systemctl start fail2ban

echo ""
echo "✅ Servidor configurado correctamente"
echo ""
echo "Siguiente paso:"
echo "  1. Copia el proyecto MesaRPG al servidor:"
echo "     scp -r ./MesaRPG/* root@TU_IP:/opt/mesarpg/"
echo ""
echo "  2. Ejecuta el script de despliegue:"
echo "     cd /opt/mesarpg/deploy"
echo "     chmod +x deploy.sh"
echo "     ./deploy.sh tu-dominio.com"
