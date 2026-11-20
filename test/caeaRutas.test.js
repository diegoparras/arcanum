'use strict';

// Rutas de CAEA: config solo admin, punto de venta validado contra ARCA (EmisionTipo CAEA).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/caea');
const { sendError } = require('../src/lib/http');

function deps() {
  const guardado = [];
  const caea = {
    estado: async () => ({ config: null, caeas: [], pendientes: 0 }),
    guardarConfig: async (cuit, c) => { guardado.push([cuit, c]); return { cuit, ...c }; },
    asegurar: async () => [{ estado: 'obtenido' }],
    informarPendientes: async () => ({ informados: 0, errores: 0 }),
    informarSinMovimiento: async () => [],
  };
  const wsfev1 = { getParams: async () => [{ Nro: 3, EmisionTipo: 'CAE', Bloqueado: 'N' }, { Nro: 9, EmisionTipo: 'CAEA', Bloqueado: 'N' }] };
  return { caea, wsfev1, guardado };
}

async function conServidor(principal, d, fn) {
  const manejar = crearRutas(d);
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!(await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal))) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
const put = (base, ruta, b) => fetch(base + ruta, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

test('prender CAEA exige un punto de venta de tipo CAEA', async () => {
  const d = deps();
  await conServidor({ username: 'a', role: 'admin' }, d, async (base) => {
    const mal = await put(base, '/api/caea/20263630743/config', { activo: true, puntoVenta: 3 });
    assert.strictEqual(mal.status, 400);
    assert.match((await mal.json()).error, /CAEA/);
    const ok = await put(base, '/api/caea/20263630743/config', { activo: true, puntoVenta: 9, minutosEspera: 45 });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(d.guardado[0], ['20263630743', { activo: true, puntoVenta: 9, minutosEspera: 45 }]);
  });
});

test('apagar no necesita validar contra ARCA', async () => {
  const d = deps();
  d.wsfev1.getParams = async () => { throw new Error('ARCA caido'); };
  await conServidor({ username: 'a', role: 'admin' }, d, async (base) => {
    assert.strictEqual((await put(base, '/api/caea/20263630743/config', { activo: false })).status, 200);
  });
});

test('operador no cambia la config pero puede pedir el CAEA de su CUIT', async () => {
  const d = deps();
  const op = { username: 'o', role: 'operador', cuitAllow: ['20263630743'] };
  await conServidor(op, d, async (base) => {
    assert.strictEqual((await put(base, '/api/caea/20263630743/config', { activo: false })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/caea/20263630743/solicitar`, { method: 'POST' })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/caea/30711111118/solicitar`, { method: 'POST' })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/caea/20263630743`)).status, 200);
  });
});

test('apagar con pendientes avisa que se van a seguir informando', async () => {
  const d = deps();
  d.caea.estado = async () => ({ config: { activo: true }, caeas: [{ caea: 'X' }], pendientes: 2 });
  await conServidor({ username: 'a', role: 'admin' }, d, async (base) => {
    const r = await (await put(base, '/api/caea/20263630743/config', { activo: false })).json();
    assert.match(r.advertencia, /2 comprobante/);
  });
});
