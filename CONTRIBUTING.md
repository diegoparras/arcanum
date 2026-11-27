# Contribuir a Arcanum

Gracias por querer aportar. Arcanum es parte de la suite **Escriba** y se publica con licencia MIT: al enviar un aporte aceptás que se distribuya bajo esa licencia.

## Entorno de desarrollo

Requisitos: Node 20 o superior y Docker (para Postgres).

```bash
npm install
docker compose up -d arcanum-db     # solo la base
ARCANUM_ENV=homo npm run dev         # la app en modo watch, contra esa base
```

O todo junto: `docker compose up -d --build`.

| Comando | Qué hace |
|---|---|
| `npm run lint` | ESLint sobre `src/` y `test/` |
| `npm test` | La suite completa (`node --test`), sin tocar la red |
| `npm run dev` | Servidor con recarga automática |

**Nunca pruebes contra ARCA de producción.** Para homologación usá un CUIT de prueba y `ARCANUM_ENV=homo`. Para pruebas de punta a punta sin ARCA, `scripts/arca-stub.js` imita WSAA y WSFEv1 (se apunta con `ARCANUM_ENDPOINT_WSAA` y `ARCANUM_ENDPOINT_WSFEV1`). Para correr un contenedor local que no hable con ARCA: `ARCANUM_DAEMONS=0` y `--dns 127.0.0.1`.

## Estilo y arquitectura

- Node nativo, **sin frameworks**: servidor HTTP propio en `src/server.js`, frontend vanilla en `public/index.html`, sin build step.
- **Sin emojis** en la UI, la documentación ni la CLI (regla de marca de la suite). Íconos: SVG de línea.
- Textos visibles en español rioplatense, con tildes. Los identificadores del código pueden ir sin tilde.
- El catálogo de servicios de ARCA vive en `src/catalog.defaults.js` (semilla) y se edita en vivo desde el panel; para sumar un web service nuevo, agregá su descriptor ahí.
- Servicios "ricos" (validación y REST ergonómico) en `src/services/`. El resto pasa por el motor genérico (`src/soap/engine.js`).
- **Nunca** registres secretos, claves privadas, certificados ni claves fiscales en logs. Lo sensible se cifra con `src/crypto/vault.js`.
- Todo dato que llega al panel se escapa (`esc()` para HTML, `jsA()` para atributos con JavaScript).

## Mensajes de commit

Seguimos [Conventional Commits](https://www.conventionalcommits.org/es/v1.0.0/), en español y con la versión al final:

```
tipo(ámbito): qué cambia, en una línea - X.Y.Z
```

| Tipo | Cuándo |
|---|---|
| `feat` | Funcionalidad nueva |
| `fix` | Corrección de un error (con `fix(seguridad)` para todo lo de seguridad) |
| `docs` | Solo documentación |
| `style` | Apariencia de la UI, sin cambio de comportamiento |
| `refactor` | Cambio interno sin cambio de comportamiento |
| `test` | Solo tests |
| `chore` | Mantenimiento: dependencias, CI, empaquetado |

El ámbito es el área tocada: `mis-comprobantes`, `analisis`, `constatacion`, `factorum`, `ui`, `seguridad`, `docs`, `ci`. Ejemplo:

```
fix(constatacion): reintentar con DNI y consumidor final - 2.1.7
```

## Versiones

Cada cambio que se publica sube la versión ([SemVer](https://semver.org/lang/es/)): el patch para correcciones y mejoras chicas, el minor para funcionalidad nueva. Hay que actualizarla en tres lugares, y un test verifica que coincidan:

1. `package.json` y `package-lock.json` (`npm version patch --no-git-tag-version`).
2. `info.version` en `openapi.yaml`.
3. Una sección nueva en `CHANGELOG.md`, arriba de todo.

Al llegar a `main`, la CI publica la imagen `ghcr.io/diegoparras/arcanum` con esa versión y crea la Release.

## Pull requests

1. Hacé un fork y una rama con nombre descriptivo (`fix/constatacion-cuil`).
2. Que pasen `npm run lint` y `npm test`.
3. Subí la versión como se explica arriba.
4. Describí qué cambia y por qué. Si toca un web service de ARCA, contá cómo lo verificaste en homologación.

## Documentación, capturas y video

Las capturas, la portada, las guías en PDF y el video se generan con los scripts de [`docs/fuentes/`](docs/fuentes/README.md), siempre contra una instancia de demostración con datos ficticios.

## Reportes de seguridad

No por issues públicos: ver [SECURITY.md](SECURITY.md).
