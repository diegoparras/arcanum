# Arcanum — imagen minima, sin root, con healthcheck. Patron de la suite Escriba.
# Imagen base pinneada por digest para builds reproducibles (node:24-slim, LTS).
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ENV NODE_ENV=production \
    ARCANUM_DATA_DIR=/data \
    PORT=8094

WORKDIR /app

# Instala solo dependencias de produccion (capa cacheable).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY openapi.yaml ./openapi.yaml
# Novedades por version: el log de arranque y la UI las leen de aca.
COPY CHANGELOG.md ./CHANGELOG.md

# Volumen persistente: certificados de cada CUIT + cache de tokens.
RUN mkdir -p /data/certs /data/cache && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8094)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
