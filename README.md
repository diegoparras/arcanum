# Arcanum

**Gateway REST + panel web self-hosted para los Web Services de ARCA (ex-AFIP).**
El regalo para contadores: instalás un Docker, abrís el navegador y operás *todos*
los servicios de ARCA sin pelear con SOAP. La firma WSAA es **100% local** (la
clave privada nunca sale de tu servidor ni pasa por terceros) y todo se puede
automatizar desde n8n. Sin cuentas, sin suscripciones, sin intermediarios.

Parte de la suite **Escriba**. Licencia Apache-2.0. No afiliado a ARCA/AFIP.

---

## Qué hace

- **Todos los servicios de ARCA** mediante un **catálogo declarativo** (facturación,
  exportación, MTXCA, bonos, turismo, FCE MiPyME, padrón A4/A5/A10/A13,
  constatación, agro y remitos). Módulos "ricos" para los más usados y un **motor
  genérico** (`/api/ws/:servicio/:operacion`) para cualquier otro.
- **Catálogo editable en vivo por el superadmin**: ARCA cambia endpoints seguido;
  los editás desde la UI sin redeployar (guardado en Postgres, auditado).
- **Panel web** con métricas (emisiones, uptime de cada WS, latencia, tokens,
  certificados por vencer), alta de clientes, emisión, comprobantes y **guía de
  activación paso a paso** por servicio.
- **Ciclo de vida del certificado**: genera el CSR, lo subís a ARCA, pegás el
  `.crt`. Las claves privadas se guardan **cifradas (AES-256-GCM)** en Postgres.
- **WSAA con auto-recuperación**: cachea el Token/Sign 12h, renueva proactivamente
  y reintenta solo si ARCA rechaza por token vencido.
- **Facturación**: emitir y obtener CAE (auto-numeración), NC/ND con comprobantes
  asociados, **validación previa** de importes, **idempotencia** (anti doble-CAE),
  consulta/reimpresión y **PDF legal con QR de ARCA**.
- **Integración**: export CSV para Libro IVA, **webhooks** a n8n (firmados HMAC),
  endpoint Prometheus en `/metrics`, y OpenAPI en `/docs`.

```
Navegador / n8n  ──REST──>  Arcanum (Docker, en tu servidor)  ──SOAP──>  ARCA
                            └─ firma WSAA local · Postgres · cache de token
```

---

## Instalación (un comando)

Requisitos: Docker. Generá los secretos:

```bash
openssl rand -hex 24   # ARCANUM_API_KEY
openssl rand -hex 32   # ARCANUM_MASTER_KEY (cifra las claves privadas; guardala)
```

```bash
git clone <repo> arcanum && cd arcanum
cp .env.example .env        # completá ARCANUM_API_KEY y ARCANUM_MASTER_KEY
docker compose up -d
```

Levanta Postgres + la app en el puerto **8094**. Abrí **http://localhost:8094**.
En el log aparece, una sola vez, el usuario `admin` y su contraseña (o fijala con
`ARCANUM_ADMIN_PASS`). Para desplegar en EasyPanel/Dokploy/Portainer ver
[DESPLIEGUE.md](DESPLIEGUE.md).

---

## Primeros pasos en el panel

1. **Entrá** con `admin` y la contraseña del log.
2. **Clientes → Nuevo cliente**: poné CUIT y razón social → se genera el CSR.
3. Subí el CSR a ARCA (homologación: WSASS; producción: portal de Certificados),
   descargá el `.crt` y usá **Pegar .crt**.
4. En **Servicios**, cada uno tiene **Cómo activar** (qué asociar en el
   Administrador de Relaciones de Clave Fiscal) y se verifica solo.
5. **Emitir** una factura de prueba → obtenés el CAE y el **PDF con QR**.

---

## Para n8n / API

Toda la API vive bajo `/api` y acepta autenticación por **`X-API-Key`** (la del
`.env`) o por sesión del panel. Ejemplo de emisión:

```bash
curl -X POST http://localhost:8094/api/wsfev1/comprobantes \
  -H "X-API-Key: TU_CLAVE" -H "Content-Type: application/json" \
  -d '{ "cuit":"20111111112","puntoVenta":1,"tipoComprobante":11,
        "importeNeto":100,"importeIva":21,"importeTotal":121,
        "idempotencyKey":"venta-0001",
        "alicuotasIva":[{"id":5,"baseImponible":100,"importe":21}] }'
```

Endpoints principales: `/api/wsfev1/comprobantes` (emitir), `/api/wsfev1/consultar`,
`/api/wsfev1/ultimo-autorizado`, `/api/wsfev1/parametros/{nombre}`,
`/api/padron/{a13|a5}/{cuit}`, `/api/ws/{servicio}/{operacion}` (genérico),
`/api/comprobantes` (+ `/export.csv` y `/{cuit}/{pv}/{tipo}/{nro}/pdf`),
`/api/services` (catálogo), `/api/metrics`, `/metrics` (Prometheus).
Documentación interactiva en `/docs`.

---

## Seguridad

- Claves privadas cifradas en reposo (AES-256-GCM); la master key vive en el
  entorno, nunca en la DB.
- Tokens WSAA con lock distribuido (advisory locks de Postgres).
- Auth por sesión (cookie firmada HMAC) con roles —superadmin/admin/operador/
  lectura— o API key. Comparaciones en tiempo constante.
- Imagen sin root, healthcheck, y daemons de fondo (monitor, renovación, alertas).
- En producción: `ARCANUM_ENV=prod`, secretos propios y detrás de HTTPS.

## Tests

```bash
npm install && npm test
```

## Estado y roadmap

Núcleo, facturación WSFEv1, padrón, catálogo, UI, auth y despliegue: **operativos
y verificados end-to-end** (incluida la conexión real a homologación de ARCA).
Pendiente: promover a "ricos" más servicios del long-tail (WSFEX/MTXCA/agro hoy van
por el motor genérico), federación opcional con Lockatus (hooks listos), y la
verificación del camino con firma usando un certificado real de homologación.
Ver [CHANGELOG.md](CHANGELOG.md).
