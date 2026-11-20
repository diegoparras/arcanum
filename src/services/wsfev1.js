'use strict';

// WSFEv1 — Factura Electronica nacional (comprobantes A/B/C/M, CAE).
// Mapea el SOAP de ARCA a funciones JS limpias. El router REST las expone.

const db = require('../db');
const webhooks = require('./webhooks');
const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { withTokenRetry } = require('../auth/recovery');
const { post, escapeXml, SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

const NS = 'http://ar.gov.afip.dif.FEV1/';
const SERVICE = 'wsfe';

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}
function fmtDate(d) {
  // Acepta 'YYYY-MM-DD' o Date; devuelve 'YYYYMMDD' que es lo que pide ARCA.
  if (!d) return null;
  const s = String(d);
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  throw new SoapError(`Fecha invalida: ${d} (use YYYY-MM-DD)`, 400);
}
function todayYmd() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function auth(cuit) {
  const ta = await getAccessTicket(cuit, SERVICE);
  return (
    '<ar:Auth>' +
    `<ar:Token>${ta.token}</ar:Token>` +
    `<ar:Sign>${ta.sign}</ar:Sign>` +
    `<ar:Cuit>${normalizeCuit(cuit)}</ar:Cuit>` +
    '</ar:Auth>'
  );
}

function envelope(inner) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">` +
    '<soapenv:Header/>' +
    `<soapenv:Body>${inner}</soapenv:Body>` +
    '</soapenv:Envelope>'
  );
}

async function call(method, innerBody) {
  const env = envelope(`<ar:${method}>${innerBody}</ar:${method}>`);
  const body = await post(config.endpoints.wsfev1, `${NS}${method}`, env);
  const resp = body?.[`${method}Response`]?.[`${method}Result`];
  if (resp === undefined) {
    throw new SoapError(`Respuesta inesperada de WSFEv1.${method}`, 502, { body });
  }
  return resp;
}

function collectErrors(result) {
  const errs = result?.Errors?.Err;
  if (!errs) return [];
  const arr = Array.isArray(errs) ? errs : [errs];
  return arr.map((e) => ({ code: e.Code, message: e.Msg }));
}

/** Chequeo de salud del servicio (sin auth). */
async function dummy() {
  const result = await call('FEDummy', '');
  return { appServer: result.AppServer, dbServer: result.DbServer, authServer: result.AuthServer };
}

/** Ultimo numero de comprobante autorizado para (ptoVta, tipoCbte). */
async function lastAuthorized(cuit, ptoVta, tipoCbte) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const inner =
      (await auth(cuit)) +
      `<ar:PtoVta>${parseInt(ptoVta, 10)}</ar:PtoVta>` +
      `<ar:CbteTipo>${parseInt(tipoCbte, 10)}</ar:CbteTipo>`;
    const result = await call('FECompUltimoAutorizado', inner);
    const errors = collectErrors(result);
    if (errors.length) throw new SoapError(errors[0].message, 422, { errors });
    return { puntoVenta: Number(result.PtoVta), tipoComprobante: Number(result.CbteTipo), ultimoNumero: Number(result.CbteNro) };
  });
}

function buildAlicuotas(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list
    .map(
      (a) =>
        '<ar:AlicIva>' +
        `<ar:Id>${parseInt(a.id, 10)}</ar:Id>` +
        `<ar:BaseImp>${fmtMoney(a.baseImponible)}</ar:BaseImp>` +
        `<ar:Importe>${fmtMoney(a.importe)}</ar:Importe>` +
        '</ar:AlicIva>',
    )
    .join('');
  return `<ar:Iva>${items}</ar:Iva>`;
}

