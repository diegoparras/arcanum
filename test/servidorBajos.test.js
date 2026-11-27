'use strict';

// Hallazgos bajos del servidor (auditoria 2026-11-26): B-04 (errores internos), B-06 (Secure),
// B-08 (health sin version) y B-10 (timeouts).

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { sendError } = require('../src/lib/http');
const session = require('../src/auth/session');

let server; let base;
before(async () => {
  ({ server } = require('../src/server'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); });

test('B-04: un 500 no muestra el mensaje interno', () => {
  let cuerpo = '';
  const res = { headersSent: false, writeHead() {}, end(b) { cuerpo = String(b); } };
  sendError(res, new Error('relation "x" does not exist at character 42'));
  assert.doesNotMatch(cuerpo, /relation|character/);
  assert.match(cuerpo, /Error interno/);
});

test('B-04: una cookie mal codificada no da 500 (ni en el panel ni en la API)', async () => {
  const h = { Cookie: 'arcanum_sess=%E0%A4%A; otra=1' };
  assert.strictEqual((await fetch(base + '/', { headers: h })).status, 200);
  assert.strictEqual((await fetch(base + '/api/auth/me', { headers: h })).status, 401);
});

test('B-04: un login con cuerpo null da 400, no 500', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  assert.strictEqual(r.status, 400);
});

test('B-06: la cookie es Secure si el pedido llego por https, aunque ARCA este en homologacion', () => {
  const https = { headers: { 'x-forwarded-proto': 'https' }, socket: {} };
  const http = { headers: {}, socket: {} };
  assert.match(session.cookieHeader('t', https), /Secure/);
  assert.doesNotMatch(session.cookieHeader('t', http), /Secure/);
});

test('B-08: /api/health no dice la version ni el entorno', async () => {
  const j = await (await fetch(base + '/api/health')).json();
  assert.deepStrictEqual(j, { ok: true });
});

test('B-10: el servidor tiene timeouts y tope de conexiones propios', () => {
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 30000);
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 180000);
  assert.ok(server.maxConnections > 0);
});

test('B-08: con alcance por CUIT, las metricas filtran cada consulta por esos CUITs', async () => {
  const db = require('../src/db');
  const catalog = require('../src/catalog');
  const metrics = require('../src/services/metrics');
  const original = db.query; const lista = catalog.list;
  catalog.list = () => [];
  const vistas = [];
  db.query = async (sql, p = []) => { vistas.push([sql, p]); return { rows: [{ hoy: 0, total: 0, monto_hoy: 0, n: 0, por_vencer: 0, vencidos: 0, errores: 0, lat: 0 }] }; };
  try {
    await metrics.resumen({ cuits: ['20111111112'] });
    const sobreDatos = vistas.filter(([sql]) => /FROM (comprobantes|access_tickets|tenants|requests)|LEFT JOIN comprobantes/.test(sql));
    assert.strictEqual(sobreDatos.length, 5);
    for (const [sql, p] of sobreDatos) {
      assert.match(sql, /cuit = ANY\(\$\d::text\[\]\)/, sql);
      assert.ok(p.some((x) => Array.isArray(x) && x[0] === '20111111112'));
    }
  } finally { db.query = original; catalog.list = lista; }
});
