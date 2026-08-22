# MesaRPG rewrite — build de producción del frontend (React + Vite) servido con nginx.
#
# En el servidor compartido, el nginx del propio host (sprinta-web) enruta
# rpgvision.duckdns.org: /api/ y /ws/ hacia el contenedor del backend, el resto hacia
# este contenedor — mismo origen público para ambos, así que VITE_API_URL se deja vacío
# (rutas relativas /api/... contra el propio origen, ver src/api.ts). VITE_WS_URL sí
# necesita ser absoluta (el constructor WebSocket no admite rutas relativas), horneada
# al dominio público real en build (ver ../deploy/docker-compose.oracle.yml, build.args).
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_API_URL=""
ARG VITE_WS_URL
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://127.0.0.1/ || exit 1
