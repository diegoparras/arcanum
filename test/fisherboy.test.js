'use strict';

// Cliente de Fisherboy: auth de servicio, errores claros y propagacion de la vista en vivo.
// Contra un servidor HTTP falso en 127.0.0.1, sin red real.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearCliente } = require('../src/services/fisherboy');

function servidorFalso(manejar) {
  return new Promise((resolve) => {
    const pedidos = [];
    const srv = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        pedidos.push({ method: req.method, url: req.url, headers: req.headers, cuerpo });
        manejar(req, res, cuerpo);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, pedidos, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('iniciar manda Bearer y body', async () => {
  const f = await servidorFalso((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'tok-1', estado: 'arrancando' }));
  });
  try {
    const c = crearCliente({ leerConfig: async () => ({ url: f.url, token: 'secreto-fb' }) });
    const r = await c.iniciar({ url: 'https://auth.afip.gob.ar/', receta: [], secretos: { clave_fiscal: 'x' } });
    assert.strictEqual(r.token, 'tok-1');
    assert.strictEqual(f.pedidos[0].url, '/api/agent/start');
    assert.strictEqual(f.pedidos[0].headers.authorization, 'Bearer secreto-fb');
    assert.deepStrictEqual(JSON.parse(f.pedidos[0].cuerpo).secretos, { clave_fiscal: 'x' });
  } finally { f.srv.close(); }
});

test('sin configurar da 503', async () => {
  const c = crearCliente({ leerConfig: async () => ({ url: '', token: '' }) });
  await assert.rejects(c.estado('tok'), (e) => e.httpStatus === 503 && /no está configurado/.test(e.message));
});

test('servidor caido da 503 con mensaje', async () => {
  const c = crearCliente({ leerConfig: async () => ({ url: 'http://127.0.0.1:1', token: 't' }) });
  await assert.rejects(c.estado('tok'), (e) => e.httpStatus === 503 && /No se pudo contactar a Fisherboy/.test(e.message));
});

test('error de Fisherboy se propaga con su detalle', async () => {
  const f = await servidorFalso((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Ya hay 2 sesiones de agente corriendo.' }));
  });
  try {
    const c = crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) });
    await assert.rejects(c.iniciar({ url: 'x', receta: [] }), (e) => e.httpStatus === 429 && /2 sesiones/.test(e.message));
  } finally { f.srv.close(); }
});

test('frame: un 204 (sin pantalla nueva) se propaga con el estado del agente', async () => {
  const f = await servidorFalso((req, res) => {
    res.writeHead(204, { 'X-Agent-Estado': 'corriendo', 'X-Agent-Seq': '7' });
    res.end();
  });
  try {
    const c = crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) });
    const fr = await c.frame('tok', 7);
    assert.strictEqual(fr.status, 204);
    assert.strictEqual(fr.headers['x-agent-estado'], 'corriendo');
    assert.strictEqual(f.pedidos[0].url, '/api/agent/tok/frame?desde=7');
  } finally { f.srv.close(); }
});

test('archivo devuelve bytes y el token del path se escapa', async () => {
  const f = await servidorFalso((req, res) => { res.writeHead(200); res.end(Buffer.from('a;b')); });
  try {
    const c = crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) });
    const b = await c.archivo('to/k', 0);
    assert.strictEqual(b.toString(), 'a;b');
    assert.strictEqual(f.pedidos[0].url, '/api/agent/to%2Fk/files/0');
  } finally { f.srv.close(); }
});

test('configurado: solo con URL y token, sin tocar la red', async () => {
  const con = (cfg) => crearCliente({ leerConfig: async () => cfg }).configurado();
  assert.strictEqual(await con({ url: 'http://fisherboy:8000', token: 'abc' }), true);
  assert.strictEqual(await con({ url: 'http://fisherboy:8000', token: '' }), false);
  assert.strictEqual(await con({ url: '', token: 'abc' }), false);
  assert.strictEqual(await con(null), false);
  const roto = crearCliente({ leerConfig: async () => { throw new Error('sin base'); } });
  assert.strictEqual(await roto.configurado(), false);
});
