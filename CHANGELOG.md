# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versionado semantico.

## [0.6.2] - 2026-07-14

### Tests
- Cobertura para los modulos nuevos (test/nuevos.test.js, 17 tests): reglas-comprobante
  (sugerencia de letra A/B/C), importar.parseQr (decodifica QR de ARCA / rechaza basura),
  engine.toXml (serializacion + rechazo de claves invalidas / inyeccion XML), y helpers de
  lotes (n/pInt anti-NaN, alicuotaId por tasa, aging verde/amarillo/rojo, parseCsv, normItem).
  Total 27 tests (antes 10).

## [0.6.1] - 2026-07-14

### Seguridad (auditoria + remediacion)
- **IDOR multi-tenant en /api/lotes (CRITICO/ALTO)**: el bloque del facturador no aplicaba
  `assertCuitAllowed`, permitiendo a un usuario scoped por `cuit_allow` leer/emitir/exportar
  lotes de OTRO CUIT (incl. sacar CAE real bajo certificado ajeno). Ahora toda ruta `/api/lotes`
  resuelve el CUIT dueno y valida contra el principal; el listado exige `?cuit` para usuarios
  scoped. Verificado (403 cross-tenant, 200 propio).
- **Cert ajeno (MEDIO)**: `/api/apoc`, `/api/padron`, `/api/contribuyente` firmaban el TRA con
  el certificado de la representada sin `assertCuitAllowed`. Agregado.
- **Import bajo CUIT arbitrario (MEDIO)**: la importacion por QR persistia bajo el CUIT emisor
  del QR; ahora persiste bajo el CUIT consultante (autorizado), con el emisor en `raw.cuitEmisor`.
- **Inyeccion XML por claves (BAJO)**: `engine.toXml` valida cada clave como NCName.
- **Robustez**: `pInt`/`n` rechazan NaN (evita 500 al cargar lote y facturas $0 silenciosas);
  la alicuota IVA del facturador se infiere de la tasa (no hardcodeada a 21%); wsmtxca deriva
  `importeIva`/`alicuotasIva` de los subtotales para el PDF.
- Informe completo (13 hallazgos) en AUDIT-arcanum-2026-07-14.md (no versionado).

## [0.6.0] - 2026-07-14

### Agregado
- **Facturador masivo** (nueva seccion "Facturador"): lotes de facturacion con
  seguimiento y **semaforo de antiguedad** (verde <5d, amarillo 5-15d, rojo >15d).
  - Cargar lote por CSV o `items[]` (una fila por profesional/cliente).
  - Maquina de estados por item: pendiente -> solicitado -> emitido | recibido | rechazado.
  - **Emitir el CAE** de un item o de todo el lote (usa WSFEv1, numero auto, idempotente).
  - **Marcar recibido** (el profesional emitio y te mando su comprobante).
  - **Solicitar por email** al profesional (SMTP).
  - Export CSV con dias pendientes y semaforo. Perfiles pyme / asociacion.
  - `GET/POST /api/lotes`, `GET /api/lotes/:id`, `/emitir`, `/items/:id/(emitir|recibido|solicitar)`, `/export.csv`.
  - Verificado end-to-end (crear, aging, recibido, export, emision hasta el nivel de cert).

### Comparado con ArcanumPro
- Su facturador trackea; el nuestro ademas **emite el CAE real** integrado (WSFEv1),
  resuelve el numero solo, es idempotente y computa el aging en el server.

## [0.5.0] - 2026-07-08

### Agregado (inspirado en ArcanumPro, mejorado)
- **Multi-emisor por CUIT**: los datos fiscales del emisor (razon social, domicilio,
  condicion IVA, IIBB, inicio act., flag MiPyME) se guardan **en la DB por cada CUIT**
  y se editan desde la UI (Clientes -> Datos fiscales), en vez de un JSON estatico que
  obligue a redeployar. El PDF usa el encabezado del CUIT correcto. Fallback al emisor
  global por env. `GET/PUT /api/tenants/:cuit/emisor`.
