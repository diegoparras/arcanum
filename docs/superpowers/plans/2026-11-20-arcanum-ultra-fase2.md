# Arcanum ULTRA, fase 2: cola de emisión, CAEA, sincronización de emitidos y backups — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la facturación no se corte cuando ARCA no responde (cola con recuperación segura y CAEA opcional), traer lo emitido por fuera de Arcanum y respaldar la base con backups cifrados restaurables.

**Architecture:** Servicios puros con dependencias inyectadas (como `misComprobantes.crear`), SQL aislado en un repo por servicio, rutas en `src/rutas/*.js` enganchadas en `server.js`, tareas de fondo en `daemon.js`. La E2E corre contra un **stub de WSAA + WSFEv1** en Docker (no hay certificado de homologación y nunca se prueba contra ARCA real).

**Tech Stack:** Node 22 nativo, `pg`, `node:test`, `zlib`, `crypto` (AES-256-GCM, HKDF), vanilla JS en `public/index.html`.

**Spec:** `arcanum/docs/superpowers/specs/2026-11-20-arcanum-ultra-fase2-design.md`

## Global Constraints

- Nunca dos CAE para la misma venta: un reintento tras un corte ambiguo consulta primero el número intentado.
- Nunca re-fechar sin pedido explícito (`fechaHoy: true` de una persona).
- CAEA apagado por defecto; se prende por CUIT. Comprobantes CAEA siempre se informan o se avisa antes de `FchTopeInf`.
- Ventana de fecha de ARCA: 5 días (concepto 1, productos), 10 días (2 y 3, servicios).
- Backups cifrados (AES-256-GCM, clave HKDF de la master key o `ARCANUM_BACKUP_KEY`); nunca claves en claro.
- Nombres y orden de todo XML nuevo validados contra `test/fixtures/wsfev1.wsdl`.
- Sin emojis; ojito en contraseñas; textos en castellano rioplatense; versión final 0.10.0.
- Docker solo por WSL. Las pruebas jamás tocan ARCA real (endpoints por variable apuntando al stub).

## Review Focus

1. ARCA responde lento, el CAE se otorgó pero la respuesta no llegó: el reintento adopta ese CAE, no saca otro.
2. Arcanum se reinicia con ítems en `procesando`: vuelven a `pendiente` al arrancar, sin duplicar.
3. Ítem encolado hace 6 días (productos): queda `requiere_humano`, no se emite con otra fecha.
4. CAEA vencido con comprobantes sin informar y ARCA caído hasta la fecha tope: aviso `caea_informe_pendiente`.
5. Restaurar un backup con otra master key: error claro, base intacta.

---

### Task 1: Clasificar indisponibilidad y marcar el número intentado

**Files:** Modify `src/soap/client.js`, `src/services/wsfev1.js`. Create `src/services/contingencia.js`. Test `test/contingencia.test.js`.

**Interfaces — Produces:**
- `SoapError.extra.tipo`: `'conexion' | 'timeout' | 'http' | 'fault'` (puesto por `post`), `extra.status` en `'http'`.
- `esIndisponibilidad(e) -> boolean`: `conexion`, `timeout`, `http` con status ≥ 500, o `fault` cuyo texto matchea `/no disponible|unavailable|temporalmente|timeout|time out/i`. Validaciones (400/422) y `Resultado R` nunca.
- En `wsfev1.emitir`, si `call('FECAESolicitar')` lanza, el error lleva `e.numeroIntentado = numero` y `e.cbteFecha`.

- [ ] Tests: `timeout es indisponibilidad`, `conexion rechazada lo es`, `http 503 lo es y 400 no`, `fault NullReference no lo es, fault "servicio no disponible" si`, `validacion 422 no`. Run `node --test test/contingencia.test.js` → FAIL → implementar → PASS. Commit `feat(cola): clasificar indisponibilidad de ARCA`.

### Task 2: Servicio de cola (`src/services/colaEmision.js`)

**Migración** `emision_cola(id serial PK, cuit, entorno, idempotency_key UNIQUE NOT NULL, cuerpo jsonb, fecha date, concepto int, estado, intentos int default 0, proximo_intento_at timestamptz, numero_intentado int, ultimo_error text, resultado jsonb, modo text default 'CAE', creado_at, actualizado_at, creado_por, origen)` + índice `(estado, proximo_intento_at)`.

