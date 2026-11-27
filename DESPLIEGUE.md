# Despliegue de Arcanum

Arcanum son dos piezas: **Postgres** y la **app**. Elegí el camino según tu panel.

Antes que nada, generá los dos secretos:

```bash
openssl rand -hex 24   # ARCANUM_API_KEY
openssl rand -hex 32   # ARCANUM_MASTER_KEY  (cifra las claves privadas; guardala bien)
```

---

## Opción A — Docker vanilla / Dokploy / Portainer / Coolify (compose)

Estos paneles importan un `docker-compose.yml`. Es el camino más simple.

```bash
git clone <repo> arcanum && cd arcanum
cp .env.example .env        # completá ARCANUM_API_KEY, ARCANUM_MASTER_KEY,
                            # ARCANUM_SESSION_SECRET y POSTGRES_PASSWORD
docker compose up -d
```

Levanta `arcanum-db` (Postgres) y `arcanum` (app), conectados solos. La app queda
en `127.0.0.1:8094`: delante va el proxy con HTTPS. Para abrirla a la red sin proxy (no
recomendado, sin TLS), `ARCANUM_BIND=0.0.0.0`. En los paneles, pegá el contenido del compose
en su editor y cargá las variables del `.env` en la sección de Environment: todas las de
`.env.example` llegan al contenedor.

`POSTGRES_PASSWORD` es obligatoria. Si actualizás una instalación que ya tenía la base con la
clave por defecto, poné `POSTGRES_PASSWORD=arcanum` (y cambiala después con `ALTER USER`).

---

## Opción B — EasyPanel (su modo compose está en beta)

Si el compose de EasyPanel te da problemas, armá los dos servicios a mano. Es
igual de simple y más estable.

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
   # opcional, para el pase entre apps de la suite (la del dominio del paso 5):
   ARCANUM_PUBLIC_URL=https://arcanum.tu-dominio.com
   ```
   Reemplazá `USUARIO`, `PASSWORD` y `BASE` por los del paso 1, y `arcanum-db`
   por el nombre interno real de tu servicio Postgres.
4. **Volumes**: montá un volumen en `/data` (guarda la master key autogenerada si
   no la definís por env; igual conviene definirla).
5. **Ports / Domains**: exponé el `8094` y asignale un dominio con HTTPS.
6. Deploy. Si no definiste `ARCANUM_API_KEY` o `ARCANUM_ADMIN_PASS`, Arcanum las
   genera y las deja en el volumen, legibles solo por la app: **nunca** en los logs.
   Los logs dicen dónde leerlas desde la consola del servicio:
   `cat /data/api-key-generada` y `cat /data/admin-clave-inicial`. La clave de API
   generada se reutiliza en cada reinicio; el archivo de la contraseña del superadmin
   conviene borrarlo después de cambiarla.

> Importante: en producción poné siempre `ARCANUM_ENV=prod`, `ARCANUM_API_KEY`
> y `ARCANUM_MASTER_KEY` propias, y la app detrás de HTTPS.

---

## Verificar que quedó arriba

```bash
curl https://TU-DOMINIO/api/health
# { "ok": true, "service": "arcanum", ... }
```

La interfaz web y la documentación quedan en `https://TU-DOMINIO/`.

---

## Actualizaciones

- **Compose**: `docker compose pull && docker compose up -d`
- **EasyPanel**: botón *Deploy* / *Redeploy* del servicio App.

El esquema de la base se migra solo al arrancar (idempotente). Tus datos viven en
el volumen de Postgres; respaldalo (`pg_dump`) junto con tu `ARCANUM_MASTER_KEY`.

---

## Mis Comprobantes: conectar Fisherboy

Mis Comprobantes se baja operando la página de ARCA con la *sesión de agente* de Fisherboy
(1.9.0 o más nuevo). Arcanum le habla por la red interna.

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
cargalos desde el menú **Fisherboy y Mis Comprobantes** (superadmin). En la pestaña
**Mis Comprobantes** tiene que decir "Fisherboy 1.9.x conectado".

**Primera corrida real**: cargá la clave fiscal del CUIT, tocá **Sincronizar ahora** y mirala en
vivo. Si un paso de la receta no coincide con la página real, tomá el control, terminá ese paso
a mano y después ajustá la receta desde el menú. Si ARCA rechaza la clave, Arcanum bloquea la
credencial y no reintenta: revisala y volvé a cargarla.

## Facturas recibidas: conectar Factorum

Factorum lee las facturas recibidas (QR, texto, OCR e IA opcional), corre los controles y las
constata con ARCA **a través de Arcanum**. La conexión va en los dos sentidos:

- **Arcanum -> Factorum**: con `FACTORUM_URL` y `FACTORUM_TOKEN` (el `FACTORUM_API_KEY` de
  Factorum). Es lo que usan la pestaña **Facturas recibidas**, `/api/factorum/...` y las
  herramientas MCP.
- **Factorum -> Arcanum**: Factorum llama a `POST /api/constatacion` (WSCDC + apócrifos) y a
  `GET /api/padron/a5/:cuit?cuit=` con una **clave de API de Arcanum** (`ARCANUM_API_KEY` en
  Factorum). En Arcanum no hay que habilitar nada nuevo: solo crear esa clave.

