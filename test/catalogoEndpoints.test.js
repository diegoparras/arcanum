'use strict';

// Catalogo de servicios (auditoria 2026-11-26, A-08): el sobre SOAP lleva el Ticket de Acceso de
// WSAA del CUIT, asi que solo viaja a https de los dominios de ARCA.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const catalog = require('../src/catalog');
const { DEFAULTS } = require('../src/catalog.defaults');

afterEach(() => { delete process.env.ARCANUM_CATALOGO_ENDPOINTS_LIBRES; });

test('los 25 servicios de fabrica pasan la validacion', () => {
  for (const d of DEFAULTS) {
    for (const u of Object.values(d.endpoints)) assert.doesNotThrow(() => catalog.validarEndpoint(u), `${d.id}: ${u}`);
  }
});

test('acepta https de afip.gov.ar, afip.gob.ar y arca.gob.ar y sus subdominios', () => {
  for (const u of ['https://servicios1.afip.gov.ar/wsfev1/service.asmx', 'https://cpea-ws.arca.gob.ar/x', 'https://afip.gob.ar/ws']) {
    assert.doesNotThrow(() => catalog.validarEndpoint(u), u);
  }
});

test('rechaza http, dominios parecidos, IPs y hosts internos', () => {
  for (const u of ['http://servicios1.afip.gov.ar/wsfev1/service.asmx', 'https://afip.gov.ar.atacante.com/soap',
    'https://noafip.gov.ar/soap', 'https://169.254.169.254/latest', 'https://127.0.0.1/', 'https://postgres:5432/',
    'https://user:pw@servicios1.afip.gov.ar/x', 'no-es-url']) {
    assert.throws(() => catalog.validarEndpoint(u), (e) => e.httpStatus === 400, u);
  }
});

test('con ARCANUM_CATALOGO_ENDPOINTS_LIBRES=1 (solo pruebas con stubs) acepta cualquier http(s)', () => {
  process.env.ARCANUM_CATALOGO_ENDPOINTS_LIBRES = '1';
  assert.doesNotThrow(() => catalog.validarEndpoint('http://stub-arca:8080/soap'));
  assert.throws(() => catalog.validarEndpoint('ftp://stub-arca/soap'), (e) => e.httpStatus === 400);
});

test('el motor SOAP no usa un endpoint fuera de ARCA aunque ya este guardado en la base', async () => {
  const engine = require('../src/soap/engine');
  const original = catalog.get;
  catalog.get = (id) => (id === 'viejo_malo'
    ? { id, enabled: true, wsaaService: 'wsfe', soapNamespace: 'http://x/', endpoints: { homo: 'http://127.0.0.1:9/soap', prod: 'http://127.0.0.1:9/soap' } }
    : original(id));
  try {
    await assert.rejects(engine.call('viejo_malo', 'Consultar', {}, { cuit: '20111111112' }), (e) => e.httpStatus === 400 || e.httpStatus === 502);
    await assert.rejects(engine.call('viejo_malo', 'Consultar', {}, { cuit: '20111111112' }), /ARCA/);
  } finally { catalog.get = original; }
});

test('activacion.docs solo acepta https (no javascript: ni data:)', () => {
  const base = { id: 'x_docs', wsaaService: 'wsfe', soapNamespace: 'http://x/', endpoints: { homo: 'https://wswhomo.afip.gov.ar/a', prod: 'https://servicios1.afip.gov.ar/a' } };
  assert.throws(() => catalog.validateDef({ ...base, activacion: { docs: 'javascript:alert(1)' } }), (e) => e.httpStatus === 400);
  assert.throws(() => catalog.validateDef({ ...base, activacion: { docs: 'data:text/html,x' } }), (e) => e.httpStatus === 400);
  assert.doesNotThrow(() => catalog.validateDef({ ...base, activacion: { docs: 'https://www.afip.gob.ar/ws/doc.pdf' } }));
});
