'use strict';

// Sesiones de la UI: token firmado (HMAC-SHA256) guardado en cookie. Sin estado
// en servidor, igual que el patron de Lockatus/Selega.

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
    console.log('[arcanum] Sin ARCANUM_SESSION_SECRET: se genero un secreto de sesion en el volumen (no se muestra en el log).');
  } catch (e) {
    console.warn(`[arcanum] Sin ARCANUM_SESSION_SECRET y no se pudo guardar uno generado (${e.message}): las sesiones se cierran al reiniciar.`);
  }
  return (secretoResuelto = nuevo);
}

function sign(principal) {
  const payload = { u: principal.username, r: principal.role, c: principal.cuitAllow || null, exp: Date.now() + TTL_MS };
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
    return { username: p.u, role: p.r, cuitAllow: p.c || null };
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function fromRequest(req) {
  return verify(parseCookies(req)[COOKIE]);
}

function cookieHeader(token) {
  const secure = config.isProd ? ' Secure;' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${TTL_MS / 1000}`;
}
function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = { sign, verify, fromRequest, cookieHeader, clearCookieHeader, COOKIE };
