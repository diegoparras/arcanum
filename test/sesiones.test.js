'use strict';

// Sesiones con estado (auditoria 2026-11-26, M-06): el logout revoca la cookie en el servidor y el
// rol de un usuario local se relee de la base.

const { test } = require('node:test');
const assert = require('node:assert');

const { crearSesiones } = require('../src/auth/sesiones');
const session = require('../src/auth/session');

function baseFalsa() {
  const sesiones = new Map();
  const usuarios = new Map([['ana', { username: 'ana', role: 'admin', cuit_allow: null }]]);
  const db = {
    async query(sql, p = []) {
      if (/^INSERT INTO sesiones/.test(sql)) { sesiones.set(p[0], { username: p[1], origen: p[2], email: p[4] || null, revocada: false }); return { rows: [] }; }
      if (/^DELETE FROM sesiones/.test(sql)) return { rows: [] };
      if (/^SELECT email FROM sesiones/.test(sql)) { const s = sesiones.get(p[0]); return { rows: s && !s.revocada ? [{ email: s.email }] : [] }; }
      if (/^UPDATE sesiones SET revocada_at/.test(sql)) { const s = sesiones.get(p[0]); if (s) s.revocada = true; return { rows: [] }; }
      if (/FROM usuarios/.test(sql)) { const u = usuarios.get(p[0]); return { rows: u ? [u] : [] }; }
      throw new Error('sql inesperado ' + sql);
    },
  };
  return { db, sesiones, usuarios };
}

test('una sesion creada esta vigente; revocada deja de estarlo aunque la cookie siga siendo valida', async () => {
  const b = baseFalsa();
  const s = crearSesiones({ db: b.db });
  const sid = await s.crear({ username: 'ana' }, 'local');
  assert.strictEqual(await s.vigente(sid), true);
  await s.revocar(sid);
  assert.strictEqual(await s.vigente(sid), false);
});

test('la revocacion hecha por otra instancia se nota cuando vence el cache', async () => {
  const b = baseFalsa();
  let t = 1000;
  const s = crearSesiones({ db: b.db, ahora: () => t, cacheMs: 30000 });
  const sid = await s.crear({ username: 'ana' }, 'local');
  b.sesiones.get(sid).revocada = true; // revocada "desde afuera"
  assert.strictEqual(await s.vigente(sid), true, 'dentro del cache sigue la respuesta anterior');
  t += 31000;
  assert.strictEqual(await s.vigente(sid), false);
});

test('olvidarUsuario descarta el cache: un cambio en la base se ve al instante', async () => {
  const b = baseFalsa();
  const s = crearSesiones({ db: b.db, ahora: () => 0 });
  await s.usuarioLocal('ana');
  b.usuarios.set('ana', { username: 'ana', role: 'lectura', cuit_allow: null, debe_cambiar: false });
  s.olvidarUsuario('ana');
  assert.strictEqual((await s.usuarioLocal('ana')).role, 'lectura');
});

test('un sid inexistente o vacio no esta vigente', async () => {
  const s = crearSesiones({ db: baseFalsa().db });
  assert.strictEqual(await s.vigente('no-existe'), false);
  assert.strictEqual(await s.vigente(null), false);
});

test('el rol de un usuario local sale de la base, y un usuario borrado devuelve null', async () => {
  const b = baseFalsa();
  let t = 0;
  const s = crearSesiones({ db: b.db, ahora: () => t });
  assert.deepStrictEqual(await s.usuarioLocal('ana'), { role: 'admin', cuitAllow: null, debeCambiar: false });
  b.usuarios.set('ana', { username: 'ana', role: 'lectura', cuit_allow: ['20111111112'] });
  t += 31000;
  assert.deepStrictEqual(await s.usuarioLocal('ana'), { role: 'lectura', cuitAllow: ['20111111112'], debeCambiar: false });
  b.usuarios.delete('ana');
  t += 31000;
  assert.strictEqual(await s.usuarioLocal('ana'), null);
});

test('la cookie lleva el identificador de sesion y el origen; sin identificador no vale', () => {
  const t = session.sign({ username: 'ana', role: 'admin', sid: 'abc', origen: 'local' });
  assert.deepStrictEqual(session.verify(t), { username: 'ana', role: 'admin', cuitAllow: null, sid: 'abc', origen: 'local' });
  const vieja = session.sign({ username: 'ana', role: 'admin' });
  assert.strictEqual(session.verify(vieja), null, 'una cookie sin sid (de antes de 2.1.14) no vale');
});

test('2.2.1: la sesion federada guarda el email verificado; las demas no', async () => {
  const b = baseFalsa();
  let t = 0;
  const s = crearSesiones({ db: b.db, ahora: () => t });
  const fed = await s.crear({ username: 'diegoparras', email: 'diego@ejemplo.com' }, 'oidc');
  assert.strictEqual(await s.emailFederado(fed), 'diego@ejemplo.com');
  assert.strictEqual(b.sesiones.get(fed).email, 'diego@ejemplo.com');
  // Pasado el cache, se lee de la base.
  t += 31000;
  assert.strictEqual(await s.emailFederado(fed), 'diego@ejemplo.com');
  // Una sesion local (o de un pase) no guarda email aunque el principal traiga uno.
  const loc = await s.crear({ username: 'ana', email: 'ana@otro.com' }, 'local');
  const pase = await s.crear({ username: 'x@b.com', email: 'x@b.com' }, 'suite');
  assert.strictEqual(b.sesiones.get(loc).email, null);
  assert.strictEqual(b.sesiones.get(pase).email, null);
  assert.strictEqual(await s.emailFederado(loc), null);
  // Federada sin email, revocada o inexistente: null.
  const sinMail = await s.crear({ username: 'sub-1' }, 'oidc');
  assert.strictEqual(await s.emailFederado(sinMail), null);
  await s.revocar(fed);
  assert.strictEqual(await s.emailFederado(fed), null);
  assert.strictEqual(await s.emailFederado('no-existe'), null);
});

test('2.2.1: el usuario local trae el email de la ficha si lo tiene', async () => {
  const b = baseFalsa();
  b.usuarios.set('beto', { username: 'beto', role: 'operador', cuit_allow: null, email: 'beto@b.com' });
  const s = crearSesiones({ db: b.db, ahora: () => 0 });
  assert.deepStrictEqual(await s.usuarioLocal('beto'), { role: 'operador', cuitAllow: null, debeCambiar: false, email: 'beto@b.com' });
  assert.strictEqual((await s.usuarioLocal('ana')).email, undefined);
});
