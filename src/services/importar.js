'use strict';

// Importar un comprobante que NO emitimos nosotros (te lo mandaron).
// Se lee el QR de ARCA (RG 4892), que trae los datos estructurados y firmados por
// el emisor, y ADEMAS se CONSTATA contra ARCA con WSCDC: no alcanza con que el CAE
// no este duplicado, queremos que ARCA confirme que el comprobante es autentico.
//
// Flujo: QR -> datos -> whitelist de emisores -> dedup por CAE -> constatar en ARCA
//        -> persistir (origen='importado').

const db = require('../db');
const engine = require('../soap/engine');
const { config } = require('../config');
const { SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

/**
 * Decodifica el QR de ARCA. Acepta la URL completa
 * (https://www.afip.gob.ar/fe/qr/?p=BASE64) o directamente el base64.
 */
function parseQr(qr) {
  if (!qr || typeof qr !== 'string') throw new SoapError('Falta el contenido del QR', 400);
  let b64 = qr.trim();
  const m = b64.match(/[?&]p=([A-Za-z0-9+/=_-]+)/);
  if (m) b64 = m[1];
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  let json;
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new SoapError('El QR no es un QR de ARCA válido (no se pudo decodificar)', 422);
  }
  if (!json || !json.cuit || !json.codAut) {
    throw new SoapError('El QR no tiene los campos esperados (cuit / codAut)', 422);
  }
  return validarComprobante({
    cuitEmisor: String(json.cuit),
    puntoVenta: Number(json.ptoVta),
    tipoComprobante: Number(json.tipoCmp),
    numero: Number(json.nroCmp),
    fecha: String(json.fecha || '').replace(/-/g, ''), // YYYYMMDD
    importeTotal: Number(json.importe),
    moneda: json.moneda || 'PES',
    cotizacion: Number(json.ctz || 1),
    docTipo: Number(json.tipoDocRec) || 99,
    docNro: String(json.nroDocRec || 0),
    cae: String(json.codAut),
    tipoCodAut: json.tipoCodAut || 'E',
  });
}

/**
 * Formato estricto de un comprobante a importar (venga del QR o cargado a mano). Lo que no tiene
 * forma de dato de ARCA se rechaza con 422 y sin repetir el valor recibido en el mensaje: el CAE y
 * el CUIT se guardan y se muestran en el panel (auditoria 2026-11-26, A-06).
 */
function validarComprobante(d) {
  const mal = (campo) => { throw new SoapError(`El comprobante tiene ${campo} con formato inválido`, 422); };
  if (!/^\d{11}$/.test(String(d.cuitEmisor))) mal('un CUIT emisor (deben ser 11 dígitos)');
  if (!/^\d{14}$/.test(String(d.cae))) mal('un CAE/CAEA (deben ser 14 dígitos)');
  if (!/^\d{8}$/.test(String(d.fecha))) mal('una fecha (AAAA-MM-DD)');
  if (!/^\d{1,20}$/.test(String(d.docNro))) mal('un documento del receptor');
  for (const [k, campo] of [['puntoVenta', 'un punto de venta'], ['tipoComprobante', 'un tipo'], ['numero', 'un número']]) {
    if (!Number.isInteger(d[k]) || d[k] <= 0) mal(campo);
  }
  if (!Number.isFinite(d.importeTotal)) mal('un importe');
  if (!['E', 'A'].includes(d.tipoCodAut || 'E')) mal('un tipo de autorización (E o A)');
  if (!/^[A-Z0-9$]{1,4}$/.test(String(d.moneda || 'PES'))) mal('una moneda');
  return d;
}

/** Constata el comprobante contra ARCA (WSCDC). Devuelve { valido, resultado, observaciones }. */
async function constatar(cuitConsultante, d) {
  const params = {
    CmpReq: {
      CbteModo: d.tipoCodAut === 'A' ? 'CAEA' : 'CAE',
      CuitEmisor: normalizeCuit(d.cuitEmisor),
      PtoVta: d.puntoVenta,
      CbteTipo: d.tipoComprobante,
      CbteNro: d.numero,
      CbteFch: d.fecha,
      ImpTotal: Number(d.importeTotal).toFixed(2),
      CodAutorizacion: d.cae,
      DocTipoReceptor: d.docTipo,
      DocNroReceptor: d.docNro,
    },
  };
  const r = await engine.call('wscdc', 'ComprobanteConstatar', params, { cuit: normalizeCuit(cuitConsultante) });
  const res = (r && (r.ComprobanteConstatarResult || r.Result)) || r || {};
  const resultado = res.Resultado || null;
  const obs = res.Observaciones && res.Observaciones.Obs;
  const observaciones = obs
    ? (Array.isArray(obs) ? obs : [obs]).map((o) => ({ code: o.Code, message: o.Msg }))
    : [];
  return { valido: resultado === 'A', resultado, observaciones };
}

