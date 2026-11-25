'use strict';

// Rutas de Mis Comprobantes: permisos por rol y por CUIT, la clave nunca vuelve, y la vista en
// vivo pasa por Arcanum. Servidor HTTP real en 127.0.0.1 con servicio y Fisherboy simulados.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/misComprobantes');
const { sendError } = require('../src/lib/http');

const ADMIN = { username: 'admin', role: 'admin' };
const LECTURA = { username: 'lee', role: 'lectura' };
const OPERADOR = { username: 'op', role: 'operador', cuitAllow: ['30711111118'] };

function mcFalso() {
  const m = { llamadas: [] };
  m.estadoCredencial = async () => ({ cargada: true, cuitLogin: '20263630743', sincronizar: false });
  m.guardarCredencial = async (cuit, body, usuario) => { m.llamadas.push(['cred', cuit, body, usuario]); return { cargada: true }; };
  m.sincronizar = async (cuit, o) => { m.llamadas.push(['sync', cuit, o]); return { id: 7, cuit, estado: 'iniciando' }; };
  m.lanzar = (id) => m.llamadas.push(['lanzar', id]);
  m.corrida = async (id) => ({ id: Number(id), cuit: '20263630743', estado: 'corriendo', token_fb: 'tok-9' });
  m.listar = async () => [{ id: 1 }];
  m.corridas = async () => [];
  m.receta = async () => ({ url: 'https://auth.afip.gob.ar/', pasos: [] });
  return m;
}

function fbFalso() {
  const f = { eventos: [] };
  f.frame = async () => ({ status: 200, headers: { 'x-agent-estado': 'humano', 'x-agent-seq': '3' }, body: Buffer.from('JPG') });
  f.evento = async (t, cmd) => { f.eventos.push([t, cmd]); return { ok: true }; };
  f.tomarControl = async (t) => { f.eventos.push([t, 'takeover']); return { ok: true, estado: 'humano' }; };
  f.devolver = async (t) => { f.eventos.push([t, 'resume']); return { ok: true }; };
  return f;
}

async function conServidor(principal, deps, fn) {
  const manejar = crearRutas(deps);
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal);
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

const pedir = (base, method, ruta, cuerpo) => fetch(base + ruta, {
  method, headers: cuerpo ? { 'Content-Type': 'application/json' } : {}, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
});

test('lectura no puede sincronizar (403)', async () => {
  const mc = mcFalso();
  await conServidor(LECTURA, { mc, fisherboy: fbFalso() }, async (base) => {
    const r = await pedir(base, 'POST', '/api/mis-comprobantes/20263630743/sincronizar', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(mc.llamadas.length, 0);
    assert.strictEqual((await pedir(base, 'GET', '/api/mis-comprobantes/20263630743')).status, 200);
  });
});

test('operador fuera de su cuit_allow (403) y dentro (202)', async () => {
  const mc = mcFalso();
  await conServidor(OPERADOR, { mc, fisherboy: fbFalso() }, async (base) => {
    const body = { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' };
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/20263630743/sincronizar', body)).status, 403);
    const ok = await pedir(base, 'POST', '/api/mis-comprobantes/30711111118/sincronizar', body);
    assert.strictEqual(ok.status, 202);
    assert.deepStrictEqual(mc.llamadas.map((l) => l[0]), ['sync', 'lanzar']);
    assert.strictEqual(mc.llamadas[0][2].usuario, 'op');
  });
});

test('GET credencial nunca trae la clave y solo admin la carga', async () => {
  const mc = mcFalso();
  await conServidor(ADMIN, { mc, fisherboy: fbFalso() }, async (base) => {
    const r = await (await pedir(base, 'GET', '/api/mis-comprobantes/20263630743/credencial')).json();
    assert.strictEqual(r.credencial.cargada, true);
    assert.ok(!('clave' in r.credencial) && !('clave_cifrada' in r.credencial));
    assert.ok(Number.isInteger(r.diaria.hora) && typeof r.diaria.activa === 'boolean');
    const put = await pedir(base, 'PUT', '/api/mis-comprobantes/20263630743/credencial', { cuitLogin: '20263630743', clave: 'secreta' });
    assert.strictEqual(put.status, 200);
    assert.ok(!(await put.text()).includes('secreta'));
  });
  await conServidor(OPERADOR, { mc: mcFalso(), fisherboy: fbFalso() }, async (base) => {
    const put = await pedir(base, 'PUT', '/api/mis-comprobantes/30711111118/credencial', { clave: 'x' });
    assert.strictEqual(put.status, 403);
  });
});

test('vista en vivo: frame, evento, tomar control y devolver pasan por Arcanum', async () => {
  const fb = fbFalso();
  await conServidor(ADMIN, { mc: mcFalso(), fisherboy: fb }, async (base) => {
    const fr = await pedir(base, 'GET', '/api/mis-comprobantes/corridas/7/frame?desde=2');
    assert.strictEqual(fr.status, 200);
    assert.strictEqual(fr.headers.get('content-type'), 'image/jpeg');
    assert.strictEqual(fr.headers.get('x-agent-estado'), 'humano');
    assert.strictEqual(Buffer.from(await fr.arrayBuffer()).toString(), 'JPG');
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/tomar-control')).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/evento', { tipo: 'click', x: 10, y: 20 })).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/evento', { tipo: 'navegar', url: 'https://evil.com' })).status, 400);
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/devolver')).status, 200);
    assert.deepStrictEqual(fb.eventos.map((e) => e[1].tipo || e[1]), ['takeover', 'click', 'resume']);
  });
});

