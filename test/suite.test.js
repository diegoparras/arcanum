'use strict';

// Suite Escriba: pase entre apps (docs/suite-pase.md). Receptora (Factorum -> Arcanum): reglas de
// rol, CUITs, alta, un solo uso y vencimiento. Origen (Arcanum -> Factorum): el pedido que se arma
// contra un Factorum falso (servidor HTTP real en 127.0.0.1) y el healthz cacheado. Rutas: quien
// puede pedir un pase, la sesion que abre /suite/entrar y la excepcion del rol lectura.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearSuite, topear, intersecar, hashPase, MSG } = require('../src/services/suite');
const { crearRutas } = require('../src/rutas/suite');
const { crearCliente } = require('../src/services/factorum');
const { assertPuedeEscribir } = require('../src/auth/permisos');
const { normSuite } = require('../src/auth/apikeys');
const session = require('../src/auth/session');
const { sendError } = require('../src/lib/http');

const A = '30711111118';
const B = '20222222223';
const C = '20333333334';

/** El mismo contrato que repoSql, en memoria. */
function repoMemoria({ usuarios = [], ajustes = {} } = {}) {
  const r = { usuarios: usuarios.map((u, i) => ({ id: i + 1, activo: true, origen: 'local', cuit_allow: null, email: null, nombre: null, ...u })), pases: [], eventos: [], ajustes: { ...ajustes } };
  r.leerAjustes = async () => ({ ...r.ajustes });
  r.guardarAjustes = async (v) => { r.ajustes = { ...v }; };
  r.usuarioPorEmail = async (email) => {
    const e = email.toLowerCase();
    return r.usuarios.find((u) => u.email && u.email.toLowerCase() === e)
      || r.usuarios.find((u) => !u.email && u.username.toLowerCase() === e) || null;
  };
  r.usuarioPorNombre = async (n) => r.usuarios.find((u) => u.username === n) || null;
  r.crearUsuario = async ({ email, nombre, role, cuitAllow, origen }) => {
    if (r.usuarios.some((u) => u.username === email || (u.email && u.email.toLowerCase() === email))) return null;
    const u = { id: r.usuarios.length + 1, username: email, email, nombre, role, cuit_allow: cuitAllow, origen, activo: true };
    r.usuarios.push(u);
    return u;
  };
  r.guardarPase = async (p) => { r.pases.push({ ...p, usado: false }); };
  r.canjearPase = async (h, ahora) => {
    const p = r.pases.find((x) => x.tokenHash === h && !x.usado && x.vence.getTime() > ahora.getTime());
    if (!p) return null;
    p.usado = true;
    const u = r.usuarios.find((x) => x.username === p.username);
    return {
      app: p.app, email: p.email, username: p.username, role: p.role, cuit_allow: p.cuitAllow, clave_id: p.claveId,
      existe: !!u, activo: u ? u.activo !== false : false, debe_cambiar: !!(u && u.debe_cambiar),
    };
  };
  r.buscarPase = async (h) => {
    const p = r.pases.find((x) => x.tokenHash === h);
    return p ? { app: p.app, email: p.email, username: p.username, clave_id: p.claveId, usado_at: p.usado ? new Date() : null } : null;
  };
  r.auditar = async (e) => { r.eventos.push(e); };
  r.auditoria = async () => r.eventos.slice().reverse();
  return r;
}

const URL_PUB = 'https://arcanum.ejemplo.com';
const claveSuite = (extra = {}) => ({ username: 'clave:Factorum', role: 'lectura', via: 'clave', claveId: 7, prefijo: 'ark_1a2b3c', suite: true, suiteRolTope: 'operador', cuitAllow: null, ...extra });
const tokenDe = (url) => new URL(url).searchParams.get('pase');

function armar({ usuarios, ajustes = { urlPublica: URL_PUB }, env = {}, factorum } = {}) {
  let t = Date.parse('2026-11-27T12:00:00Z');
  const repo = repoMemoria({ usuarios, ajustes });
  const suite = crearSuite({ repo, env, factorum, ahora: () => t });
  return { repo, suite, avanzar: (ms) => { t += ms; } };
}

