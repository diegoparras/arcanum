'use strict';

// Padron / Constancia de inscripcion. Consulta datos de un contribuyente.
//   - A13  -> "Mi categoria" / datos de padron (servicio ws_sr_padron_a13)
//   - A5   -> Constancia de inscripcion (servicio ws_sr_constancia_inscripcion)
//
// Ambos exponen getPersona(token, sign, cuitRepresentada, idPersona).

const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { post, SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');
const { crearCache } = require('../lib/cacheTtl');

const PADRONES = {
  // A5 (constancia) usa getPersona_v2; A13 usa getPersona.
  a13: { service: 'ws_sr_padron_a13', ns: 'http://a13.soap.ws.server.puc.sr/', op: 'getPersona', endpoint: () => config.endpoints.padronA13 },
  a5: { service: 'ws_sr_constancia_inscripcion', ns: 'http://a5.soap.ws.server.puc.sr/', op: 'getPersona_v2', endpoint: () => config.endpoints.constancia },
};

// Cache corto del padron (ARCANUM_PADRON_CACHE_S, default 1 hora; 0 lo apaga).
// Clave: entorno + alcance + representada + consultado. Solo se guardan respuestas OK.
const cache = crearCache({
  ttlMs: parseInt(process.env.ARCANUM_PADRON_CACHE_S || '3600', 10) * 1000,
  max: parseInt(process.env.ARCANUM_PADRON_CACHE_MAX || '2000', 10),
});

/**
 * Consulta los datos de `idPersona` (CUIT a consultar) usando el certificado
 * del CUIT `cuitRepresentada` (el contador / representante).
 * @param {string} alcance  'a13' | 'a5'
 */
async function consultarPersona(alcance, cuitRepresentada, idPersona, opts = {}) {
  return (await consultarPersonaConMeta(alcance, cuitRepresentada, idPersona, opts)).datos;
}

/**
 * Igual que consultarPersona, pero informa si salio del cache.
 * @param {object} [opts] { fresco: true } ignora el cache y vuelve a consultar a ARCA.
 * @returns {Promise<{datos, cache: {usado: boolean, consultado: string}}>}
 */
async function consultarPersonaConMeta(alcance, cuitRepresentada, idPersona, opts = {}) {
  if (!PADRONES[alcance]) throw new SoapError(`Alcance de padrón desconocido: ${alcance}`, 404);
  const repre = normalizeCuit(cuitRepresentada);
  const target = normalizeCuit(idPersona);
  if (!target) throw new SoapError('idPersona (CUIT a consultar) inválido', 400);
  const clave = `${config.env}:${alcance}:${repre}:${target}`;
  if (!opts.fresco) {
    const e = cache.leer(clave);
    if (e) return { datos: e.valor, cache: { usado: true, consultado: new Date(e.guardado).toISOString() } };
  }
  const datos = await consultarArca(alcance, repre, target);
  cache.guardar(clave, datos);
  return { datos, cache: { usado: false, consultado: new Date().toISOString() } };
}

async function consultarArca(alcance, repre, target) {
  const cfg = PADRONES[alcance];

  const ta = await getAccessTicket(repre, cfg.service);
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="${cfg.ns}">` +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    `<a:${cfg.op}>` +
    `<token>${ta.token}</token>` +
    `<sign>${ta.sign}</sign>` +
    `<cuitRepresentada>${repre}</cuitRepresentada>` +
    `<idPersona>${target}</idPersona>` +
    `</a:${cfg.op}>` +
    '</soapenv:Body>' +
    '</soapenv:Envelope>';

  const body = await post(cfg.endpoint(), '', envelope);
  const r = body?.[`${cfg.op}Response`];
  const resp = r?.personaReturn || r;
  if (!resp) throw new SoapError('Padrón no devolvió datos de persona', 502, { body });
  return resp;
}

module.exports = { consultarPersona, consultarPersonaConMeta, PADRONES, _cache: cache };
