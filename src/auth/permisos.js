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

/**
 * Lista de CUITs permitidos al dar de alta una clave o un usuario (auditoria 2026-11-26, M-10).
 * Ausente o vacia: sin limite (null). Con algun elemento que no sea un CUIT de 11 digitos: 400.
 * Antes un CUIT mal tipeado se descartaba en silencio y la credencial quedaba con acceso a todos.
 */
function listaCuits(v, campo = 'cuits') {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw Object.assign(new Error(`"${campo}" tiene que ser una lista de CUITs`), { httpStatus: 400 });
  const out = [];
  for (const c of v) {
    const n = normalizeCuit(c);
    if (!/^\d{11}$/.test(n)) {
      throw Object.assign(new Error(`CUIT inválido en "${campo}": ${String(c).slice(0, 20)} (tienen que ser 11 dígitos)`), { httpStatus: 400 });
    }
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : null;
}

/** Admin y superadmin ven todos los CUITs: una lista para ellos no se aplicaria. */
function sinCuitsParaAdmin(rol, cuits) {
  if (cuits && ['admin', 'superadmin'].includes(rol)) {
    throw Object.assign(new Error('El rol admin ve todos los CUITs: para limitar a algunos, usá operador o lectura'), { httpStatus: 400 });
  }
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
//  - suite/abrir/<app>: pide a la otra app de la suite Escriba (Factorum) un pase para entrar
//    con la misma persona. En Arcanum no modifica nada (solo anota la auditoria) y lo que la
//    persona pueda hacer alla lo decide la otra app con su propio rol. Solo sesiones del
//    navegador (la ruta rechaza claves de API).
// POST /api/suite/pase NO es una excepcion: se atiende antes de esta regla y solo con una clave
// habilitada para la suite (ver src/rutas/suite.js).
const POST_SOLO_LECTURA_PREFIJOS = [/^\/api\/suite\/abrir\/[a-z]+$/];

function assertPuedeEscribir(principal, method, pathname = '') {
  if (principal.role !== 'lectura' || method === 'GET' || method === 'HEAD') return;
  if (method === 'POST' && POST_SOLO_LECTURA.has(pathname)) return;
  if (method === 'POST' && POST_SOLO_LECTURA_PREFIJOS.some((re) => re.test(pathname))) return;
  throw Object.assign(new Error('Acceso de solo lectura: este usuario o clave no puede emitir ni modificar nada.'), { httpStatus: 403 });
}

module.exports = { requireRole, assertCuitAllowed, scopedRequiresCuit, assertPuedeEscribir, listaCuits, sinCuitsParaAdmin, POST_SOLO_LECTURA, POST_SOLO_LECTURA_PREFIJOS };