function emisoresPermitidos() {
  const raw = process.env.ARCANUM_EMISORES_PERMITIDOS || '';
  return raw
    .split(',')
    .map((s) => normalizeCuit(s.trim()))
    .filter(Boolean);
}

/**
 * Importa un comprobante ajeno.
 * @param {string} cuitConsultante CUIT con certificado (el que consulta/constata)
 * @param {object} input { qr } o los campos sueltos del comprobante
 */
async function importar(cuitConsultante, input = {}) {
  const consultante = normalizeCuit(cuitConsultante);
  if (!consultante) throw new SoapError('Falta el CUIT consultante (con certificado)', 400);

  const d = input.qr ? parseQr(input.qr) : validarComprobante({
    cuitEmisor: normalizeCuit(input.cuitEmisor),
    puntoVenta: Number(input.puntoVenta),
    tipoComprobante: Number(input.tipoComprobante),
    numero: Number(input.numero),
    fecha: String(input.fecha || '').replace(/-/g, ''),
    importeTotal: Number(input.importeTotal),
    moneda: input.moneda || 'PES',
    cotizacion: Number(input.cotizacion || 1),
    docTipo: Number(input.docTipo) || 99,
    docNro: String(input.docNro || 0),
    cae: String(input.cae || ''),
    tipoCodAut: input.tipoCodAut || 'E',
  });
  if (!d.cuitEmisor || !d.cae || !d.numero) {
    throw new SoapError('Faltan datos del comprobante (cuitEmisor, cae, número). Pasá `qr` o los campos.', 422);
  }

  // 1) Whitelist de emisores (opcional): bloquea comprobantes de emisores no habilitados.
  const permitidos = emisoresPermitidos();
  if (permitidos.length && !permitidos.includes(d.cuitEmisor)) {
    throw new SoapError(`El emisor ${d.cuitEmisor} no está en la lista de emisores habilitados`, 403);
  }

  // 2) Dedup por CAE (no re-ingresar el mismo comprobante).
  const dup = await db.query(
    'SELECT cuit, punto_venta, tipo_cbte, numero FROM comprobantes WHERE cae=$1 AND entorno=$2 LIMIT 1',
    [d.cae, config.env],
  );
  if (dup.rows.length) {
    throw new SoapError(`Comprobante ya ingresado (CAE ${d.cae} duplicado)`, 409, { existente: dup.rows[0] });
  }

  // 3) Constatacion contra ARCA (la mejora: no solo "no duplicado", sino "ARCA dice que existe").
  let constatacion = { valido: false, resultado: null, observaciones: [], consultado: false, motivo: null };
  try {
    const c = await constatar(consultante, d);
    constatacion = { ...c, consultado: true, motivo: null };
  } catch (e) {
    // Falla cerrado (auditoria 2026-11-26, M-09): si ARCA no pudo constatarlo, no se guarda. Antes se
    // importaba igual y quedaba como "Autorizado" sin que nadie lo hubiera validado.
    throw new SoapError(
      `No se pudo constatar el comprobante con ARCA, así que no se importó: ${e.message}. Probá de nuevo cuando ARCA responda, o revisá que el certificado tenga asociado WSCDC.`,
      503,
    );
  }
  if (constatacion.consultado && !constatacion.valido) {
    throw new SoapError(
      `ARCA NO valida este comprobante (resultado ${constatacion.resultado || 'R'}). Podría ser apócrifo o tener datos mal cargados.`,
      422,
      { constatacion },
    );
  }

  // 4) Persistir como importado, BAJO EL CUIT DEL CONSULTANTE (el que esta autorizado),
  //    no bajo el CUIT emisor que viene del QR (evita escribir en el tenant ajeno / IDOR).
  //    El emisor real queda como metadato en raw.
  const raw = {
    ...d,
    cuit: consultante,
    cuitEmisor: d.cuitEmisor,
    importado: true,
    constatacion,
    receptorNombre: input.receptorNombre || null,
    importeNeto: input.importeNeto != null ? Number(input.importeNeto) : null,
    importeIva: input.importeIva != null ? Number(input.importeIva) : null,
  };
  await db.query(
    `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
       importe_total, doc_tipo, doc_nro, raw, origen)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,'A', to_date($7,'YYYYMMDD'),$8,$9,$10,$11,'importado')
     ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
    [consultante, config.env, d.puntoVenta, d.tipoComprobante, d.numero, d.cae, d.fecha,
      d.importeTotal, d.docTipo, d.docNro, JSON.stringify(raw)],
  );

  return { ...d, cuitConsultante: consultante, origen: 'importado', constatacion };
}

module.exports = { importar, parseQr, constatar, validarComprobante };
