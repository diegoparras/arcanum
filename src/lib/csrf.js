'use strict';

// Proteccion CSRF para pedidos autenticados por cookie (auditoria 2026-11-26, M-07).
//
// SameSite=Lax frena a un sitio ajeno, pero no a uno "hermano" (otra app bajo el mismo dominio
// registrable). Y un POST con Content-Type text/plain no dispara preflight. Por eso, cuando la
// autenticacion es la sesion del panel y el metodo escribe:
//  1. El pedido tiene que venir del propio origen: Sec-Fetch-Site same-origin o none; si el
//     navegador no lo manda, el Origin (si viene) tiene que ser el del host.
//  2. Si trae cuerpo, tiene que declararse JSON (eso fuerza el preflight en un pedido ajeno).
// Las claves de API no usan cookie: no aplica.

const SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function chequearCsrf(req, principal) {
  if (!principal || principal.via !== 'sesion' || SEGUROS.has(req.method)) return;
  const h = req.headers || {};
  const sitio = String(h['sec-fetch-site'] || '').toLowerCase();
  if (sitio) {
    if (sitio !== 'same-origin' && sitio !== 'none') throw err('Pedido rechazado: no viene del panel de Arcanum', 403);
  } else if (h.origin) {
    let o;
    try { o = new URL(h.origin).host; } catch { o = ''; }
    const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
    if (!o || o !== host) throw err('Pedido rechazado: no viene del panel de Arcanum', 403);
  }
  const tieneCuerpo = Number(h['content-length'] || 0) > 0 || !!h['transfer-encoding'];
  if (tieneCuerpo && !/^application\/json\b/i.test(String(h['content-type'] || ''))) {
    throw err('El cuerpo tiene que ser JSON (Content-Type: application/json)', 415);
  }
}

module.exports = { chequearCsrf };
