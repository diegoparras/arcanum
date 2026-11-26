'use strict';

// Rutas de Monotributo:
//   GET /api/monotributo/categorias      topes vigentes cargados (cualquier rol)
//   PUT /api/monotributo/categorias      reemplaza los topes (superadmin): { topes } o { csv } de la plantilla
//   GET /api/monotributo/categorias/plantilla.csv   los topes cargados como CSV para editar e importar
//   GET /api/monotributo/:cuit           uso de la categoria en los ultimos 12 meses (?categoria=A..K)

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed } = require('../auth/permisos');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function crearRutas({ mono } = {}) {
  const servicio = () => mono || require('../services/monotributo');

  return async function manejar(req, res, url, seg, principal) {
    if (seg[0] !== 'api' || seg[1] !== 'monotributo' || !seg[2]) return false;
    req._op = 'monotributo';
    if (seg[2] === 'categorias' && seg[3] === 'plantilla.csv' && !seg[4] && req.method === 'GET') {
      const csv = servicio().plantillaCsv(await servicio().categorias());
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="topes-monotributo.csv"', 'Cache-Control': 'no-store' });
      res.end(`﻿${csv}`);
      return true;
    }
    if (seg[3]) return false;
    if (seg[2] === 'categorias') {
      if (req.method === 'GET') return json(res, 200, { ok: true, categorias: await servicio().categorias() });
      if (req.method === 'PUT') {
        requireRole(principal, 'superadmin');
        const b = await readJsonBody(req);
        // Desde la plantilla: { csv, vigencia, fuente }. Por JSON: { topes, vigencia, fuente }.
        const datos = typeof b.csv === 'string'
          ? { topes: servicio().topesDesdeCsv(b.csv), vigencia: b.vigencia, fuente: b.fuente }
          : b;
        return json(res, 200, { ok: true, categorias: await servicio().guardarCategorias(datos, principal.username) });
      }
      return false;
    }
    if (req.method !== 'GET') return false;
    const cuit = String(seg[2]).replace(/\D/g, '');
    if (cuit.length !== 11) return false;
    req._cuit = cuit;
    assertCuitAllowed(principal, cuit);
    const cat = url.searchParams.get('categoria');
    if (cat && !/^[A-Ka-k]$/.test(cat)) throw Object.assign(new Error('categoria: una letra de la A a la K'), { httpStatus: 400 });
    const opts = cat ? { categoria: cat.toUpperCase() } : {};
    return json(res, 200, { ok: true, monotributo: await servicio().topes(cuit, opts) });
  };
}

module.exports = { crearRutas };
