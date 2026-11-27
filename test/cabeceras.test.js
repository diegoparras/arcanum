'use strict';

// Cabeceras de seguridad (auditoria 2026-11-26, M-08), contra el servidor real.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

let server; let base;
before(async () => {
  ({ server } = require('../src/server'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); });

test('el panel sale con CSP, no enmarcable y nosniff', async () => {
  const r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(csp, /https?:\/\//, 'el panel no carga nada de otro origen');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('referrer-policy'), 'same-origin');
});

test('la API tambien lleva las cabeceras comunes, y HSTS solo detras de https', async () => {
  const r = await fetch(base + '/api/health');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('strict-transport-security'), null);
  const s = await fetch(base + '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(s.headers.get('strict-transport-security') || '', /max-age=31536000/);
});

test('/docs permite solo el CDN de Redoc', async () => {
  const r = await fetch(base + '/docs');
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self' https:\/\/cdn\.redoc\.ly/);
});
