#!/bin/bash
# MesaRPG - Script de Despliegue para DigitalOcean
# Uso: ./deploy.sh tu-dominio.com

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🎲 MesaRPG - Script de Despliegue${NC}"
echo "=================================="

# Verificar que se proporcionó un dominio
if [ -z "$1" ]; then
    echo -e "${YELLOW}Uso: ./deploy.sh tu-dominio.com${NC}"
    echo ""
    echo "Este script configura MesaRPG en un servidor con:"
    echo "  - Docker y Docker Compose"
    echo "  - Nginx como proxy reverso"
    echo "  - SSL automático con Let's Encrypt"
    echo ""
    echo "Requisitos previos:"
    echo "  1. Un servidor Ubuntu 20.04+ (DigitalOcean Droplet recomendado)"
    echo "  2. Un dominio apuntando a la IP del servidor"
    echo "  3. Puerto 80 y 443 abiertos"
    exit 1
fi

DOMAIN=$1
EMAIL=${2:-"admin@$DOMAIN"}

echo -e "${GREEN}📋 Configuración:${NC}"
echo "  Dominio: $DOMAIN"
echo "  Email: $EMAIL"
echo ""

# 1. Actualizar sistema
echo -e "${GREEN}📦 Actualizando sistema...${NC}"
apt-get update && apt-get upgrade -y

# 2. Instalar Docker
echo -e "${GREEN}🐳 Instalando Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    usermod -aG docker $USER
else
    echo "Docker ya está instalado"
fi

# 3. Instalar Docker Compose
echo -e "${GREEN}🐳 Instalando Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null; then
    apt-get install -y docker-compose-plugin
else
    echo "Docker Compose ya está instalado"
fi

# 4. Crear directorios
echo -e "${GREEN}📁 Creando directorios...${NC}"
mkdir -p /opt/mesarpg
cd /opt/mesarpg

# 5. Clonar o copiar proyecto (esto asume que ya está en el servidor)
if [ ! -d "/opt/mesarpg/server" ]; then
    echo -e "${YELLOW}⚠️  Copia el proyecto MesaRPG a /opt/mesarpg${NC}"
    echo "   Puedes usar: scp -r ./MesaRPG/* root@tu-servidor:/opt/mesarpg/"
    exit 1
fi

# 6. Actualizar configuración de Nginx con el dominio
echo -e "${GREEN}🔧 Configurando Nginx...${NC}"
sed -i "s/DOMAIN/$DOMAIN/g" deploy/nginx.conf

# 7. Crear certificados SSL iniciales (dummy para que Nginx arranque)
echo -e "${GREEN}🔐 Configurando SSL...${NC}"
mkdir -p deploy/certbot/conf/live/$DOMAIN
mkdir -p deploy/certbot/www

# Crear certificado temporal
openssl req -x509 -nodes -newkey rsa:4096 -days 1 \
    -keyout deploy/certbot/conf/live/$DOMAIN/privkey.pem \
    -out deploy/certbot/conf/live/$DOMAIN/fullchain.pem \
    -subj "/CN=$DOMAIN"

# 8. Iniciar servicios
echo -e "${GREEN}🚀 Iniciando servicios...${NC}"
cd deploy
docker compose -f docker-compose.prod.yml up -d

# 9. Esperar a que Nginx esté listo
echo -e "${GREEN}⏳ Esperando a que Nginx esté listo...${NC}"
sleep 10

# 10. Obtener certificado real de Let's Encrypt
echo -e "${GREEN}🔐 Obteniendo certificado SSL de Let's Encrypt...${NC}"
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $DOMAIN

# 11. Reiniciar Nginx con el nuevo certificado
echo -e "${GREEN}🔄 Reiniciando Nginx...${NC}"
docker compose -f docker-compose.prod.yml restart nginx

# 12. Configurar renovación automática de SSL
echo -e "${GREEN}⏰ Configurando renovación automática de SSL...${NC}"
(crontab -l 2>/dev/null; echo "0 3 * * * cd /opt/mesarpg/deploy && docker compose -f docker-compose.prod.yml run --rm certbot renew && docker compose -f docker-compose.prod.yml restart nginx") | crontab -

echo ""
echo -e "${GREEN}✅ ¡Despliegue completado!${NC}"
echo ""
echo "=================================="
echo "🎲 MesaRPG está disponible en:"
echo ""
echo "  📺 Pantalla (Display): https://$DOMAIN/display"
echo "  📱 Móvil (Jugadores):  https://$DOMAIN/mobile"
echo "  🎮 Admin (GM):         https://$DOMAIN/admin"
echo "  📚 API Docs:           https://$DOMAIN/docs"
echo ""
echo "=================================="
echo ""
echo "Los usuarios solo necesitan abrir estas URLs en su navegador."
echo "¡Sin instalación requerida!"