**Interfaces — Produces** (`crear({repo, wsfev1, webhooks, ahora})` + `servicio()`):
- `ESPERAS_MIN = [1, 2, 5, 10, 30, 60]`; `proximoIntento(intentos, ahora) -> Date`.
- `fueraDeVentana(fechaYmd, concepto, hoy) -> boolean` (5 / 10 días).
- `coincide(consultado, cuerpo) -> boolean`: mismo `importeTotal` (±0.01) y mismo `docNro`.
- `encolar(cuit, inv, {numeroIntentado, cbteFecha, usuario, origen}) -> item`: fija `fecha` (la del pedido o hoy, AAAAMMDD) dentro del cuerpo, genera `idempotencyKey` si falta (`cola-<hex>`); si ya existe un ítem con esa clave, lo devuelve.
- `procesar(id) -> item`: toma con lock; si `numero_intentado` → `wsfev1.consultar`; si existe y `coincide` → `emitido` adoptando el CAE (persiste en `comprobantes` vía `wsfev1.registrarAdoptado`); si fuera de ventana → `requiere_humano`; si no → `authorizeInvoice`; indisponible → `pendiente` con backoff y nuevo `numero_intentado`; rechazo → `rechazado`. Webhooks `comprobante_emitido|comprobante_rechazado|cola_requiere_humano`.
- `procesarPendientes()`, `listar({cuit, estado})`, `obtener(id)`, `reintentar(id, {fechaHoy})`, `cancelar(id)`, `reencolarProcesando()` (arranque).
- `wsfev1.registrarAdoptado(cuit, consultado, cuerpo, idem)`: inserta en `comprobantes` el comprobante consultado (idempotente).

- [ ] Tests (dobles): `corte ambiguo adopta el CAE existente sin emitir`, `numero intentado que no coincide emite de nuevo`, `fuera de ventana pasa a requiere_humano sin emitir`, `fechaHoy re-fecha solo a pedido`, `indisponible reprograma con espera creciente`, `rechazo es final`, `encolar con la misma clave no duplica`, `procesando vuelve a pendiente al arrancar`. FAIL → implementar → PASS. Commit `feat(cola): cola de emision con recuperacion segura`.

### Task 3: Cola conectada (API, daemon, MCP, UI)

**Files:** `src/server.js` (POST comprobantes), create `src/rutas/cola.js`, `src/daemon.js`, `src/mcp/herramientas.js`, `public/index.html`, `openapi.yaml`, eventos en `webhooks.js`/`mailer.js` (`comprobante_encolado`, `cola_requiere_humano`).

- POST `/api/wsfev1/comprobantes` con `contingencia: true` (o header `X-Arcanum-Contingencia: 1`): indisponibilidad → `encolar` → **202** `{ok:true, encolado:true, cola}`.
- `GET /api/cola?cuit&estado`, `GET /api/cola/:id`, `POST /api/cola/:id/reintentar` (`{fechaHoy}`), `POST /api/cola/:id/cancelar` (operador+ con scope de CUIT).
- Daemon: `procesarPendientes` cada minuto y en la transición a `arca_restablecido`; `reencolarProcesando` en el arranque.
- MCP `cola_emision({cuit?, estado?})` (solo lectura). Lista: 14 herramientas.
- UI: tilde "Si ARCA no responde, dejarlo en cola" (marcado) en Emitir; nueva pestaña **Contingencia** con la cola (estado, intentos, próximo intento, error, botones Reintentar / Emitir con fecha de hoy / Cancelar).

- [ ] Tests: `test/colaRutas.test.js` (lectura 403 en reintentar, scope por CUIT, 202 al encolar con un `wsfev1` doble que lanza timeout), MCP lista 14. FAIL → implementar → PASS (`npm test`, `npm run lint`). Commit `feat(cola): API, daemon, MCP y pestana Contingencia`.

### Task 4: CAEA — servicio (`src/services/caea.js`)