function buildTributos(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list
    .map(
      (t) =>
        '<ar:Tributo>' +
        `<ar:Id>${parseInt(t.id, 10)}</ar:Id>` +
        (t.descripcion ? `<ar:Desc>${escapeXml(t.descripcion)}</ar:Desc>` : '') +
        `<ar:BaseImp>${fmtMoney(t.baseImponible)}</ar:BaseImp>` +
        `<ar:Alic>${fmtMoney(t.alicuota)}</ar:Alic>` +
        `<ar:Importe>${fmtMoney(t.importe)}</ar:Importe>` +
        '</ar:Tributo>',
    )
    .join('');
  return `<ar:Tributos>${items}</ar:Tributos>`;
}

// Comprobantes asociados: obligatorios en Notas de Credito/Debito.
function buildCbtesAsoc(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list
    .map(
      (a) =>
        '<ar:CbteAsoc>' +
        `<ar:Tipo>${parseInt(a.tipo, 10)}</ar:Tipo>` +
        `<ar:PtoVta>${parseInt(a.puntoVenta, 10)}</ar:PtoVta>` +
        `<ar:Nro>${parseInt(a.numero, 10)}</ar:Nro>` +
        (a.cuit ? `<ar:Cuit>${normalizeCuit(a.cuit)}</ar:Cuit>` : '') +
        (a.fecha ? `<ar:CbteFch>${fmtDate(a.fecha)}</ar:CbteFch>` : '') +
        '</ar:CbteAsoc>',
    )
    .join('');
  return `<ar:CbtesAsoc>${items}</ar:CbtesAsoc>`;
}

// Validacion previa: que los importes cierren antes de molestar a ARCA.
function validarImportes(inv) {
  const n = (x) => Number(x || 0);
  const neto = n(inv.importeNeto);
  const iva = n(inv.importeIva);
  const trib = n(inv.importeTributos);
  const exento = n(inv.importeExento);
  const noGrav = n(inv.importeNoGravado);
  const total = n(inv.importeTotal);
  const suma = +(neto + iva + trib + exento + noGrav).toFixed(2);
  if (Math.abs(suma - total) > 0.01) {
    throw new SoapError(
      `Los importes no cierran: neto+iva+tributos+exento+noGravado = ${suma} pero importeTotal = ${total.toFixed(2)}`,
      422,
    );
  }
  if (Array.isArray(inv.alicuotasIva) && inv.alicuotasIva.length) {
    const sumIva = +inv.alicuotasIva.reduce((a, x) => a + Number(x.importe || 0), 0).toFixed(2);
    if (Math.abs(sumIva - iva) > 0.01) {
      throw new SoapError(`La suma de IVA por alicuota (${sumIva}) no coincide con importeIva (${iva.toFixed(2)})`, 422);
    }
  }
  // Moneda extranjera: la cotizacion es obligatoria y > 0 (ARCA la valida).
  if (String(inv.moneda || 'PES') !== 'PES' && !(Number(inv.cotizacion) > 0)) {
    throw new SoapError('Para moneda extranjera hay que informar `cotizacion` (> 0). Consultala en /api/wsfev1/parametros/cotizacion.', 422);
  }
}

// RG 5866/2026: en ventas a consumidor final por importe total >= $10.000.000
// hay que identificar al comprador (DNI/CUIL/CDI). tipoDoc 99 = "sin identificar".
const UMBRAL_CF_IDENTIFICACION = Number(process.env.ARCANUM_UMBRAL_CF_ID || 10000000);
function validarIdentificacionConsumidorFinal(inv, tipoCbte) {
  const total = Number(inv.importeTotal || 0);
  if (total < UMBRAL_CF_IDENTIFICACION) return;
  // Aplica a comprobantes B (6/7/8) y C (11/12/13), tipicos a consumidor final.
  const esBoC = [6, 7, 8, 11, 12, 13].includes(tipoCbte);
  const esCF = Number(inv.condicionIvaReceptor) === 5 || esBoC;
  const docTipo = parseInt(inv.tipoDocReceptor ?? 99, 10);
  const docNro = normalizeCuit(inv.nroDocReceptor ?? 0) || '0';
  if (esCF && (docTipo === 99 || docNro === '0' || !docNro)) {
    throw new SoapError(
      `RG 5866: por ser >= $${UMBRAL_CF_IDENTIFICACION.toLocaleString('es-AR')} a consumidor final hay que identificar al comprador (DNI/CUIL/CDI). Pasá tipoDocReceptor (96=DNI, 86=CUIL, 87=CDI, 80=CUIT) y nroDocReceptor.`,
      422,
    );
  }
}

