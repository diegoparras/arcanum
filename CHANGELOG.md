# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versionado semantico.

## [0.3.2] - 2026-07-04

### Agregado
- PDF: **detalle de items linea por linea** (Codigo / Producto-Servicio / Cantidad /
  U. Medida / P. Unitario / % Bonif / Subtotal). Se pasan en `items` al emitir y se
  persisten; si no hay, se muestra una linea resumen.
- PDF: **caja "Regimen de Transparencia Fiscal al Consumidor (Ley 27.743)"** con IVA
  Contenido + Otros Impuestos Nacionales Indirectos, solo en Factura B a consumidor final.
- PDF: leyenda **"*147 Telefono gratuito - Defensa del Consumidor"**, **"Pag. 1/1"** y
  **wordmark ARCA** ("Agencia de Recaudacion y Control Aduanero" + "Comprobante Autorizado")
  en reemplazo del recuadro negro.

## [0.3.1] - 2026-07-04

### Cambiado
- PDF: los importes se muestran con `$` (no "PES"), con el simbolo separado del
  numero y alineado como en el layout oficial de ARCA. "ORIGINAL" centrado arriba
  y caja de letra reposicionada para calcar la representacion impresa vigente.

## [0.3.0] - 2026-07-04

### Agregado
- **Representacion impresa legal del comprobante (PDF renovado)**: datos del emisor
  (razon social, condicion IVA, domicilio, CUIT, IIBB, inicio de actividades),
  receptor con su **condicion frente al IVA**, discriminacion de IVA por alicuota
  (A/M) o total (B/C), periodo facturado (servicios), condicion de venta, leyendas
  ("A CONSUMIDOR FINAL" RG 5866, Ley 27.743), CAE + vencimiento, QR de ARCA y
  **codigo de barras Interleaved 2 of 5** (RG 1415). Datos del emisor por env
  (`ARCANUM_EMISOR_*`).
- **CondicionIVAReceptorId en WSFEv1** (RG 5616, obligatoria desde 2025): se envia
  en la emision y se persiste para el PDF. Parametro `condicionIvaReceptor`.
- **Regla RG 5866/2026**: en ventas a consumidor final por total >= $10.000.000 se
  exige identificar al comprador (DNI/CUIL/CDI); si falta, se rechaza con 422.
  Umbral configurable (`ARCANUM_UMBRAL_CF_ID`).
- **Sugerencia de comprobante** (`reglas-comprobante.js`): dada la condicion del
  emisor + la del receptor sugiere letra A/B/C y si discrimina IVA. Integrada en
  `/api/contribuyente` (campo `comprobanteSugerido`).

### Nota
- Inspirado en el fork open-source ArcanumPro (derivado de Arcanum, Apache-2.0):
  se reimplementaron el layout legal y el helper de reglas, adaptados a nuestra
  arquitectura (config por env, persistencia del desglose, integracion al semaforo).

## [0.2.5] - 2026-06-24

### Agregado
- **Vista consolidada del contribuyente** con semaforo de riesgo fiscal:
  `GET /api/contribuyente/:cuit?cuit=<representada>` combina Padron A5 + WSAPOC en
  una sola respuesta. Devuelve `semaforo` (VERDE/AMARILLO/ROJO), `fiscal`
  (tipoContribuyente, condicionIVA, tipoComprobante, estadoClave, domicilio) y `apoc`.
  Las dos consultas en paralelo; APOC es best-effort (si falla, no aborta el analisis).
  Preset en el Generador y ruta en OpenAPI. Verificado contra ARCA produccion.

## [0.2.4] - 2026-06-24

### Agregado
- **WSAPOC (base de apocrifos)**: nuevo servicio del catalogo + modulo rico.
  `GET /api/apoc/:cuit?cuit=<representada>` devuelve `{ esApocrifo, fechaCondicion, fechaPublicacion, codigo }`.
  Endpoint .NET (`eapoc-ws.afip.gob.ar`), namespace `tempuri.org`, credencial envuelta (`<credencial>`).
  Verificado contra ARCA produccion. Reusa el cache de TA (no pide token nuevo por consulta → anti-baneo).
- Nuevo `authStyle: 'apoc'` en el motor generico (sobre `<credencial>` con `CUITDelegado`).
- Preset de APOC en el Generador de codigo.

## [0.2.0] - 2026-06-24

### Agregado
- **e-Ventanilla** (modulo rico SOAP 1.2 + MTOM): listar/leer comunicaciones y descargar PDF adjuntos.
- **Switch de entorno homo/prod desde la UI** (admin), en caliente y persistido.
- **Importar par clave+certificado** existente desde la UI/API.
- **Verificar asociacion** del certificado por servicio (boton en la UI + `/api/services/:id/verificar`).
- **Emision por lote** (JSON o CSV): `POST /api/wsfev1/lote`.
- **Notificaciones por email** (SMTP) ademas de webhooks.
- **OIDC**: verificacion de la firma del id_token contra el JWKS.
- Menu hamburguesa (Acerca de + tema + entorno), ojitos en contrasenas, generador con presets de e-Ventanilla/padron A5.
- OpenAPI completo, ESLint, SECURITY.md, CONTRIBUTING.md, imagen base pinneada por digest, mas tests.

### Cambiado
- Token WSAA: sin renovacion proactiva (evita el rechazo "ya posee un TA valido" y el baneo); renovacion lazy + fallback al TA cacheado.
- Quitados padron A4/A10 (endpoints no verificados) con poda automatica.
- Timeout SOAP a 15s para errores rapidos.

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