test('suite: topear e intersecar CUITs', () => {
  assert.strictEqual(topear('superadmin', 'operador'), 'operador');
  assert.strictEqual(topear('lectura', 'admin'), 'lectura');
  assert.strictEqual(topear('operador', 'operador'), 'operador');
  assert.strictEqual(topear('usuario', 'operador'), null);
  assert.deepStrictEqual(intersecar(null, null), null);
  assert.deepStrictEqual(intersecar([A, C], null), [A, C]);
  assert.deepStrictEqual(intersecar(null, [A, B]), [A, B]);
  assert.deepStrictEqual(intersecar([A, C], [A, B]), [A]);
  assert.deepStrictEqual(intersecar([C], [A, B]), []);
});

test('suite: pase valido abre la sesion con el usuario, el rol y los CUITs que decide Arcanum', async () => {
  const { repo, suite } = armar();
  const r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'Diego@Ejemplo.com', nombre: 'Diego', rol: 'usuario', cuits: [B] }, { ip: '10.0.0.1' });
  assert.strictEqual(r.ok, true);
  assert.match(r.url, /^https:\/\/arcanum\.ejemplo\.com\/suite\/entrar\?pase=[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(r.vence, '2026-11-27T12:01:00.000Z');
  const token = tokenDe(r.url);
  assert.strictEqual(Buffer.from(token, 'base64url').length, 32);
  // En la base, solo el SHA-256 del token.
  assert.strictEqual(repo.pases.length, 1);
  assert.strictEqual(repo.pases[0].tokenHash, hashPase(token));
  assert.ok(!JSON.stringify(repo.pases).includes(token));
  // Usuario nuevo con origen factorum, sin distinguir mayusculas en el email.
  const u = repo.usuarios.find((x) => x.email === 'diego@ejemplo.com');
  assert.ok(u);
  assert.strictEqual(u.origen, 'factorum');
  assert.strictEqual(u.role, 'operador');
  assert.deepStrictEqual(u.cuit_allow, [B]);
  const p = await suite.canjearPase(token, { ip: '10.0.0.2' });
  assert.deepStrictEqual(p, { username: 'diego@ejemplo.com', role: 'operador', cuitAllow: [B] });
  // Auditoria: emitido y usado, con email, app, prefijo de la clave y rol; nunca el token.
  const ev = repo.eventos.map((e) => e.evento);
  assert.deepStrictEqual(ev, ['pase_emitido', 'pase_usado']);
  assert.strictEqual(repo.eventos[0].email, 'diego@ejemplo.com');
  assert.strictEqual(repo.eventos[0].app, 'factorum');
  assert.strictEqual(repo.eventos[0].clavePrefijo, 'ark_1a2b3c');
  assert.strictEqual(repo.eventos[0].rol, 'operador');
  assert.ok(!JSON.stringify(repo.eventos).includes(token));
});

test('suite: pase vencido a los 60 s', async () => {
  const { suite, avanzar } = armar();
  const r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'a@b.com', rol: 'lectura' });
  avanzar(60_001);
  assert.strictEqual(await suite.canjearPase(tokenDe(r.url)), null);
});

test('suite: un pase se usa una sola vez', async () => {
  const { repo, suite, avanzar } = armar();
  const r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'a@b.com', rol: 'lectura' });
  avanzar(59_000);
  assert.ok(await suite.canjearPase(tokenDe(r.url)));
  assert.strictEqual(await suite.canjearPase(tokenDe(r.url)), null);
  assert.strictEqual(await suite.canjearPase('no-es-un-pase'), null);
  assert.strictEqual(await suite.canjearPase('A'.repeat(43)), null); // bien formado, pero nunca existio
  // El reuso queda anotado con la persona; los anonimos (mal formado o inexistente) no dejan fila (M-12).
  const rech = repo.eventos.filter((e) => e.evento === 'pase_rechazado');
  assert.strictEqual(rech.length, 1);
  assert.strictEqual(rech[0].email, 'a@b.com');
  assert.strictEqual(rech[0].detalle, 'pase ya usado');
});

test('suite: un pase reusado en un loop no llena la auditoria', async () => {
  const { repo, suite } = armar();
  const r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'a@b.com', rol: 'lectura' });
  assert.ok(await suite.canjearPase(tokenDe(r.url)));
  for (let i = 0; i < 100; i++) assert.strictEqual(await suite.canjearPase(tokenDe(r.url)), null);
  assert.strictEqual(repo.eventos.filter((e) => e.evento === 'pase_rechazado').length, 30);
});