/**
 * Emite un comprobante y obtiene su CAE. Valida importes, soporta comprobantes
 * asociados (NC/ND), reintenta ante token vencido, es idempotente (idempotencyKey)
 * y persiste el resultado en la tabla comprobantes.
 * Si no se pasa `numero`, lo calcula como ultimo autorizado + 1.
 */
/** Comprobante ya emitido con esta clave de idempotencia, o null. */
async function previoIdempotente(idem) {
  if (!idem) return null;
  const prev = await db.query('SELECT raw FROM comprobantes WHERE idempotency_key = $1', [idem]);
  return prev.rows.length ? { ...prev.rows[0].raw, idempotente: true } : null;
}

async function authorizeInvoice(cuit, inv) {
  const c = normalizeCuit(cuit);
  const idem = inv.idempotencyKey || null;

  // Idempotencia: si ya emitimos con esta clave, devolvemos el resultado guardado.
  const previo = await previoIdempotente(idem);
  if (previo) return previo;

  validarImportes(inv);
  if (inv.pdf) require('./pdf').preferencias(inv.pdf); // validar ANTES de pedir el CAE

  const ptoVta = parseInt(inv.puntoVenta, 10);
  const tipoCbte = parseInt(inv.tipoComprobante, 10);
  const concepto = parseInt(inv.concepto ?? 1, 10);
  validarIdentificacionConsumidorFinal(inv, tipoCbte);

  // Lock por (cuit, entorno, ptoVta, tipoCbte): serializa la emision para que dos
  // requests no lean el mismo "ultimo autorizado" y colisionen el numero.
  return withTokenRetry(c, SERVICE, config.env, () =>
    db.withLock(`emit:wsfe:${c}:${config.env}:${ptoVta}:${tipoCbte}`, () => emitir(c, inv, { ptoVta, tipoCbte, concepto, idem })));
}

/**
 * Arma <FeCAEReq> de FECAESolicitar. Nombres y orden segun el WSDL real de WSFEv1
 * (test/wsfev1Xml.test.js lo valida contra test/fixtures/wsfev1.wsdl).
 */
