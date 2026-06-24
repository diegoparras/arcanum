'use strict';

// Introspeccion de WSDL: lee el contrato del servicio en vivo y devuelve sus
// operaciones, el soapAction y (best-effort) los campos de entrada. Asi el
// generador / n8n no necesita conocer la estructura de antemano.

const { XMLParser } = require('fast-xml-parser');
const catalog = require('../catalog');
const { config } = require('../config');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
const cache = new Map();

const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const strip = (n) => String(n || '').replace(/^[^:]*:/, '');
const AUTH_FIELDS = /^(auth|authrequest|token|sign|cuit|cuitrepresentada)$/i;

async function fetchWsdl(url) {
  if (cache.has(url)) return cache.get(url);
  const wsdlUrl = url.includes('?') ? url : url.toLowerCase().includes('.asmx') ? url + '?WSDL' : url + '?wsdl';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let txt;
  try {
    const r = await fetch(wsdlUrl, { signal: ctrl.signal });
    txt = await r.text();
  } finally {
    clearTimeout(t);
  }
  const doc = parser.parse(txt);
  cache.set(url, doc);
  return doc;
}

/** Lista las operaciones del servicio con su soapAction y parametros de entrada. */
async function operaciones(serviceId) {
  const svc = catalog.get(serviceId);
  if (!svc) throw Object.assign(new Error('Servicio desconocido'), { httpStatus: 404 });
  const doc = await fetchWsdl(catalog.endpoint(svc, config.env));
  const def = doc.definitions || {};

  const soapActions = {};
  for (const b of arr(def.binding)) {
    for (const op of arr(b.operation)) {
      const name = op['@_name'];
      if (name) soapActions[name] = op.operation ? op.operation['@_soapAction'] ?? null : null;
    }
  }

  const opInput = {};
  for (const pt of arr(def.portType)) {
    for (const op of arr(pt.operation)) {
      if (op['@_name'] && op.input && op.input['@_message']) opInput[op['@_name']] = strip(op.input['@_message']);
    }
  }

  const msgElement = {};
  for (const m of arr(def.message)) {
    const part = arr(m.part)[0];
    if (m['@_name']) msgElement[strip(m['@_name'])] = part ? strip(part['@_element'] || part['@_type']) : null;
  }

  const elements = {};
  const complexTypes = {};
  for (const sch of arr(def.types && def.types.schema)) {
    for (const e of arr(sch.element)) if (e['@_name']) elements[e['@_name']] = e;
    for (const ct of arr(sch.complexType)) if (ct['@_name']) complexTypes[ct['@_name']] = ct;
  }

  function paramsOf(elementName) {
    const e = elements[elementName];
    if (!e) return [];
    let ct = e.complexType;
    if (!ct && e['@_type']) ct = complexTypes[strip(e['@_type'])];
    if (!ct) return [];
    const seq =
      ct.sequence ||
      ct.all ||
      (ct.complexContent && ct.complexContent.extension && ct.complexContent.extension.sequence);
    return arr(seq && seq.element)
      .map((k) => ({ nombre: k['@_name'], tipo: strip(k['@_type'] || ''), opcional: k['@_minOccurs'] === '0' }))
      .filter((p) => p.nombre && !AUTH_FIELDS.test(p.nombre));
  }

  const names = Object.keys(soapActions).length ? Object.keys(soapActions) : Object.keys(opInput);
  return names
    .map((n) => {
      const elName = msgElement[opInput[n]];
      return { nombre: n, soapAction: soapActions[n] ?? null, parametros: elName ? paramsOf(elName) : [] };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

module.exports = { operaciones };
