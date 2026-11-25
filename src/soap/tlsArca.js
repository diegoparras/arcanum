'use strict';

// TLS hacia ARCA.
//
// Varios servidores de ARCA (servicios1.afip.gov.ar, que atiende wsfev1, entre otros) negocian
// Diffie-Hellman de 1024 bits. OpenSSL 3, y por lo tanto Node desde la 17, lo rechaza con el
// nivel de seguridad por defecto (SECLEVEL=2): la conexion falla con ERR_SSL_DH_KEY_TOO_SMALL y
// fetch solo dice "fetch failed". Sin esto no se puede facturar.
//
// El arreglo NO es global (nada de NODE_OPTIONS=--tls-cipher-list): solo las conexiones a hosts
// de ARCA usan SECLEVEL=1, que acepta esa clave sin bajar a SECLEVEL=0, y siguen exigiendo
// TLS 1.2 y certificado valido. Webhooks, OIDC y cualquier otro destino quedan con la
// seguridad por defecto de Node.

const { Agent, fetch: undiciFetch } = require('undici');

/** Opciones TLS para ARCA. Congeladas: nadie las relaja mas en tiempo de ejecucion. */
const OPCIONES_TLS_ARCA = Object.freeze({
  ciphers: 'DEFAULT@SECLEVEL=1',
  minVersion: 'TLSv1.2',
});

/** Dominios de ARCA (y de AFIP, su nombre anterior) que usan los web services. */
const DOMINIOS_ARCA = Object.freeze(['afip.gov.ar', 'afip.gob.ar', 'arca.gob.ar']);

/** true si el host es uno de los dominios de ARCA o un subdominio suyo (sin trampas de sufijo). */
function esHostArca(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return DOMINIOS_ARCA.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Agente undici con las opciones TLS de ARCA. `extra` es para pruebas (p. ej. una CA local). */
function crearAgenteArca(extra = {}) {
  return new Agent({ connect: { ...OPCIONES_TLS_ARCA, ...extra } });
}

let agenteArca = null;

/** Agente para la URL: el de ARCA si es https a un host de ARCA; si no, undefined (default de Node). */
function dispatcherPara(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || !esHostArca(u.hostname)) return undefined;
  if (!agenteArca) agenteArca = crearAgenteArca();
  return agenteArca;
}

/**
 * fetch que usa el TLS de ARCA solo cuando la URL es de ARCA. Para cualquier otra URL es el
 * fetch global de Node, sin cambios.
 */
function fetchArca(url, opciones = {}) {
  const dispatcher = dispatcherPara(url);
  return dispatcher ? undiciFetch(url, { ...opciones, dispatcher }) : fetch(url, opciones);
}

/** Mensaje de un fallo de fetch con la causa real (e.cause.code), no solo "fetch failed". */
function causaDeFallo(e) {
  const msg = (e && e.message) || String(e);
  const c = e && e.cause;
  const detalle = c && (c.code || c.message);
  return detalle ? `${msg} (${detalle})` : msg;
}

module.exports = { OPCIONES_TLS_ARCA, DOMINIOS_ARCA, esHostArca, crearAgenteArca, dispatcherPara, fetchArca, causaDeFallo };
