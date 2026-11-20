'use strict';

// Rutas de Monotributo:
//   GET /api/monotributo/categorias      topes vigentes cargados (cualquier rol)
//   PUT /api/monotributo/categorias      reemplaza los topes (superadmin)
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
    if (seg[0] !== 'api' || seg[1] !== 'monotributo' || !seg[2] || seg[3]) return false;
    req._op = 'monotributo';
    if (seg[2] === 'categorias') {
      if (req.method === 'GET') return json(res, 200, { ok: true, categorias: await servicio().categorias() });
      if (req.method === 'PUT') {
        requireRole(principal, 'superadmin');
        const b = await readJsonBody(req);
        return json(res, 200, { ok: true, categorias: await servicio().guardarCategorias(b, principal.username) });
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