test('suite: un usuario borrado despues de emitir el pase no entra con el', async () => {
  const { repo, suite } = armar({ usuarios: [{ username: 'ana', email: 'ana@b.com', role: 'operador' }] });
  const r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'ana@b.com', rol: 'usuario' });
  repo.usuarios.length = 0;
  assert.strictEqual(await suite.canjearPase(tokenDe(r.url)), null);
  assert.ok(repo.eventos.some((e) => e.evento === 'pase_rechazado' && e.detalle === 'el usuario ya no existe'));
});

test('suite: quien tiene pendiente cambiar la contrasena inicial no entra con un pase', async () => {
  const { repo, suite } = armar({ usuarios: [{ username: 'admin', email: 'admin@b.com', role: 'superadmin', debe_cambiar: true }] });
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'admin@b.com', rol: 'superadmin' }), (e) => e.httpStatus === 403 && e.message === MSG.debeCambiar);
  assert.strictEqual(repo.pases.length, 0);
});

test('suite: el alta por un pase valida como un alta a mano (CUITs, email, usuario y admin sin lista)', async () => {
  const { repo, suite } = armar();
  // Un CUIT mal formado es un 400, nunca se descarta en silencio (M-10).
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'x@b.com', rol: 'usuario', cuits: [B, '123'] }), (e) => e.httpStatus === 400);
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'x@b.com', rol: 'usuario', cuits: 'todos' }), (e) => e.httpStatus === 400);
  // Email con caracteres que no van en una direccion.
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: '"<img>"@b.com', rol: 'usuario' }), (e) => e.httpStatus === 400);
  // El usuario de Arcanum es el email: hasta 64 caracteres, como en un alta a mano.
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: `${'a'.repeat(60)}@b.com`, rol: 'usuario' }), (e) => e.httpStatus === 403 && e.message === MSG.emailLargo);
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'x@b.com', rol: '__proto__' }), (e) => e.httpStatus === 403);
  assert.strictEqual(repo.usuarios.length, 0);
  // admin con una lista de CUITs no existe en Arcanum: entra como operador con esa lista.
  const r = await suite.emitirPase(claveSuite({ suiteRolTope: 'superadmin' }), { app: 'factorum', email: 'jefa@b.com', rol: 'admin', cuits: [B] });
  assert.deepStrictEqual(await suite.canjearPase(tokenDe(r.url)), { username: 'jefa@b.com', role: 'operador', cuitAllow: [B] });
  assert.strictEqual(repo.usuarios[0].role, 'operador');
});

test('suite: una clave sin el flag (o la maestra) no da pases', async () => {
  const { repo, suite } = armar();
  for (const clave of [claveSuite({ suite: false }), { username: 'apikey', role: 'admin', via: 'maestra' }]) {
    await assert.rejects(
      suite.emitirPase(clave, { app: 'factorum', email: 'a@b.com', rol: 'admin' }),
      (e) => e.httpStatus === 403 && e.message === 'Esta clave no está habilitada para abrir sesiones de la suite',
    );
  }
  assert.strictEqual(repo.usuarios.length, 0);
  assert.strictEqual(repo.pases.length, 0);
  assert.ok(repo.eventos.every((e) => e.evento === 'pase_rechazado'));
});

test('suite: el rol queda topeado por la clave (y el usuario nuevo se guarda topeado)', async () => {
  const { repo, suite } = armar();
  let r = await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'jefe@b.com', rol: 'superadmin' });
  assert.strictEqual((await suite.canjearPase(tokenDe(r.url))).role, 'operador');
  assert.strictEqual(repo.usuarios[0].role, 'operador');
  // Tope superadmin puesto a proposito: llega como superadmin.
  r = await suite.emitirPase(claveSuite({ suiteRolTope: 'superadmin' }), { app: 'factorum', email: 'otro@b.com', rol: 'superadmin' });
  assert.strictEqual((await suite.canjearPase(tokenDe(r.url))).role, 'superadmin');
  // Tope lectura: un admin de Arcanum entra como lectura.
  const x = armar({ usuarios: [{ username: 'ana', email: 'ana@b.com', role: 'admin' }] });
  r = await x.suite.emitirPase(claveSuite({ suiteRolTope: 'lectura' }), { app: 'factorum', email: 'ana@b.com', rol: 'admin' });
  assert.strictEqual((await x.suite.canjearPase(tokenDe(r.url))).role, 'lectura');
  // Rol de Factorum desconocido para un usuario nuevo: no queda rol valido.
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'z@b.com', rol: 'dios' }), (e) => e.httpStatus === 403 && e.message === MSG.sinRol);
});

