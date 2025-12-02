# 🌐 Despliegue en la Nube - MesaRPG

Esta guía te permite desplegar MesaRPG en un servidor en la nube (DigitalOcean, AWS, etc.) para que los usuarios finales no necesiten instalar nada.

## 🎯 Resultado Final

Una vez desplegado, los usuarios solo necesitan abrir estas URLs en su navegador:

| Rol | URL | Descripción |
|-----|-----|-------------|
| **Pantalla/Display** | `https://tu-dominio.com/display` | Pantalla grande que muestra el mapa y efectos |
| **Jugadores Móvil** | `https://tu-dominio.com/mobile` | Interfaz para jugadores desde su móvil |
| **Game Master** | `https://tu-dominio.com/admin` | Panel de control del GM |

**¡Sin instalación requerida!** Solo abrir el navegador.

## 📋 Requisitos

### En DigitalOcean (Recomendado)

- **Droplet**: Ubuntu 22.04 LTS
- **Plan mínimo**: Basic $6/mes (1GB RAM, 1 vCPU)
- **Plan recomendado**: Basic $12/mes (2GB RAM, 1 vCPU)
- **Dominio**: Un dominio propio (ej: `mesarpg.tudominio.com`)

### Alternativamente

- Cualquier VPS con Ubuntu 20.04+
- Mínimo 1GB RAM
- Puertos 80 y 443 abiertos

## 🚀 Despliegue Rápido (5 minutos)

### 1. Crear Droplet en DigitalOcean

1. Ve a [DigitalOcean](https://www.digitalocean.com/)
2. Crea un nuevo Droplet:
   - **Imagen**: Ubuntu 22.04 LTS
   - **Plan**: Basic $6-12/mes
   - **Región**: La más cercana a tus jugadores
   - **Autenticación**: SSH Key (recomendado) o Password

### 2. Configurar DNS

Apunta tu dominio a la IP del Droplet:
```
Tipo: A
Nombre: @ (o subdominio como "rpg")
Valor: IP_DEL_DROPLET
TTL: 300
```

### 3. Conectar al Servidor

```bash
ssh root@IP_DEL_DROPLET
```

### 4. Configurar Servidor

```bash
# Descargar y ejecutar script de configuración
curl -fsSL https://raw.githubusercontent.com/tu-usuario/mesarpg/main/deploy/setup-server.sh | bash
```

O manualmente:

```bash
# Actualizar sistema
apt update && apt upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com | bash

# Configurar firewall
ufw allow ssh && ufw allow http && ufw allow https && ufw --force enable
```

### 5. Subir Proyecto

Desde tu PC local:

```bash
# Windows (PowerShell)
scp -r .\MesaRPG\* root@IP_DEL_DROPLET:/opt/mesarpg/

# Linux/Mac
scp -r ./MesaRPG/* root@IP_DEL_DROPLET:/opt/mesarpg/
```

### 6. Desplegar

En el servidor:

```bash
cd /opt/mesarpg/deploy
chmod +x deploy.sh
./deploy.sh tu-dominio.com tu-email@ejemplo.com
```

¡Listo! El script:
- Configura Docker
- Obtiene certificados SSL gratuitos (Let's Encrypt)
- Inicia todos los servicios
- Configura renovación automática de SSL

## 🔧 Despliegue Manual (Paso a Paso)

Si prefieres más control:

### 1. Instalar Docker

```bash
curl -fsSL https://get.docker.com | bash
apt install -y docker-compose-plugin
```

### 2. Copiar Proyecto

```bash
mkdir -p /opt/mesarpg
# Copiar archivos desde tu PC
```

### 3. Configurar Nginx

Edita `deploy/nginx.conf` y reemplaza `DOMAIN` con tu dominio:

```bash
sed -i 's/DOMAIN/tu-dominio.com/g' /opt/mesarpg/deploy/nginx.conf
```

### 4. Obtener Certificados SSL

```bash
cd /opt/mesarpg/deploy

# Crear directorios
mkdir -p certbot/conf/live/tu-dominio.com certbot/www

# Certificado temporal (para que Nginx arranque)
openssl req -x509 -nodes -newkey rsa:4096 -days 1 \
    -keyout certbot/conf/live/tu-dominio.com/privkey.pem \
    -out certbot/conf/live/tu-dominio.com/fullchain.pem \
    -subj "/CN=tu-dominio.com"

# Iniciar servicios
docker compose -f docker-compose.prod.yml up -d

# Obtener certificado real
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
    --webroot --webroot-path=/var/www/certbot \
    --email tu-email@ejemplo.com --agree-tos --no-eff-email \
    -d tu-dominio.com

# Reiniciar Nginx
docker compose -f docker-compose.prod.yml restart nginx
```

### 5. Configurar Renovación Automática

```bash
crontab -e
# Añadir línea:
0 3 * * * cd /opt/mesarpg/deploy && docker compose -f docker-compose.prod.yml run --rm certbot renew && docker compose -f docker-compose.prod.yml restart nginx
```

## 📱 Uso para los Usuarios Finales

### Para el Game Master

1. Abre `https://tu-dominio.com/admin` en tu navegador
2. Controla el combate, turnos y personajes
3. Abre `https://tu-dominio.com/display` en la pantalla grande

### Para los Jugadores

1. Abre `https://tu-dominio.com/mobile` en tu móvil
2. Introduce tu nombre
3. Selecciona tu personaje
4. ¡Juega!

### Instalar como App (PWA)

Los jugadores pueden "instalar" la app en su móvil:

**Android (Chrome):**
1. Abre la URL en Chrome
2. Toca el menú ⋮ → "Añadir a pantalla de inicio"

**iPhone (Safari):**
1. Abre la URL en Safari
2. Toca el botón compartir → "Añadir a pantalla de inicio"

## 🔍 Comandos Útiles

```bash
# Ver logs
docker compose -f docker-compose.prod.yml logs -f

# Reiniciar servicios
docker compose -f docker-compose.prod.yml restart

# Detener todo
docker compose -f docker-compose.prod.yml down

# Actualizar después de cambios
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

## 🛠️ Solución de Problemas

### Los WebSockets no conectan

Verifica que Nginx está configurado correctamente:
```bash
docker compose -f docker-compose.prod.yml logs nginx
```

### Error de certificado SSL

```bash
# Renovar certificado manualmente
docker compose -f docker-compose.prod.yml run --rm certbot renew
docker compose -f docker-compose.prod.yml restart nginx
```

### El servidor no responde

```bash
# Verificar estado de contenedores
docker ps

# Reiniciar todo
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

## 💰 Costos Estimados

| Servicio | Costo Mensual |
|----------|---------------|
| DigitalOcean Droplet (Basic) | $6-12 USD |
| Dominio (.com) | ~$1 USD (anual ~$12) |
| SSL (Let's Encrypt) | **Gratis** |
| **Total** | **~$7-13 USD/mes** |

## 🔒 Seguridad

El despliegue incluye:
- ✅ HTTPS obligatorio
- ✅ Certificados SSL automáticos
- ✅ Firewall configurado (UFW)
- ✅ Fail2ban para prevenir ataques
- ✅ Headers de seguridad HTTP
