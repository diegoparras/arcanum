'use strict';

// Vista en vivo de Mis Comprobantes: quien puede manejar el navegador de Fisherboy y donde
// (auditoria 2026-11-26, A-02). Admin y superadmin, siempre. Un operador, solo cuando la corrida
// pidio una persona, solo despues de tomar el control el mismo, y solo en el login de ARCA o en
// Mis Comprobantes: el portal ya entro con la clave fiscal, que el operador no conoce.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/misComprobantes');
const { sendError } = require('../src/lib/http');

const CUIT = '30711111118';
const OPERADOR = { username: 'op', role: 'operador', cuitAllow: [CUIT] };
const OTRO_OP = { username: 'op2', role: 'operador', cuitAllow: [CUIT] };
const ADMIN = { username: 'ad', role: 'admin', cuitAllow: null };

function dobles(corrida) {
  const fb = { llamadas: [], url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml' };
  fb.tomarControl = async (t) => { fb.llamadas.push(['takeover', t]); return { ok: true }; };
  fb.devolver = async (t) => { fb.llamadas.push(['devolver', t]); return { ok: true }; };
  fb.evento = async (t, cmd) => { fb.llamadas.push(['evento', cmd.tipo]); return { ok: true }; };
  fb.frame = async () => ({ status: 204, headers: { 'x-agent-url': fb.url, 'x-agent-estado': corrida.estado } });
  const mc = { corrida: async (id) => ({ id: Number(id), cuit: CUIT, token_fb: 'tok-1', ...corrida }) };
  return { mc, fisherboy: fb };
}

async function servidor(deps) {
  const manejar = crearRutas(deps);
  const auditoria = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const principal = JSON.parse(req.headers['x-principal']);
    try {
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal);
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
    res.on('finish', () => auditoria.push({ cuit: req._cuit || null, op: req._op || null, status: res.statusCode }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/mis-comprobantes/corridas/9`;
  const pedir = (p, quien, metodo = 'POST', body) => fetch(base + p, {
    method: metodo, headers: { 'x-principal': JSON.stringify(quien), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { pedir, auditoria, cerrar: () => srv.close() };
}

test('operador: toma el control cuando ARCA pide una persona y maneja el login', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    assert.strictEqual((await s.pedir('/frame', OPERADOR, 'GET')).status, 204);
    assert.strictEqual((await s.pedir('/tomar-control', OPERADOR)).status, 200);
    assert.strictEqual((await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'texto', texto: 'secreto' })).status, 200);
    assert.deepStrictEqual(deps.fisherboy.llamadas.map((l) => l[0]), ['takeover', 'evento']);
  } finally { s.cerrar(); }
});

test('operador: no manda eventos si el control lo tomo otro (o nadie)', async () => {
  const deps = dobles({ estado: 'humano' });
  const s = await servidor(deps);
  try {
    await s.pedir('/frame', OPERADOR, 'GET');
    assert.strictEqual((await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'click', x: 1, y: 1 })).status, 403);
    assert.strictEqual((await s.pedir('/tomar-control', OPERADOR)).status, 403, 'en "humano" el control ya es de otro');
    assert.deepStrictEqual(deps.fisherboy.llamadas, []);
  } finally { s.cerrar(); }
});

test('operador: fuera del login y de Mis Comprobantes no puede tocar nada', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    await s.pedir('/frame', OPERADOR, 'GET');
    assert.strictEqual((await s.pedir('/tomar-control', OPERADOR)).status, 200);
    deps.fisherboy.url = 'https://portalcf.cloud.afip.gob.ar/portal/app/relaciones';
    await s.pedir('/frame', OPERADOR, 'GET');
    const r = await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'click', x: 1, y: 1 });
    assert.strictEqual(r.status, 403);
    deps.fisherboy.url = 'https://fes.afip.gob.ar/mcmp/jsp/comprobantesRecibidos.do';
    await s.pedir('/frame', OPERADOR, 'GET');
    assert.strictEqual((await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'scroll', dy: 100 })).status, 200);
  } finally { s.cerrar(); }
});

test('operador: sin URL conocida del navegador no manda eventos', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    assert.strictEqual((await s.pedir('/tomar-control', OPERADOR)).status, 200);
    assert.strictEqual((await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'click', x: 1, y: 1 })).status, 403);
  } finally { s.cerrar(); }
});

test('otro operador no usa el control que tomo el primero', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    await s.pedir('/frame', OPERADOR, 'GET');
    assert.strictEqual((await s.pedir('/tomar-control', OPERADOR)).status, 200);
    assert.strictEqual((await s.pedir('/evento', OTRO_OP, 'POST', { tipo: 'click', x: 1, y: 1 })).status, 403);
  } finally { s.cerrar(); }
});

test('admin: toma el control en cualquier estado vivo y en cualquier pagina', async () => {
  const deps = dobles({ estado: 'corriendo' });
  deps.fisherboy.url = 'https://portalcf.cloud.afip.gob.ar/portal/app/';
  const s = await servidor(deps);
  try {
    assert.strictEqual((await s.pedir('/tomar-control', ADMIN)).status, 200);
    assert.strictEqual((await s.pedir('/evento', ADMIN, 'POST', { tipo: 'click', x: 1, y: 1 })).status, 200);
  } finally { s.cerrar(); }
});

test('auditoria: cada evento queda con CUIT, tipo y pagina, nunca con lo tipeado', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    await s.pedir('/frame', OPERADOR, 'GET');
    await s.pedir('/tomar-control', OPERADOR);
    await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'texto', texto: 'clave-que-no-va-al-log' });
    const ev = s.auditoria.find((a) => a.op && a.op.startsWith('evento'));
    assert.strictEqual(ev.cuit, CUIT);
    assert.match(ev.op, /^evento:texto @ auth\.afip\.gob\.ar\/contribuyente_\/login\.xhtml$/);
    assert.ok(!JSON.stringify(s.auditoria).includes('clave-que-no-va-al-log'));
    assert.ok(s.auditoria.some((a) => a.op === 'tomar-control' && a.cuit === CUIT));
  } finally { s.cerrar(); }
});

test('operador: en esperando_humano resuelve el captcha sin tomar el control (como hace el panel)', async () => {
  const deps = dobles({ estado: 'esperando_humano' });
  const s = await servidor(deps);
  try {
    await s.pedir('/frame', OPERADOR, 'GET');
    assert.strictEqual((await s.pedir('/evento', OPERADOR, 'POST', { tipo: 'click', x: 10, y: 20 })).status, 200);
  } finally { s.cerrar(); }
});

test('B-02: la corrida que devuelve la API no trae el token de Fisherboy ni el log crudo', async () => {
  const deps = dobles({ estado: 'corriendo', log: ['paso 1', 'secreto?'] });
  const s = await servidor(deps);
  try {
    const r = await s.pedir('', OPERADOR, 'GET');
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.corrida.token_fb, undefined);
    assert.strictEqual(j.corrida.log, undefined);
    assert.strictEqual(j.corrida.estado, 'corriendo');
  } finally { s.cerrar(); }
});
