'use strict';

// Controles de acceso compartidos por las rutas REST y el servidor MCP.
// Roles: superadmin | admin | operador | lectura. Las claves de API tienen los mismos
// roles (menos superadmin) y, opcionalmente, una lista de CUITs permitidos.

const { normalizeCuit } = require('./tenants');

function requireRole(principal, ...roles) {
  if (!roles.includes(principal.role)) {
    throw Object.assign(new Error(`Requiere rol: ${roles.join(' o ')}`), { httpStatus: 403 });
  }
}

// Scoping por CUIT: admin/superadmin y la clave maestra ven todo. Un usuario o una
// clave con cuit_allow solo puede operar esos CUITs (cierra el IDOR multi-tenant).
// Sin cuit_allow (default) = todos, para el modelo "un contador, todos sus CUITs".
function assertCuitAllowed(principal, cuit) {
  if (['superadmin', 'admin'].includes(principal.role)) return;
  const allow = principal.cuitAllow;
  if (!allow || !allow.length) return;
  const c = normalizeCuit(cuit);
  if (!c || !allow.includes(c)) throw Object.assign(new Error('No autorizado para ese CUIT'), { httpStatus: 403 });
}

function scopedRequiresCuit(principal) {
  return !['superadmin', 'admin'].includes(principal.role) && !!(principal.cuitAllow && principal.cuitAllow.length);
}

// Solo lectura, fallando cerrado: un usuario o clave con rol "lectura" no puede hacer
// nada que no sea GET/HEAD en la API REST. Asi no hay que acordarse de poner el chequeo
// en cada ruta de escritura (emision, passthrough generico /api/ws, configuracion...).
// Excepcion explicita (lista cerrada): POST que solo calculan y no escriben nada.
// POST que solo consultan (no emiten ni guardan nada): los puede usar el rol lectura.
//  - vista-previa: valida un comprobante sin emitirlo.
//  - constatacion: WSCDC + apocrifos de una lista; devuelve el resultado y no lo guarda (la
//    constatacion de los recibidos de Mis Comprobantes, que si guarda, es otra ruta y sigue
//    exigiendo operador). Es lo que usa Factorum para verificar facturas.
const POST_SOLO_LECTURA = new Set(['/api/wsfev1/comprobantes/vista-previa', '/api/constatacion']);

function assertPuedeEscribir(principal, method, pathname = '') {
  if (principal.role !== 'lectura' || method === 'GET' || method === 'HEAD') return;
  if (method === 'POST' && POST_SOLO_LECTURA.has(pathname)) return;
  throw Object.assign(new Error('Acceso de solo lectura: este usuario o clave no puede emitir ni modificar nada.'), { httpStatus: 403 });
}

module.exports = { requireRole, assertCuitAllowed, scopedRequiresCuit, assertPuedeEscribir, POST_SOLO_LECTURA };
