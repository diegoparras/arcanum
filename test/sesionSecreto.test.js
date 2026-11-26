'use strict';

// Secreto de sesion (C-01 de la auditoria 2026-11-26): sale de ARCANUM_SESSION_SECRET o de un
// archivo generado en el volumen. Nunca de la clave de API ni de la master key.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = ['ARCANUM_SESSION_SECRET', 'ARCANUM_MASTER_KEY', 'ARCANUM_API_KEY', 'ARCANUM_DATA_DIR'];
const previo = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let dir;

function cargar(env = {}) {
  for (const k of ENV) delete process.env[k];
  process.env.ARCANUM_DATA_DIR = dir;
  Object.assign(process.env, env);
  for (const m of ['../src/config', '../src/auth/session']) delete require.cache[require.resolve(m)];
  return require('../src/auth/session');
}

function firmaCon(secreto, token) {
  return crypto.createHmac('sha256', secreto).update(token.split('.')[0]).digest('base64url');
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sesion-')); });
after(() => {
  for (const k of ENV) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; }
  for (const m of ['../src/config', '../src/auth/session']) delete require.cache[require.resolve(m)];
});

test('con ARCANUM_SESSION_SECRET, firma con ese valor', () => {
  const s = cargar({ ARCANUM_SESSION_SECRET: 'x'.repeat(64) });
  const t = s.sign({ username: 'u', role: 'lectura', sid: 'x1', origen: 'local' });
  assert.strictEqual(t.split('.')[1], firmaCon('x'.repeat(64), t));
  assert.deepStrictEqual(s.verify(t), { username: 'u', role: 'lectura', cuitAllow: null, sid: 'x1', origen: 'local' });
});

test('con solo ARCANUM_API_KEY, la clave de API no sirve para forjar sesiones', () => {
  const s = cargar({ ARCANUM_API_KEY: 'clave-de-api-maestra' });
  const t = s.sign({ username: 'u', role: 'superadmin' });
  assert.notStrictEqual(t.split('.')[1], firmaCon('clave-de-api-maestra', t));
  const data = Buffer.from(JSON.stringify({ u: 'x', r: 'superadmin', c: null, exp: Date.now() + 6e4 })).toString('base64url');
  assert.strictEqual(s.verify(`${data}.${firmaCon('clave-de-api-maestra', data + '.')}`), null);
});

test('con solo ARCANUM_MASTER_KEY, la master key no firma sesiones', () => {
  const mk = 'a'.repeat(64);
  const s = cargar({ ARCANUM_MASTER_KEY: mk });
  const t = s.sign({ username: 'u', role: 'superadmin' });
  assert.notStrictEqual(t.split('.')[1], firmaCon(mk, t));
});

test('sin secreto en el entorno, genera uno en el volumen con permisos 0600 y lo reusa al reiniciar', () => {
  const t = cargar().sign({ username: 'u', role: 'operador', sid: 'x2', origen: 'local' });
  const archivo = path.join(dir, 'session-secret');
  assert.ok(fs.existsSync(archivo), 'no se guardo el secreto generado');
  assert.ok(fs.readFileSync(archivo, 'utf8').trim().length >= 64);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(archivo).mode & 0o777, 0o600);
  // "Reinicio": se recarga el modulo y la sesion anterior sigue valiendo.
  assert.deepStrictEqual(cargar().verify(t), { username: 'u', role: 'operador', cuitAllow: null, sid: 'x2', origen: 'local' });
});

test('dos instalaciones sin configurar no comparten secreto', () => {
  const t = cargar().sign({ username: 'u', role: 'superadmin', sid: 'x3' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-sesion-'));
  assert.strictEqual(cargar().verify(t), null);
});