function armarFeCAEReq(inv, { ptoVta, tipoCbte, concepto, numero, cbteFecha, caea = null, fchHsGen = null }) {
  // Para Servicios (concepto 2 o 3) ARCA exige fechas de servicio y vto de pago.
  let serviceDates = '';
  if (concepto === 2 || concepto === 3) {
    const fd = fmtDate(inv.fechaServicioDesde) || cbteFecha;
    const fh = fmtDate(inv.fechaServicioHasta) || cbteFecha;
    const fv = fmtDate(inv.fechaVtoPago) || cbteFecha;
    serviceDates =
      `<ar:FchServDesde>${fd}</ar:FchServDesde>` +
      `<ar:FchServHasta>${fh}</ar:FchServHasta>` +
      `<ar:FchVtoPago>${fv}</ar:FchVtoPago>`;
  }

  const detalle =
    `<ar:FeDetReq><ar:${caea ? 'FECAEADetRequest' : 'FECAEDetRequest'}>` +
    `<ar:Concepto>${concepto}</ar:Concepto>` +
    `<ar:DocTipo>${parseInt(inv.tipoDocReceptor ?? 99, 10)}</ar:DocTipo>` +
    `<ar:DocNro>${normalizeCuit(inv.nroDocReceptor ?? 0) || 0}</ar:DocNro>` +
    `<ar:CbteDesde>${numero}</ar:CbteDesde>` +
    `<ar:CbteHasta>${numero}</ar:CbteHasta>` +
    `<ar:CbteFch>${cbteFecha}</ar:CbteFch>` +
    `<ar:ImpTotal>${fmtMoney(inv.importeTotal)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${fmtMoney(inv.importeNoGravado)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${fmtMoney(inv.importeNeto)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${fmtMoney(inv.importeExento)}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${fmtMoney(inv.importeTributos)}</ar:ImpTrib>` +
    `<ar:ImpIVA>${fmtMoney(inv.importeIva)}</ar:ImpIVA>` +
    serviceDates +
    `<ar:MonId>${escapeXml(inv.moneda || 'PES')}</ar:MonId>` +
    `<ar:MonCotiz>${fmtMoney(inv.cotizacion ?? 1)}</ar:MonCotiz>` +
    // CanMisMonExt (RG 5616): obligatorio si la moneda no es PES. 'S' = el receptor
    // cancela en la misma moneda extranjera; 'N' = cancela en pesos.
    (String(inv.moneda || 'PES') !== 'PES'
      ? `<ar:CanMisMonExt>${(inv.canMisMonExt || (inv.pagaEnMonedaExtranjera ? 'S' : 'N')) === 'S' ? 'S' : 'N'}</ar:CanMisMonExt>`
      : '') +
    // Condicion IVA del receptor (RG 5616): obligatoria en WSFEv1 desde 2025.
    (inv.condicionIvaReceptor != null
      ? `<ar:CondicionIVAReceptorId>${parseInt(inv.condicionIvaReceptor, 10)}</ar:CondicionIVAReceptorId>`
      : '') +
    buildCbtesAsoc(inv.comprobantesAsociados) +
    buildTributos(inv.tributos) +
    buildAlicuotas(inv.alicuotasIva) +
    // CAEA (FECAEARegInformativo): FECAEADetRequest = FEDetRequest + CAEA + CbteFchHsGen.
    (caea ? `<ar:CAEA>${escapeXml(caea)}</ar:CAEA><ar:CbteFchHsGen>${escapeXml(fchHsGen || '')}</ar:CbteFchHsGen>` : '') +
    `</ar:${caea ? 'FECAEADetRequest' : 'FECAEDetRequest'}></ar:FeDetReq>`;

  const cabecera =
    '<ar:FeCabReq>' +
    '<ar:CantReg>1</ar:CantReg>' +
    `<ar:PtoVta>${ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${tipoCbte}</ar:CbteTipo>` +
    '</ar:FeCabReq>';

  const raiz = caea ? 'FeCAEARegInfReq' : 'FeCAEReq';
  return `<ar:${raiz}>${cabecera}${detalle}</ar:${raiz}>`;
}