**Migraciones:** `caea_config(cuit PK, activo bool, punto_venta int, minutos_espera int default 30, actualizado_at, actualizado_por)`, `caea(id serial, cuit, entorno, periodo int, orden int, caea text, vig_desde date, vig_hasta date, tope_inf date, obtenido_at, UNIQUE(cuit, entorno, periodo, orden))`, `caea_sin_mov(caea_id, punto_venta, informado_at, resultado jsonb, PK(caea_id, punto_venta))`; `comprobantes` usa `raw.modo='CAEA'`, `raw.informado`, `raw.fchHsGen`.

**Interfaces — Produces** (`crear({repo, wsfev1, webhooks, ahora})`):
- `quincena(fecha) -> {periodo: AAAAMM, orden: 1|2}`; `quincenasAPedir(hoy) -> [actual, proxima]`.
- `wsfev1.armarFeCAEReq(inv, {..., caea, fchHsGen})`: con `caea` arma `<FeCAEARegInfReq>` con `FECAEADetRequest` (+ `CAEA`, `CbteFchHsGen`); validado contra el WSDL (tipo `FECAEARequest`).
- `wsfev1.caeaSolicitar(cuit, periodo, orden)`, `caeaConsultar(...)`, `caeaInformar(cuit, inv, {caea, numero, cbteFecha, fchHsGen})`, `caeaSinMovimiento(cuit, ptoVta, caea)`.
- `asegurar(cuit) -> caea[]`: consulta y si no existe solicita las dos quincenas; "todavía no" no es error.
- `emitirConCaea(cuit, item) -> out`: punto de venta CAEA de la config, número = max(local, último conocido) + 1 con lock, `fchHsGen` = ahora; guarda en `comprobantes` (modo CAEA, informado false). Error si no hay CAEA vigente.
- `informarPendientes(cuit)`, `informarSinMovimiento(cuit)`, `avisos(cuit, hoy)` (`caea_informe_pendiente` a ≤ 2 días del tope).
- `pdf.js`: `tipoCodAut: 'A'` y `codAut` = CAEA cuando `raw.modo === 'CAEA'`.

- [ ] Tests: `quincena 15 y 16 de noviembre`, `quincenas a pedir cruzan el mes`, `FeCAEARegInfReq respeta el WSDL`, `asegurar consulta antes de solicitar`, `emitirConCaea numera sobre el maximo local`, `sin CAEA vigente es error`, `informar marca informado`, `aviso a dos dias del tope`, `QR del PDF con tipoCodAut A`. FAIL → implementar → PASS. Commit `feat(caea): CAEA opcional por CUIT`.

### Task 5: CAEA conectado

- Cola: un ítem de un CUIT con CAEA activo, indisponible por más de `minutos_espera` desde `creado_at` → `emitirConCaea` (estado `emitido`, `modo = 'CAEA'`).
- Daemon: `asegurar` diario; `informarPendientes` + `informarSinMovimiento` cada 15 min si ARCA responde; `avisos` diario. Eventos `caea_obtenido`, `caea_informe_pendiente`, `caea_informe_error`.
- API `src/rutas/caea.js`: `GET/PUT /api/caea/:cuit/config` (admin+; valida que el punto de venta sea `EmisionTipo` CAEA con `FEParamGetPtosVenta`), `GET /api/caea/:cuit`, `POST /api/caea/:cuit/solicitar`, `POST /api/caea/:cuit/informar`.
- UI: en Contingencia, tarjeta CAEA por CUIT (activar, punto de venta, minutos, códigos vigentes, pendientes de informar, fechas tope).

- [ ] Tests: `cola usa CAEA pasados los minutos de espera`, `cola no usa CAEA si esta apagado`, rutas con permisos. FAIL → implementar → PASS. Commit `feat(caea): cola, daemon, API y UI`.

### Task 6: Sincronizar emitidos (`src/services/syncEmitidos.js`)

**Interfaces — Produces:**
- `TIPOS_USUALES = [1,2,3,6,7,8,11,12,13,51,52,53]`.
- `planificar({ultimoArca, ultimoLocal, tope}) -> {desde, hasta}` (sube desde `ultimoLocal + 1`; si no hay local, baja desde `ultimoArca` hasta cortar por fecha).
- `sincronizar(cuit, {dias = ARCANUM_SYNC_DIAS (90), tope = 500, deps}) -> {traidos, porPuntoVenta, diferencias, pendiente}`: puntos de venta CAE no bloqueados, `lastAuthorized`, `consultar`, inserta con `origen = 'arca'`; compara CAE/importe de los locales que existen en ARCA; webhook `emitidos_por_fuera` si `traidos > 0`.
- `POST /api/wsfev1/sincronizar {cuit}` (operador+), daemon diario, botón en Comprobantes.

