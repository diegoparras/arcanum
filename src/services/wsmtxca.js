'use strict';

// WSMTXCA — Factura Electronica con detalle (comprobantes A/B con items linea por
// linea, cada uno con su alicuota de IVA). SOAP JAX-WS: authRequest como primer
// elemento, parametros sin prefijo. Mapea a funciones JS limpias.

const db = require('../db');
const webhooks = require('./webhooks');
const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { withTokenRetry } = require('../auth/recovery');
const { post, escapeXml, SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

const NS = 'http://impl.service.wsmtxca.afip.gov.ar/service/';
const SERVICE = 'wsmtxca';

function money(n) { return Number(n || 0).toFixed(2); }
function isoDate(d) {
  if (!d) return null;
  const s = String(d);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  throw new SoapError(`Fecha invalida: ${d} (use YYYY-MM-DD)`, 400);
}
function todayIso() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Busca la primera aparicion de `key` en un objeto anidado (respuestas JAX-WS varian).
function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}
function asArray(x) { return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]; }

function envelope(inner) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS}">` +
    `<soapenv:Header/><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`
  );
}
async function authEl(cuit) {
  const ta = await getAccessTicket(normalizeCuit(cuit), SERVICE);
  return `<authRequest><token>${ta.token}</token><sign>${ta.sign}</sign><cuitRepresentada>${normalizeCuit(cuit)}</cuitRepresentada></authRequest>`;
}
async function callAuth(cuit, method, params = '') {
  const body = await post(config.endpoints.wsmtxca, `${NS}${method}`, envelope(`<ser:${method}>${await authEl(cuit)}${params}</ser:${method}>`));
  const resp = body?.[`${method}Response`] ?? body;
  const errs = asArray(deepFind(resp, 'codigoDescripcion') || deepFind(resp, 'arrayErrores'));
  const errMsg = errs.map((e) => (e && (e.descripcion || e.Msg)) || '').filter(Boolean).join(' | ');
  if (errMsg) throw new SoapError(`WSMTXCA rechazo: ${errMsg}`, 422, { resp });
  return resp;
}

/** Estado del servicio (sin auth). */
async function dummy() {
  const body = await post(config.endpoints.wsmtxca, `${NS}dummy`, envelope('<ser:dummy/>'));
  const r = body?.dummyResponse ?? body;
  return { appServer: deepFind(r, 'appserver'), dbServer: deepFind(r, 'dbserver'), authServer: deepFind(r, 'authserver') };
}

/** Ultimo comprobante autorizado para (puntoVenta, tipoComprobante). */
async function lastAuthorized(cuit, ptoVta, tipoCbte) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, async () => {
    const params =
      '<consultaUltimoComprobanteAutorizadoRequest>' +
      `<codigoTipoComprobante>${parseInt(tipoCbte, 10)}</codigoTipoComprobante>` +
      `<numeroPuntoVenta>${parseInt(ptoVta, 10)}</numeroPuntoVenta>` +
      '</consultaUltimoComprobanteAutorizadoRequest>';
    const r = await callAuth(c, 'consultarUltimoComprobanteAutorizado', params);
    return { ultimoNumero: parseInt(deepFind(r, 'numeroComprobante') || 0, 10), puntoVenta: parseInt(ptoVta, 10), tipoComprobante: parseInt(tipoCbte, 10) };
  });
}

/** Consulta un comprobante ya emitido (con su detalle). */
async function consultar(cuit, ptoVta, tipoCbte, numero) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, async () => {
    const params =
      '<consultaComprobanteRequest>' +
      `<codigoTipoComprobante>${parseInt(tipoCbte, 10)}</codigoTipoComprobante>` +
      `<numeroPuntoVenta>${parseInt(ptoVta, 10)}</numeroPuntoVenta>` +
      `<numeroComprobante>${parseInt(numero, 10)}</numeroComprobante>` +
      '</consultaComprobanteRequest>';
    return callAuth(c, 'consultarComprobante', params);
  });
}

/** Alicuotas de IVA vigentes (catalogo, util para armar los items). */
async function alicuotasIVA(cuit) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, () => callAuth(c, 'consultarAlicuotasIVA'));
}

