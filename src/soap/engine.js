'use strict';

// Motor SOAP generico guiado por el catalogo. Permite invocar CUALQUIER
// operacion de CUALQUIER servicio declarado, resolviendo la autenticacion WSAA
// automaticamente. Los modulos "ricos" (wsfev1, etc.) construyen el XML a mano
// para validar fino; este motor cubre todo el resto (passthrough).

const catalog = require('../catalog');
const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { withTokenRetry } = require('../auth/recovery');
const { post, escapeXml, SoapError } = require('./client');
const { normalizeCuit } = require('../auth/tenants');

// Serializa un objeto JS a XML (hijos sin prefijo, heredan el namespace por
// defecto del elemento operacion). Arrays => elementos repetidos con la misma key.
function toXml(obj) {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return escapeXml(obj);
  let out = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) out += `<${k}>${toXml(item)}</${k}>`;
    } else if (v !== null && typeof v === 'object') {
      out += `<${k}>${toXml(v)}</${k}>`;
    } else {
      out += `<${k}>${escapeXml(v)}</${k}>`;
    }
  }
  return out;
}

function authStyleOf(svc) {
  if (svc.authStyle) return svc.authStyle;
  if (String(svc.soapNamespace || '').includes('puc.sr')) return 'params'; // padron
  return 'body-auth'; // FEV1 y familia .asmx
}

/**
 * Invoca una operacion SOAP de un servicio del catalogo.
 * @param {string} serviceId  id del servicio (ej. 'wsfev1')
 * @param {string} operation  nombre de la operacion (ej. 'FECAESolicitar')
 * @param {object} params     parametros del cuerpo (se serializan a XML)
 * @param {object} opts       { cuit, entorno }
 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/; // nombres SOAP validos (NCName simplificado)

async function call(serviceId, operation, params = {}, opts = {}) {
  // Validacion estricta: evita inyeccion XML por el nombre de operacion/servicio.
  if (!NAME_RE.test(String(serviceId))) throw new SoapError('serviceId invalido', 400);
  if (!NAME_RE.test(String(operation))) throw new SoapError('Operacion invalida (use letras, numeros y guion bajo)', 400);
  const svc = catalog.get(serviceId);
  if (!svc) throw new SoapError(`Servicio desconocido: ${serviceId}`, 404);
  if (svc.enabled === false) throw new SoapError(`Servicio ${serviceId} deshabilitado`, 409);

  const entorno = opts.entorno || config.env;
  const url = catalog.endpoint(svc, entorno);
  const ns = svc.soapNamespace;
  const isDummy = svc.dummyOp && operation === svc.dummyOp;
  const cuit = normalizeCuit(opts.cuit || '');
  const style = authStyleOf(svc);

  // soapActionTemplate puede ser '' (vacio, tipico en JAX-WS). null/undefined => ns+op.
  const soapAction =
    svc.soapActionTemplate != null ? svc.soapActionTemplate.replace('{op}', operation) : `${ns}${operation}`;

  async function doPost(inner) {
    const envelope =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      `<soapenv:Header/><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
    const body = await post(url, soapAction, envelope);
    return body?.[`${operation}Response`] ?? body;
  }

  if (isDummy) {
    return doPost(`<${operation} xmlns="${ns}">${toXml(params)}</${operation}>`);
  }

  // Con auth: reintenta una vez si ARCA rechaza por token vencido.
  return withTokenRetry(cuit, svc.wsaaService, entorno, async () => {
    const ta = await getAccessTicket(cuit, svc.wsaaService, entorno);
    let inner;
    if (style === 'params') {
      // Estilo padron: operacion con prefijo, token/sign/cuitRepresentada sueltos.
      inner =
        `<a:${operation} xmlns:a="${ns}">` +
        `<token>${ta.token}</token><sign>${ta.sign}</sign>` +
        `<cuitRepresentada>${cuit}</cuitRepresentada>` +
        toXml(params) +
        `</a:${operation}>`;
    } else if (style === 'java') {
      // Estilo JAX-WS (wsmtxca, wslpg, etc.): authRequest como primer elemento.
      inner =
        `<ser:${operation} xmlns:ser="${ns}">` +
        `<authRequest><token>${ta.token}</token><sign>${ta.sign}</sign><cuitRepresentada>${cuit}</cuitRepresentada></authRequest>` +
        toXml(params) +
        `</ser:${operation}>`;
    } else {
      // Estilo body-auth (FEV1 y familia): <Auth><Token><Sign><Cuit> + params.
      inner =
        `<${operation} xmlns="${ns}">` +
        `<Auth><Token>${ta.token}</Token><Sign>${ta.sign}</Sign><Cuit>${cuit}</Cuit></Auth>` +
        toXml(params) +
        `</${operation}>`;
    }
    return doPost(inner);
  });
}

module.exports = { call, toXml };
