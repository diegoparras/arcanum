'use strict';

// Tests de las mejoras 0.8: cache del padron, limite y anomalias por clave, vista previa
// de emision, estado de claves y la excepcion de solo lectura. Sin red ni base de datos.

const { test } = require('node:test');
const assert = require('node:assert');

const { crearCache } = require('../src/lib/cacheTtl');
const { crearLimitador, crearDetector } = require('../src/auth/limites');
const { revisarComprobante, cuitValido } = require('../src/services/vistaPrevia');
const { _internos: h } = require('../src/mcp/herramientas');
const apikeys = require('../src/auth/apikeys');
const permisos = require('../src/auth/permisos');
const webhooks = require('../src/services/webhooks');

function reloj(t0 = Date.UTC(2026, 10, 18, 12, 0, 30)) {
  let t = t0;
  const f = () => t;
  f.avanzar = (ms) => { t += ms; };
  return f;
}

// ---------- cache ----------
test('cache: devuelve dentro del TTL y vence despues', () => {
  const ahora = reloj();
  const c = crearCache({ ttlMs: 1000, ahora });
  c.guardar('a', { x: 1 });
  assert.deepStrictEqual(c.leer('a').valor, { x: 1 });
  ahora.avanzar(999);
  assert.ok(c.leer('a'));
  ahora.avanzar(2);
  assert.strictEqual(c.leer('a'), null);
  assert.strictEqual(c.tamano, 0);
});
test('cache: respeta el tope descartando la entrada mas vieja', () => {
  const c = crearCache({ ttlMs: 60000, max: 2, ahora: reloj() });
  c.guardar('a', 1); c.guardar('b', 2); c.guardar('c', 3);
  assert.strictEqual(c.leer('a'), null);
  assert.strictEqual(c.leer('c').valor, 3);
});
test('cache: TTL 0 lo apaga', () => {
  const c = crearCache({ ttlMs: 0 });
  c.guardar('a', 1);
  assert.strictEqual(c.leer('a'), null);
});

// ---------- limite por clave ----------
test('limite: corta al llegar al tope y se libera al minuto siguiente', () => {
  const ahora = reloj();
  const l = crearLimitador({ ahora, porDefecto: 3 });
  assert.ok(l.permitir(1).ok); assert.ok(l.permitir(1).ok); assert.ok(l.permitir(1).ok);
  const r = l.permitir(1);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reintentarEnS > 0 && r.reintentarEnS <= 60);
  assert.ok(l.permitir(2).ok, 'otra clave no se ve afectada');
  ahora.avanzar(60_000);
  assert.ok(l.permitir(1).ok);
});
test('limite: el limite propio de la clave pisa al default', () => {
  const l = crearLimitador({ ahora: reloj(), porDefecto: 100 });
  assert.ok(l.permitir(7, 1).ok);
  assert.strictEqual(l.permitir(7, 1).ok, false);
});
test('limite: default 0 lo desactiva', () => {
  const l = crearLimitador({ ahora: reloj(), porDefecto: 0 });
  for (let i = 0; i < 500; i++) assert.ok(l.permitir(1).ok);
});

// ---------- anomalias ----------
test('anomalias: barrido de CUITs avisa una sola vez por hora', () => {
  const ahora = reloj();
  const d = crearDetector({ ahora, umbrales: { cuitsPorHora: 3, rechazosPorHora: 0 } });
  assert.deepStrictEqual(d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '1' }), []);
  d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '1' }); // repetido no suma
  d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '2' });
  const a = d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '3' });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].motivo, 'muchos_cuits');
  assert.deepStrictEqual(d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '4' }), []);
  ahora.avanzar(3_600_000);
  assert.deepStrictEqual(d.registrar({ id: 1, nombre: 'x', status: 200, cuitConsultado: '9' }), [], 'la hora nueva arranca de cero');
});
test('anomalias: muchos 403/429 avisan', () => {
  const d = crearDetector({ ahora: reloj(), umbrales: { cuitsPorHora: 0, rechazosPorHora: 2 } });
  assert.deepStrictEqual(d.registrar({ id: 5, status: 403 }), []);
  assert.deepStrictEqual(d.registrar({ id: 5, status: 200 }), []);
  assert.strictEqual(d.registrar({ id: 5, status: 429 })[0].motivo, 'muchos_rechazos');
});

