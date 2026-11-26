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
      if (/^INSERT INTO sesiones/.test(sql)) { sesiones.set(p[0], { username: p[1], origen: p[2], revocada: false }); return { rows: [] }; }
      if (/^DELETE FROM sesiones/.test(sql)) return { rows: [] };
      if (/^SELECT 1 FROM sesiones/.test(sql)) { const s = sesiones.get(p[0]); return { rows: s && !s.revocada ? [{}] : [] }; }
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

test('un sid inexistente o vacio no esta vigente', async () => {
  const s = crearSesiones({ db: baseFalsa().db });
  assert.strictEqual(await s.vigente('no-existe'), false);
  assert.strictEqual(await s.vigente(null), false);
});

test('el rol de un usuario local sale de la base, y un usuario borrado devuelve null', async () => {
  const b = baseFalsa();
  let t = 0;
  const s = crearSesiones({ db: b.db, ahora: () => t });
  assert.deepStrictEqual(await s.usuarioLocal('ana'), { role: 'admin', cuitAllow: null });
  b.usuarios.set('ana', { username: 'ana', role: 'lectura', cuit_allow: ['20111111112'] });
  t += 31000;
  assert.deepStrictEqual(await s.usuarioLocal('ana'), { role: 'lectura', cuitAllow: ['20111111112'] });
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