test('suite: un usuario existente no se escala por venir de la otra app', async () => {
  const { repo, suite } = armar({ usuarios: [{ username: 'lucia', email: 'lucia@b.com', role: 'lectura', cuit_allow: [A] }] });
  const r = await suite.emitirPase(claveSuite({ suiteRolTope: 'superadmin' }), { app: 'factorum', email: 'LUCIA@b.com', rol: 'superadmin', cuits: null });
  const p = await suite.canjearPase(tokenDe(r.url));
  assert.deepStrictEqual(p, { username: 'lucia', role: 'lectura', cuitAllow: [A] });
  assert.strictEqual(repo.usuarios.length, 1);
  assert.strictEqual(repo.usuarios[0].role, 'lectura');
  // Tambien por usuario igual al email, si no tiene email cargado.
  const x = armar({ usuarios: [{ username: 'pepe@b.com', role: 'operador' }] });
  const r2 = await x.suite.emitirPase(claveSuite(), { app: 'factorum', email: 'pepe@b.com', rol: 'admin' });
  assert.strictEqual((await x.suite.canjearPase(tokenDe(r2.url))).role, 'operador');
});

test('suite: usuario desactivado no recibe pase ni entra con uno ya dado', async () => {
  const { repo, suite } = armar({ usuarios: [{ username: 'baja', email: 'baja@b.com', role: 'operador', activo: false }] });
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'baja@b.com', rol: 'usuario' }), (e) => e.httpStatus === 403);
  const x = armar({ usuarios: [{ username: 'sigue', email: 'sigue@b.com', role: 'operador' }] });
  const r = await x.suite.emitirPase(claveSuite(), { app: 'factorum', email: 'sigue@b.com', rol: 'usuario' });
  x.repo.usuarios[0].activo = false; // lo desactivan entre el pase y el clic
  assert.strictEqual(await x.suite.canjearPase(tokenDe(r.url)), null);
  assert.strictEqual(repo.pases.length, 0);
});

test('suite: los CUITs se intersecan con los de la clave', async () => {
  const clave = claveSuite({ cuitAllow: [A, B] });
  // Nuevo con [A, C] -> [A].
  let x = armar();
  let r = await x.suite.emitirPase(clave, { app: 'factorum', email: 'n@b.com', rol: 'usuario', cuits: [A, C] });
  assert.deepStrictEqual((await x.suite.canjearPase(tokenDe(r.url))).cuitAllow, [A]);
  // Nuevo con todos (null) -> los de la clave.
  r = await x.suite.emitirPase(clave, { app: 'factorum', email: 't@b.com', rol: 'usuario', cuits: null });
  assert.deepStrictEqual((await x.suite.canjearPase(tokenDe(r.url))).cuitAllow, [A, B]);
  // Existente sin CUITs en comun -> 403 (una lista vacia en Arcanum seria "todos").
  x = armar({ usuarios: [{ username: 'c', email: 'c@b.com', role: 'operador', cuit_allow: [C] }] });
  await assert.rejects(x.suite.emitirPase(clave, { app: 'factorum', email: 'c@b.com', rol: 'usuario' }), (e) => e.httpStatus === 403 && e.message === MSG.sinCuits);
  // Existente admin (ve todo) con una clave acotada: queda operador con los CUITs de la clave.
  x = armar({ usuarios: [{ username: 'adm', email: 'adm@b.com', role: 'admin' }] });
  r = await x.suite.emitirPase(claveSuite({ cuitAllow: [A], suiteRolTope: 'admin' }), { app: 'factorum', email: 'adm@b.com', rol: 'admin' });
  assert.deepStrictEqual(await x.suite.canjearPase(tokenDe(r.url)), { username: 'adm', role: 'operador', cuitAllow: [A] });
});

