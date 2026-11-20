'use strict';

// Cola conectada: emitir con contingencia (202 al encolar), y rutas con permisos y scope.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { emitirOEncolar, crearRutas } = require('../src/rutas/cola');
const { SoapError } = require('../src/soap/client');
const { sendError } = require('../src/lib/http');

const timeout = () => Object.assign(new SoapError('Timeout', 504, { tipo: 'timeout' }), { numeroIntentado: 9 });

function colaFalsa() {
  const c = { encolados: [], acciones: [] };
  c.encolar = async (cuit, inv, o) => { c.encolados.push({ cuit, inv, o }); return { id: 3, estado: 'pendiente', cuit }; };
  c.obtener = async (id) => ({ id: Number(id), cuit: '20263630743', estado: 'requiere_humano' });
  c.listar = async (f) => [{ id: 1, cuit: '20263630743', estado: 'pendiente' }, { id: 2, cuit: '30711111118', estado: 'pendiente' }].filter((x) => !f.cuit || x.cuit === f.cuit);
  c.reintentar = async (id, o) => { c.acciones.push(['reintentar', id, o]); return { id, estado: 'emitido' }; };
  c.cancelar = async (id) => { c.acciones.push(['cancelar', id]); return { id, estado: 'cancelado' }; };
  return c;
}

test('con contingencia y ARCA caido, encola y responde 202', async () => {
  const cola = colaFalsa();
  const wsfev1 = { authorizeInvoice: async () => { throw timeout(); } };
  const r = await emitirOEncolar('20263630743', { importeTotal: 1 }, { contingencia: true, usuario: 'u' }, { wsfev1, cola });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.body.encolado, true);
  assert.strictEqual(cola.encolados[0].o.numeroIntentado, 9);
});

test('sin contingencia el error sale como antes', async () => {
  const wsfev1 = { authorizeInvoice: async () => { throw timeout(); } };
  await assert.rejects(emitirOEncolar('20263630743', {}, { contingencia: false }, { wsfev1, cola: colaFalsa() }), (e) => e.httpStatus === 504);
});

test('un rechazo o error de validacion nunca se encola', async () => {
  const cola = colaFalsa();
  const wsfev1 = { authorizeInvoice: async () => { throw new SoapError('Importes no cierran', 422); } };
  await assert.rejects(emitirOEncolar('20263630743', {}, { contingencia: true }, { wsfev1, cola }), (e) => e.httpStatus === 422);
  const ok = await emitirOEncolar('20263630743', {}, { contingencia: true }, { wsfev1: { authorizeInvoice: async () => ({ aprobado: false }) }, cola });
  assert.strictEqual(ok.status, 422);
  assert.strictEqual(cola.encolados.length, 0);
});

async function conServidor(principal, cola, fn) {
  const manejar = crearRutas({ cola });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!(await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal))) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('lectura ve la cola pero no puede reintentar', async () => {
  const cola = colaFalsa();
  await conServidor({ username: 'l', role: 'lectura' }, cola, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/cola`)).status, 200);
    assert.strictEqual((await fetch(`${base}/api/cola/1/reintentar`, { method: 'POST' })).status, 403);
  });
});

test('operador solo ve y opera sus CUIT', async () => {
  const cola = colaFalsa();
  const op = { username: 'o', role: 'operador', cuitAllow: ['30711111118'] };
  await conServidor(op, cola, async (base) => {
    const l = await (await fetch(`${base}/api/cola`)).json();
    assert.deepStrictEqual(l.cola.map((x) => x.id), [2]);
    assert.strictEqual((await fetch(`${base}/api/cola/1/cancelar`, { method: 'POST' })).status, 403);
  });
  await conServidor({ username: 'a', role: 'admin' }, cola, async (base) => {
    const r = await fetch(`${base}/api/cola/1/reintentar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"fechaHoy":true}' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(cola.acciones[0], ['reintentar', 1, { fechaHoy: true }]);
  });
});