async function emitir(cuit, inv, { ptoVta, tipoCbte, concepto, idem }) {
  // Re-chequeo de idempotencia YA DENTRO del lock: si un reintento llego mientras el
  // primer pedido seguia hablando con ARCA, espero al lock y devuelvo ese comprobante
  // en vez de emitir otro con el numero siguiente.
  const previo = await previoIdempotente(idem);
  if (previo) return previo;

  // Intento anterior con esta clave cuya respuesta no llego (timeout, corte, reinicio): se
  // resuelve ANTES de numerar. Si ARCA ya lo otorgo, se adopta; si no se puede saber, no se emite.
  const vuelos = require('./vuelo');
  const vrepo = vuelos.repoSql(db);
  if (idem) {
    const r = await vuelos.resolver(await vrepo.obtener(idem), { consultar });
    if (r.estado === 'adoptar') {
      const raw = await registrarAdoptado(cuit, r.consultado, inv, idem);
      await vrepo.borrar(idem);
      webhooks.emitir('comprobante_emitido', raw).catch(() => {});
      return { ...raw, idempotente: true };
    }
  }

  let numero = inv.numero;
  if (!numero) {
    const last = await lastAuthorized(cuit, ptoVta, tipoCbte);
    numero = last.ultimoNumero + 1;
  }
  numero = parseInt(numero, 10);

  const cbteFecha = inv.fecha ? fmtDate(inv.fecha) : todayYmd();

  const inner = (await auth(cuit)) + armarFeCAEReq(inv, { ptoVta, tipoCbte, concepto, numero, cbteFecha });
  // Anotar el vuelo ANTES de llamar: si Arcanum muere con el pedido en el aire, el proximo
  // intento con esta clave sabe que numero verificar.
  if (idem) {
    await vrepo.anotar(idem, {
      cuit, entorno: config.env, puntoVenta: ptoVta, tipoCbte, numero,
      importeTotal: Number(inv.importeTotal || 0), docNro: String(normalizeCuit(inv.nroDocReceptor ?? 0) || 0), fecha: cbteFecha,
    });
  }
  let result;
  try {
    result = await call('FECAESolicitar', inner);
  } catch (e) {
    // El pedido pudo haber llegado a ARCA: la cola consulta este numero antes de reintentar,
    // para no sacar dos CAE para la misma venta.
    e.numeroIntentado = numero;
    e.cbteFecha = cbteFecha;
    throw e; // el vuelo queda anotado: el proximo intento lo resuelve
  }
  // ARCA contesto (aprobado o rechazado): ya no hay duda sobre este intento.
  if (idem) await vrepo.borrar(idem).catch(() => {});

  const topErrors = collectErrors(result);
  const det = result?.FeDetResp?.FECAEDetResponse;
  const detalleResp = Array.isArray(det) ? det[0] : det;
  const obs = detalleResp?.Observaciones?.Obs;
  const observaciones = obs ? (Array.isArray(obs) ? obs : [obs]).map((o) => ({ code: o.Code, message: o.Msg })) : [];

  const resultado = detalleResp?.Resultado || result?.FeCabResp?.Resultado;
  const aprobado = resultado === 'A';

  const out = {
      // Modelo visual y nombre de archivo del PDF elegidos al facturar (ver services/pdf.js).
      pdf: inv.pdf ? require('./pdf').preferencias(inv.pdf) : undefined,
    aprobado,
    resultado, // 'A' aprobado, 'R' rechazado, 'P' parcial
    cae: detalleResp?.CAE || null,
    caeVencimiento: detalleResp?.CAEFchVto || null,
    puntoVenta: ptoVta,
    tipoComprobante: tipoCbte,
    numero,
    fecha: cbteFecha,
    cuit,
    moneda: inv.moneda || 'PES',
    cotizacion: Number(inv.cotizacion ?? 1),
    canMisMonExt: String(inv.moneda || 'PES') !== 'PES' ? ((inv.canMisMonExt || (inv.pagaEnMonedaExtranjera ? 'S' : 'N')) === 'S' ? 'S' : 'N') : null,
    importeTotal: Number(inv.importeTotal || 0),
    docTipo: parseInt(inv.tipoDocReceptor ?? 99, 10),
    docNro: String(normalizeCuit(inv.nroDocReceptor ?? 0) || 0),
    observaciones,
    errores: topErrors,
    // Discriminacion y datos para la representacion impresa (PDF legal).
    concepto,
    importeNeto: Number(inv.importeNeto || 0),
    importeIva: Number(inv.importeIva || 0),
    importeExento: Number(inv.importeExento || 0),
    importeNoGravado: Number(inv.importeNoGravado || 0),
    importeTributos: Number(inv.importeTributos || 0),
    alicuotasIva: Array.isArray(inv.alicuotasIva) ? inv.alicuotasIva : [],
    items: Array.isArray(inv.items) ? inv.items : [],
    condicionIvaReceptor: inv.condicionIvaReceptor != null ? parseInt(inv.condicionIvaReceptor, 10) : null,
    receptorNombre: inv.receptorNombre || inv.razonSocialReceptor || null,
    receptorDomicilio: inv.receptorDomicilio || null,
    condicionVenta: inv.condicionVenta || null,
    fechaServicioDesde: inv.fechaServicioDesde || null,
    fechaServicioHasta: inv.fechaServicioHasta || null,
    fechaVtoPago: inv.fechaVtoPago || null,
  };

  // Persistimos solo los aprobados (los rechazados quedan en el log de requests).
  if (aprobado) {
    try {
      await db.query(
        `INSERT INTO comprobantes
           (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
            importe_total, doc_tipo, doc_nro, idempotency_key, raw)
         VALUES ($1,$2,$3,$4,$5,$6, to_date($7,'YYYYMMDD'),$8, to_date($9,'YYYYMMDD'),
                 $10,$11,$12,$13,$14)
         ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
        [cuit, config.env, ptoVta, tipoCbte, numero, out.cae, out.caeVencimiento, resultado, cbteFecha,
         out.importeTotal, out.docTipo, out.docNro, idem, JSON.stringify(out)],
      );
    } catch (e) {
      console.error('[arcanum] no se pudo persistir el comprobante:', e.message);
    }
  }

  webhooks.emitir(aprobado ? 'comprobante_emitido' : 'comprobante_rechazado', out).catch(() => {});
  return out;
}

/**
 * Guarda en `comprobantes` uno que ARCA ya autorizo pero cuya respuesta no nos llego (corte
 * ambiguo): la cola lo ADOPTA en vez de emitir otro. Idempotente.
 */
async function registrarAdoptado(cuit, consultado, cuerpo, idem) {
  const c = normalizeCuit(cuit);
  // Ese numero ya esta registrado para OTRA venta: no se adopta (seria un CAE ajeno).
  const ya = await db.query(
    'SELECT idempotency_key FROM comprobantes WHERE cuit = $1 AND entorno = $2 AND punto_venta = $3 AND tipo_cbte = $4 AND numero = $5',
    [c, config.env, consultado.puntoVenta, consultado.tipoComprobante, consultado.numero]);
  if (ya.rows[0] && ya.rows[0].idempotency_key !== idem) {
    throw new SoapError(`El numero ${consultado.numero} ya esta registrado en Arcanum para otra venta: revisa antes de emitir`, 409);
  }
  const raw = {
    ...cuerpo,
    aprobado: true, resultado: 'A', adoptado: true, cuit: c,
    cae: consultado.cae, caeVencimiento: consultado.caeVencimiento,
    puntoVenta: consultado.puntoVenta, tipoComprobante: consultado.tipoComprobante, numero: consultado.numero,
    fecha: consultado.fecha, importeTotal: Number(consultado.importeTotal),
    docTipo: consultado.docTipo, docNro: consultado.docNro,
  };
  await db.query(
    `INSERT INTO comprobantes
       (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
        importe_total, doc_tipo, doc_nro, idempotency_key, raw)
     VALUES ($1,$2,$3,$4,$5,$6, to_date($7,'YYYYMMDD'),'A', to_date($8,'YYYYMMDD'),$9,$10,$11,$12,$13)
     ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
    [c, config.env, consultado.puntoVenta, consultado.tipoComprobante, consultado.numero, consultado.cae,
      consultado.caeVencimiento, consultado.fecha, raw.importeTotal, consultado.docTipo, consultado.docNro, idem, JSON.stringify(raw)]);
  return raw; // el aviso comprobante_emitido lo manda la cola (uno solo)
}

// --- CAEA (Codigo de Autorizacion Electronico Anticipado), ver services/caea.js ---
function caeaGet(r) {
  const g = r && r.ResultGet;
  if (!g || !g.CAEA) return null;
  return {
    caea: String(g.CAEA), periodo: Number(g.Periodo), orden: Number(g.Orden),
    vigDesde: String(g.FchVigDesde), vigHasta: String(g.FchVigHasta), topeInf: String(g.FchTopeInf),
  };
}

/** CAEA ya otorgado para (periodo, orden), o null si ARCA no tiene ninguno. */
async function caeaConsultar(cuit, periodo, orden) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const r = await call('FECAEAConsultar', (await auth(cuit)) + `<ar:Periodo>${parseInt(periodo, 10)}</ar:Periodo><ar:Orden>${parseInt(orden, 10)}</ar:Orden>`);
    return caeaGet(r);
  });
}