test('suite: sin URL publica responde 409 y no crea a nadie', async () => {
  const { repo, suite } = armar({ ajustes: {} });
  await assert.rejects(
    suite.emitirPase(claveSuite(), { app: 'factorum', email: 'a@b.com', rol: 'usuario' }),
    (e) => e.httpStatus === 409 && e.message === 'Falta la URL pública de Arcanum',
  );
  assert.strictEqual(repo.usuarios.length, 0);
  // Con ARCANUM_PUBLIC_URL alcanza (y la barra final no se duplica).
  const x = armar({ ajustes: {}, env: { ARCANUM_PUBLIC_URL: 'https://ark.ejemplo.com/' } });
  const r = await x.suite.emitirPase(claveSuite(), { app: 'factorum', email: 'a@b.com', rol: 'usuario' });
  assert.match(r.url, /^https:\/\/ark\.ejemplo\.com\/suite\/entrar\?pase=/);
});

test('suite: con el alta automatica apagada solo entran los que ya tienen usuario', async () => {
  const { repo, suite } = armar({ ajustes: { urlPublica: URL_PUB, crearUsuarios: false }, usuarios: [{ username: 'ya', email: 'ya@b.com', role: 'operador' }] });
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'nuevo@b.com', rol: 'usuario' }), (e) => e.httpStatus === 403 && e.message === MSG.sinAlta);
  assert.strictEqual(repo.usuarios.length, 1);
  assert.ok((await suite.emitirPase(claveSuite(), { app: 'factorum', email: 'ya@b.com', rol: 'usuario' })).ok);
  // Por entorno tambien se apaga.
  const x = armar({ env: { ARCANUM_SUITE_CREAR_USUARIOS: '0' } });
  assert.strictEqual((await x.suite.config()).crearUsuarios, false);
});

test('suite: datos invalidos en el pedido', async () => {
  const { suite } = armar();
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'otra', email: 'a@b.com', rol: 'usuario' }), (e) => e.httpStatus === 400);
  await assert.rejects(suite.emitirPase(claveSuite(), { app: 'factorum', email: 'sin-arroba', rol: 'usuario' }), (e) => e.httpStatus === 400);
});

test('claves: rol tope de la suite (operador por defecto, y no admin con CUITs)', () => {
  assert.deepStrictEqual(normSuite({ suite: true }), { suite: true, tope: 'operador' });
  assert.deepStrictEqual(normSuite({ suite: true, suiteRolTope: 'superadmin' }), { suite: true, tope: 'superadmin' });
  assert.deepStrictEqual(normSuite({}), { suite: false, tope: 'operador' });
  assert.throws(() => normSuite({ suite: true, suiteRolTope: 'usuario' }), (e) => e.httpStatus === 400);
  assert.throws(() => normSuite({ suite: true, suiteRolTope: 'admin' }, [A]), (e) => e.httpStatus === 400);
  assert.deepStrictEqual(normSuite({ suite: true, suiteRolTope: 'lectura' }, [A]), { suite: true, tope: 'lectura' });
});

test('permisos: el rol lectura puede usar POST /api/suite/abrir/:app (y nada mas de la suite)', () => {
  const lectura = { username: 'lee', role: 'lectura' };
  assert.doesNotThrow(() => assertPuedeEscribir(lectura, 'POST', '/api/suite/abrir/factorum'));
  assert.doesNotThrow(() => assertPuedeEscribir(lectura, 'GET', '/api/suite/apps'));
  for (const [m, p] of [['PUT', '/api/suite/config'], ['POST', '/api/suite/pase'], ['POST', '/api/suite/abrir/factorum/x'], ['DELETE', '/api/suite/abrir/factorum'], ['POST', '/api/suite/abrir/']]) {
    assert.throws(() => assertPuedeEscribir(lectura, m, p), (e) => e.httpStatus === 403, `${m} ${p}`);
  }
});

// --- Factorum falso (origen) ---

async function conFactorumFalso(responder, fn) {
  const pedidos = [];
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const p = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(partes).toString('utf8') };
      pedidos.push(p);
      const [status, cuerpo] = responder(p);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cuerpo));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const factorum = { ...crearCliente({ leerConfig: async () => ({ url, token: 'tok-factorum' }) }), config: async () => ({ url, tokenCargado: true }) };
  try { await fn({ factorum, pedidos }); } finally { srv.close(); }
}

