'use strict';

// Auto-recuperacion de token: si ARCA rechaza una operacion porque el Ticket de
// Acceso esta vencido/invalido, invalidamos la cache y reintentamos UNA vez (lo
// que fuerza un relogin limpio). Asi el contador nunca ve un error transitorio
// de token.

const tokenStore = require('./tokenStore');

// Patrones de error de token de ARCA (WSAA y servicios de negocio).
const TOKEN_ERR = /token.*(venc|expir|inv[aá]lid|invalid|caduc)|validaciondetoken|cms\.(bad|expired)|el token no es v[aá]lido|wsaa|xml\.generationtime/i;

function looksLikeTokenError(e) {
  const msg = (e && e.message) || '';
  const extra = e && e.extra ? JSON.stringify(e.extra) : '';
  return TOKEN_ERR.test(msg) || TOKEN_ERR.test(extra);
}

/**
 * Ejecuta `fn`; si falla por token, invalida (cuit,service,entorno) y reintenta.
 */
async function withTokenRetry(cuit, service, entorno, fn) {
  try {
    return await fn();
  } catch (e) {
    if (looksLikeTokenError(e)) {
      await tokenStore.invalidate(cuit, service, entorno);
      return fn();
    }
    throw e;
  }
}

module.exports = { withTokenRetry, looksLikeTokenError };
