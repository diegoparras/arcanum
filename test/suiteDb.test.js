'use strict';

// Suite Escriba contra Postgres de verdad: la migracion, las claves con el flag de la suite, el
// repositorio SQL (alta, un solo uso, vencimiento) y el login de un usuario desactivado.
// Corre solo con ARCANUM_TEST_DATABASE_URL (una base descartable: crea y borra filas):
//   ARCANUM_TEST_DATABASE_URL=postgres://usuario@localhost:5432/arcanum_test npm test

const { test } = require('node:test');
const assert = require('node:assert');

const URL_DB = process.env.ARCANUM_TEST_DATABASE_URL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;
const opts = { skip: URL_DB ? false : 'sin ARCANUM_TEST_DATABASE_URL' };

test('suite en Postgres: claves, pase de un solo uso, vencido y usuario desactivado', opts, async () => {
  const db = require('../src/db');
  const apikeys = require('../src/auth/apikeys');
  const users = require('../src/auth/users');
  const { crearSuite, repoSql } = require('../src/services/suite');
  try {
    await db.migrate();
    await db.query("DELETE FROM usuarios WHERE email LIKE '%@suite-test.local' OR username LIKE '%@suite-test.local'");
    await db.query("DELETE FROM settings WHERE key = 'suite'");

    // Clave con el flag y tope; con CUITs no se puede topear en admin.
    const k = await apikeys.crear({ nombre: 'Factorum (test)', rol: 'lectura', suite: true });
    assert.strictEqual(k.suite, true);
    assert.strictEqual(k.suiteRolTope, 'operador');
    await assert.rejects(apikeys.crear({ nombre: 'x', rol: 'lectura', cuits: ['30711111118'], suite: true, suiteRolTope: 'admin' }), (e) => e.httpStatus === 400);
    const p = await apikeys.verificar(k.clave);
    assert.strictEqual(p.suite, true);
    assert.strictEqual(p.prefijo, k.clave.slice(0, 10));
    const sin = await apikeys.configurarSuite(k.id, { suite: false });
    assert.strictEqual(sin.suite, false);
    assert.strictEqual((await apikeys.verificar(k.clave)).suite, false);
    await apikeys.configurarSuite(k.id, { suite: true, suiteRolTope: 'superadmin' });
    const rot = await apikeys.rotar(k.id, { graciaDias: 0 });
    assert.strictEqual(rot.suite, true);
    assert.strictEqual(rot.suiteRolTope, 'superadmin');
    const clave = await apikeys.verificar(rot.clave);

    let t = Date.now();
    const suite = crearSuite({ repo: repoSql(db), env: {}, factorum: { config: async () => ({}) }, ahora: () => t });
    await assert.rejects(suite.emitirPase(clave, { app: 'factorum', email: 'nueva@suite-test.local', rol: 'usuario' }), (e) => e.httpStatus === 409);
    await suite.guardarConfig({ urlPublica: 'http://localhost:8094', crearUsuarios: true }, 'test');

    // Alta con origen factorum, sin contrasena utilizable.
    const r = await suite.emitirPase(clave, { app: 'factorum', email: 'Nueva@Suite-Test.local', nombre: 'Nueva', rol: 'usuario', cuits: ['30711111118'] });
    const token = new URL(r.url).searchParams.get('pase');
    const { rows: u } = await db.query("SELECT username, email, role, origen, cuit_allow, pass_hash FROM usuarios WHERE email = 'nueva@suite-test.local'");
    assert.strictEqual(u.length, 1);
    assert.strictEqual(u[0].origen, 'factorum');
    assert.strictEqual(u[0].role, 'operador');
    assert.deepStrictEqual(u[0].cuit_allow, ['30711111118']);
    await assert.rejects(users.login(u[0].username, ''), (e) => e.httpStatus === 401);
    const { rows: guardado } = await db.query('SELECT token_hash FROM suite_pases WHERE token_hash = $1', [require('../src/services/suite').hashPase(token)]);
    assert.strictEqual(guardado.length, 1);
    const { rows: conToken } = await db.query('SELECT count(*)::int AS n FROM suite_pases WHERE token_hash = $1', [token]);
    assert.strictEqual(conToken[0].n, 0);

    // Un solo uso, aunque lleguen dos a la vez.
    const [a, b] = await Promise.all([suite.canjearPase(token), suite.canjearPase(token)]);
    assert.strictEqual([a, b].filter(Boolean).length, 1);
    assert.deepStrictEqual(a || b, { username: 'nueva@suite-test.local', role: 'operador', cuitAllow: ['30711111118'] });

    // Existente: no se escala ni se duplica; vencido a los 60 s.
    const r2 = await suite.emitirPase(clave, { app: 'factorum', email: 'NUEVA@suite-test.local', rol: 'superadmin' });
    t += 61_000;
    assert.strictEqual(await suite.canjearPase(new URL(r2.url).searchParams.get('pase')), null);
    t = Date.now();
    const r3 = await suite.emitirPase(clave, { app: 'factorum', email: 'nueva@suite-test.local', rol: 'superadmin' });
    assert.strictEqual((await suite.canjearPase(new URL(r3.url).searchParams.get('pase'))).role, 'operador');
    const { rows: n } = await db.query("SELECT count(*)::int AS n FROM usuarios WHERE email = 'nueva@suite-test.local'");
    assert.strictEqual(n[0].n, 1);

    // Desactivado: ni pase nuevo ni el que ya tenia, ni login con contrasena.
    const r4 = await suite.emitirPase(clave, { app: 'factorum', email: 'nueva@suite-test.local', rol: 'usuario' });
    await users.actualizar('nueva@suite-test.local', { activo: false }, 'root');
    assert.strictEqual(await suite.canjearPase(new URL(r4.url).searchParams.get('pase')), null);
    await assert.rejects(suite.emitirPase(clave, { app: 'factorum', email: 'nueva@suite-test.local', rol: 'usuario' }), (e) => e.httpStatus === 403);
    await users.crear({ username: 'baja@suite-test.local', password: 'clave-larga-1', role: 'operador' });
    await users.actualizar('baja@suite-test.local', { activo: false }, 'root');
    await assert.rejects(users.login('baja@suite-test.local', 'clave-larga-1'), (e) => e.httpStatus === 403);

    // Auditoria: emitidos, usados y rechazados, sin el token.
    const ev = await suite.auditoria(50);
    for (const e of ['pase_emitido', 'pase_usado', 'pase_rechazado']) assert.ok(ev.some((x) => x.evento === e), e);
    assert.ok(!JSON.stringify(ev).includes(token));
    assert.ok(ev.some((x) => x.clavePrefijo === rot.clave.slice(0, 10)));
  } finally {
    await db.query("DELETE FROM usuarios WHERE email LIKE '%@suite-test.local' OR username LIKE '%@suite-test.local'").catch(() => {});
    await db.query("DELETE FROM api_keys WHERE nombre = 'Factorum (test)'").catch(() => {});
    await db.query("DELETE FROM settings WHERE key = 'suite'").catch(() => {});
    await db.pool.end();
  }
});
