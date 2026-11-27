'use strict';

// 2.2.1: la sesion federada (Lockatus) guarda el email verificado en la tabla `sesiones`, checkAuth
// lo pone en el principal y /api/auth/me lo devuelve. Una sesion local sigue con el email de su
// ficha. Contra Postgres y el servidor real; corre solo con ARCANUM_TEST_DATABASE_URL:
//   ARCANUM_TEST_DATABASE_URL=postgres://usuario@localhost:5432/arcanum_test npm test

const { test, after } = require('node:test');
const assert = require('node:assert');

const URL_DB = process.env.ARCANUM_TEST_DATABASE_URL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;
const opts = { skip: URL_DB ? false : 'sin ARCANUM_TEST_DATABASE_URL' };

after(async () => { if (URL_DB) await require('../src/db').pool.end(); });

const FED = 'fed-lockatus-221';
const LOCAL = 'local-lockatus-221';

test('Postgres: la sesion federada guarda el email verificado y /api/auth/me lo devuelve; la local, el de su ficha', opts, async () => {
  const db = require('../src/db');
  const users = require('../src/auth/users');
  const sesiones = require('../src/auth/sesiones');
  const session = require('../src/auth/session');
  const { principalDeClaims } = require('../src/auth/oidc');
  const { server } = require('../src/server');
  try {
    await db.migrate();
    await db.query('DELETE FROM usuarios WHERE username = $1', [LOCAL]);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const me = async (cookie) => {
      const r = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 200);
      return (await r.json()).usuario;
    };
    // Lo mismo que hace el callback de OIDC con el principal de exchangeCode.
    const entrarFederado = async (claims) => {
      const p = principalDeClaims(claims);
      const sid = await sesiones.servicio().crear(p, 'oidc');
      return { sid, cookie: `${session.COOKIE}=${session.sign({ ...p, sid, origen: 'oidc' })}` };
    };

    const f = await entrarFederado({ sub: 's-221', preferred_username: FED, email: 'Fed@Lockatus.Test', email_verified: true, role: 'operador' });
    const { rows } = await db.query('SELECT email, origen FROM sesiones WHERE sid = $1', [f.sid]);
    assert.deepStrictEqual(rows, [{ email: 'fed@lockatus.test', origen: 'oidc' }]);
    const u = await me(f.cookie);
    assert.strictEqual(u.username, FED);
    assert.strictEqual(u.origen, 'oidc');
    assert.strictEqual(u.email, 'fed@lockatus.test');
    // La cookie no lleva el email: sale de la sesion registrada.
    assert.ok(!Buffer.from(f.cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8').includes('lockatus.test'));

    // email_verified false: la sesion queda sin email.
    const g = await entrarFederado({ sub: 's-221b', preferred_username: FED, email: 'fed@lockatus.test', email_verified: false });
    assert.strictEqual((await db.query('SELECT email FROM sesiones WHERE sid = $1', [g.sid])).rows[0].email, null);
    assert.strictEqual((await me(g.cookie)).email, null);

    // Sesion local: el email de la ficha, y la fila de la sesion sin email.
    await users.crear({ username: LOCAL, password: 'una-clave-larga-221', role: 'lectura', email: 'local@lockatus.test' });
    const pl = { username: LOCAL, role: 'lectura', email: 'otro@lockatus.test' };
    const sl = await sesiones.servicio().crear(pl, 'local');
    const cl = `${session.COOKIE}=${session.sign({ ...pl, sid: sl, origen: 'local' })}`;
    assert.strictEqual((await db.query('SELECT email FROM sesiones WHERE sid = $1', [sl])).rows[0].email, null);
    const ul = await me(cl);
    assert.strictEqual(ul.origen, 'local');
    assert.strictEqual(ul.email, 'local@lockatus.test');

    // Federado con una ficha del mismo usuario que tiene email: /me muestra el de la ficha (el que
    // va a Factorum), aunque la sesion guarde el de Lockatus.
    const h = await entrarFederado({ sub: 's-221c', preferred_username: LOCAL, email: 'lk@lockatus.test', role: 'lectura' });
    assert.strictEqual((await db.query('SELECT email FROM sesiones WHERE sid = $1', [h.sid])).rows[0].email, 'lk@lockatus.test');
    assert.strictEqual((await me(h.cookie)).email, 'local@lockatus.test');
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok)).catch(() => {});
    await db.query('DELETE FROM usuarios WHERE username = $1', [LOCAL]).catch(() => {});
    await db.query('DELETE FROM sesiones WHERE username = ANY($1)', [[FED, LOCAL]]).catch(() => {});
  }
});