/** Pide el CAEA de (periodo, orden). Si ARCA no lo da (todavia no, ya existe, etc.) lanza 422. */
async function caeaSolicitar(cuit, periodo, orden) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const r = await call('FECAEASolicitar', (await auth(cuit)) + `<ar:Periodo>${parseInt(periodo, 10)}</ar:Periodo><ar:Orden>${parseInt(orden, 10)}</ar:Orden>`);
    const g = caeaGet(r);
    if (g) return g;
    const errors = collectErrors(r);
    throw new SoapError(errors.length ? errors.map((e) => `${e.code}: ${e.message}`).join('; ') : 'ARCA no otorgo el CAEA', 422, { errors });
  });
}

/** Informa a ARCA un comprobante emitido con CAEA (FECAEARegInformativo). */
async function caeaInformar(cuit, inv, { caea, numero, cbteFecha, fchHsGen }) {
  const ptoVta = parseInt(inv.puntoVenta, 10);
  const tipoCbte = parseInt(inv.tipoComprobante, 10);
  const concepto = parseInt(inv.concepto ?? 1, 10);
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const inner = (await auth(cuit)) + armarFeCAEReq(inv, { ptoVta, tipoCbte, concepto, numero, cbteFecha, caea, fchHsGen });
    const r = await call('FECAEARegInformativo', inner);
    const det = r?.FeDetResp?.FECAEADetResponse;
    const d = Array.isArray(det) ? det[0] : det;
    const obs = d?.Observaciones?.Obs;
    return {
      resultado: d?.Resultado || r?.FeCabResp?.Resultado || null,
      observaciones: obs ? (Array.isArray(obs) ? obs : [obs]).map((o) => ({ code: o.Code, message: o.Msg })) : [],
      errores: collectErrors(r),
    };
  });
}

