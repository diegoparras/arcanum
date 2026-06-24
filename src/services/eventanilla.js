'use strict';

// e-Ventanilla (Ventanilla Electronica) — modulo rico.
//
// Es SOAP 1.2 con auth prefijada (typ1:) y los adjuntos llegan en MTOM/multipart
// binario, asi que no entra por el motor generico (SOAP 1.1). Aca lo manejamos a
// mano, reusando el caché de token WSAA de Arcanum (servicio veconsumerws).
//
// Operaciones: dummy, consultarComunicaciones, consumirComunicacion (cuerpo +
// adjuntos PDF reales).

const { XMLParser } = require('fast-xml-parser');
const catalog = require('../catalog');
const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { normalizeCuit } = require('../auth/tenants');
const { SoapError } = require('../soap/client');

const WSAA_SERVICE = 'veconsumerws';
const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  typ: 'http://ve.tecno.afip.gov.ar/domain/service/ws/types',
  typ1: 'http://core.tecno.afip.gov.ar/model/ws/types',
};
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

const num = (x) => (x === undefined || x === null || x === '' ? null : Number(x));

function endpoint(entorno) {
  const url = catalog.endpoint('eventanilla', entorno || config.env);
  if (!url) throw new SoapError('e-Ventanilla no esta en el catalogo', 404);
  return url;
}