const RESP_OK = (p) => (p.url === '/healthz' ? [200, { ok: true, version: '0.3.0' }]
  : [200, { ok: true, url: 'https://factorum.ejemplo.com/suite/entrar?pase=abc', vence: '2026-11-27T12:01:00Z' }]);

test('origen: arma el pedido a Factorum con el token de conexion y la identidad de la sesion', async () => {
  await conFactorumFalso(RESP_OK, async ({ factorum, pedidos }) => {
    const { repo, suite } = armar({ factorum, usuarios: [{ username: 'lee', email: 'Lee@Estudio.com', nombre: 'Lee Lectora', role: 'lectura', cuit_allow: [A] }] });
    const r = await suite.abrir('factorum', { username: 'lee', role: 'lectura', cuitAllow: [A] }, { ip: '1.2.3.4' });
    assert.deepStrictEqual(r, { ok: true, url: 'https://factorum.ejemplo.com/suite/entrar?pase=abc' });
    const p = pedidos.find((x) => x.url === '/api/suite/pase');
    assert.strictEqual(p.method, 'POST');
    assert.strictEqual(p.headers.authorization, 'Bearer tok-factorum');
    assert.match(p.headers['content-type'], /^application\/json/);
    assert.deepStrictEqual(JSON.parse(p.body), { app: 'arcanum', email: 'Lee@Estudio.com', nombre: 'Lee Lectora', rol: 'lectura', cuits: [A] });
    // Sin CUITs (todos) va null; un usuario federado sin fila usa su usuario si es un email.
    await suite.abrir('factorum', { username: 'Fede@Estudio.com', role: 'admin', cuitAllow: null });
    assert.deepStrictEqual(JSON.parse(pedidos.at(-1).body), { app: 'arcanum', email: 'fede@estudio.com', nombre: 'Fede@Estudio.com', rol: 'admin', cuits: null });
    assert.deepStrictEqual(repo.eventos.map((e) => e.evento), ['abrir', 'abrir']);
    assert.ok(!JSON.stringify(repo.eventos).includes('pase=abc'));
  });
});

test('origen: sin email, con clave de API o desactivado no se pide nada a Factorum', async () => {
  await conFactorumFalso(RESP_OK, async ({ factorum, pedidos }) => {
    const { suite } = armar({ factorum, usuarios: [{ username: 'admin', role: 'superadmin' }, { username: 'baja', email: 'baja@b.com', role: 'operador', activo: false }] });
    await assert.rejects(suite.abrir('factorum', { username: 'admin', role: 'superadmin' }), (e) => e.httpStatus === 409 && /email/.test(e.message));
    await assert.rejects(suite.abrir('factorum', { username: 'clave:x', role: 'operador', via: 'clave' }), (e) => e.httpStatus === 403);
    await assert.rejects(suite.abrir('factorum', { username: 'baja', role: 'operador' }), (e) => e.httpStatus === 403);
    await assert.rejects(suite.abrir('otra', { username: 'admin', role: 'superadmin' }), (e) => e.httpStatus === 404);
    assert.strictEqual(pedidos.length, 0);
  });
});

test('origen: los errores de Factorum vuelven con su mensaje (y un 401 no parece la sesion de Arcanum)', async () => {
  let resp = [403, { ok: false, error: 'Esta clave no está habilitada para abrir sesiones de la suite' }];
  await conFactorumFalso(() => resp, async ({ factorum }) => {
    const { repo, suite } = armar({ factorum });
    const yo = { username: 'yo@b.com', role: 'operador' };
    await assert.rejects(suite.abrir('factorum', yo), (e) => e.httpStatus === 403 && e.message === 'Factorum: Esta clave no está habilitada para abrir sesiones de la suite');
    resp = [409, { ok: false, error: 'Falta la URL pública de Factorum' }];
    await assert.rejects(suite.abrir('factorum', yo), (e) => e.httpStatus === 409 && e.message === 'Factorum: Falta la URL pública de Factorum');
    resp = [401, { ok: false, error: 'no autorizado' }];
    await assert.rejects(suite.abrir('factorum', yo), (e) => e.httpStatus === 502 && /FACTORUM_TOKEN/.test(e.message));
    resp = [200, { ok: true, url: 'javascript:alert(1)' }];
    await assert.rejects(suite.abrir('factorum', yo), (e) => e.httpStatus === 502);
    assert.strictEqual(repo.eventos.filter((e) => e.evento === 'abrir_rechazado').length, 4);
  });
});