function buildItems(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) throw new SoapError('WSMTXCA necesita al menos un item (items[])', 422);
  return (
    '<arrayItems>' +
    arr
      .map((it) => {
        const cond = it.codigoCondicionIVA ?? it.condicionIVA;
        if (cond === undefined) throw new SoapError('Cada item necesita `codigoCondicionIVA` (ej. 5=21%, 4=10.5%, 3=0%)', 422);
        return (
          '<item>' +
          (it.unidadesMtx != null ? `<unidadesMtx>${parseInt(it.unidadesMtx, 10)}</unidadesMtx>` : '') +
          (it.codigoMtx != null ? `<codigoMtx>${escapeXml(it.codigoMtx)}</codigoMtx>` : '') +
          `<codigo>${escapeXml(it.codigo || '')}</codigo>` +
          `<descripcion>${escapeXml(it.descripcion || it.desc || '')}</descripcion>` +
          `<cantidad>${money(it.cantidad ?? 1)}</cantidad>` +
          `<codigoUnidadMedida>${parseInt(it.codigoUnidadMedida ?? 7, 10)}</codigoUnidadMedida>` +
          `<precioUnitario>${money(it.precioUnitario ?? 0)}</precioUnitario>` +
          (it.importeBonificacion != null ? `<importeBonificacion>${money(it.importeBonificacion)}</importeBonificacion>` : '') +
          `<codigoCondicionIVA>${parseInt(cond, 10)}</codigoCondicionIVA>` +
          `<importeIVA>${money(it.importeIVA ?? 0)}</importeIVA>` +
          `<importeItem>${money(it.importeItem ?? it.subtotal ?? 0)}</importeItem>` +
          '</item>'
        );
      })
      .join('') +
    '</arrayItems>'
  );
}
function buildSubtotalesIVA(subs) {
  const arr = Array.isArray(subs) ? subs : [];
  if (!arr.length) return '';
  return (
    '<arraySubtotalesIVA>' +
    arr.map((s) => `<subtotalIVA><codigo>${parseInt(s.codigo ?? s.id, 10)}</codigo><importe>${money(s.importe)}</importe></subtotalIVA>`).join('') +
    '</arraySubtotalesIVA>'
  );
}

/**
 * Emite un comprobante con detalle (items con IVA por linea) y obtiene el CAE.
 * inv: { puntoVenta, tipoComprobante, concepto, tipoDocReceptor, nroDocReceptor,
 *        importeGravado, importeNoGravado, importeExento, importeSubtotal,
 *        importeOtrosTributos, importeTotal, moneda, cotizacion, condicionIvaReceptor,
 *        items[]{codigo,descripcion,cantidad,codigoUnidadMedida,precioUnitario,
 *                codigoCondicionIVA,importeIVA,importeItem}, subtotalesIVA[]{codigo,importe},
 *        fecha, fechaServicioDesde/Hasta, fechaVtoPago, idempotencyKey, numero? }
 */