/** Informa que un punto de venta no uso el CAEA (FECAEASinMovimientoInformar). */
async function caeaSinMovimiento(cuit, ptoVta, caea) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const r = await call('FECAEASinMovimientoInformar', (await auth(cuit)) + `<ar:PtoVta>${parseInt(ptoVta, 10)}</ar:PtoVta><ar:CAEA>${escapeXml(caea)}</ar:CAEA>`);
    return { resultado: r?.Resultado || null, errores: collectErrors(r) };
  });
}

/** Consulta un comprobante ya emitido (para reimprimir o verificar en ARCA). */
async function consultar(cuit, ptoVta, tipoCbte, numero) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, async () => {
    const inner =
      (await auth(cuit)) +
      '<ar:FeCompConsReq>' +
      `<ar:CbteTipo>${parseInt(tipoCbte, 10)}</ar:CbteTipo>` +
      `<ar:CbteNro>${parseInt(numero, 10)}</ar:CbteNro>` +
      `<ar:PtoVta>${parseInt(ptoVta, 10)}</ar:PtoVta>` +
      '</ar:FeCompConsReq>';
    const result = await call('FECompConsultar', inner);
    const errors = collectErrors(result);
    if (errors.length) throw new SoapError(errors[0].message, 422, { errors });
    const r = result?.ResultGet;
    if (!r) throw new SoapError('Comprobante no encontrado en ARCA', 404);
    return {
      puntoVenta: Number(r.PtoVta),
      tipoComprobante: Number(r.CbteTipo),
      numero: Number(r.CbteDesde),
      fecha: r.CbteFch,
      cae: r.CodAutorizacion,
      caeVencimiento: r.FchVto,
      resultado: r.Resultado,
      importeTotal: Number(r.ImpTotal),
      docTipo: Number(r.DocTipo),
      docNro: String(r.DocNro),
      moneda: r.MonId,
    };
  });
}

// --- Tablas de parametros (catalogos) ---
async function getParam(cuit, method, itemKey) {
  return withTokenRetry(normalizeCuit(cuit), SERVICE, config.env, () => _getParam(cuit, method, itemKey));
}
async function _getParam(cuit, method, itemKey) {
  const inner = await auth(cuit);
  const result = await call(method, inner);
  const errors = collectErrors(result);
  if (errors.length) throw new SoapError(errors[0].message, 422, { errors });
  const node = result?.ResultGet?.[itemKey];
  if (!node) return [];
  return Array.isArray(node) ? node : [node];
}

