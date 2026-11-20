# Arcanum ULTRA, fase 2 — que la facturación no se corte, sincronizar emitidos y backups

Fecha: 2026-11-20. Continúa `2026-11-19-arcanum-ultra-design.md` (fase 1, ya en 0.9.0).

## Intención

El contador no puede quedarse sin facturar porque ARCA se cae, ni enterarse tarde de que algo
se facturó por fuera de Arcanum, ni perder la base (certificados, comprobantes, claves) por
falta de un respaldo. Fase 2 = esas tres cosas.

Decisiones del usuario: cola de reintentos para todos; **CAEA opcional, apagado por defecto,
se prende por CUIT**; si está prendido, Arcanum pide el CAEA de cada quincena, lo usa solo
cuando ARCA no responde e informa todo solo (incluido "sin movimiento"), con avisos.

## Anti-objetivos

- Sacar **dos CAE para la misma venta** (reintento después de un corte ambiguo).
- Emitir un comprobante con una fecha que el usuario no eligió (re-fechar sin que lo pida).
- Dejar comprobantes CAEA **sin informar** pasada la fecha tope sin avisar a nadie.
- Un backup que no se puede restaurar, o que expone claves privadas en claro.

## Datos verificados contra el WSDL real de WSFEv1

`FECAEASolicitar(Periodo:int AAAAMM, Orden:short 1|2)` y `FECAEAConsultar(...)` → `FECAEAGet`
`{CAEA, Periodo, Orden, FchVigDesde, FchVigHasta, FchTopeInf, FchProceso, Observaciones}`.
`FECAEARegInformativo(FeCAEARegInfReq: {FeCabReq: FECabRequest, FeDetReq: [FEDetRequest + CAEA +
CbteFchHsGen]})`. `FECAEASinMovimientoInformar(PtoVta, CAEA)` y `FECAEASinMovimientoConsultar`.
Los puntos de venta traen `EmisionTipo` (CAE / CAEA) en `FEParamGetPtosVenta`.

## Diseño

### A. Cola de emisión (para todos)

- `POST /api/wsfev1/comprobantes` acepta `contingencia: true` (la UI lo manda por defecto, con
  un tilde). Sin el flag, todo igual que hoy.
- Si la emisión falla por **indisponibilidad** (red, timeout, 5xx, WSAA caído) y vino el flag:
  se guarda en `emision_cola` con su `idempotencyKey` (se genera si no vino) y la **fecha fijada
  al momento de encolar**, y se responde **202** `{ encolado: true, cola: {id, estado} }` +
  webhook `comprobante_encolado`. Un rechazo de ARCA (`Resultado R`) o un error de validación
  nunca se encolan: son finales.
- **Corte ambiguo**: si el pedido llegó a mandarse a ARCA, se guarda `numero_intentado`. Antes de
  reintentar, se consulta ese número en ARCA: si existe con el mismo importe total y documento
  del receptor, se **adopta ese CAE** (no se emite de nuevo).
- Procesador: cada minuto (daemon) y en el acto con `arca_restablecido`. Un ítem a la vez por
  (CUIT, punto de venta, tipo) con lock. Reintentos con espera creciente (1, 2, 5, 10, 30, 60 min).
- **Ventana de fecha**: ARCA acepta fechas hasta 5 días atrás (productos) o 10 (servicios). Si
  el ítem queda fuera, pasa a `requiere_humano`; la persona decide "emitir con fecha de hoy" o
  cancelar. Nunca se re-fecha solo.
- Estados: `pendiente | procesando | emitido | rechazado | requiere_humano | cancelado`.
- API: `GET /api/cola`, `GET /api/cola/:id`, `POST /api/cola/:id/reintentar` (`{fechaHoy?}`),
  `POST /api/cola/:id/cancelar`. MCP de solo lectura `cola_emision`.

### B. CAEA (opcional por CUIT)

- Config por CUIT (`caea_config`): activo, punto de venta CAEA (tiene que ser de tipo CAEA en
  ARCA; se valida con `FEParamGetPtosVenta`), minutos de espera antes de usar CAEA (def. 30).
- Daemon diario: para cada CUIT activo, **consulta** y si no existe **solicita** el CAEA de la
  quincena en curso y de la próxima (cuando ARCA lo permita; si dice que todavía no, se reintenta
  al otro día). Se guarda en `caea` con vigencia y fecha tope.
- Uso: un ítem de la cola de un CUIT con CAEA activo que lleva más de N minutos sin poder
  emitirse se emite **con CAEA**, en el punto de venta CAEA, numerado localmente (máximo entre
  lo local y el último conocido de ARCA, + 1, con lock), fecha y hora de generación guardadas.
  Se persiste en `comprobantes` con `modo CAEA` e `informado = false`, y el PDF lleva el QR con
  `tipoCodAut = A`.
- Informar: cuando ARCA responde, `FECAEARegInformativo` de cada comprobante CAEA pendiente.
  Vencida la vigencia, `FECAEASinMovimientoInformar` para cada punto de venta CAEA sin uso.
- Avisos: `caea_obtenido`, `caea_informe_pendiente` (a 2 días de la fecha tope con algo sin
  informar) y `caea_informe_error`.
- API: `GET/PUT /api/caea/:cuit/config`, `GET /api/caea/:cuit` (códigos y pendientes),
  `POST /api/caea/:cuit/solicitar`, `POST /api/caea/:cuit/informar`.

### C. Sincronizar emitidos con ARCA (FECompConsultar)

- `POST /api/wsfev1/sincronizar {cuit}` y daemon diario. Por cada punto de venta CAE no bloqueado
  y cada tipo usual: último autorizado en ARCA contra último local; trae los que faltan con
  `FECompConsultar` y los guarda en `comprobantes` con `origen = 'arca'` (emitidos por fuera).
- Primera vez: hacia atrás desde el último, hasta 90 días (`ARCANUM_SYNC_DIAS`). Tope de 500
  consultas por corrida; la próxima sigue donde quedó.
- Reporte: cuántos se trajeron por punto de venta, y diferencias (comprobante local cuyo CAE o
  importe no coincide con ARCA). Webhook `emitidos_por_fuera` cuando aparecen nuevos.

### D. Backups

- Backup **desde la app** (la imagen no trae `pg_dump`): todas las tablas salvo logs y cachés
  (`requests`, `service_status`, `access_tickets`), en JSON por tabla, gzip, cifrado AES-256-GCM
  con una clave derivada de la master key (HKDF) o `ARCANUM_BACKUP_KEY` si se define. Cabecera
  con versión, tablas, cantidades y SHA-256 del contenido.
- Diario a `ARCANUM_BACKUP_HORA` (3, hora argentina) en `/data/backups`, retiene
  `ARCANUM_BACKUP_RETENER` (14). Webhook `backup_creado` / `backup_fallo`.
- UI (superadmin): lista, "Crear ahora", descargar, y **aviso de master key**: muestra la huella
  (8 hex del SHA-256) y pide confirmar "la guardé fuera del servidor"; hasta entonces, banner.
- Restaurar: `node src/tools/restaurar-backup.js <archivo>` muestra qué hay (simulacro) y con
  `--confirmar` reemplaza los datos en una transacción. Falla limpio si la clave no coincide.

## Fuera de alcance

Copias a S3 u otro destino (queda el webhook y la descarga), emisión CAEA para WSFEX/MTXCA.

## Al criterio de quien construye

Tipos "usuales" a sincronizar (A, B, C, M y sus NC/ND), formato exacto de archivo de backup,
textos de UI.