// ---------- vista previa (sin red) ----------
const HOY = new Date(2026, 10, 18);
const facturaC = {
  puntoVenta: 3, tipoComprobante: 11, concepto: 1, tipoDocReceptor: 99, nroDocReceptor: '0',
  condicionIvaReceptor: 5, importeNeto: 100, importeIva: 0, importeTotal: 100, idempotencyKey: 'k1',
};
test('vista previa: una Factura C correcta no tiene problemas', () => {
  const r = revisarComprobante(facturaC, { hoy: HOY });
  assert.deepStrictEqual(r.problemas, []);
  assert.strictEqual(r.datos.letra, 'C');
  assert.strictEqual(r.datos.tipoNombre, 'Factura C');
  assert.strictEqual(r.datos.fecha, '2026-11-18');
});
test('vista previa: C con IVA, importes que no cierran y sin condicion IVA', () => {
  const r = revisarComprobante({ ...facturaC, importeIva: 21, importeTotal: 100, condicionIvaReceptor: undefined, alicuotasIva: [{ id: 5, baseImponible: 100, importe: 21 }] }, { hoy: HOY });
  const t = r.problemas.join(' | ');
  assert.match(t, /no cierran/);
  assert.match(t, /no discriminan IVA/);
  assert.match(t, /condicionIvaReceptor/);
});
test('vista previa: Factura A exige CUIT del receptor valido y alicuotas', () => {
  const r = revisarComprobante({ ...facturaC, tipoComprobante: 1, tipoDocReceptor: 96, nroDocReceptor: '12345678', importeNeto: 100, importeIva: 21, importeTotal: 121, condicionIvaReceptor: 1 }, { hoy: HOY });
  const t = r.problemas.join(' | ');
  assert.match(t, /Factura A necesita/);
  assert.match(t, /alicuotasIva/);
  const r2 = revisarComprobante({ ...facturaC, tipoComprobante: 1, tipoDocReceptor: 80, nroDocReceptor: '20111111111', importeNeto: 100, importeIva: 21, importeTotal: 121, condicionIvaReceptor: 1, alicuotasIva: [{ id: 5, baseImponible: 100, importe: 21 }] }, { hoy: HOY });
  assert.match(r2.problemas.join(' | '), /no es valido/);
});
test('vista previa: nota de credito sin comprobante asociado', () => {
  const r = revisarComprobante({ ...facturaC, tipoComprobante: 13 }, { hoy: HOY });
  assert.match(r.problemas.join(' | '), /comprobantesAsociados/);
});
test('vista previa: fecha fuera de la ventana de ARCA', () => {
  const r = revisarComprobante({ ...facturaC, fecha: '2026-11-01' }, { hoy: HOY });
  assert.match(r.problemas.join(' | '), /17 dias/);
  const s = revisarComprobante({ ...facturaC, concepto: 2, fecha: '2026-11-10' }, { hoy: HOY });
  assert.ok(!s.problemas.some((p) => /dias de hoy/.test(p)), 'servicios: hasta 10 dias');
});
test('vista previa: consumidor final grande sin identificar (RG 5866)', () => {
  const r = revisarComprobante({ ...facturaC, importeNeto: 12000000, importeTotal: 12000000 }, { hoy: HOY });
  assert.match(r.problemas.join(' | '), /RG 5866/);
});
test('vista previa: sin clave de idempotencia es advertencia, no problema', () => {
  const r = revisarComprobante({ ...facturaC, idempotencyKey: undefined }, { hoy: HOY });
  assert.deepStrictEqual(r.problemas, []);
  assert.match(r.advertencias.join(' | '), /idempotencyKey/);
});
test('cuitValido: digito verificador', () => {
  assert.strictEqual(cuitValido('20-26363074-3'), true);
  assert.strictEqual(cuitValido('30500010912'), true);
  assert.strictEqual(cuitValido('20263630744'), false);
  assert.strictEqual(cuitValido('123'), false);
});

// ---------- herramientas / claves / permisos ----------
test('e-Ventanilla: estado leida con o sin tilde', () => {
  assert.strictEqual(h.estadoLeida('Leída'), true);
  assert.strictEqual(h.estadoLeida('No leída'), false);
  assert.strictEqual(h.estadoLeida('NO LEIDA'), false);
  assert.strictEqual(h.estadoLeida(null), null);
});
test('claves: estado activa, vencida o dada de baja', () => {
  const ahora = Date.UTC(2026, 10, 18);
  assert.strictEqual(apikeys.estadoDe({}, ahora), 'activa');
  assert.strictEqual(apikeys.estadoDe({ expires_at: new Date(ahora + 1000) }, ahora), 'activa');
  assert.strictEqual(apikeys.estadoDe({ expires_at: new Date(ahora - 1000) }, ahora), 'vencida');
  assert.strictEqual(apikeys.estadoDe({ revoked_at: new Date(ahora - 1), expires_at: new Date(ahora + 1e6) }, ahora), 'dada_de_baja');
});
test('permisos: lectura puede la vista previa (POST que no escribe) pero no emitir', () => {
  const lectura = { role: 'lectura' };
  assert.doesNotThrow(() => permisos.assertPuedeEscribir(lectura, 'POST', '/api/wsfev1/comprobantes/vista-previa'));
  assert.throws(() => permisos.assertPuedeEscribir(lectura, 'POST', '/api/wsfev1/comprobantes'), (e) => e.httpStatus === 403);
  assert.throws(() => permisos.assertPuedeEscribir(lectura, 'PUT', '/api/wsfev1/comprobantes/vista-previa'), (e) => e.httpStatus === 403);
  assert.throws(() => permisos.assertPuedeEscribir(lectura, 'POST', '/api/wsfev1/comprobantes/vista-previa/x'), (e) => e.httpStatus === 403);
});
test('webhooks: eventos nuevos de avisos proactivos', () => {
  for (const e of ['comunicacion_nueva', 'clave_por_vencer', 'clave_anomala', 'arca_caido', 'arca_restablecido']) {
    assert.ok(webhooks.EVENTOS.includes(e), e);
  }
});
