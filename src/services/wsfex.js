'use strict';

// WSFEXv1 — Factura Electronica de Exportacion (comprobante E, cod. 19).
// Moneda extranjera, sin IVA, con pais destino / cliente del exterior / incoterms.
// Mapea el SOAP de ARCA a funciones JS limpias. authStyle body-auth (<Auth>).

const db = require('../db');
const webhooks = require('./webhooks');
const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { withTokenRetry } = require('../auth/recovery');
const { post, escapeXml, SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

const NS = 'http://ar.gov.afip.dif.fexv1/';
const SERVICE = 'wsfex';
const CBTE_TIPO = 19; // Factura E de exportacion

function money(n) { return Number(n || 0).toFixed(2); }
function ymd(d) {
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
function envelope(inner) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">` +
    `<soapenv:Header/><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`
  );
}
async function authEl(cuit, extra = '') {
  const ta = await getAccessTicket(normalizeCuit(cuit), SERVICE);
  return (
    '<ar:Auth>' +
    `<ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign>` +
    `<ar:Cuit>${normalizeCuit(cuit)}</ar:Cuit>${extra}</ar:Auth>`
  );
}
async function post_(method, inner) {
  const body = await post(config.endpoints.wsfex, `${NS}${method}`, envelope(`<ar:${method}>${inner}</ar:${method}>`));
  const r = body?.[`${method}Response`]?.[`${method}Result`];
  if (r === undefined) throw new SoapError(`WSFEX no devolvio ${method}Result`, 502, { body });
  // FEXErr con codigo != 0 => error de negocio.
  const err = r.FEXErr;
  if (err && String(err.ErrCode) !== '0' && err.ErrCode !== undefined) {
    throw new SoapError(`WSFEX ${err.ErrCode}: ${err.ErrMsg}`, 422, { fexErr: err });
  }
  return r;
}

/** Estado del servicio (sin auth). */
async function dummy() {
  const body = await post(config.endpoints.wsfex, `${NS}FEXDummy`, envelope('<ar:FEXDummy/>'));
  const r = body?.FEXDummyResponse?.FEXDummyResult || {};
  return { appServer: r.AppServer, dbServer: r.DbServer, authServer: r.AuthServer };
}

/** Ultimo comprobante autorizado para un punto de venta (Factura E). */
async function lastAuthorized(cuit, ptoVta) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, async () => {
    const auth = await authEl(c, `<ar:Pto_venta>${parseInt(ptoVta, 10)}</ar:Pto_venta><ar:Cbte_Tipo>${CBTE_TIPO}</ar:Cbte_Tipo>`);
    const r = await post_('FEXGetLast_CMP', auth);
    return { ultimoNumero: parseInt(r.Cbte_nro || 0, 10), fecha: r.Fecha_cbte || null, puntoVenta: parseInt(ptoVta, 10) };
  });
}

/** Ultimo Id de request usado (se pide +1 para cada FEXAuthorize). */
async function lastId(cuit) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, async () => {
    const r = await post_('FEXGetLast_ID', await authEl(c));
    return parseInt(r.Id || 0, 10);
  });
}

/** Consulta un comprobante E ya emitido. */
async function consultar(cuit, ptoVta, numero) {
  const c = normalizeCuit(cuit);
  return withTokenRetry(c, SERVICE, config.env, async () => {
    const inner =
      (await authEl(c)) +
      `<ar:Cmp><ar:Cbte_tipo>${CBTE_TIPO}</ar:Cbte_tipo>` +
      `<ar:Punto_vta>${parseInt(ptoVta, 10)}</ar:Punto_vta>` +
      `<ar:Cbte_nro>${parseInt(numero, 10)}</ar:Cbte_nro></ar:Cmp>`;
    return post_('FEXGetCMP', inner);
  });
}

