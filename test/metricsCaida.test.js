'use strict';

// /metrics con la base caida (auditoria 2026-11-26, M-02): responde 503 y el proceso sigue vivo.
// Antes escribia las cabeceras antes de consultar y el error posterior tiraba el proceso.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const metrics = require('../src/services/metrics');
const { sendError } = require('../src/lib/http');

let server; let base; const original = metrics.prometheus;
before(async () => {
  ({ server } = require('../src/server'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { metrics.prometheus = original; delete process.env.ARCANUM_METRICS_TOKEN; server.closeAllConnections(); await new Promise((ok) => server.close(ok)); });

test('si la base falla, /metrics da 503 y el servidor sigue respondiendo', async () => {
  metrics.prometheus = async () => { throw new Error('timeout exceeded when trying to connect'); };
  const r = await fetch(base + '/metrics');
  assert.strictEqual(r.status, 503);
  assert.strictEqual((await fetch(base + '/api/health')).status, 200);
});

test('con ARCANUM_METRICS_TOKEN, /metrics exige ese token', async () => {
  metrics.prometheus = async () => 'arcanum_up 1\n';
  process.env.ARCANUM_METRICS_TOKEN = 'scrape-123';
  assert.strictEqual((await fetch(base + '/metrics')).status, 401);
  const ok = await fetch(base + '/metrics', { headers: { Authorization: 'Bearer scrape-123' } });
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /arcanum_up 1/);
});

test('sendError con las cabeceras ya enviadas corta la conexion en vez de tirar', () => {
  let destruida = false;
  const res = { headersSent: true, writeHead() { throw new Error('ERR_HTTP_HEADERS_SENT'); }, end() {}, destroy() { destruida = true; } };
  assert.doesNotThrow(() => sendError(res, new Error('x')));
  assert.strictEqual(destruida, true);
});
