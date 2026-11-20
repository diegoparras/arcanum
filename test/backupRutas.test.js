'use strict';

// Rutas de backups: solo superadmin; descarga solo de nombres validos.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/backups');
const { sendError } = require('../src/lib/http');

const bk = {
  directorio: () => '/no/existe',
  listar: () => [],
  crear: async () => ({ nombre: 'arcanum-20261120-0300.arcbak', bytes: 10 }),
  ruta: (dir, n) => { if (!/^arcanum-\d{8}-\d{4}\.arcbak$/.test(n)) throw Object.assign(new Error('Nombre de backup invalido'), { httpStatus: 400 }); return `${dir}/${n}`; },
};
const db = { query: async () => ({ rows: [] }) };

async function conServidor(principal, fn) {
  const manejar = crearRutas({ backup: bk, db });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!(await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal))) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('admin no ve ni crea backups', async () => {
  await conServidor({ username: 'a', role: 'admin' }, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/backups`)).status, 403);
    assert.strictEqual((await fetch(`${base}/api/backups`, { method: 'POST' })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/sistema/master-key`)).status, 403);
  });
});

test('superadmin crea; descarga rechaza nombres raros', async () => {
  await conServidor({ username: 's', role: 'superadmin' }, async (base) => {
    assert.strictEqual((await fetch(`${base}/api/backups`, { method: 'POST' })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/backups/..%2F.masterkey`)).status, 400);
    assert.strictEqual((await fetch(`${base}/api/backups/arcanum-20261120-0300.arcbak`)).status, 404);
    const mk = await fetch(`${base}/api/sistema/master-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(mk.status, 400);
  });
});