test('origen: /api/suite/apps lista Factorum si esta conectado, con su healthz cacheado 60 s', async () => {
  let sano = true;
  await conFactorumFalso((p) => (p.url === '/healthz' ? [sano ? 200 : 503, { ok: sano }] : [404, {}]), async ({ factorum, pedidos }) => {
    const { suite, avanzar } = armar({ factorum });
    assert.deepStrictEqual(await suite.apps(), [{ app: 'factorum', nombre: 'Factorum', disponible: true }]);
    sano = false;
    avanzar(30_000);
    assert.strictEqual((await suite.apps())[0].disponible, true); // del cache
    assert.strictEqual(pedidos.filter((p) => p.url === '/healthz').length, 1);
    avanzar(31_000);
    assert.strictEqual((await suite.apps())[0].disponible, false);
    assert.strictEqual(pedidos.filter((p) => p.url === '/healthz').length, 2);
  });
  // Sin Factorum conectado no hay apps.
  const { suite } = armar({ factorum: { config: async () => ({ url: '', tokenCargado: false }) } });
  assert.deepStrictEqual(await suite.apps(), []);
});

// --- Rutas ---

/** Sesiones en memoria con el contrato de src/auth/sesiones.js (crear devuelve el sid). */
function sesionesMemoria() {
  const creadas = [];
  return { creadas, async crear(p, origen) { const sid = `sid-${creadas.length + 1}`; creadas.push({ sid, username: p.username, origen }); return sid; } };
}

async function conServidor({ suite, principal, clave, sesiones = sesionesMemoria() }, fn) {
  const rutas = crearRutas({
    suite,
    sesiones,
    principalDeClave: async (req) => {
      const k = req.headers['x-api-key'] || (String(req.headers.authorization || '').match(/^Bearer (\S+)$/) || [])[1];
      if (!k) return null;
      if (k !== 'ark_buena') throw Object.assign(new Error('Clave invalida o dada de baja.'), { httpStatus: 401 });
      return clave;
    },
  });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (await rutas.publicas(req, res, url)) return;
      const p = principal || session.fromRequest(req);
      if (!p) throw Object.assign(new Error('401'), { httpStatus: 401 });
      assertPuedeEscribir(p, req.method, url.pathname);
      if (await rutas.privadas(req, res, url, url.pathname.split('/').filter(Boolean), p)) return;
      res.writeHead(404); res.end();
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

const post = (base, ruta, cuerpo, headers = {}) => fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(cuerpo || {}), redirect: 'manual' });