### 1. La clave de Arcanum para Factorum

En Arcanum, **Usuarios -> Claves de API -> Nueva**:

- **Rol `lectura`**. Alcanza: `POST /api/constatacion` es una de las excepciones de `POST` del rol
  lectura (como la vista previa), porque solo consulta WSCDC y apócrifos y no guarda nada. Con
  lectura, la clave no puede emitir ni modificar nada aunque se filtre.
- **CUITs permitidos**: solo los que constatan (los que tienen certificado con WSCDC y reciben las
  facturas). Con otro CUIT, Arcanum responde `403`.
- Opcional: vencimiento y límite por minuto (un lote grande constata de a muchos; 120 por minuto
  alcanza para la mayoría).

Nunca le pases a Factorum la `ARCANUM_API_KEY` maestra de Arcanum (es rol admin, sin límite de
CUITs).

### 2. Levantar Factorum

**Compose**: sumá el archivo de Factorum (trae su propio Postgres):

```bash
openssl rand -hex 24   # FACTORUM_TOKEN (Arcanum <-> Factorum)
openssl rand -hex 32   # FACTORUM_MASTER_KEY (obligatoria si los archivos van a R2)
```

En el `.env`:

```
FACTORUM_TOKEN=<el de arriba>
FACTORUM_ARCANUM_API_KEY=<la clave de lectura del paso 1>
ARCANUM_CUIT_CONSULTANTE=<CUIT por defecto para constatar, si no se indica otro>
# opcional, IA (compatible con OpenAI, incluido Ollama):
FACTORUM_LLM_API_BASE_URL=http://ollama:11434/v1
FACTORUM_LLM_MODEL=qwen2.5vl:7b
# opcional, archivos en R2 / S3 (si no, quedan en el volumen de Factorum):
FACTORUM_MASTER_KEY=...
FACTORUM_R2_ENDPOINT=...
FACTORUM_R2_BUCKET=...
FACTORUM_R2_ACCESS_KEY=...
FACTORUM_R2_SECRET_KEY=...
```

```bash
docker compose -f docker-compose.yml -f docker-compose.factorum.yml up -d
# con IA local (Ollama) en el mismo compose:
docker compose -f docker-compose.yml -f docker-compose.factorum.yml --profile ia up -d
docker compose exec ollama ollama pull qwen2.5vl:7b
```

**EasyPanel**: en el mismo proyecto, un Postgres para Factorum y el servicio Factorum (imagen
`ghcr.io/diegoparras/factorum:latest`, puerto interno `8095`, volumen en `/data`) con:

```
FACTORUM_DATABASE_URL=postgres://USUARIO:PASSWORD@<postgres-de-factorum>:5432/BASE
FACTORUM_API_KEY=<FACTORUM_TOKEN>
ARCANUM_URL=http://<servicio-arcanum>:8094
ARCANUM_API_KEY=<la clave de lectura del paso 1>
ARCANUM_CUIT_CONSULTANTE=<CUIT por defecto>
# opcional, IA:
LLM_API_BASE_URL=...
LLM_API_KEY=...
LLM_MODEL=...
# opcional, R2:
FACTORUM_MASTER_KEY=...
FACTORUM_R2_ENDPOINT=...
FACTORUM_R2_BUCKET=...
FACTORUM_R2_ACCESS_KEY=...
FACTORUM_R2_SECRET_KEY=...
```

### 3. Conectar Arcanum

`FACTORUM_URL=http://<servicio-factorum>:8095` y `FACTORUM_TOKEN=<el mismo>`, o cargalos desde el
menú **Factorum (facturas recibidas)** (superadmin; el token se guarda cifrado y tiene el ojito
para verlo mientras lo tipeás). Con **Probar** tiene que decir "Factorum 0.x conectado" y, si la
clave del paso 1 está bien, "constata con Arcanum". La pestaña **Facturas recibidas** aparece sola
cuando Factorum responde.

**Primera prueba**: en **Facturas recibidas -> Verificar una factura**, subí una factura real
recibida. Tiene que volver `VALIDA` (o `NO VERIFICABLE` si al CUIT consultante le falta WSCDC). Si
dice que ARCA no respondió, revisá en Arcanum el uso de la clave de Factorum (botón **Uso**): un
`403` es un CUIT que no está en la lista de CUITs permitidos de esa clave (el rol `lectura` alcanza).

## Suite Escriba: pase entre Arcanum y Factorum

Con las dos apps conectadas, se pasa de una a la otra sin volver a loguearse: en Arcanum, con la
grilla de arriba a la derecha; en Factorum, con su botón para abrir Arcanum. Cada lado usa la
credencial que ya tiene para hablarle al otro, habilitada para la suite. Contrato:
[docs/suite-pase.md](docs/suite-pase.md).

### 1. URLs públicas

Cada app necesita la dirección con la que se entra **desde el navegador** (no la interna tipo
`http://factorum:8095`):

