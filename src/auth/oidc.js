'use strict';

// Federacion opcional con Lockatus (u otro proveedor OIDC). Authorization Code
// + PKCE. Se activa solo si estan las variables de entorno; si no, el login local
// sigue funcionando igual. La verificacion del id_token es por intercambio de
// codigo contra el token endpoint (confidential client con secret).

const crypto = require('crypto');

const CFG = {
  issuer: process.env.ARCANUM_OIDC_ISSUER || '',
  clientId: process.env.ARCANUM_OIDC_CLIENT_ID || '',
  clientSecret: process.env.ARCANUM_OIDC_CLIENT_SECRET || '',
  redirectUri: process.env.ARCANUM_OIDC_REDIRECT_URI || '',
  scope: process.env.ARCANUM_OIDC_SCOPE || 'openid profile email',
  roleClaim: process.env.ARCANUM_OIDC_ROLE_CLAIM || 'role',
  // Si el claim no trae un rol conocido: lectura (lo minimo). Antes era operador, que puede emitir.
  defaultRole: ['superadmin', 'admin', 'operador', 'lectura'].includes(process.env.ARCANUM_OIDC_DEFAULT_ROLE) ? process.env.ARCANUM_OIDC_DEFAULT_ROLE : 'lectura',
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
  const claims = await verifyIdToken(tok.id_token);
  const role = mapRole(claims[CFG.roleClaim]);
  const username = claims.preferred_username || claims.email || claims.sub || 'oidc-user';
  return { username, role, federated: true };
}

// Palabra exacta del claim -> rol de Arcanum. Lockatus declara para Arcanum superadmin, admin,
// operador y lectura; editor y lector son los nombres viejos. Se compara la palabra entera (no
// "contiene admin") y, si vienen varias, gana la de mas permisos.
const ROLES_CLAIM = {
  superadmin: 'superadmin', admin: 'admin',
  operador: 'operador', editor: 'operador',
  lectura: 'lectura', lector: 'lectura', read: 'lectura', readonly: 'lectura',
};
const ORDEN_ROLES = ['lectura', 'operador', 'admin', 'superadmin'];

function mapRole(claim) {
  const palabras = (Array.isArray(claim) ? claim.join(',') : String(claim || ''))
    .toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const roles = palabras.map((p) => ROLES_CLAIM[p]).filter(Boolean);
  if (!roles.length) return CFG.defaultRole;
  return roles.sort((a, b) => ORDEN_ROLES.indexOf(b) - ORDEN_ROLES.indexOf(a))[0];
}

function b64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let jwksCache = null;
async function jwks() {
  if (jwksCache) return jwksCache;
  const d = await discover();
  if (!d.jwks_uri) throw new Error('OIDC: el issuer no expone jwks_uri');
  const res = await fetchTimeout(d.jwks_uri);
  jwksCache = (await res.json()).keys || [];
  return jwksCache;
}

/** Verifica firma RS256 del id_token contra el JWKS + claims (iss/aud/exp). */
async function verifyIdToken(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('OIDC: id_token malformado');
  const [h, p, sig] = parts;
  const header = JSON.parse(b64url(h).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('OIDC: alg no soportado (' + header.alg + ')');
  const keys = await jwks();
  const jwk = keys.find((k) => k.kid === header.kid) || keys.find((k) => k.kty === 'RSA');
  if (!jwk) throw new Error('OIDC: no se encontro la clave en el JWKS');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(h + '.' + p), pub, b64url(sig));
  if (!ok) throw new Error('OIDC: firma del id_token invalida');
  const claims = JSON.parse(b64url(p).toString('utf8'));
  const d = await discover();
  const iss = CFG.issuer.replace(/\/$/, '');
  if (claims.iss !== d.issuer && claims.iss !== iss) throw new Error('OIDC: iss invalido');
  const aud = claims.aud;
  if (aud !== CFG.clientId && !(Array.isArray(aud) && aud.includes(CFG.clientId))) throw new Error('OIDC: aud invalido');
  if (claims.exp && Date.now() / 1000 > claims.exp) throw new Error('OIDC: id_token expirado');
  return claims;
}

module.exports = { enabled, buildAuthUrl, exchangeCode, mapRole, CFG };