test('rutas: POST /api/suite/pase solo con clave, y /suite/entrar abre la sesion una vez', async () => {
  const { suite } = armar();
  const sesiones = sesionesMemoria();
  await conServidor({ suite, clave: claveSuite(), sesiones }, async (base) => {
    const cuerpo = { app: 'factorum', email: 'diego@b.com', nombre: 'Diego', rol: 'usuario' };
    assert.strictEqual((await post(base, '/api/suite/pase', cuerpo)).status, 401);
    assert.strictEqual((await post(base, '/api/suite/pase', cuerpo, { 'X-API-Key': 'ark_mala' })).status, 401);
    // Una sesion de navegador no alcanza: hace falta la clave.
    const cookie = `${session.COOKIE}=${session.sign({ username: 'root', role: 'superadmin', sid: 'sid-root', origen: 'local' })}`;
    assert.strictEqual((await post(base, '/api/suite/pase', cuerpo, { Cookie: cookie })).status, 401);
    const r = await post(base, '/api/suite/pase', cuerpo, { Authorization: 'Bearer ark_buena' });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    const ruta = new URL(j.url);
    const e1 = await fetch(`${base}${ruta.pathname}${ruta.search}`, { redirect: 'manual' });
    assert.strictEqual(e1.status, 302);
    assert.strictEqual(e1.headers.get('location'), '/');
    assert.strictEqual(e1.headers.get('referrer-policy'), 'no-referrer');
    const sc = e1.headers.get('set-cookie');
    assert.match(sc, new RegExp(`^${session.COOKIE}=`));
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    // Secure con la misma regla que el login: aca el pedido llego por http y sin proxy.
    assert.doesNotMatch(sc, /Secure/);
    const tok = sc.split(';')[0].split('=').slice(1).join('=');
    // La misma sesion registrada (y revocable) que abre el login, con origen "suite".
    assert.deepStrictEqual(sesiones.creadas, [{ sid: 'sid-1', username: 'diego@b.com', origen: 'suite' }]);
    assert.deepStrictEqual(session.verify(tok), { username: 'diego@b.com', role: 'operador', cuitAllow: null, sid: 'sid-1', origen: 'suite' });
    const e2 = await fetch(`${base}${ruta.pathname}${ruta.search}`, { redirect: 'manual' });
    assert.strictEqual(e2.status, 302);
    assert.strictEqual(e2.headers.get('location'), '/?suite=pase-vencido');
    assert.strictEqual(e2.headers.get('set-cookie'), null);
    assert.strictEqual(sesiones.creadas.length, 1);
    // Detras de un proxy con https, Secure (igual que el login).
    const r3 = await (await post(base, '/api/suite/pase', cuerpo, { Authorization: 'Bearer ark_buena' })).json();
    const ruta3 = new URL(r3.url);
    const e3 = await fetch(`${base}${ruta3.pathname}${ruta3.search}`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(e3.headers.get('set-cookie'), /Secure/);
  });
  // Clave sin el flag: 403 con el mensaje del contrato.
  await conServidor({ suite, clave: claveSuite({ suite: false }) }, async (base) => {
    const r = await post(base, '/api/suite/pase', { app: 'factorum', email: 'a@b.com', rol: 'usuario' }, { 'X-API-Key': 'ark_buena' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(await r.json(), { ok: false, error: 'Esta clave no está habilitada para abrir sesiones de la suite' });
  });
});

test('rutas: una sesion de rol lectura puede abrir Factorum; los ajustes son de superadmin', async () => {
  await conFactorumFalso(RESP_OK, async ({ factorum }) => {
    const { suite } = armar({ factorum, usuarios: [{ username: 'lee', email: 'lee@b.com', role: 'lectura' }] });
    await conServidor({ suite, principal: { username: 'lee', role: 'lectura' } }, async (base) => {
      const a = await (await fetch(`${base}/api/suite/apps`)).json();
      assert.deepStrictEqual(a, { ok: true, apps: [{ app: 'factorum', nombre: 'Factorum', disponible: true }] });
      const r = await post(base, '/api/suite/abrir/factorum', {});
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { ok: true, url: 'https://factorum.ejemplo.com/suite/entrar?pase=abc' });
      assert.strictEqual((await fetch(`${base}/api/suite/config`)).status, 403);
      assert.strictEqual((await fetch(`${base}/api/suite/config`, { method: 'PUT', body: '{}' })).status, 403);
      assert.strictEqual((await fetch(`${base}/api/suite/auditoria`)).status, 403);
    });
    await conServidor({ suite, principal: { username: 'root', role: 'superadmin' } }, async (base) => {
      const r = await fetch(`${base}/api/suite/config`, { method: 'PUT', body: JSON.stringify({ urlPublica: 'https://nuevo.ejemplo.com/', crearUsuarios: false }) });
      const j = await r.json();
      assert.strictEqual(j.suite.urlPublica, 'https://nuevo.ejemplo.com');
      assert.strictEqual(j.suite.urlPublicaDesde, 'ajustes');
      assert.strictEqual(j.suite.crearUsuarios, false);
      assert.strictEqual((await fetch(`${base}/api/suite/config`, { method: 'PUT', body: JSON.stringify({ urlPublica: 'ftp://x' }) })).status, 400);
    });
    // Con una clave de API no se abre otra app (es para personas en el navegador).
    await conServidor({ suite, principal: { username: 'clave:x', role: 'operador', via: 'clave' } }, async (base) => {
      assert.strictEqual((await post(base, '/api/suite/abrir/factorum', {})).status, 403);
    });
  });
});
