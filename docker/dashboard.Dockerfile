# Dashboard estatico (SPA vanilla real: login JWT + 15 telas conectadas ao
# backend). Servido direto pelo nginx a partir de apps/dashboard/public - sem
# build Node/Vite (o front React desconectado foi removido na consolidacao).
FROM node:22-alpine AS dashboard
WORKDIR /app
COPY apps/dashboard/public apps/dashboard/public
COPY scripts/build-dashboard.mjs scripts/build-dashboard.mjs
RUN node scripts/build-dashboard.mjs

FROM nginx:alpine

COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard /app/apps/dashboard/public /usr/share/nginx/html
RUN chmod -R 755 /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
