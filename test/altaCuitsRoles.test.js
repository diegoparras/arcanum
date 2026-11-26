'use strict';

// Alta de claves y usuarios (auditoria 2026-11-26, M-10): un CUIT mal tipeado o un rol desconocido
// es un error, no "todos los CUITs" ni "operador" en silencio.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const apikeys = require('../src/auth/apikeys');
const users = require('../src/auth/users');
const { listaCuits } = require('../src/auth/permisos');

const s400 = (e) => e.httpStatus === 400;

test('lista de CUITs: vacia o ausente = sin limite; con cualquier CUIT invalido = 400', () => {
  assert.strictEqual(listaCuits(undefined), null);
  assert.strictEqual(listaCuits(null), null);
  assert.strictEqual(listaCuits([]), null);
  assert.deepStrictEqual(listaCuits(['20-11111111-2', '20111111112', '30711111118']), ['20111111112', '30711111118']);
  assert.throws(() => listaCuits(['2011111111']), (e) => s400(e) && /2011111111/.test(e.message));
  assert.throws(() => listaCuits(['20111111112', 'x']), s400);
  assert.throws(() => listaCuits('20111111112'), s400, 'un string suelto no es una lista');
});

async function conBase(fn) {
  const original = db.query;
  const inserts = [];
  db.query = async (sql, p) => { inserts.push([sql, p]); return { rows: [{ id: 1, nombre: p[0], role: p[2], prefix: 'ak_', cuit_allow: p[4], created_at: new Date() }] }; };
  try { return await fn(inserts); } finally { db.query = original; }
}

test('clave: un CUIT con un digito de menos se rechaza (antes quedaba con acceso a todos)', async () => {
  await conBase(async (ins) => {
    await assert.rejects(apikeys.crear({ nombre: 'x', rol: 'lectura', cuits: ['2011111111'] }), s400);
    assert.strictEqual(ins.length, 0);
  });
});

test('clave: una clave admin con CUITs se rechaza (el rol admin ve todos y el limite no se aplicaria)', async () => {
  await conBase(async () => {
    await assert.rejects(apikeys.crear({ nombre: 'x', rol: 'admin', cuits: ['20111111112'] }), (e) => s400(e) && /admin/.test(e.message));
  });
});

test('usuario: rol desconocido o CUIT invalido se rechazan', async () => {
  await conBase(async (ins) => {
    await assert.rejects(users.crear({ username: 'u', password: 'clave-larga-1', role: 'lector' }), (e) => s400(e) && /rol/i.test(e.message));
    await assert.rejects(users.crear({ username: 'u', password: 'clave-larga-1', role: 'lectura', cuitAllow: ['123'] }), s400);
    await assert.rejects(users.crear({ username: 'u', password: 'clave-larga-1', role: 'admin', cuitAllow: ['20111111112'] }), s400);
    assert.strictEqual(ins.length, 0);
    const u = await users.crear({ username: 'u', password: 'clave-larga-1', role: 'lectura', cuitAllow: ['20-11111111-2'] });
    assert.deepStrictEqual(u, { username: 'u', role: 'lectura', cuitAllow: ['20111111112'] });
  });
});