- **Arcanum**: `ARCANUM_PUBLIC_URL=https://arcanum.tu-dominio.com` (se acepta también
  `ARCANUM_URL_PUBLICA`), o el menú **Suite Escriba (pase entre apps)** (superadmin), que pisa a la
  variable. Sin ella, Arcanum responde `409` "Falta la URL pública de Arcanum" cuando Factorum pide
  un pase.
- **Factorum**: su propia URL pública (`FACTORUM_URL_PUBLICA`) y la de Arcanum
  (`ARCANUM_URL_PUBLICA`, la misma que `ARCANUM_PUBLIC_URL`): Factorum controla que el pase de
  Arcanum lleve ahí. En compose, `docker-compose.factorum.yml` le pasa `ARCANUM_PUBLIC_URL` como
  `ARCANUM_URL_PUBLICA`.

La sesión que abre el pase es la misma del login: queda registrada (se cierra con **Salir** o al
desactivar o borrar a la persona) y la cookie sale `Secure` con la misma regla (https informado por
el proxy en `X-Forwarded-Proto`, ARCA en producción o `ARCANUM_COOKIE_SECURE=1`). Quien entró con
un pase no tiene contraseña en Arcanum: no entra por el login normal.

### 2. De Factorum a Arcanum: la clave de Arcanum, habilitada para la suite

Es la misma clave `ark_...` que Factorum usa para constatar (paso 1 de la sección anterior). En
Arcanum, **Usuarios → Claves de API → Suite** (o al crearla):

- **Puede abrir sesiones de la suite**: sí.
- **Rol tope**: `operador` (por defecto). Nadie entra desde Factorum por encima de ese rol, aunque
  en Factorum sea admin. `admin` o `superadmin` como tope los pone solo un superadmin, a propósito;
  una clave con CUITs permitidos llega como mucho a `operador` (admin y superadmin ven todos los
  CUITs).
- **CUITs permitidos** de la clave: los de quien entra se intersecan con estos. Si la clave está
  acotada a los CUITs que constatan, la gente que entra desde Factorum queda acotada a esos.

El rol de la clave sigue siendo el de constatar (`lectura` alcanza): el tope de la suite es aparte.
Quien ya tiene usuario en Arcanum (por email) entra con su rol y sus CUITs de Arcanum, topeados;
quien no, se da de alta solo, con origen `factorum`, salvo que lo apagues
(`ARCANUM_SUITE_CREAR_USUARIOS=0` o el menú **Suite Escriba**).

### 3. De Arcanum a Factorum: el token de Factorum, habilitado para la suite

Arcanum pide el pase con `FACTORUM_TOKEN` (o el token cargado en el menú **Factorum (facturas
recibidas)**). En Factorum, esa credencial tiene que poder **abrir sesiones de la suite** con un
**rol tope** (`usuario` por defecto); ver la documentación de Factorum. Arcanum manda el email, el
nombre, el rol de Arcanum tal cual (Factorum lo traduce: operador → usuario) y los CUITs
permitidos de la persona, y Factorum decide con lo suyo.

Cada usuario de Arcanum que quiera usar la grilla necesita un **email** (Usuarios → Editar). Sin
email, Arcanum avisa y no pide nada.

### 4. Probar

1. En Arcanum, la grilla aparece arriba a la derecha cuando Factorum está conectado; "No responde
   ahora" si su healthz falló en el último minuto.
2. Tocá **Factorum**: tenés que entrar sin loguearte. Si Factorum contesta "Esta clave no está
   habilitada para abrir sesiones de la suite", falta el paso 3.
3. Desde Factorum, el botón para abrir Arcanum: tenés que entrar con tu usuario de Arcanum. En
   Arcanum, el menú **Suite Escriba** muestra los últimos movimientos (pases emitidos, usados y
   rechazados) y la clave con la que se pidió cada uno.

## Prueba de emisión en homologación (antes de facturar en producción)

Saca un CAE real **de prueba** contra los servidores de homologación de ARCA y verifica
todo el circuito: ARCA responde, último número, vista previa, emisión, que ARCA devuelva
el mismo CAE al consultarlo y que un reintento con la misma clave de idempotencia no
saque otro. Nunca toca producción: el script fuerza el entorno `homo` y aborta si el
endpoint no es de homologación.

1. En Arcanum (instancia local o con el entorno en `homo`), en **Clientes**, da de alta
   el CUIT y descargá el CSR que genera.
2. Entrá a ARCA con clave fiscal y abrí **WSASS - Autogestión Certificados Homologación**
   (adherilo en "Administrador de relaciones" si no aparece).
3. En WSASS: *Nuevo certificado*, pegá el CSR y copiá el certificado que devuelve.
4. En WSASS: *Crear autorización a servicio*, elegí el certificado y el servicio
   **wsfe** (Facturación electrónica).
5. En Arcanum, en **Clientes**, pegá el certificado en ese CUIT.
6. Corré la prueba:

```bash
docker compose exec arcanum node src/tools/prueba-homologacion.js --cuit 20111111112
```

Opciones: `--pv 1` (punto de venta), `--tipo 11` (11 = Factura C, 6 = Factura B,
1 = Factura A) y `--total 100`. Termina con `PRUEBA OK` o con el paso que falló.