test('vista en vivo respeta el cuit_allow del operador', async () => {
  await conServidor(OPERADOR, { mc: mcFalso(), fisherboy: fbFalso() }, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/mis-comprobantes/corridas/7/frame')).status, 403);
  });
});

test('receta: admin la ve, solo superadmin la cambia', async () => {
  await conServidor(ADMIN, { mc: mcFalso(), fisherboy: fbFalso() }, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/mis-comprobantes/receta')).status, 200);
    assert.strictEqual((await pedir(base, 'PUT', '/api/mis-comprobantes/receta', { url: 'https://x', pasos: [] })).status, 403);
  });
});

test('constatacion: lista por JSON o CSV con scope, y constatar recibidos', async () => {
  const llamadas = [];
  const constatacion = {
    constatarLista: async (cuit, items) => { llamadas.push(['lista', cuit, items.length]); return { cantidad: items.length, resultados: [] }; },
    parsearListaCsv: (csv, cuit) => { llamadas.push(['csv', cuit]); return [{ cuitEmisor: '1' }, { cuitEmisor: '2' }]; },
    constatarRecibidos: async (cuit) => { llamadas.push(['recibidos', cuit]); return { cantidad: 0 }; },
  };
  await conServidor(OPERADOR, { mc: mcFalso(), fisherboy: fbFalso(), constatacion }, async (base) => {
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '20263630743', items: [{}] })).status, 403);
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '30711111118', items: [{}] })).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '30711111118', csv: 'a;b' })).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/30711111118/constatar')).status, 200);
  });
  assert.deepStrictEqual(llamadas, [['lista', '30711111118', 1], ['csv', '30711111118'], ['lista', '30711111118', 2], ['recibidos', '30711111118']]);
  await conServidor(LECTURA, { mc: mcFalso(), fisherboy: fbFalso(), constatacion }, async (base) => {
    // Constatar los recibidos guarda el resultado: sigue siendo de operador.
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/20263630743/constatar')).status, 403);
    // Constatar una lista solo consulta: lectura puede (es lo que usa Factorum).
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '20263630743', items: [{}] })).status, 200);
  });
  // Lectura acotada a un CUIT: no puede constatar con otro.
  const LECTURA_ACOTADA = { username: 'fac', role: 'lectura', cuitAllow: ['30711111118'] };
  await conServidor(LECTURA_ACOTADA, { mc: mcFalso(), fisherboy: fbFalso(), constatacion }, async (base) => {
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '20263630743', items: [{}] })).status, 403);
    assert.strictEqual((await pedir(base, 'POST', '/api/constatacion', { cuit: '30711111118', items: [{}] })).status, 200);
  });
});

test('el OK que pide Fisherboy se responde desde Arcanum (si y no)', async () => {
  const mc = mcFalso();
  mc.responderOk = async (id, si) => { mc.llamadas.push(['ok', id, si]); return { ok: true }; };
  await conServidor(OPERADOR, { mc, fisherboy: fbFalso() }, async (base) => {
    // El operador solo opera su CUIT: la corrida 7 es de otro.
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/ok')).status, 403);
  });
  await conServidor(ADMIN, { mc, fisherboy: fbFalso() }, async (base) => {
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/ok')).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/mis-comprobantes/corridas/7/no')).status, 200);
    assert.deepStrictEqual(mc.llamadas, [['ok', 7, true], ['ok', 7, false]]);
  });
});

test('rango sugerido: respeta el cuit_allow y devuelve la proxima sincronizacion', async () => {
  const mc = mcFalso();
  mc.rangoSugerido = async (cuit, tipo) => ({ desde: '2026-10-26', hasta: '2026-11-25', primera: false, cuit, tipo });
  await conServidor(OPERADOR, { mc, fisherboy: fbFalso() }, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/mis-comprobantes/20263630743/rango')).status, 403);
    const r = await (await pedir(base, 'GET', '/api/mis-comprobantes/30711111118/rango?tipo=emitidos')).json();
    assert.deepStrictEqual([r.rango.desde, r.rango.tipo], ['2026-10-26', 'emitidos']);
  });
});
