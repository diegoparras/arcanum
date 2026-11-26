# Arcanum — imagen minima, sin root, con healthcheck. Patron de la suite Escriba.
# Imagen base pinneada por digest para builds reproducibles (node:24-slim, LTS).
# Dos etapas (auditoria 2026-11-26, B-17): las dependencias se instalan con `npm ci` (exige el
# lock) y la imagen final no trae npm ni corepack, que la app no usa.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production \
    ARCANUM_DATA_DIR=/data \
    PORT=8094

WORKDIR /app

COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json package-lock.json ./

COPY src ./src
COPY public ./public
COPY openapi.yaml ./openapi.yaml
# Novedades por version: el log de arranque y la UI las leen de aca.
COPY CHANGELOG.md ./CHANGELOG.md

# Volumen persistente: certificados de cada CUIT + cache de tokens. El codigo (/app) queda de
# root: el usuario que ejecuta no puede modificarlo.
RUN mkdir -p /data/certs /data/cache && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8094)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