- **Importar comprobante por QR** (`POST /api/comprobantes/importar`): decodifica el QR
  de ARCA, valida whitelist de emisores (`ARCANUM_EMISORES_PERMITIDOS`), dedup por CAE
  y **CONSTATA contra ARCA con WSCDC** (mejora sobre el dedup local: confirma que el
  comprobante es autentico). Se persiste con `origen='importado'`. UI en Comprobantes.

### Comparado con ArcanumPro
- Ellos: multi-emisor via emisores.json estatico (redeploy) + import por QR con dedup local.
- Nosotros: multi-emisor editable en DB + import con constatacion real en ARCA.

## [0.4.2] - 2026-07-08

### Corregido
- El **motor SOAP generico** ahora soporta SOAP 1.2: el passthrough
  `/api/ws/wsapoc/GetPublicacionAPOC` usa `<Credencial>` (namespace tempuri) en SOAP 1.2,
  igual que el modulo rico. Antes quedaba con el formato viejo (codigo 201). Verificado
  contra prod (codigo 0). SOAP 1.1 del resto de los servicios sin cambios (regresion OK).

## [0.4.1] - 2026-07-08

### Corregido
- **WSAPOC**: el request estaba mal formado (`<credencial>` en minuscula/sin namespace,
  SOAP 1.1), por lo que ARCA devolvia siempre codigo 201 "Object reference". Ahora usa
  `<tem:Credencial>` (namespace tempuri) en SOAP 1.2 y devuelve codigo 0 con los datos
  reales; parseo tolerante a namespaces. Verificado contra prod (201 -> 0).
  Gracias a francomeretta1-spec (PR #1). Se quitaron los console.log de diagnostico.

## [0.4.0] - 2026-07-04

### Agregado
- **WSFEXv1 (Factura E de exportacion)** promovido a modulo rico: `GET /api/wsfex/status`,
  `/ultimo-autorizado`, `/ultimo-id`, `/consultar`, y `POST /api/wsfex/comprobantes`
  (cliente del exterior, pais destino, moneda/cotizacion, incoterms, permisos, items[]).
  Persiste el comprobante (tipo 19) y lo integra al PDF/consulta. FEXDummy verificado
  contra prod OK.
- **WSMTXCA (factura con detalle)** promovido a modulo rico: `GET /api/wsmtxca/status`,
  `/ultimo-autorizado`, `/alicuotas`, `/consultar`, y `POST /api/wsmtxca/comprobantes`
  con **IVA por item** (arrayItems + arraySubtotalesIVA) y CondicionIVAReceptorId.
  dummy verificado contra prod OK; el envelope JAX-WS llega y ARCA responde el negocio.
- Presets de ambos en el Generador y rutas en OpenAPI.

### Nota
- La emision de WSFEX/WSMTXCA requiere asociar el certificado a esos servicios en el
  Administrador de Relaciones (boton "Como activar"). El plumbing (WSAA + envelope +
  parseo) esta verificado; la emision fiscal no se probo para no generar comprobantes reales.

## [0.3.17] - 2026-07-04

### Cambiado
- Gris de reposo de los campos a #eef0f3 (sutil pero visible sobre las tarjetas
  blancas). Verificado: input/select computan #eef0f3 (antes el bug los dejaba blancos).

## [0.3.16] - 2026-07-04

### Corregido
- El fondo gris de reposo no se aplicaba a los input/select: una regla base posterior
  (`input,select,textarea{background:var(--panel)}`) lo pisaba con blanco (y ademas
  mataba la flecha del select por usar el shorthand `background`). Se cambio a
  `background-color:var(--field-rest)`.
- El gris de reposo ahora es el tono del fondo (`var(--bg)`), mas suave; al enfocar
  sigue pasando al celeste. Se restauro la flecha de los `<select>`.

## [0.3.15] - 2026-07-04

### Cambiado
- El gris de reposo de los campos se hizo mas visible (#e4e6ea en claro,
  rgba blanco .08 en oscuro); antes era casi imperceptible sobre la tarjeta.

## [0.3.14] - 2026-07-04

### Cambiado
- Campos de formulario: por defecto en gris muy claro (`--field-rest`, con variante
  para modo oscuro) para diferenciarlos del fondo; al enfocarlos pasan al celeste
  (`--field-bg`) con el borde azul suave.

