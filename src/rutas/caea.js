'use strict';

// CAEA (opcional por CUIT):
//   GET  /api/caea/:cuit              config, codigos CAEA y pendientes de informar
//   PUT  /api/caea/:cuit/config       { activo, puntoVenta, minutosEspera }  admin+
//   POST /api/caea/:cuit/solicitar    pide/recupera los CAEA de la quincena y la proxima  operador+
//   POST /api/caea/:cuit/informar     informa lo emitido con CAEA y los "sin movimiento"  operador+

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed } = require('../auth/permisos');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function crearRutas({ caea, wsfev1 } = {}) {
  const servicio = () => caea || require('../services/caea').servicio();
  const ws = () => wsfev1 || require('../services/wsfev1');

  return async function manejar(req, res, url, seg, principal) {
    if (seg[0] !== 'api' || seg[1] !== 'caea') return false;
    const cuit = String(seg[2] || '').replace(/\D/g, '');
    if (cuit.length !== 11) return false;
    req._op = 'caea';
    req._cuit = cuit;
    assertCuitAllowed(principal, cuit);

    if (req.method === 'GET' && !seg[3]) return json(res, 200, { ok: true, caea: await servicio().estado(cuit) });

    if (req.method === 'PUT' && seg[3] === 'config' && !seg[4]) {
      requireRole(principal, 'superadmin', 'admin');
      const b = await readJsonBody(req);
      const activo = b.activo === true;
      const puntoVenta = b.puntoVenta != null ? parseInt(b.puntoVenta, 10) : null;
      const minutosEspera = Math.min(Math.max(parseInt(b.minutosEspera ?? 30, 10) || 30, 5), 24 * 60);
      if (activo) {
        if (!puntoVenta) throw err('Para prender CAEA hace falta el punto de venta CAEA', 400);
        let pvs;
        try {
          pvs = await ws().getParams(cuit, 'puntosVenta');
        } catch (e) {
          throw err(`No se pudo validar el punto de venta con ARCA: ${e.message}`, 503);
        }
        const pv = pvs.find((p) => Number(p.Nro) === puntoVenta);
        if (!pv) throw err(`ARCA no tiene el punto de venta ${puntoVenta} para este CUIT`, 400);
        if (!/CAEA/i.test(String(pv.EmisionTipo || ''))) throw err(`El punto de venta ${puntoVenta} es de tipo ${pv.EmisionTipo || '?'}: para contingencia tiene que ser de tipo CAEA`, 400);
        if (String(pv.Bloqueado || 'N').toUpperCase() === 'S') throw err(`El punto de venta ${puntoVenta} esta bloqueado en ARCA`, 400);
      }
      const config = await servicio().guardarConfig(cuit, { activo, puntoVenta, minutosEspera }, principal.username);
      return json(res, 200, { ok: true, config });
    }

    if (req.method === 'POST' && (seg[3] === 'solicitar' || seg[3] === 'informar') && !seg[4]) {
      requireRole(principal, 'superadmin', 'admin', 'operador');
      if (seg[3] === 'solicitar') return json(res, 200, { ok: true, quincenas: await servicio().asegurar(cuit) });
      const informe = await servicio().informarPendientes(cuit);
      const sinMovimiento = await servicio().informarSinMovimiento(cuit);
      return json(res, 200, { ok: true, informe, sinMovimiento });
    }
    return false;
  };
}

module.exports = { crearRutas };
