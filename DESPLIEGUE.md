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

---

## Mis Comprobantes: conectar Fisherboy

Mis Comprobantes se baja operando la pagina de ARCA con la *sesion de agente* de Fisherboy
(1.9.0 o mas nuevo). Arcanum le habla por la red interna.

**Compose**: sumá el archivo de Fisherboy:

```bash
openssl rand -hex 24   # FISHERBOY_TOKEN
openssl rand -hex 32   # FISHERBOY_SECRET_KEY
docker compose -f docker-compose.yml -f docker-compose.fisherboy.yml up -d
```

**EasyPanel**: en el mismo proyecto, servicio Fisherboy (imagen `ghcr.io/diegoparras/fisherboy:latest`)
con Redis, y estas variables:

```
API_TOKEN=<FISHERBOY_TOKEN>
API_TOKEN_ROLE=angel
AGENT_ALLOWED_DOMAINS=afip.gob.ar,arca.gob.ar
# opcional, IA de respaldo (compatible con OpenAI, incluido Ollama):
LLM_API_BASE_URL=...
LLM_API_KEY=...
LLM_MODEL=...
```

En Arcanum: `FISHERBOY_URL=http://<servicio-fisherboy>:8000` y `FISHERBOY_TOKEN=<el mismo>`, o
cargalos desde el menu **Fisherboy y Mis Comprobantes** (superadmin). En la pestana
**Mis Comprobantes** tiene que decir "Fisherboy 1.9.x conectado".

**Primera corrida real**: cargá la clave fiscal del CUIT, tocá **Sincronizar ahora** y mirala en
vivo. Si un paso de la receta no coincide con la pagina real, tomá el control, terminá ese paso
a mano y despues ajustá la receta desde el menu. Si ARCA rechaza la clave, Arcanum bloquea la
credencial y no reintenta: revisala y volvé a cargarla.

## Prueba de emision en homologacion (antes de facturar en produccion)

Saca un CAE real **de prueba** contra los servidores de homologacion de ARCA y verifica
todo el circuito: ARCA responde, ultimo numero, vista previa, emision, que ARCA devuelva
el mismo CAE al consultarlo y que un reintento con la misma clave de idempotencia no
saque otro. Nunca toca produccion: el script fuerza el entorno `homo` y aborta si el
endpoint no es de homologacion.

1. En Arcanum (instancia local o con el entorno en `homo`), en **Clientes**, da de alta
   el CUIT y descarga el CSR que genera.
2. Entra a ARCA con clave fiscal y abri **WSASS - Autogestion Certificados Homologacion**
   (adherilo en "Administrador de relaciones" si no aparece).
3. En WSASS: *Nuevo certificado*, pega el CSR y copia el certificado que devuelve.
4. En WSASS: *Crear autorizacion a servicio*, elegi el certificado y el servicio
   **wsfe** (Facturacion electronica).
5. En Arcanum, en **Clientes**, pega el certificado en ese CUIT.
6. Corre la prueba:

```bash
docker compose exec arcanum node src/tools/prueba-homologacion.js --cuit 20111111112
```

Opciones: `--pv 1` (punto de venta), `--tipo 11` (11 = Factura C, 6 = Factura B,
1 = Factura A) y `--total 100`. Termina con `PRUEBA OK` o con el paso que fallo.