function buildItems(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) throw new SoapError('La factura E necesita al menos un item (items[])', 422);
  return (
    '<ar:Items>' +
    arr
      .map(
        (it) =>
          '<ar:Item>' +
          `<ar:Pro_codigo>${escapeXml(it.codigo || '')}</ar:Pro_codigo>` +
          `<ar:Pro_ds>${escapeXml(it.descripcion || it.desc || '')}</ar:Pro_ds>` +
          `<ar:Pro_qty>${money(it.cantidad ?? 1)}</ar:Pro_qty>` +
          `<ar:Pro_umed>${parseInt(it.unidadMedida ?? 7, 10)}</ar:Pro_umed>` +
          `<ar:Pro_precio_uni>${money(it.precioUnitario ?? it.total ?? 0)}</ar:Pro_precio_uni>` +
          `<ar:Pro_bonificacion>${money(it.bonificacion ?? 0)}</ar:Pro_bonificacion>` +
          `<ar:Pro_total_item>${money(it.total ?? it.subtotal ?? 0)}</ar:Pro_total_item>` +
          '</ar:Item>',
      )
      .join('') +
    '</ar:Items>'
  );
}

/**
 * Emite una Factura E de exportacion y obtiene el CAE.
 * inv: { puntoVenta, cliente, cuitPaisCliente, domicilioCliente, idImpositivo,
 *        paisDestino, tipoExportacion(1|2|3), moneda, cotizacion, incoterms, incotermsDesc,
 *        idioma(1|2|3), formaPago, permisoExistente('S'|'N'), permisos[], importeTotal,
 *        items[], obsComerciales, obs, fecha, idempotencyKey, numero? }
 */