const PARAMS = {
  tiposComprobante: { method: 'FEParamGetTiposCbte', item: 'CbteTipo' },
  tiposDocumento: { method: 'FEParamGetTiposDoc', item: 'DocTipo' },
  tiposConcepto: { method: 'FEParamGetTiposConcepto', item: 'ConceptoTipo' },
  alicuotasIva: { method: 'FEParamGetTiposIva', item: 'IvaTipo' },
  monedas: { method: 'FEParamGetTiposMonedas', item: 'Moneda' },
  tiposTributo: { method: 'FEParamGetTiposTributos', item: 'TributoTipo' },
  puntosVenta: { method: 'FEParamGetPtosVenta', item: 'PtoVenta' },
};

async function getParams(cuit, name) {
  const p = PARAMS[name];
  if (!p) throw new SoapError(`Parametro desconocido: ${name}`, 404);
  return getParam(cuit, p.method, p.item);
}

/** Emite un lote de comprobantes; nunca corta el lote ante un rechazo. */
async function authorizeBatch(invoices) {
  const resultados = [];
  for (const inv of invoices) {
    try {
      if (!inv || !inv.cuit) throw new SoapError('Falta "cuit" en una fila del lote', 400);
      resultados.push(await authorizeInvoice(inv.cuit, inv));
    } catch (e) {
      resultados.push({ aprobado: false, cuit: inv && inv.cuit, error: e.message });
    }
  }
  const aprobados = resultados.filter((r) => r.aprobado).length;
  return { total: resultados.length, aprobados, rechazados: resultados.length - aprobados, resultados };
}

/** Parsea un CSV (header + filas) a un arreglo de comprobantes. */
function parseLoteCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(delim).map((h) => h.trim());
  const n = (x) => (x === '' || x === undefined ? undefined : Number(x));
  return lines.slice(1).map((line) => {
    const cols = line.split(delim);
    const o = {};
    headers.forEach((h, i) => (o[h] = (cols[i] || '').trim()));
    const inv = {
      cuit: o.cuit,
      puntoVenta: n(o.puntoVenta),
      tipoComprobante: n(o.tipoComprobante),
      concepto: n(o.concepto) || 1,
      tipoDocReceptor: n(o.tipoDocReceptor) || 99,
      nroDocReceptor: o.nroDocReceptor || '0',
      importeNeto: n(o.importeNeto) || 0,
      importeIva: n(o.importeIva) || 0,
      importeTotal: n(o.importeTotal) || 0,
      idempotencyKey: o.idempotencyKey || undefined,
      fecha: o.fecha || undefined,
    };
    if (o.alicuotaId && inv.importeIva) {
      inv.alicuotasIva = [{ id: n(o.alicuotaId), baseImponible: inv.importeNeto, importe: inv.importeIva }];
    }
    return inv;
  });
}

/** ¿Hay una emision en vuelo sin resolver para esta clave? (la cola no usa CAEA si la hay) */
async function hayVuelo(idem) {
  if (!idem) return false;
  return !!(await require('./vuelo').repoSql(db).obtener(idem));
}

module.exports = {
  armarFeCAEReq,
  registrarAdoptado,
  hayVuelo,
  caeaConsultar,
  caeaSolicitar,
  caeaInformar,
  caeaSinMovimiento,
  dummy,
  lastAuthorized,
  authorizeInvoice,
  authorizeBatch,
  parseLoteCsv,
  consultar,
  getParams,
  PARAMS,
  // Para la vista previa (services/vistaPrevia.js): mismas reglas que la emision real.
  validarImportes,
  validarIdentificacionConsumidorFinal,
  previoIdempotente,
  fmtDate,
  UMBRAL_CF_IDENTIFICACION,
};
