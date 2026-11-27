'use strict';

// Conexion con Fisherboy y Factorum (auditoria 2026-11-26, A-07): el token de servicio nunca viaja
// a un host distinto de aquel para el que se cargo.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.ARCANUM_MASTER_KEY = process.env.ARCANUM_MASTER_KEY || crypto.randomBytes(32).toString('hex');
const vault = require('../src/crypto/vault');
const { crearConexion, validarUrlServicio } = require('../src/services/conexiones');

let settings; let avisos;
const db = {
  async query(sql, params = []) {
    if (/^\s*SELECT value FROM settings/i.test(sql)) return { rows: settings.has(params[0]) ? [{ value: settings.get(params[0]) }] : [] };
    if (/^\s*INSERT INTO settings/i.test(sql)) { settings.set(params[0], params[1]); return { rows: [] }; }
    throw new Error('sql inesperado: ' + sql);
  },
};
const webhooks = { emitir: async (ev, d) => { avisos.push([ev, d]); } };
const ENV = {};
const fb = () => crearConexion({ clave: 'fisherboy', nombre: 'Fisherboy', varUrl: 'FB_URL', varToken: 'FB_TOKEN', deps: { db, vault, webhooks, env: ENV } });

beforeEach(() => { settings = new Map(); avisos = []; delete ENV.FB_URL; delete ENV.FB_TOKEN; });

test('URL: internas http (servicio de la red, IP privada) y publicas https se aceptan', () => {
  assert.strictEqual(validarUrlServicio('http://fisherboy:8099/', 'Fisherboy'), 'http://fisherboy:8099');
  assert.strictEqual(validarUrlServicio('http://10.0.1.5:8095', 'Fisherboy'), 'http://10.0.1.5:8095');
  assert.strictEqual(validarUrlServicio('https://fisherboy.ejemplo.com', 'Fisherboy'), 'https://fisherboy.ejemplo.com');
});

test('URL: metadata de la nube, link-local, credenciales en la URL y http publico se rechazan', () => {
  for (const u of ['http://169.254.169.254/latest', 'http://metadata.google.internal', 'http://0.0.0.0:80',
    'https://user:pass@fisherboy.ejemplo.com', 'http://fisherboy.ejemplo.com', 'ftp://fisherboy', 'fisherboy:8099']) {
    assert.throws(() => validarUrlServicio(u, 'Fisherboy'), (e) => e.httpStatus === 400, u);
  }
});

test('cambiar solo la URL a otro host sin token nuevo se rechaza y no cambia nada', async () => {
  await fb().guardar({ url: 'http://fisherboy:8099', token: 'tok-1' }, 'diego');
  await assert.rejects(fb().guardar({ url: 'http://otro:8099' }, 'diego'), (e) => e.httpStatus === 409);
  assert.deepStrictEqual(await fb().leer(), { url: 'http://fisherboy:8099', token: 'tok-1' });
});

test('mismo host (otra ruta o con barra final) conserva el token', async () => {
  await fb().guardar({ url: 'http://fisherboy:8099', token: 'tok-1' }, 'diego');
  await fb().guardar({ url: 'http://fisherboy:8099/' }, 'diego');
  assert.deepStrictEqual(await fb().leer(), { url: 'http://fisherboy:8099', token: 'tok-1' });
});

test('otro host con token nuevo se acepta y avisa por webhook sin el token', async () => {
  await fb().guardar({ url: 'http://fisherboy:8099', token: 'tok-1' }, 'diego');
  await fb().guardar({ url: 'http://fisherboy2:8099', token: 'tok-2' }, 'diego');
  assert.deepStrictEqual(await fb().leer(), { url: 'http://fisherboy2:8099', token: 'tok-2' });
  const [ev, d] = avisos.at(-1);
  assert.strictEqual(ev, 'conexion_cambiada');
  assert.deepStrictEqual({ ...d }, { servicio: 'Fisherboy', antes: 'http://fisherboy:8099', despues: 'http://fisherboy2:8099', tokenCambiado: true, usuario: 'diego' });
  assert.ok(!JSON.stringify(avisos).includes('tok-'));
});

test('se puede borrar el token', async () => {
  await fb().guardar({ url: 'http://fisherboy:8099', token: 'tok-1' }, 'diego');
  await fb().guardar({ borrarToken: true }, 'diego');
  assert.deepStrictEqual(await fb().leer(), { url: 'http://fisherboy:8099', token: '' });
});

test('URL por entorno: no se pisa desde el panel', async () => {
  ENV.FB_URL = 'http://fisherboy:8099'; ENV.FB_TOKEN = 'tok-env';
  await assert.rejects(fb().guardar({ url: 'http://otro:8099', token: 'x' }, 'diego'), (e) => e.httpStatus === 409);
  assert.deepStrictEqual(await fb().leer(), { url: 'http://fisherboy:8099', token: 'tok-env' });
  assert.deepStrictEqual(await fb().config(), { url: 'http://fisherboy:8099', tokenCargado: true, urlDelEntorno: true });
});

test('token por entorno: nunca viaja a una URL que no es la del entorno', async () => {
  ENV.FB_TOKEN = 'tok-env';
  settings.set('fisherboy', JSON.stringify({ url: 'http://otro:8099', tokenCifrado: null })); // config vieja
  assert.deepStrictEqual(await fb().leer(), { url: 'http://otro:8099', token: '' });
  // Y guardar una URL sin token no copia el del entorno a la base.
  await fb().guardar({ url: 'http://otro:8099' }, 'diego');
  assert.ok(!settings.get('fisherboy').includes('tok-env'));
  assert.strictEqual(JSON.parse(settings.get('fisherboy')).tokenCifrado, null);
});