async function authorize(cuit, inv) {
  const c = normalizeCuit(cuit);
  const idem = inv.idempotencyKey || null;
  if (idem) {
    const prev = await db.query('SELECT raw FROM comprobantes WHERE idempotency_key = $1', [idem]);
    if (prev.rows.length) return { ...prev.rows[0].raw, idempotente: true };
  }
  const ptoVta = parseInt(inv.puntoVenta, 10);
  const tipoCbte = parseInt(inv.tipoComprobante, 10);
  const concepto = parseInt(inv.concepto ?? 1, 10);
  if (!ptoVta || !tipoCbte) throw new SoapError('Faltan `puntoVenta` o `tipoComprobante`', 422);

  return withTokenRetry(c, SERVICE, config.env, async () => {
    const numero = inv.numero ? parseInt(inv.numero, 10) : (await lastAuthorized(c, ptoVta, tipoCbte)).ultimoNumero + 1;
    const fechaEmision = inv.fecha ? isoDate(inv.fecha) : todayIso();

    let serviceDates = '';
    if (concepto === 2 || concepto === 3) {
      serviceDates =
        `<fechaServicioDesde>${isoDate(inv.fechaServicioDesde) || fechaEmision}</fechaServicioDesde>` +
        `<fechaServicioHasta>${isoDate(inv.fechaServicioHasta) || fechaEmision}</fechaServicioHasta>` +
        `<fechaVencimientoPago>${isoDate(inv.fechaVtoPago) || fechaEmision}</fechaVencimientoPago>`;
    }

    const reqXml =
      '<comprobanteCAERequest>' +
      `<codigoTipoComprobante>${tipoCbte}</codigoTipoComprobante>` +
      `<numeroPuntoVenta>${ptoVta}</numeroPuntoVenta>` +
      `<numeroComprobante>${numero}</numeroComprobante>` +
      `<fechaEmision>${fechaEmision}</fechaEmision>` +
      `<codigoTipoDocumento>${parseInt(inv.tipoDocReceptor ?? 99, 10)}</codigoTipoDocumento>` +
      `<numeroDocumento>${normalizeCuit(inv.nroDocReceptor ?? 0) || 0}</numeroDocumento>` +
      `<importeGravado>${money(inv.importeGravado ?? inv.importeNeto)}</importeGravado>` +
      `<importeNoGravado>${money(inv.importeNoGravado)}</importeNoGravado>` +
      `<importeExento>${money(inv.importeExento)}</importeExento>` +
      `<importeSubtotal>${money(inv.importeSubtotal ?? inv.importeGravado ?? inv.importeNeto)}</importeSubtotal>` +
      `<importeOtrosTributos>${money(inv.importeOtrosTributos ?? inv.importeTributos)}</importeOtrosTributos>` +
      `<importeTotal>${money(inv.importeTotal)}</importeTotal>` +
      `<codigoMoneda>${escapeXml(inv.moneda || 'PES')}</codigoMoneda>` +
      `<cotizacionMoneda>${money(inv.cotizacion ?? 1)}</cotizacionMoneda>` +
      (inv.observaciones ? `<observaciones>${escapeXml(inv.observaciones)}</observaciones>` : '') +
      `<codigoConcepto>${concepto}</codigoConcepto>` +
      serviceDates +
      buildItems(inv.items) +
      buildSubtotalesIVA(inv.subtotalesIVA) +
      (inv.condicionIvaReceptor != null ? `<condicionIVAReceptorId>${parseInt(inv.condicionIvaReceptor, 10)}</condicionIVAReceptorId>` : '') +
      '</comprobanteCAERequest>';

    const r = await callAuth(c, 'autorizarComprobante', reqXml);
    const cae = deepFind(r, 'CAE') || deepFind(r, 'cae');
    const caeVto = deepFind(r, 'fechaVencimientoCAE') || deepFind(r, 'fechaVencimiento');
    const resultado = deepFind(r, 'resultado') || (cae ? 'A' : 'R');
    const aprobado = !!cae && resultado !== 'R';

    const out = {
      aprobado,
      resultado,
      cae: cae || null,
      caeVencimiento: caeVto || null,
      puntoVenta: ptoVta,
      tipoComprobante: tipoCbte,
      numero,
      concepto,
      fecha: fechaEmision.replace(/-/g, ''),
      cuit: c,
      moneda: inv.moneda || 'PES',
      cotizacion: Number(inv.cotizacion ?? 1),
      importeTotal: Number(inv.importeTotal || 0),
      importeNeto: Number(inv.importeGravado ?? inv.importeNeto ?? 0),
      // El IVA en wsmtxca va por items/subtotales; lo derivamos para el PDF/registro.
      importeIva: Number(inv.importeIva ?? (Array.isArray(inv.subtotalesIVA) ? inv.subtotalesIVA.reduce((a, s) => a + Number(s.importe || 0), 0) : 0)),
      alicuotasIva: Array.isArray(inv.subtotalesIVA) ? inv.subtotalesIVA.map((s) => ({ id: parseInt(s.codigo ?? s.id, 10), importe: Number(s.importe || 0) })) : [],
      importeExento: Number(inv.importeExento || 0),
      importeNoGravado: Number(inv.importeNoGravado || 0),
      importeTributos: Number(inv.importeOtrosTributos ?? inv.importeTributos ?? 0),
      condicionIvaReceptor: inv.condicionIvaReceptor != null ? parseInt(inv.condicionIvaReceptor, 10) : null,
      docTipo: parseInt(inv.tipoDocReceptor ?? 99, 10),
      docNro: String(normalizeCuit(inv.nroDocReceptor ?? 0) || 0),
      receptorNombre: inv.receptorNombre || null,
      items: (Array.isArray(inv.items) ? inv.items : []).map((it) => ({
        codigo: it.codigo,
        descripcion: it.descripcion || it.desc,
        cantidad: it.cantidad,
        unidadMedida: it.codigoUnidadMedida,
        precioUnitario: it.precioUnitario,
        subtotal: it.importeItem ?? it.subtotal,
      })),
      observaciones: asArray(deepFind(r, 'arrayObservaciones')).map((o) => ({ message: (o && (o.descripcion || o.Msg)) || '' })).filter((o) => o.message),
      conDetalle: true,
    };

    if (aprobado) {
      try {
        await db.query(
          `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
             importe_total, doc_tipo, doc_nro, idempotency_key, raw)
           VALUES ($1,$2,$3,$4,$5,$6, to_date($7,'YYYYMMDD'),$8, to_date($9,'YYYYMMDD'),$10,$11,$12,$13,$14)
           ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
          [c, config.env, ptoVta, tipoCbte, numero, out.cae, out.caeVencimiento, out.resultado, out.fecha,
            out.importeTotal, out.docTipo, out.docNro, idem, JSON.stringify(out)],
        );
      } catch (e) {
        console.error('[arcanum] no se pudo persistir el comprobante MTXCA:', e.message);
      }
    }
    webhooks.emitir(aprobado ? 'comprobante_emitido' : 'comprobante_rechazado', out).catch(() => {});
    return out;
  });
}

module.exports = { dummy, lastAuthorized, consultar, alicuotasIVA, authorize };
