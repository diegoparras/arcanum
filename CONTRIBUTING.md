# Contribuir a Arcanum

Gracias por querer aportar. Arcanum es parte de la suite **Escriba** y se publica con licencia MIT. Al enviar un aporte aceptás que se distribuya bajo esa licencia.

## Desarrollo

Requisitos: Node 20+ y Docker (para Postgres).

```bash
npm install
docker compose up -d arcanum-db    # solo la base
ARCANUM_ENV=homo npm run dev        # la app en watch, contra esa base
```

O todo junto: `docker compose up -d --build`.

- Lint: `npm run lint`
- Tests: `npm test`

## Estilo y arquitectura

- Node nativo, **sin frameworks** (servidor HTTP propio en `src/server.js`). Frontend vanilla en
  `public/index.html`, sin build step.
- **Sin emojis** en UI, docs ni CLI (regla de marca de la suite). Íconos: SVG de línea.
- El catálogo de servicios de ARCA vive en `src/catalog.defaults.js` (semilla) y se puede editar en
  vivo; para sumar un WS nuevo, agregá su descriptor ahí.
- Servicios "ricos" (validación + REST ergonómico) en `src/services/`. El resto va por el motor
  genérico (`src/soap/engine.js`).
- **Nunca** loguear secretos ni claves privadas. Las claves se cifran con `src/crypto/vault.js`.

## Pull requests

1. Hacé un fork y una rama descriptiva.
2. Que pasen `npm run lint` y `npm test`.
3. **Subí el patch de la versión** en `package.json` (regla de deploy de la suite).
4. Describí qué cambia y por qué. Si toca un WS de ARCA, indicá cómo lo verificaste (homologación).

## Reportes de seguridad

No por issues públicos: ver [SECURITY.md](SECURITY.md).