- [ ] Tests: `trae los que faltan desde el ultimo local`, `primera vez corta por fecha`, `respeta el tope y deja pendiente`, `detecta diferencia de CAE`, `ignora puntos de venta CAEA y bloqueados`. FAIL → implementar → PASS. Commit `feat(sync): emitidos por fuera de Arcanum`.

### Task 7: Backups (`src/services/backup.js`, `src/tools/restaurar-backup.js`)

**Interfaces — Produces:**
- `TABLAS_EXCLUIDAS = ['requests', 'service_status', 'access_tickets']`.
- `clave() -> Buffer` (HKDF-SHA256 de la master key, info `arcanum-backup-v1`, o `ARCANUM_BACKUP_KEY` hex).
- `empaquetar(tablas: {nombre: filas[]}, meta) -> Buffer` y `desempaquetar(buf) -> {meta, tablas}`: formato `ARCBAK1\n` + JSON de cabecera (versión, fecha, tablas, cantidades, sha256) + `iv|tag|cifrado(gzip(json))`. Clave equivocada o manipulado → error 422 "no se pudo descifrar".
- `crear() -> {archivo, bytes, tablas}` (a `/data/backups`), `listar()`, `ruta(nombre)` (sin path traversal), `podar(retener = ARCANUM_BACKUP_RETENER 14)`.
- `restaurar(buf, {confirmar}) -> resumen` (simulacro sin `confirmar`; con `confirmar`, en una transacción: `TRUNCATE ... CASCADE` de las tablas del backup e `INSERT` respetando columnas existentes).
- `huellaMasterKey()` (8 hex del SHA-256), setting `master_key_respaldada_at`.
- Rutas superadmin: `GET /api/backups`, `POST /api/backups`, `GET /api/backups/:nombre`, `GET/POST /api/sistema/master-key`. Daemon diario `ARCANUM_BACKUP_HORA` (3). Eventos `backup_creado`, `backup_fallo`.
- UI: menú **Backups** (superadmin) con lista, Crear ahora, Descargar, y aviso de master key con huella y confirmación; banner en Panel hasta confirmar.

- [ ] Tests: `ida y vuelta conserva tablas y filas`, `otra clave da 422`, `un byte cambiado da 422`, `podar deja los N mas nuevos`, `ruta rechaza ../`, `huella estable`, `restaurar sin confirmar no escribe` (repo doble). FAIL → implementar → PASS. Commit `feat(backup): backups cifrados y restauracion`.

### Task 8: Stub de ARCA, E2E, docs y versión 0.10.0

- `test/arca-stub/servidor.js`: WSAA (`loginCms` devuelve un TA válido 12 h) y WSFEv1 (`FECompUltimoAutorizado`, `FECAESolicitar`, `FECompConsultar`, `FEParamGetPtosVenta`, `FECAEASolicitar/Consultar/RegInformativo/SinMovimientoInformar`, `FEDummy`) en memoria, con modos `caido`, `lento` (otorga el CAE y no responde a tiempo) y `ok` por `POST /_modo`.
- `config.js`: `ARCANUM_ENDPOINT_WSAA` / `ARCANUM_ENDPOINT_WSFEV1` pisan los de homo (solo para pruebas; documentado así).
- E2E en WSL (scratch override): tenant de prueba con par clave/cert autofirmado importado; caído → 202 en cola; `ok` → emitido; `lento` → al volver, adopta el mismo CAE (un solo comprobante); ítem viejo → `requiere_humano`; CAEA: asegurar, emitir con CAEA en caída, informar al volver; sync trae comprobantes creados directo en el stub; backup → borrar una fila → restaurar → vuelve; restaurar con otra clave falla.
- README, DESPLIEGUE, CHANGELOG, OpenAPI, `package.json` 0.10.0. Revisión final (subagente) y push.

- [ ] E2E PASS con evidencia; `npm test` y `npm run lint` limpios. Commit `release: Arcanum 0.10.0`.