## [0.3.13] - 2026-07-04

### Cambiado
- Webhooks: los eventos ahora vienen **destildados** por defecto (el usuario elige
  cuales suscribir). Se valida que haya al menos uno seleccionado al crear.

## [0.3.12] - 2026-07-04

### Cambiado
- Webhooks: el multi-select nativo de Eventos (que se veia "todo pintado" porque las
  opciones venian todas seleccionadas) se reemplazo por una lista de checkboxes,
  consistente entre navegadores y sobre el fondo celeste.

## [0.3.11] - 2026-07-04

### Corregido
- Multi-select de Eventos (Webhooks): las opciones se veian blancas sobre el campo
  celeste. Ahora son transparentes (muestran el celeste) con las seleccionadas en azul.

## [0.3.10] - 2026-07-04

### Cambiado
- Todos los campos para completar (input, textarea, select) ahora tienen fondo
  celeste claro (`--field-bg`) con borde azul suave, para diferenciarlos del resto.
  Adaptado a modo claro y oscuro.

## [0.3.9] - 2026-07-04

### Corregido
- El `index.html` (que lleva todo el JS/CSS inline) ahora se sirve con
  `Cache-Control: no-cache, must-revalidate`, para que el navegador nunca quede con
  un bundle viejo cacheado tras un update (causaba UI rara/lenta hasta un hard-refresh).

### Performance (0.3.8)
- Feedback instantaneo al cambiar de vista: `go()` limpia y muestra "Cargando..." al
  instante en vez de dejar el contenido anterior hasta que responde el fetch.

## [0.3.7] - 2026-07-04

### Corregido
- **Contraste en hover:** el design system pintaba de azul el fondo de cualquier
  boton en hover pero no cambiaba el texto, dejando gris/oscuro sobre azul (visible
  en la barra de navegacion). Ahora el nav en hover va azul + texto blanco, y los
  botones secundarios usan un hover claro y legible.
- **Performance:** se quito el `backdrop-filter: blur(8px)` del header sticky, que
  forzaba repintado en cada scroll y hacia sentir la interfaz lenta/pesada.

## [0.3.6] - 2026-07-04

### Corregido
- Login: el toggle de mostrar/ocultar contrasena usaba clases sin estilo
  (`.pass-wrap`/`.pass-toggle`), por lo que el icono se veia como un circulo negro
  y se desacomodaba al clickear. Ahora usa `.pwwrap`/`.eye` (icono line, posicion
  fija dentro del campo), como el resto de los campos de clave de la app.

## [0.3.5] - 2026-07-04

### Corregido / Agregado
- **Moneda extranjera** en WSFEv1, ahora correcta de punta a punta:
  - `CanMisMonExt` (RG 5616) se envia cuando la moneda no es PES ('S'=paga en la
    misma moneda, 'N'=paga en pesos; via `canMisMonExt` o `pagaEnMonedaExtranjera`).
  - Validacion: `cotizacion` obligatoria y > 0 si la moneda no es PES.
  - QR: la moneda y la cotizacion se toman del comprobante real (antes `ctz` estaba
    fijo en 1 y la moneda no se leia; ambos bugs corregidos).
  - PDF: importes en la moneda emitida (DOL, etc.), con linea de cotizacion,
    equivalente en pesos y leyenda "Pagadero en la moneda de emision" (si CanMisMonExt=S).
  - Se persisten `cotizacion` y `canMisMonExt`.

## [0.3.4] - 2026-07-04

### Cambiado
- Isologo ARCA oficial (paths vectoriales reales) embebido en el PDF, en negro,
  reemplazando el wordmark tipografico. `public/arca-logo.svg` actualizado al vector real.

## [0.3.3] - 2026-07-04

### Agregado
- Isologo institucional de ARCA como asset vectorial (`public/arca-logo.svg`).
- PDF: el pie usa el wordmark ARCA en el gris institucional (#4d4d4d) con el tagline
  "Agencia de Recaudacion y Control Aduanero" en dos lineas, como el logo oficial.

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
