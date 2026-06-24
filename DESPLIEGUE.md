# Despliegue de Arcanum

Arcanum son dos piezas: **Postgres** y la **app**. Elegí el camino segun tu panel.

Antes que nada, generá los dos secretos:

```bash
openssl rand -hex 24   # ARCANUM_API_KEY
openssl rand -hex 32   # ARCANUM_MASTER_KEY  (cifra las claves privadas; guardala bien)
```

---

## Opcion A — Docker vanilla / Dokploy / Portainer / Coolify (compose)

Estos paneles importan un `docker-compose.yml`. Es el camino mas simple.

```bash
git clone <repo> arcanum && cd arcanum
cp .env.example .env        # completá ARCANUM_API_KEY y ARCANUM_MASTER_KEY
docker compose up -d
```

Levanta `arcanum-db` (Postgres) y `arcanum` (app), conectados solos. La app queda
en el puerto `8094`. En los paneles, pegá el contenido del compose en su editor y
cargá las variables del `.env` en la seccion de Environment.

---

## Opcion B — EasyPanel (su modo compose esta en beta)

Si el compose de EasyPanel te da problemas, armá los dos servicios a mano. Es
igual de simple y mas estable.

### 1. Servicio Postgres

1. En tu proyecto de EasyPanel: **+ Service → Postgres**.
2. Nombre: `arcanum-db`. Anotá usuario, password y base que te genera.
3. EasyPanel lo expone internamente como host `arcanum-db` (nombre del servicio).

### 2. Servicio App

1. **+ Service → App**.
2. **Source**: imagen `ghcr.io/diegoparras/arcanum:latest` (o tu repo de GitHub
   para que buildee el Dockerfile).
3. **Environment** — cargá estas variables:
   ```
   ARCANUM_ENV=homo
   ARCANUM_API_KEY=<tu clave hex de 24>
   ARCANUM_MASTER_KEY=<tu clave hex de 32>
   DATABASE_URL=postgres://USUARIO:PASSWORD@arcanum-db:5432/BASE
   PORT=8094
   ```
   Reemplazá `USUARIO`, `PASSWORD` y `BASE` por los del paso 1, y `arcanum-db`
   por el nombre interno real de tu servicio Postgres.
4. **Volumes**: montá un volumen en `/data` (guarda la master key autogenerada si
   no la definís por env; igual conviene definirla).
5. **Ports / Domains**: exponé el `8094` y asignale un dominio con HTTPS.
6. Deploy. Mirá los logs: si no definiste `ARCANUM_API_KEY`, ahí aparece la
   generada (una sola vez).

> Importante: en produccion poné siempre `ARCANUM_ENV=prod`, `ARCANUM_API_KEY`
> y `ARCANUM_MASTER_KEY` propias, y la app detras de HTTPS.

---

## Verificar que quedo arriba

```bash
curl https://TU-DOMINIO/api/health
# { "ok": true, "service": "arcanum", ... }
```

La interfaz web y la documentacion quedan en `https://TU-DOMINIO/`.

---

## Actualizaciones

- **Compose**: `docker compose pull && docker compose up -d`
- **EasyPanel**: botón *Deploy* / *Redeploy* del servicio App.

El esquema de la base se migra solo al arrancar (idempotente). Tus datos viven en
el volumen de Postgres; respaldalo (`pg_dump`) junto con tu `ARCANUM_MASTER_KEY`.
