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
}

/**
 * Emite un comprobante y obtiene su CAE. Valida importes, soporta comprobantes
 * asociados (NC/ND), reintenta ante token vencido, es idempotente (idempotencyKey)
 * y persiste el resultado en la tabla comprobantes.
 * Si no se pasa `numero`, lo calcula como ultimo autorizado + 1.
 */
async function authorizeInvoice(cuit, inv) {
  const c = normalizeCuit(cuit);
  const idem = inv.idempotencyKey || null;

  // Idempotencia: si ya emitimos con esta clave, devolvemos el resultado guardado.
  if (idem) {
    const prev = await db.query('SELECT raw FROM comprobantes WHERE idempotency_key = $1', [idem]);
    if (prev.rows.length) return { ...prev.rows[0].raw, idempotente: true };
  }

  validarImportes(inv);

  const ptoVta = parseInt(inv.puntoVenta, 10);
  const tipoCbte = parseInt(inv.tipoComprobante, 10);
  const concepto = parseInt(inv.concepto ?? 1, 10);

  return withTokenRetry(c, SERVICE, config.env, () => emitir(c, inv, { ptoVta, tipoCbte, concepto, idem }));
}

async function emitir(cuit, inv, { ptoVta, tipoCbte, concepto, idem }) {
  let numero = inv.numero;
  if (!numero) {
    const last = await lastAuthorized(cuit, ptoVta, tipoCbte);
    numero = last.ultimoNumero + 1;
  }
  numero = parseInt(numero, 10);

  const cbteFecha = inv.fecha ? fmtDate(inv.fecha) : todayYmd();

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
    '<ar:FECAEDetRequest><ar:FECAEDetalle>' +
    `<ar:Concepto>${concepto}</ar:Concepto>` +
    `<ar:DocTipo>${parseInt(inv.tipoDocReceptor ?? 99, 10)}</ar:DocTipo>` +
    `<ar:DocNro>${normalizeCuit(inv.nroDocReceptor ?? 0) || 0}</ar:DocNro>` +
    `<ar:CbteDesde>${numero}</ar:CbteDesde>` +
    `<ar:CbteHasta>${numero}</ar:CbteHasta>` +
    `<ar:CbteFecha>${cbteFecha}</ar:CbteFecha>` +
    `<ar:ImpTotal>${fmtMoney(inv.importeTotal)}</ar:ImpTotal>` +
    `<ar:ImpTotConc>${fmtMoney(inv.importeNoGravado)}</ar:ImpTotConc>` +
    `<ar:ImpNeto>${fmtMoney(inv.importeNeto)}</ar:ImpNeto>` +
    `<ar:ImpOpEx>${fmtMoney(inv.importeExento)}</ar:ImpOpEx>` +
    `<ar:ImpTrib>${fmtMoney(inv.importeTributos)}</ar:ImpTrib>` +
    `<ar:ImpIVA>${fmtMoney(inv.importeIva)}</ar:ImpIVA>` +
    serviceDates +
    `<ar:MonId>${escapeXml(inv.moneda || 'PES')}</ar:MonId>` +
    `<ar:MonCotiz>${fmtMoney(inv.cotizacion ?? 1)}</ar:MonCotiz>` +
    buildCbtesAsoc(inv.comprobantesAsociados) +
    buildTributos(inv.tributos) +
    buildAlicuotas(inv.alicuotasIva) +
    '</ar:FECAEDetalle></ar:FECAEDetRequest>';

  const cabecera =
    '<ar:FeCAECabRequest>' +
    '<ar:CantReg>1</ar:CantReg>' +
    `<ar:PtoVta>${ptoVta}</ar:PtoVta>` +
    `<ar:CbteTipo>${tipoCbte}</ar:CbteTipo>` +
    '</ar:FeCAECabRequest>';

  const inner = (await auth(cuit)) + `<ar:FeCAEReq>${cabecera}${detalle}</ar:FeCAEReq>`;
  const result = await call('FECAESolicitar', inner);

  const topErrors = collectErrors(result);
  const det = result?.FeDetResp?.FECAEDetResponse;
  const detalleResp = Array.isArray(det) ? det[0] : det;
  const obs = detalleResp?.Observaciones?.Obs;
  const observaciones = obs ? (Array.isArray(obs) ? obs : [obs]).map((o) => ({ code: o.Code, message: o.Msg })) : [];

  const resultado = detalleResp?.Resultado || result?.FeCabResp?.Resultado;
  const aprobado = resultado === 'A';

  const out = {
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
    importeTotal: Number(inv.importeTotal || 0),
    docTipo: parseInt(inv.tipoDocReceptor ?? 99, 10),
    docNro: String(normalizeCuit(inv.nroDocReceptor ?? 0) || 0),
    observaciones,
    errores: topErrors,
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

module.exports = {
  dummy,
  lastAuthorized,
  authorizeInvoice,
  consultar,
  getParams,
  PARAMS,
};
