'use strict';

// Federacion opcional con Lockatus (u otro proveedor OIDC). Authorization Code
// + PKCE. Se activa solo si estan las variables de entorno; si no, el login local
// sigue funcionando igual. La verificacion del id_token es por intercambio de
// codigo contra el token endpoint (confidential client con secret).

const crypto = require('crypto');
const { config } = require('../config');

const CFG = {
  issuer: process.env.ARCANUM_OIDC_ISSUER || '',
  clientId: process.env.ARCANUM_OIDC_CLIENT_ID || '',
  clientSecret: process.env.ARCANUM_OIDC_CLIENT_SECRET || '',
  redirectUri: process.env.ARCANUM_OIDC_REDIRECT_URI || '',
  scope: process.env.ARCANUM_OIDC_SCOPE || 'openid profile email',
  roleClaim: process.env.ARCANUM_OIDC_ROLE_CLAIM || 'role',
  defaultRole: process.env.ARCANUM_OIDC_DEFAULT_ROLE || 'operador',
};

function enabled() {
  return !!(CFG.issuer && CFG.clientId && CFG.clientSecret);
}

async function fetchTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

let discoveryCache = null;
async function discover() {
  if (discoveryCache) return discoveryCache;
  const url = CFG.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const res = await fetchTimeout(url);
  if (!res.ok) throw new Error('No se pudo leer la configuracion OIDC del issuer');
  discoveryCache = await res.json();
  return discoveryCache;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Devuelve { url, state, verifier } para iniciar el login. */
async function buildAuthUrl(redirectUri) {
  const d = await discover();
  const state = base64url(crypto.randomBytes(16));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.clientId,
    redirect_uri: redirectUri || CFG.redirectUri,
    scope: CFG.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${d.authorization_endpoint}?${params}`, state, verifier };
}

/** Intercambia el code por tokens y devuelve el principal { username, role }. */
async function exchangeCode(code, verifier, redirectUri) {
  const d = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || CFG.redirectUri,
    client_id: CFG.clientId,
    client_secret: CFG.clientSecret,
    code_verifier: verifier,
  });
  const res = await fetchTimeout(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('OIDC: fallo el intercambio de codigo');
  const tok = await res.json();
  const claims = decodeJwtPayload(tok.id_token) || {};
  const role = mapRole(claims[CFG.roleClaim]);
  const username = claims.preferred_username || claims.email || claims.sub || 'oidc-user';
  return { username, role, federated: true };
}

function mapRole(claim) {
  const v = Array.isArray(claim) ? claim.join(',') : String(claim || '');
  if (/superadmin/i.test(v)) return 'superadmin';
  if (/admin/i.test(v)) return 'admin';
  if (/lectura|read/i.test(v)) return 'lectura';
  return CFG.defaultRole;
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { enabled, buildAuthUrl, exchangeCode, CFG };
