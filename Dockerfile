# Arcanum — imagen minima, sin root, con healthcheck. Patron de la suite Escriba.
FROM node:22-slim

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

# Volumen persistente: certificados de cada CUIT + cache de tokens.
RUN mkdir -p /data/certs /data/cache && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8094)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
