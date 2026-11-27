'use strict';

// B-16 (auditoria 2026-11-26): sin Factorum configurado, subir un lote o verificar responde 503
// antes de leer y decodificar el cuerpo (hasta 80 MB). El cliente anuncia 100 MB y manda solo un
// pedazo: si el servidor intentara leerlo, no responderia hasta que llegue todo.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/factorum');
const { sendError } = require('../src/lib/http');

function pedidoIncompleto(port, ruta) {
  return new Promise((ok, mal) => {
    const req = http.request({ host: '127.0.0.1', port, path: ruta, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 100 * 1024 * 1024 } }, (res) => { ok(res.statusCode); res.resume(); req.destroy(); });
    req.on('error', () => {});
    req.write('{"archivos":[{"nombre":"a.pdf","contenido_base64":"' + 'x'.repeat(1000));
    setTimeout(() => { req.destroy(); mal(new Error('el servidor espero el cuerpo')); }, 2000);
  });
}

test('POST de lote o verificacion sin Factorum configurado: 503 sin esperar el cuerpo', async () => {
  const factorum = { config: async () => ({ url: '', tokenCargado: false }), LIMITES: { MAX_BODY_LOTE: 2e8, MAX_BODY_VERIFICAR: 2e8 } };
  const manejar = crearRutas({ factorum });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), { username: 'op', role: 'operador', cuitAllow: null });
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    for (const ruta of ['/api/factorum/lotes', '/api/factorum/verificar']) {
      assert.strictEqual(await pedidoIncompleto(srv.address().port, ruta), 503, ruta);
    }
  } finally { srv.closeAllConnections(); srv.close(); }
});