function envelope(opBody) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soap:Envelope xmlns:soap="${NS.soap}" xmlns:typ="${NS.typ}" xmlns:typ1="${NS.typ1}">` +
    `<soap:Header/><soap:Body>${opBody}</soap:Body></soap:Envelope>`
  );
}
function authXml(token, sign, cuit) {
  return (
    '<authRequest>' +
    `<typ1:token>${token}</typ1:token>` +
    `<typ1:sign>${sign}</typ1:sign>` +
    `<typ1:cuitRepresentada>${cuit}</typ1:cuitRepresentada>` +
    '</authRequest>'
  );
}

async function authParts(cuit, entorno) {
  const c = normalizeCuit(cuit);
  if (!c) throw new SoapError('CUIT invalido', 400);
  const ta = await getAccessTicket(c, WSAA_SERVICE, entorno || config.env);
  return { c, token: ta.token, sign: ta.sign };
}

async function postSoap(entorno, soap, binary = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.soapTimeoutMs);
  let res;
  try {
    res = await fetch(endpoint(entorno), {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=UTF-8' },
      body: soap,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new SoapError('Timeout llamando a e-Ventanilla', 504);
    throw new SoapError('No se pudo conectar con e-Ventanilla: ' + e.message, 502);
  } finally {
    clearTimeout(t);
  }
  const ct = res.headers.get('content-type') || '';
  if (binary) return { buf: Buffer.from(await res.arrayBuffer()), ct, status: res.status };
  return { text: await res.text(), ct, status: res.status };
}

function bodyOf(text) {
  const xml = stripToEnvelope(text);
  const body = parser.parse(xml)?.Envelope?.Body;
  if (body?.Fault) {
    const f = body.Fault;
    throw new SoapError('e-Ventanilla: ' + (f?.Reason?.Text || f?.faultstring || 'SOAP Fault'), 502);
  }
  return body || {};
}

function stripToEnvelope(text) {
  const s = String(text);
  const start = s.search(/<(\w+:)?Envelope[\s>]/);
  if (start < 0) return s;
  const m = s.match(/<\/(\w+:)?Envelope\s*>/);
  return m ? s.slice(start, s.indexOf(m[0]) + m[0].length) : s.slice(start);
}

// Junta recursivamente los objetos que tengan la propiedad `key`.
function collectByKey(obj, key, out = []) {
  if (Array.isArray(obj)) obj.forEach((o) => collectByKey(o, key, out));
  else if (obj && typeof obj === 'object') {
    if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj);
    for (const k of Object.keys(obj)) collectByKey(obj[k], key, out);
  }
  return out;
}

// --- Operaciones ---

async function dummy(entorno) {
  const { text } = await postSoap(entorno, envelope('<typ:dummy/>'));
  const body = bodyOf(text);
  const r = collectByKey(body, 'appserver')[0] || collectByKey(body, 'authserver')[0] || {};
  return { appServer: r.appserver || 'OK', dbServer: r.dbserver || '?', authServer: r.authserver || '?' };
}

function rangoFechas(desde, hasta) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const h = hasta ? String(hasta).slice(0, 10) : fmt(now);
  // ARCA limita la ventana a 31 dias (y fechaDesde no mas de 31 dias de hoy).
  // Para mas historia hay que consultar por tramos. Default: ultimos 30 dias.
  const d = desde ? String(desde).slice(0, 10) : fmt(new Date(now.getTime() - 30 * 86400000));
  return { desde: d, hasta: h };
}

async function consultarComunicaciones(cuit, opts = {}) {
  const { c, token, sign } = await authParts(cuit, opts.entorno);
  const r = rangoFechas(opts.desde, opts.hasta);
  const pagina = parseInt(opts.pagina || 1, 10);
  const porPagina = Math.min(parseInt(opts.porPagina || 500, 10), 500);
  const op =
    '<typ:consultarComunicaciones>' +
    authXml(token, sign, c) +
    `<filter><fechaDesde>${r.desde}</fechaDesde><fechaHasta>${r.hasta}</fechaHasta>` +
    `<pagina>${pagina}</pagina><resultadosPorPagina>${porPagina}</resultadosPorPagina></filter>` +
    '</typ:consultarComunicaciones>';
  const { text } = await postSoap(opts.entorno, envelope(op));
  const body = bodyOf(text);
  const lista = collectByKey(body, 'idComunicacion').map((x) => ({
    idComunicacion: num(x.idComunicacion),
    cuitDestinatario: num(x.cuitDestinatario),
    fechaPublicacion: x.fechaPublicacion || null,
    fechaVencimiento: x.fechaVencimiento || null,
    sistemaPublicador: num(x.sistemaPublicador),
    sistemaPublicadorDesc: x.sistemaPublicadorDesc || null,
    estado: num(x.estado),
    estadoDesc: x.estadoDesc || null,
    asunto: x.asunto || null,
    prioridad: num(x.prioridad),
    tieneAdjunto: String(x.tieneAdjunto) === 'true',
    referencia1: x.referencia1 || null,
    referencia2: x.referencia2 || null,
  }));
  return { total: lista.length, rango: r, pagina, comunicaciones: lista };
}

async function consumirComunicacion(cuit, idComunicacion, opts = {}) {
  const { c, token, sign } = await authParts(cuit, opts.entorno);
  const op =
    '<typ:consumirComunicacion>' +
    authXml(token, sign, c) +
    `<idComunicacion>${parseInt(idComunicacion, 10)}</idComunicacion>` +
    '<incluirAdjuntos>false</incluirAdjuntos>' +
    '</typ:consumirComunicacion>';
  const { text } = await postSoap(opts.entorno, envelope(op));
  const body = bodyOf(text);
  const com = collectByKey(body, 'mensaje')[0] || {};
  const meta = collectByKey(body, 'tiempoDeVida')[0] || {};
  return {
    idComunicacion: parseInt(idComunicacion, 10),
    mensaje: com.mensaje || null,
    tiempoDeVida: num(meta.tiempoDeVida),
  };
}

/** Devuelve los adjuntos PDF reales: [{ filename, type, data:Buffer }]. */
async function obtenerAdjuntos(cuit, idComunicacion, opts = {}) {
  const { c, token, sign } = await authParts(cuit, opts.entorno);
  const op =
    '<typ:consumirComunicacion>' +
    authXml(token, sign, c) +
    `<idComunicacion>${parseInt(idComunicacion, 10)}</idComunicacion>` +
    '<incluirAdjuntos>true</incluirAdjuntos>' +
    '</typ:consumirComunicacion>';
  const { buf, ct } = await postSoap(opts.entorno, envelope(op), true);

  const boundary = getBoundary(ct, buf);
  if (boundary) {
    const { xml, attachments } = parseMTOM(buf, boundary);
    const names = filenamesFromXml(xml);
    return attachments.map((a, i) => ({
      filename: names[i] || `comunicacion_${idComunicacion}_${i + 1}.pdf`,
      type: a.type || 'application/pdf',
      data: a.body,
    }));
  }
  // Sin multipart: puede venir base64 inline o un fault.
  const xml = stripToEnvelope(buf.toString('utf8'));
  const body = bodyOf(xml);
  const b64 = collectByKey(body, 'content')[0];
  if (b64 && b64.content) {
    const pdf = Buffer.from(String(b64.content).replace(/\s/g, ''), 'base64');
    return [{ filename: filenamesFromXml(xml)[0] || `comunicacion_${idComunicacion}.pdf`, type: 'application/pdf', data: pdf }];
  }
  return [];
}

// --- Parseo MTOM / multipart-related ---

function getBoundary(ct, buf) {
  const m = String(ct).match(/boundary="?([^";\s]+)"?/i);
  if (m) return m[1];
  // Algunas respuestas no traen el boundary en el header: lo leemos del cuerpo.
  const cr = buf.indexOf(0x0d);
  if (cr > 2 && cr < 300) {
    const line = buf.slice(0, cr).toString('ascii');
    if (line.startsWith('--')) return line.slice(2);
  }
  return null;
}

function indexOfBuf(hay, needle, from = 0) {
  return hay.indexOf(needle, from);
}

function parseHeaders(str) {
  const h = {};
  for (const line of str.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

function parseMTOM(buf, boundary) {
  const delim = Buffer.from('--' + boundary, 'ascii');
  const positions = [];
  let p = indexOfBuf(buf, delim, 0);
  while (p !== -1) {
    positions.push(p);
    p = indexOfBuf(buf, delim, p + delim.length);
  }
  let xml = null;
  const attachments = [];
  for (let i = 0; i < positions.length - 1; i++) {
    let start = positions[i] + delim.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x2d && buf[start + 1] === 0x2d) continue; // cierre "--"
    let end = positions[i + 1];
    if (end >= 2 && buf[end - 1] === 0x0a && buf[end - 2] === 0x0d) end -= 2;
    const part = buf.slice(start, end);
    const sep = findHeaderEnd(part);
    if (sep === -1) continue;
    const headers = parseHeaders(part.slice(0, sep).toString('utf8'));
    const body = part.slice(sep + 4);
    const ctype = (headers['content-type'] || '').toLowerCase();
    if (ctype.includes('xml') || ctype.includes('soap') || ctype.includes('xop')) {
      xml = body.toString('utf8');
    } else {
      attachments.push({
        cid: (headers['content-id'] || '').replace(/[<>]/g, ''),
        type: (headers['content-type'] || 'application/octet-stream').split(';')[0].trim(),
        body,
      });
    }
  }
  return { xml: xml ? stripToEnvelope(xml) : null, attachments };
}

function findHeaderEnd(buf) {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
}

function filenamesFromXml(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<(?:\w+:)?filename>([^<]+)<\/(?:\w+:)?filename>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

module.exports = { dummy, consultarComunicaciones, consumirComunicacion, obtenerAdjuntos, WSAA_SERVICE };