async function authorize(cuit, inv) {
  const c = normalizeCuit(cuit);
  const idem = inv.idempotencyKey || null;
  if (idem) {
    const prev = await db.query('SELECT raw FROM comprobantes WHERE idempotency_key = $1', [idem]);
    if (prev.rows.length) return { ...prev.rows[0].raw, idempotente: true };
  }
  if (!inv.cliente) throw new SoapError('Falta `cliente` (razon social del cliente del exterior)', 422);
  if (!inv.paisDestino) throw new SoapError('Falta `paisDestino` (codigo de pais destino, ver FEXGetPARAM_DST_pais)', 422);
  const ptoVta = parseInt(inv.puntoVenta, 10);
  if (!ptoVta) throw new SoapError('Falta `puntoVenta`', 422);

  // Lock por punto de venta: serializa la emision (numeracion ultimo+1 sin carrera).
  return withTokenRetry(c, SERVICE, config.env, () => db.withLock(`emit:wsfex:${c}:${config.env}:${ptoVta}`, async () => {
    const numero = inv.numero ? parseInt(inv.numero, 10) : (await lastAuthorized(c, ptoVta)).ultimoNumero + 1;
    const id = inv.id ? parseInt(inv.id, 10) : (await lastId(c)) + 1;
    const permisos =
      inv.permisoExistente === 'S' && Array.isArray(inv.permisos) && inv.permisos.length
        ? '<ar:Permisos>' +
          inv.permisos
            .map((p) => `<ar:Permiso><ar:Id_permiso>${escapeXml(p.id)}</ar:Id_permiso><ar:Dst_merc>${parseInt(p.destino, 10)}</ar:Dst_merc></ar:Permiso>`)
            .join('') +
          '</ar:Permisos>'
        : '';

    const cmp =
      '<ar:Cmp>' +
      `<ar:Id>${id}</ar:Id>` +
      `<ar:Fecha_cbte>${inv.fecha ? ymd(inv.fecha) : todayYmd()}</ar:Fecha_cbte>` +
      `<ar:Cbte_Tipo>${CBTE_TIPO}</ar:Cbte_Tipo>` +
      `<ar:Punto_vta>${ptoVta}</ar:Punto_vta>` +
      `<ar:Cbte_nro>${numero}</ar:Cbte_nro>` +
      `<ar:Tipo_expo>${parseInt(inv.tipoExportacion ?? 1, 10)}</ar:Tipo_expo>` +
      `<ar:Permiso_existente>${inv.permisoExistente === 'S' ? 'S' : 'N'}</ar:Permiso_existente>` +
      permisos +
      `<ar:Dst_cmp>${parseInt(inv.paisDestino, 10)}</ar:Dst_cmp>` +
      `<ar:Cliente>${escapeXml(inv.cliente)}</ar:Cliente>` +
      `<ar:Cuit_pais_cliente>${escapeXml(inv.cuitPaisCliente || '0')}</ar:Cuit_pais_cliente>` +
      `<ar:Domicilio_cliente>${escapeXml(inv.domicilioCliente || '')}</ar:Domicilio_cliente>` +
      `<ar:Id_impositivo>${escapeXml(inv.idImpositivo || '')}</ar:Id_impositivo>` +
      `<ar:Moneda_Id>${escapeXml(inv.moneda || 'DOL')}</ar:Moneda_Id>` +
      `<ar:Moneda_ctz>${money(inv.cotizacion ?? 1)}</ar:Moneda_ctz>` +
      `<ar:Obs_comerciales>${escapeXml(inv.obsComerciales || '')}</ar:Obs_comerciales>` +
      `<ar:Imp_total>${money(inv.importeTotal)}</ar:Imp_total>` +
      `<ar:Obs>${escapeXml(inv.obs || '')}</ar:Obs>` +
      `<ar:Forma_pago>${escapeXml(inv.formaPago || '')}</ar:Forma_pago>` +
      `<ar:Incoterms>${escapeXml(inv.incoterms || '')}</ar:Incoterms>` +
      `<ar:Incoterms_Ds>${escapeXml(inv.incotermsDesc || '')}</ar:Incoterms_Ds>` +
      `<ar:Idioma_cbte>${parseInt(inv.idioma ?? 1, 10)}</ar:Idioma_cbte>` +
      buildItems(inv.items) +
      '</ar:Cmp>';

    const r = await post_('FEXAuthorize', (await authEl(c)) + cmp);
    const res = r.FEXResultAuth || r;
    const aprobado = res.Resultado === 'A';
    const out = {
      aprobado,
      resultado: res.Resultado || null,
      cae: res.Cae || null,
      caeVencimiento: res.Fch_venc_Cae || null,
      puntoVenta: ptoVta,
      tipoComprobante: CBTE_TIPO,
      numero,
      id,
      fecha: inv.fecha ? ymd(inv.fecha) : todayYmd(),
      cuit: c,
      moneda: inv.moneda || 'DOL',
      cotizacion: Number(inv.cotizacion ?? 1),
      importeTotal: Number(inv.importeTotal || 0),
      docTipo: 80,
      docNro: String(inv.cuitPaisCliente || '0'),
      cliente: inv.cliente,
      paisDestino: inv.paisDestino,
      incoterms: inv.incoterms || null,
      items: Array.isArray(inv.items) ? inv.items : [],
      observaciones: res.Motivos_Obs ? [{ message: res.Motivos_Obs }] : [],
      exportacion: true,
      receptorNombre: inv.cliente,
    };

    if (aprobado) {
      try {
        await db.query(
          `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
             importe_total, doc_tipo, doc_nro, idempotency_key, raw)
           VALUES ($1,$2,$3,$4,$5,$6, to_date($7,'YYYYMMDD'),$8, to_date($9,'YYYYMMDD'),$10,$11,$12,$13,$14)
           ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
          [c, config.env, ptoVta, CBTE_TIPO, numero, out.cae, out.caeVencimiento, out.resultado, out.fecha,
            out.importeTotal, out.docTipo, out.docNro, idem, JSON.stringify(out)],
        );
      } catch (e) {
        console.error('[arcanum] no se pudo persistir la Factura E:', e.message);
      }
    }
    webhooks.emitir(aprobado ? 'comprobante_emitido' : 'comprobante_rechazado', out).catch(() => {});
    return out;
  }));
}

module.exports = { dummy, lastAuthorized, lastId, consultar, authorize };
