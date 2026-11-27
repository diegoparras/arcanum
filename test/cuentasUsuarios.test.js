'use strict';

// Cuentas locales (auditoria 2026-11-26, B-07): largo minimo, cambio de contrasena, baja de
// usuarios y cambio obligatorio de la contrasena generada al instalar.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const users = require('../src/auth/users');

const s = (code) => (e) => e.httpStatus === code;

function baseFalsa(inicial = []) {
  const filas = new Map(inicial.map((u) => [u.username, { ...u }]));
  const revocadas = [];
  const original = db.query;
  db.query = async (sql, p = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO usuarios/.test(q)) {
      if (filas.has(p[0])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      filas.set(p[0], { username: p[0], pass_hash: p[1], role: p[2], cuit_allow: p[3] || null, debe_cambiar: !!p[4] });
      return { rows: [] };
    }
    if (/^SELECT username, pass_hash/.test(q)) { const u = filas.get(p[0]); return { rows: u ? [u] : [] }; }
    if (/^UPDATE usuarios SET last_login/.test(q)) return { rows: [] };
    if (/^UPDATE usuarios SET pass_hash/.test(q)) { const u = filas.get(p[0]); u.pass_hash = p[1]; u.debe_cambiar = false; return { rows: [] }; }
    if (/^SELECT count\(\*\)::int AS n FROM usuarios WHERE role = 'superadmin'/.test(q)) return { rows: [{ n: [...filas.values()].filter((u) => u.role === 'superadmin').length }] };
    if (/^SELECT role FROM usuarios WHERE username/.test(q)) { const u = filas.get(p[0]); return { rows: u ? [{ role: u.role }] : [] }; }
    if (/^DELETE FROM usuarios/.test(q)) { filas.delete(p[0]); return { rows: [], rowCount: 1 }; }
    if (/^UPDATE sesiones SET revocada_at/.test(q)) { revocadas.push(p); return { rows: [] }; }
    throw new Error('sql inesperado: ' + q);
  };
  return { filas, revocadas, restaurar: () => { db.query = original; } };
}

test('crear: contrasena de menos de 12 caracteres o igual al usuario se rechaza', async () => {
  const b = baseFalsa();
  try {
    await assert.rejects(users.crear({ username: 'ana', password: 'corta', role: 'lectura' }), s(400));
    await assert.rejects(users.crear({ username: 'anastasia123', password: 'anastasia123', role: 'lectura' }), s(400));
    await users.crear({ username: 'ana', password: 'una-clave-larga', role: 'lectura' });
    assert.ok(b.filas.has('ana'));
  } finally { b.restaurar(); }
});

test('cambiar contrasena: exige la actual, valida la nueva y cierra las otras sesiones', async () => {
  const b = baseFalsa([{ username: 'ana', pass_hash: users.hashPassword('clave-vieja-123'), role: 'admin', debe_cambiar: true }]);
  try {
    await assert.rejects(users.cambiarClave('ana', 'mal', 'clave-nueva-456', 'sid-1'), s(401));
    await assert.rejects(users.cambiarClave('ana', 'clave-vieja-123', 'corta', 'sid-1'), s(400));
    await users.cambiarClave('ana', 'clave-vieja-123', 'clave-nueva-456', 'sid-1');
    assert.ok(users.verifyPassword('clave-nueva-456', b.filas.get('ana').pass_hash));
    assert.strictEqual(b.filas.get('ana').debe_cambiar, false);
    assert.deepStrictEqual(b.revocadas.at(-1), ['ana', 'sid-1'], 'revoca las otras sesiones, no la actual');
  } finally { b.restaurar(); }
});

test('login informa si hay que cambiar la contrasena', async () => {
  const b = baseFalsa([{ username: 'admin', pass_hash: users.hashPassword('generada-123456'), role: 'superadmin', debe_cambiar: true }]);
  try {
    const p = await users.login('admin', 'generada-123456');
    assert.strictEqual(p.debeCambiar, true);
  } finally { b.restaurar(); }
});

test('borrar usuario: no a uno mismo, no al ultimo superadmin, y corta sus sesiones', async () => {
  const b = baseFalsa([
    { username: 'jefe', pass_hash: 'x', role: 'superadmin' },
    { username: 'ana', pass_hash: 'x', role: 'operador' },
  ]);
  try {
    await assert.rejects(users.borrar('jefe', 'jefe'), s(409));
    await assert.rejects(users.borrar('nadie', 'jefe'), s(404));
    await users.borrar('ana', 'jefe');
    assert.ok(!b.filas.has('ana'));
    assert.deepStrictEqual(b.revocadas.at(-1), ['ana']);
    b.filas.set('otro', { username: 'otro', pass_hash: 'x', role: 'superadmin' });
    await users.borrar('otro', 'jefe');
    b.filas.set('ultimo', { username: 'ultimo', pass_hash: 'x', role: 'admin' });
    await assert.rejects(users.borrar('jefe', 'ultimo'), s(409), 'no se borra al ultimo superadmin');
  } finally { b.restaurar(); }
});
