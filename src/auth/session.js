'use strict';

// Sesiones de la UI: token firmado (HMAC-SHA256) guardado en cookie. Sin estado
// en servidor, igual que el patron de Lockatus/Selega.

const crypto = require('crypto');
const { config } = require('../config');

const COOKIE = 'arcanum_sess';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function secret() {
  return process.env.ARCANUM_SESSION_SECRET || config.masterKey || config.apiKey || 'arcanum-dev-secret';
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
