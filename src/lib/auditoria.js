'use strict';

// Fila de la auditoria de pedidos (tabla requests). Auditoria 2026-11-26, M-12:
//  - Los pedidos anonimos rechazados (sin usuario identificado) no dejan fila: cualquiera podia
//    llenar el disco con rutas largas al azar. Los intentos de login si se registran (estan
//    limitados por limiteLogin y sirven para investigar).
//  - La ruta y la operacion se truncan; el CUIT solo se guarda si es un CUIT (11 digitos).
//  - La IP es la que agrego el proxy de confianza (req._ip, ver auth/limiteLogin.ipCliente).
// La retencion (90 dias por defecto, ARCANUM_AUDITORIA_DIAS) la aplica el daemon.

const MAX_RUTA = 300;
const MAX_OP = 200;
const esCuit = (c) => (/^\d{11}$/.test(String(c || '')) ? String(c) : null);

/** @returns {null | object} null si el pedido no se audita. */
function filaAuditoria(req, res, url, duracionMs) {
  const esMcp = url.pathname === '/mcp';
  if (!url.pathname.startsWith('/api/') && !esMcp) return null;
  const esLogin = url.pathname === '/api/auth/login';
  if (!req._user && res.statusCode >= 400 && !esLogin) return null;
  const seg = url.pathname.split('/').filter(Boolean);
  const service = esMcp ? 'mcp' : seg[1] === 'ws' ? seg[2] : seg[1];
  return {
    cuit: esCuit(req._cuit) || esCuit(url.searchParams.get('cuit')),
    service: service ? String(service).slice(0, 60) : null,
    operation: req._op ? String(req._op).slice(0, MAX_OP) : null,
    http_method: req.method,
    path: url.pathname.slice(0, MAX_RUTA),
    status: res.statusCode,
    ok: res.statusCode < 400,
    duration_ms: duracionMs,
    usuario: req._user || null,
    ip: req._ip ? String(req._ip).slice(0, 64) : null,
    clave_id: req._claveId || null,
  };
}

const COLUMNAS = ['cuit', 'service', 'operation', 'http_method', 'path', 'status', 'ok', 'duration_ms', 'usuario', 'ip', 'clave_id'];

/** Inserta una fila (best-effort: la auditoria nunca rompe la respuesta). */
function guardarFila(db, fila) {
  if (!fila) return;
  db.query(
    `INSERT INTO requests (${COLUMNAS.join(', ')}) VALUES (${COLUMNAS.map((_, i) => '$' + (i + 1)).join(',')})`,
    COLUMNAS.map((c) => fila[c]),
  ).catch(() => {});
}

module.exports = { filaAuditoria, guardarFila, esCuit };
