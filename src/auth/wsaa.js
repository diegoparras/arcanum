'use strict';

// WSAA: obtencion del Ticket de Acceso (Token + Sign) para un servicio dado.
// Arma el TRA, lo firma localmente (sign.js), llama a LoginCms y cachea el TA
// segun su expirationTime real (tokenStore.js).

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');
const { signTRA } = require('./sign');
const tokenStore = require('./tokenStore');
const { load } = require('./tenants');
const { post, SoapError } = require('../soap/client');

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

function nowMinusOffset(ms) {
  return new Date(Date.now() + ms);
}

// ARCA es estricto con el reloj. Pedimos validez desde -10min hasta +10min
// para tolerar pequenos desfasajes de hora del servidor del contador.
function buildTRA(service) {
  const gen = nowMinusOffset(-10 * 60 * 1000);
  const exp = nowMinusOffset(10 * 60 * 1000);
  const uniqueId = Math.floor(Date.now() / 1000);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0">' +
    '<header>' +
    `<uniqueId>${uniqueId}</uniqueId>` +
    `<generationTime>${gen.toISOString()}</generationTime>` +
    `<expirationTime>${exp.toISOString()}</expirationTime>` +
    '</header>' +
    `<service>${service}</service>` +
    '</loginTicketRequest>'
  );
}

function buildLoginEnvelope(cmsBase64) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
    '<soapenv:Header/>' +
    '<soapenv:Body>' +
    '<wsaa:loginCms>' +
    `<wsaa:in0>${cmsBase64}</wsaa:in0>` +
    '</wsaa:loginCms>' +
    '</soapenv:Body>' +
    '</soapenv:Envelope>'
  );
}

/**
 * Devuelve { token, sign, expirationTime } vigente para (cuit, service).
 * Usa cache (Postgres); solo llama a ARCA si hace falta. `entorno` por defecto
 * el del proceso (config.env), pero se puede forzar.
 */
async function getAccessTicket(cuit, service, entorno = config.env) {
  const { cuit: c, certPem, keyPem } = await load(cuit, entorno); // valida cert+key
  return tokenStore.getOrCreate(c, service, entorno, async () => {
    const tra = buildTRA(service);
    const cms = signTRA(tra, certPem, keyPem);
    const envelope = buildLoginEnvelope(cms);

    const body = await post(config.endpoints.wsaa, '', envelope);
    const ret = body?.loginCmsResponse?.loginCmsReturn;
    if (!ret) {
      throw new SoapError('WSAA no devolvio loginCmsReturn', 502, { body });
    }
    // loginCmsReturn es el XML del TA (ya des-escapado por el parser).
    const ta = parser.parse(ret);
    const creds = ta?.loginTicketResponse?.credentials;
    const header = ta?.loginTicketResponse?.header;
    if (!creds?.token || !creds?.sign) {
      throw new SoapError('WSAA no devolvio token/sign', 502, { ta });
    }
    return {
      token: creds.token,
      sign: creds.sign,
      generationTime: header?.generationTime || null,
      expirationTime: header?.expirationTime || nowMinusOffset(12 * 60 * 60 * 1000).toISOString(),
      service,
      cuit: c,
    };
  });
}

module.exports = { getAccessTicket, buildTRA };
