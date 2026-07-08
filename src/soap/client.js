'use strict';

// Cliente SOAP minimo: arma el sobre, lo postea por HTTPS y parsea la respuesta.
// No usamos un cliente SOAP "magico" porque los WSDL de ARCA son fragiles y el
// control fino del XML evita el 90% de los dolores de cabeza.

const { XMLParser } = require('fast-xml-parser');
const { config } = require('../config');

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // descarta prefijos de namespace (soap:, ns1:, etc.)
  parseTagValue: false, // todo string: evita perder ceros o redondear importes
  trimValues: true,
});

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Postea un sobre SOAP 1.1 y devuelve el cuerpo parseado a objeto JS.
 * @param {string} url
 * @param {string} soapAction  valor del header SOAPAction (con comillas si aplica)
 * @param {string} envelope    XML completo del Envelope
 * @returns {Promise<object>}  contenido de soap:Body ya parseado
 */
async function post(url, soapAction, envelope, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.soapTimeoutMs);
  // SOAP 1.2: la accion va en el Content-Type (application/soap+xml; action="..."),
  // sin header SOAPAction. SOAP 1.1: text/xml + header SOAPAction.
  const headers = opts.soap12
    ? { 'Content-Type': `application/soap+xml; charset=utf-8; action="${soapAction}"` }
    : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: envelope,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new SoapError(`Timeout (${config.soapTimeoutMs}ms) llamando a ARCA`, 504);
    }
    throw new SoapError(`No se pudo conectar con ARCA: ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const MAX_SOAP = 25 * 1024 * 1024; // 25 MB: respuestas SOAP de ARCA son chicas
  const clen = parseInt(res.headers.get('content-length') || '0', 10);
  if (clen > MAX_SOAP) throw new SoapError('Respuesta de ARCA demasiado grande', 502);
  let text = await res.text();
  if (text.length > MAX_SOAP) throw new SoapError('Respuesta de ARCA demasiado grande', 502);
  // Respuestas MTOM/XOP o multipart traen cabeceras MIME antes del XML. Nos
  // quedamos con el <...Envelope>...</...Envelope> para poder parsear.
  const start = text.search(/<(\w+:)?Envelope[\s>]/);
  if (start > 0) {
    const m = text.match(/<\/(\w+:)?Envelope\s*>/);
    text = m ? text.slice(start, text.indexOf(m[0]) + m[0].length) : text.slice(start);
  }
  const doc = parser.parse(text);
  const envelopeObj = doc.Envelope || doc;
  const body = envelopeObj && envelopeObj.Body;

  // Fault SOAP: ARCA devuelve faultstring con el motivo real.
  if (body && body.Fault) {
    const f = body.Fault;
    const msg = f.faultstring || f.Reason?.Text || 'SOAP Fault';
    throw new SoapError(`ARCA rechazo la solicitud: ${msg}`, 502, { fault: f, raw: text });
  }

  if (!res.ok) {
    throw new SoapError(`ARCA respondio HTTP ${res.status}`, 502, { raw: text });
  }

  return body || {};
}

class SoapError extends Error {
  constructor(message, httpStatus = 502, extra = {}) {
    super(message);
    this.name = 'SoapError';
    this.httpStatus = httpStatus;
    this.extra = extra;
  }
}

module.exports = { post, escapeXml, SoapError };
