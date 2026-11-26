'use strict';

// Cabeceras de seguridad (auditoria 2026-11-26, M-08).
//
// En todas las respuestas: nosniff, no enmarcable, referrer acotado, sin camara/microfono/ubicacion
// y HSTS cuando el pedido llego por https (el proxy lo informa en X-Forwarded-Proto).
//
// CSP del panel: index.html todavia tiene JavaScript y manejadores inline, asi que 'unsafe-inline'
// sigue en script-src; aun asi impide cargar scripts de otro origen y mandar datos a otro host
// (connect-src 'self'), que es lo que necesita un XSS para llevarse algo. Sacar el inline y
// endurecer script-src queda para despues.

const CSP_PANEL = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// /docs usa Redoc desde su CDN (y Redoc trae sus fuentes y arma workers con blob:).
const CSP_DOCS = [
  "default-src 'self'",
  "script-src 'self' https://cdn.redoc.ly",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function cabecerasComunes(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https' || req.socket?.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

module.exports = { cabecerasComunes, CSP_PANEL, CSP_DOCS };
