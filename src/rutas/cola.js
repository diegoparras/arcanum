'use strict';

// Cola de emision (contingencia):
//   GET  /api/cola?cuit&estado        cualquier rol, con scope por CUIT
//   GET  /api/cola/:id
//   POST /api/cola/:id/reintentar     { fechaHoy? }  operador+ con ese CUIT
//   POST /api/cola/:id/cancelar       operador+ con ese CUIT
//
// Y emitirOEncolar(): la emision WSFEv1 con `contingencia: true` encola si ARCA no responde.

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed, scopedRequiresCuit } = require('../auth/permisos');
const { esIndisponibilidad } = require('../services/contingencia');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

/**
 * Emite; si ARCA no responde y el pedido vino con contingencia, lo deja en la cola (202).
 * Un rechazo o un error del pedido nunca se encola. Devuelve { status, body }.
 */
async function emitirOEncolar(cuit, inv, { contingencia = false, usuario = null, origen = 'api' } = {}, deps = {}) {
  const wsfev1 = deps.wsfev1 || require('../services/wsfev1');
  const cola = deps.cola || require('../services/colaEmision').servicio();
  // Con contingencia la clave se fija ANTES del primer intento: asi ese intento anota el vuelo
  // con la misma clave que despues usa la cola, y el reintento adopta el CAE si ARCA ya lo dio.
  if (contingencia && !inv.idempotencyKey) inv = { ...inv, idempotencyKey: require('../services/colaEmision').nuevaClave() };
  // Reintento del cliente con una clave que ya esta en la cola: se devuelve el estado real, nunca
  // se emite por fuera de la cola (podria salir un segundo CAE).
  if (inv.idempotencyKey && cola.porClave) {
    const ya = await cola.porClave(require('../auth/tenants').normalizeCuit(cuit), inv.idempotencyKey);
    if (ya) {
      if (ya.estado === 'emitido') return { status: 200, body: { ok: true, comprobante: ya.resultado, desdeCola: ya.id } };
      if (ya.estado === 'rechazado') return { status: 422, body: { ok: false, comprobante: ya.resultado || { aprobado: false }, error: ya.ultimo_error || 'Rechazado', desdeCola: ya.id } };
      if (ya.estado === 'cancelado') throw Object.assign(new Error(`Ese comprobante se canceló en la cola (item ${ya.id}): usá otra idempotencyKey para emitirlo de nuevo`), { httpStatus: 409 });
      return { status: 202, body: { ok: true, encolado: true, mensaje: 'Ya está en la cola.', cola: { id: ya.id, estado: ya.estado, idempotencyKey: ya.idempotency_key } } };
    }
  }
  try {
    const result = await wsfev1.authorizeInvoice(cuit, inv);
    return { status: result.aprobado ? 200 : 422, body: { ok: !!result.aprobado, comprobante: result } };
  } catch (e) {
    if (!contingencia || !esIndisponibilidad(e)) throw e;
    const item = await cola.encolar(cuit, inv, { numeroIntentado: e.numeroIntentado || null, usuario, origen });
    return {
      status: 202,
      body: {
        ok: true,
        encolado: true,
        mensaje: 'ARCA no responde: el comprobante quedó en la cola y sale solo cuando vuelva.',
        cola: { id: item.id, estado: item.estado, idempotencyKey: item.idempotency_key },
      },
    };
  }
}

function crearRutas({ cola } = {}) {
  const servicio = () => cola || require('../services/colaEmision').servicio();

  return async function manejar(req, res, url, seg, principal) {
    if (seg[0] !== 'api' || seg[1] !== 'cola') return false;
    req._op = 'cola';
    if (req.method === 'GET' && !seg[2]) {
      const q = url.searchParams;
      let lista = await servicio().listar({ cuit: q.get('cuit') || undefined, estado: q.get('estado') || undefined });
      if (scopedRequiresCuit(principal)) lista = lista.filter((x) => principal.cuitAllow.includes(x.cuit));
      return json(res, 200, { ok: true, cola: lista });
    }
    if (!/^\d+$/.test(String(seg[2] || ''))) return false;
    const item = await servicio().obtener(Number(seg[2]));
    if (!item) throw Object.assign(new Error('No existe ese item de la cola'), { httpStatus: 404 });
    assertCuitAllowed(principal, item.cuit);
    req._cuit = item.cuit;
    if (req.method === 'GET' && !seg[3]) return json(res, 200, { ok: true, item });
    if (req.method === 'POST' && (seg[3] === 'reintentar' || seg[3] === 'cancelar') && !seg[4]) {
      requireRole(principal, 'superadmin', 'admin', 'operador');
      if (seg[3] === 'cancelar') return json(res, 200, { ok: true, item: await servicio().cancelar(item.id) });
      const b = await readJsonBody(req);
      return json(res, 200, { ok: true, item: await servicio().reintentar(item.id, { fechaHoy: b.fechaHoy === true }) });
    }
    return false;
  };
}

module.exports = { emitirOEncolar, crearRutas };
