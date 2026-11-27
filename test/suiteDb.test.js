'use strict';

// Suite Escriba contra Postgres de verdad: la migracion, las claves con el flag de la suite, el
// repositorio SQL (alta, un solo uso, vencimiento) y el login de un usuario desactivado. Y la sesion
// que abre un pase, contra el servidor real: es la misma sesion registrada del login (M-06), se
// relee el usuario en cada pedido (desactivado, rol bajado), pasa por el CSRF del panel (M-07) y
// Salir la revoca. Los dos tests van en este archivo para no pisarse los ajustes de la suite.
// Corre solo con ARCANUM_TEST_DATABASE_URL (una base descartable: crea y borra filas):
//   ARCANUM_TEST_DATABASE_URL=postgres://usuario@localhost:5432/arcanum_test npm test

const { test, after } = require('node:test');
const assert = require('node:assert');

const URL_DB = process.env.ARCANUM_TEST_DATABASE_URL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;
const opts = { skip: URL_DB ? false : 'sin ARCANUM_TEST_DATABASE_URL' };

after(async () => { if (URL_DB) await require('../src/db').pool.end(); });

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
  }
});

const EMAIL = 'pase@suite-sesion.local';

test('suite en Postgres: la sesion de un pase es revocable, se relee y pasa por CSRF', opts, async () => {
  const db = require('../src/db');
  const apikeys = require('../src/auth/apikeys');
  const users = require('../src/auth/users');
  const sesiones = require('../src/auth/sesiones');
  const { server } = require('../src/server');
  let k;
  try {
    await db.migrate();
    await db.query("DELETE FROM usuarios WHERE username LIKE '%@suite-sesion.local'");
    await db.query("INSERT INTO settings (key, value) VALUES ('suite', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ urlPublica: 'http://arcanum.ejemplo.com', crearUsuarios: true })]);
    k = await apikeys.crear({ nombre: 'Suite sesion (test)', rol: 'lectura', suite: true, suiteRolTope: 'operador' });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;

    const pedirPase = async (headers = { Authorization: `Bearer ${k.clave}` }) => fetch(`${base}/api/suite/pase`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ app: 'factorum', email: EMAIL, nombre: 'Pase', rol: 'usuario' }),
    });
    const entrar = async () => {
      const r = await pedirPase();
      assert.strictEqual(r.status, 200);
      const u = new URL((await r.json()).url);
      const e = await fetch(`${base}${u.pathname}${u.search}`, { redirect: 'manual' });
      assert.strictEqual(e.headers.get('location'), '/');
      return e.headers.get('set-cookie').split(';')[0];
    };
    const me = (cookie) => fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });

    // Con la cookie sola no se pide un pase: hace falta la clave.
    const cookie = await entrar();
    assert.strictEqual((await pedirPase({ Cookie: cookie })).status, 401);

    // La sesion quedo registrada con origen suite.
    const { rows: s } = await db.query("SELECT origen FROM sesiones WHERE username = $1 AND revocada_at IS NULL", [EMAIL]);
    assert.deepStrictEqual(s.map((x) => x.origen), ['suite']);
    const r = await me(cookie);
    assert.strictEqual(r.status, 200);
    const u = (await r.json()).usuario;
    assert.strictEqual(u.role, 'operador');
    assert.strictEqual(u.origen, 'suite');

    // Le bajan el rol en Arcanum: se nota al instante. Subirlo no supera lo que dio el pase.
    await users.actualizar(EMAIL, { role: 'lectura' }, 'root');
    sesiones.servicio().olvidarUsuario(EMAIL);
    assert.strictEqual((await (await me(cookie)).json()).usuario.role, 'lectura');
    await users.actualizar(EMAIL, { role: 'admin' }, 'root');
    sesiones.servicio().olvidarUsuario(EMAIL);
    assert.strictEqual((await (await me(cookie)).json()).usuario.role, 'operador');

    // CSRF: abrir otra app desde un sitio ajeno, o con un cuerpo que no es JSON, se rechaza.
    const abrir = (headers, body = '{}') => fetch(`${base}/api/suite/abrir/factorum`, { method: 'POST', headers: { Cookie: cookie, ...headers }, body });
    assert.strictEqual((await abrir({ 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' })).status, 403);
    assert.strictEqual((await abrir({ 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' })).status, 415);

    // Sin contrasena: no entra por el login normal, con ninguna.
    for (const pw of ['', '!suite', 'una-clave-cualquiera']) {
      const l = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: EMAIL, password: pw }) });
      assert.strictEqual(l.status, 401);
    }
    await assert.rejects(users.cambiarClave(EMAIL, '!suite', 'otra-clave-larga-1'), (e) => e.httpStatus === 401);

    // Desactivado: la sesion abierta muere (la fila queda revocada) y no hay pase nuevo.
    await users.actualizar(EMAIL, { activo: false }, 'root');
    sesiones.servicio().olvidarUsuario(EMAIL);
    assert.strictEqual((await me(cookie)).status, 401);
    const { rows: rev } = await db.query('SELECT count(*)::int AS n FROM sesiones WHERE username = $1 AND revocada_at IS NULL', [EMAIL]);
    assert.strictEqual(rev[0].n, 0);
    assert.strictEqual((await pedirPase()).status, 403);

    // Reactivado: entra con un pase nuevo y Salir revoca esa sesion en el servidor.
    await users.actualizar(EMAIL, { activo: true }, 'root');
    sesiones.servicio().olvidarUsuario(EMAIL);
    const c2 = await entrar();
    assert.strictEqual((await me(c2)).status, 200);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: c2 } });
    assert.strictEqual((await me(c2)).status, 401);

    // Borrado: tampoco.
    const c3 = await entrar();
    await users.borrar(EMAIL, 'root');
    sesiones.servicio().olvidarUsuario(EMAIL);
    assert.strictEqual((await me(c3)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok)).catch(() => {});
    await db.query("DELETE FROM usuarios WHERE username LIKE '%@suite-sesion.local'").catch(() => {});
    await db.query("DELETE FROM sesiones WHERE username LIKE '%@suite-sesion.local'").catch(() => {});
    await db.query("DELETE FROM api_keys WHERE nombre = 'Suite sesion (test)'").catch(() => {});
    await db.query("DELETE FROM settings WHERE key = 'suite'").catch(() => {});
  }
});
