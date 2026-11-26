'use strict';

// Cookie de sesion de la UI: token firmado (HMAC-SHA256) con usuario, rol, CUITs y vencimiento.
// La firma prueba que la cookie la emitio Arcanum; si sigue vigente lo decide la tabla
// `sesiones` (ver auth/sesiones.js).

const crypto = require('crypto');
const { config } = require('../config');

const COOKIE = 'arcanum_sess';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

const ARCHIVO_SECRETO = 'session-secret';
let secretoResuelto = null;

/**
 * Secreto de firma de las sesiones, con una sola fuente por instalacion:
 *  1. ARCANUM_SESSION_SECRET del entorno.
 *  2. Si falta, el generado y guardado en el volumen (DATA_DIR/session-secret, 0600), que
 *     sobrevive a los reinicios; si no existe, se genera uno nuevo y se guarda.
 *  3. Si el volumen no se puede escribir, uno aleatorio en memoria: las sesiones se cierran al
 *     reiniciar, pero nunca queda un secreto predecible.
 * Nunca la clave de API (se entrega a integraciones) ni la master key (cifra los certificados):
 * quien tuviera una de esas podria firmarse una sesion de superadmin (auditoria 2026-11-26, C-01).
 */
function secret() {
  if (secretoResuelto) return secretoResuelto;
  const delEntorno = (process.env.ARCANUM_SESSION_SECRET || '').trim();
  if (delEntorno) {
    if (delEntorno.length < 32) console.warn('[arcanum] ARCANUM_SESSION_SECRET es corta (menos de 32 caracteres): usá 64 hex aleatorios.');
    return (secretoResuelto = delEntorno);
  }
  const secretos = require('./secretosIniciales');
  const previo = secretos.leerSecreto(config.dataDir, ARCHIVO_SECRETO);
  if (previo) return (secretoResuelto = previo);
  const nuevo = crypto.randomBytes(32).toString('hex');
  try {
    secretos.guardarSecreto(config.dataDir, ARCHIVO_SECRETO, nuevo);
    console.log('[arcanum] Sin ARCANUM_SESSION_SECRET: se generó un secreto de sesión en el volumen (no se muestra en el log).');
  } catch (e) {
    console.warn(`[arcanum] Sin ARCANUM_SESSION_SECRET y no se pudo guardar uno generado (${e.message}): las sesiones se cierran al reiniciar.`);
  }
  return (secretoResuelto = nuevo);
}

function sign(principal) {
  // s: identificador de la sesion en la tabla `sesiones` (auth/sesiones.js); o: origen (local u oidc).
  const payload = { u: principal.username, r: principal.role, c: principal.cuitAllow || null, s: principal.sid || null, o: principal.origen || null, exp: Date.now() + TTL_MS };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const [data, mac] = String(token).split('.');
  if (!data || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (Date.now() > p.exp) return null;
    if (!p.s) return null; // cookie de antes de 2.1.14, sin sesion registrada: no se puede revocar
    return { username: p.u, role: p.r, cuitAllow: p.c || null, sid: p.s, origen: p.o || 'local' };
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Una cookie mal codificada (de otra app del mismo dominio) se ignora: no es un 500 (B-04).
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* se ignora */ }
  }
  return out;
}

function fromRequest(req) {
  return verify(parseCookies(req)[COOKIE]);
}

/** Secure si el pedido llego por https (lo informa el proxy), si ARCA esta en prod o con
 *  ARCANUM_COOKIE_SECURE=1. Antes dependia solo del entorno de ARCA (B-06). */
function cookieHeader(token, req) {
  const proto = req && req.headers ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  const porHttps = proto === 'https' || !!(req && req.socket && req.socket.encrypted);
  const secure = porHttps || config.isProd || process.env.ARCANUM_COOKIE_SECURE === '1' ? ' Secure;' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${TTL_MS / 1000}`;
}
function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = { sign, verify, fromRequest, cookieHeader, clearCookieHeader, COOKIE };
