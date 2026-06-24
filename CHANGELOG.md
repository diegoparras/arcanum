# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versionado semantico.

## [0.1.0] - 2026-06-24

### Agregado

- Autenticacion WSAA con firma CMS/PKCS#7 **100% local** (node-forge). La clave
  privada nunca sale del contenedor ni pasa por terceros.
- Cache de Ticket de Acceso (Token + Sign) por CUIT + servicio, con lock para
  evitar logins concurrentes y respeto del `expirationTime` real.
- Multi-tenant por archivos: `data/certs/<CUIT>.crt` + `<CUIT>.key`.
- WSFEv1 (Factura Electronica nacional):
  - `POST /api/wsfev1/comprobantes` — emitir y obtener CAE (auto-numeracion).
  - `GET /api/wsfev1/ultimo-autorizado` — ultimo numero autorizado.
  - `GET /api/wsfev1/parametros/{nombre}` — catalogos (tipos, alicuotas, etc).
  - `GET /api/wsfev1/status` — FEDummy.
- Padron / Constancia: `GET /api/padron/{a13|a5}/{cuit}`.
- Diagnostico WSAA: `GET`/`DELETE /api/wsaa/{cuit}/{service}`.
- Auth por `X-API-Key` (se autogenera si no se define).
- OpenAPI 3.0 + pagina `/docs` (Redoc) para integrar con n8n.
- Docker + docker-compose, imagen sin root con healthcheck.

- Postgres con esquema completo, claves privadas cifradas (AES-256-GCM).
- Catalogo de 16 servicios editable en vivo por superadmin (motor generico +
  modulos ricos). Namespaces/endpoints verificados contra los WSDL reales.
- Ciclo de vida del certificado (genera CSR, carga el .crt con validacion).
- Auto-recuperacion de token + daemon (monitor, renovacion, alertas de vencimiento).
- Log de peticiones, idempotencia (anti doble-CAE), validacion previa de importes.
- NC/ND con comprobantes asociados, consulta/reimpresion, PDF con QR de ARCA,
  export CSV, webhooks firmados HMAC, metricas + endpoint Prometheus.
- Panel web completo (login con roles + API key + OIDC/Lockatus opcional).

### Verificado

- Motor generico contra ARCA homologacion real: wsfev1, wsfexv1, wsbfev1, wscdc
  y wsmtxca devuelven OK por sus dummy. Resto de servicios Java con namespace y
  auth correctos (su dummy requiere auth, asi que no se monitorean).

### Pendiente (roadmap)

- Verificacion del camino con firma usando un certificado de homologacion real.
- Promover WSFEX/MTXCA/agro de generico a modulos "ricos" con validaciones finas.
- Lotes (varios comprobantes por request) y CAEA.
