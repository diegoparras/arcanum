'use strict';

// B-01 (auditoria 2026-11-26): la guarda SSRF valida la IP a la que realmente se conecta (DNS
// incluido), rechaza nombres de una etiqueta e IPv6 mapeadas, y el webhook no sigue redirecciones.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { assertSafeUrl, ipBloqueada, lookupSeguro } = require('../src/lib/ssrfguard');

test('IPs internas en cualquier forma', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1', '0.0.0.0']) {
    assert.strictEqual(ipBloqueada(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '200.45.1.1', '2800:3f0:4002:800::200e']) assert.strictEqual(ipBloqueada(ip), false, ip);
});

test('URL: nombres de una etiqueta (servicios de la red interna) y [::] / [::ffff:...] se rechazan', () => {
  for (const u of ['http://arcanum-db:5432/', 'http://postgres/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/']) {
    assert.throws(() => assertSafeUrl(u), (e) => e.httpStatus === 400, u);
  }
  assert.doesNotThrow(() => assertSafeUrl('https://hooks.ejemplo.com/x'));
});

test('al conectar se valida la IP resuelta: un nombre publico que resuelve a 127.0.0.1 no pasa', async () => {
  const err = await new Promise((ok) => lookupSeguro('localtest.me', {}, (e) => ok(e)));
  // localtest.me resuelve a 127.0.0.1; sin red, el lookup falla igual (tambien es un rechazo).
  assert.ok(err, 'se permitio conectar a una IP interna');
});

test('el webhook no sigue redirecciones', async () => {
  const webhooks = require('../src/services/webhooks');
  let segundo = 0;
  const destino = http.createServer((q, r) => { segundo += 1; r.end('ok'); });
  const redir = http.createServer((q, r) => { r.writeHead(302, { Location: `http://127.0.0.1:${destino.address().port}/` }); r.end(); });
  await new Promise((ok) => destino.listen(0, '127.0.0.1', ok));
  await new Promise((ok) => redir.listen(0, '127.0.0.1', ok));
  try {
    const r = await webhooks._enviarSinGuarda({ url: `http://127.0.0.1:${redir.address().port}/` }, '{}');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(segundo, 0, 'siguio la redireccion');
  } finally { destino.close(); redir.close(); }
});

test('lookupSeguro: si alguna IP resuelta es interna se rechaza; si todas son publicas, pasa', async () => {
  const dns = require('dns');
  const original = dns.lookup;
  try {
    dns.lookup = (h, o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    const e1 = await new Promise((ok) => lookupSeguro('mixto.ejemplo.com', {}, (e) => ok(e)));
    assert.match(String(e1 && e1.message), /IP interna/);
    dns.lookup = (h, o, cb) => cb(null, [{ address: '200.45.1.1', family: 4 }]);
    const r = await new Promise((ok) => lookupSeguro('bueno.ejemplo.com', {}, (e, ip) => ok([e, ip])));
    assert.deepStrictEqual(r, [null, '200.45.1.1']);
  } finally { dns.lookup = original; }
});
