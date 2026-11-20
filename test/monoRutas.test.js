'use strict';

// Rutas de Monotributo: scope por CUIT y categorias editables solo por superadmin.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/monotributo');
const { sendError } = require('../src/lib/http');

function monoFalso() {
  const m = { llamadas: [] };
  m.topes = async (cuit, o) => { m.llamadas.push([cuit, o]); return { cuit, aplica: true, alerta: 'ok' }; };
  m.categorias = async () => ({ vigencia: '2025-08', topes: { A: 1 } });
  m.guardarCategorias = async (c) => c;
  return m;
}

async function conServidor(principal, mono, fn) {
  const manejar = crearRutas({ mono });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!(await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal))) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('topes respeta el cuit_allow y pasa la categoria indicada', async () => {
  const mono = monoFalso();
  await conServidor({ username: 'l', role: 'lectura', cuitAllow: ['20263630743'] }, mono, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/monotributo/30711111118`)).status, 403);
    const r = await fetch(`${base}/api/monotributo/20263630743?categoria=c`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(mono.llamadas[0], ['20263630743', { categoria: 'C' }]);
  });
});

test('categorias: todos las leen, solo superadmin las cambia', async () => {
  await conServidor({ username: 'a', role: 'admin' }, monoFalso(), async (base) => {
    assert.strictEqual((await fetch(`${base}/api/monotributo/categorias`)).status, 200);
    const put = await fetch(`${base}/api/monotributo/categorias`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"topes":{"A":1}}' });
    assert.strictEqual(put.status, 403);
  });
  await conServidor({ username: 's', role: 'superadmin' }, monoFalso(), async (base) => {
    const put = await fetch(`${base}/api/monotributo/categorias`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"topes":{"A":1}}' });
    assert.strictEqual(put.status, 200);
  });
});
