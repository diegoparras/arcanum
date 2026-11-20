'use strict';

// Servicio Mis Comprobantes: tramos, una corrida por CUIT, errores con motivo, CSV vacio y
// que la clave fiscal viaje SOLO en `secretos`. Repo y Fisherboy son dobles (sin DB ni red).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const mc = require('../src/services/misComprobantes');
const { RECETA_DEFAULT } = require('../src/services/misComprobantes.receta');

const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'mc-emitidos.csv'));

function repoFalso({ credencial = { cuit: '20263630743', cuit_login: '20263630743', clave_cifrada: 'cif:clave-real' }, viva = null } = {}) {
  const r = {
    corridas: {}, guardados: [], siguiente: 1,
    credencial: async () => credencial,
    corrida: async (id) => r.corridas[id] || null,
    // Alta atomica: chequea la viva y crea en la misma transaccion (con lock por CUIT).
    crearCorridaExclusiva: async (d) => {
      if (viva) return { viva };
      const id = r.siguiente++; r.corridas[id] = { id, ...d }; return { corrida: r.corridas[id] };
    },
    latidos: 0,
    actualizarCorrida: async (id, campos) => { if (campos.latido_at) r.latidos += 1; Object.assign(r.corridas[id], campos); return r.corridas[id]; },
    guardarComprobantes: async (cuit, tipo, corridaId, filas) => { r.guardados.push(...filas); return filas.length; },
    receta: async () => null,
    marcarRechazada: async (cuit, motivo) => { r.rechazo = { cuit, motivo }; },
  };
  return r;
}

function fisherboyFalso(estados, archivo = CSV) {
  const f = { iniciados: [], cerrados: [] };
  let i = 0;
  f.iniciar = async (o) => { f.iniciados.push(o); return { token: `tok-${f.iniciados.length}` }; };
  f.estado = async () => estados[Math.min(i++, estados.length - 1)];
  f.archivo = async () => archivo;
  f.cerrar = async (t) => { f.cerrados.push(t); };
  return f;
}

const vault = { decrypt: (s) => s.replace(/^cif:/, ''), encrypt: (s) => `cif:${s}` };
const webhooks = () => { const w = { eventos: [] }; w.emitir = async (e, p) => { w.eventos.push([e, p]); }; return w; };

function servicio(repo, fisherboy, w = webhooks()) {
  return { s: mc.crear({ repo, fisherboy, vault, webhooks: w, esperaMs: 1 }), w };
}

const TERMINADO = { estado: 'terminado', archivos: [{ n: 0, nombre: 'c.csv' }], log: [] };

test('tramos parte 400 dias en 2', () => {
  const t = mc.tramos('2025-01-01', '2026-02-04', 365);
  assert.strictEqual(t.length, 2);
  assert.deepStrictEqual(t[0], { desde: '2025-01-01', hasta: '2025-12-31' });
  assert.deepStrictEqual(t[1], { desde: '2026-01-01', hasta: '2026-02-04' });
  assert.deepStrictEqual(mc.tramos('2026-11-01', '2026-11-18'), [{ desde: '2026-11-01', hasta: '2026-11-18' }]);
  assert.throws(() => mc.tramos('2026-11-18', '2026-11-01'), /desde/);
});

test('sincronizar rechaza segunda corrida con 409', async () => {
  const { s } = servicio(repoFalso({ viva: { id: 9, estado: 'corriendo' } }), fisherboyFalso([TERMINADO]));
  await assert.rejects(s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' }),
    (e) => e.httpStatus === 409);
});

test('sincronizar sin credencial da 400', async () => {
  const { s } = servicio(repoFalso({ credencial: null }), fisherboyFalso([TERMINADO]));
  await assert.rejects(s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' }),
    (e) => e.httpStatus === 400 && /clave fiscal/i.test(e.message));
});

test('corrida completa guarda los comprobantes y avisa', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([{ estado: 'corriendo' }, TERMINADO]);
  const { s, w } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
  assert.strictEqual(repo.corridas[c.id].cantidad, 3);
  assert.strictEqual(repo.guardados.length, 3);
  assert.deepStrictEqual(fb.cerrados, ['tok-1']);
  assert.strictEqual(w.eventos[0][0], 'mis_comprobantes_sincronizado');
  assert.strictEqual(fb.iniciados[0].variables.rango, '01/11/2026 - 18/11/2026');
  assert.strictEqual(fb.iniciados[0].variables.tipo_boton, 'Emitidos');
});

test('seguir guarda error de Fisherboy con su motivo', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([{ estado: 'error', error: 'paso #6 (wait_url): la URL no llego', alerta: 'Clave o usuario incorrecto' }]);
  const { s, w } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'recibidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.match(repo.corridas[c.id].error, /Clave o usuario incorrecto/);
  assert.strictEqual(w.eventos[0][0], 'mis_comprobantes_fallo');
  assert.deepStrictEqual(fb.cerrados, ['tok-1']);
});

test('seguir con CSV vacio termina ok con 0', async () => {
  const repo = repoFalso();
  const vacio = Buffer.from(CSV.toString().split('\n')[0] + '\n');
  const { s } = servicio(repo, fisherboyFalso([TERMINADO], vacio));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
  assert.strictEqual(repo.corridas[c.id].cantidad, 0);
});

test('terminar sin descargar nada es un error', async () => {
  const repo = repoFalso();
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'terminado', archivos: [] }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.match(repo.corridas[c.id].error, /sin descargar/);
});

test('ambos tipos corren una sesion por tipo', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([TERMINADO]);
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'ambos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.deepStrictEqual(fb.iniciados.map((o) => o.variables.tipo_boton), ['Emitidos', 'Recibidos']);
  assert.strictEqual(repo.corridas[c.id].cantidad, 6);
});

test('esperando humano avisa una sola vez', async () => {
  const repo = repoFalso();
  const h = { estado: 'esperando_humano', motivo_humano: 'captcha' };
  const { s, w } = servicio(repo, fisherboyFalso([h, h, h, TERMINADO]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  const fallos = w.eventos.filter(([e]) => e === 'mis_comprobantes_fallo');
  assert.strictEqual(fallos.length, 1);
  assert.strictEqual(fallos[0][1].necesitaHumano, true);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
});

test('receta default usa el secreto y no un valor', () => {
  const texto = JSON.stringify(RECETA_DEFAULT);
  assert.match(texto, /\{\{secret:clave_fiscal\}\}/);
  assert.match(RECETA_DEFAULT.url, /^https:\/\/auth\.afip\.gob\.ar\//);
  assert.ok(RECETA_DEFAULT.pasos.some((p) => p.do === 'download'));
  assert.ok(RECETA_DEFAULT.pasos.some((p) => p.do === 'human_if'));
  assert.ok(RECETA_DEFAULT.pasos.some((p) => p.do === 'switch_tab'));
});

test('iniciar recibe la clave descifrada solo en secretos', async () => {
  const fb = fisherboyFalso([TERMINADO]);
  const { s } = servicio(repoFalso(), fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  const o = fb.iniciados[0];
  assert.deepStrictEqual(o.secretos, { clave_fiscal: 'clave-real' });
  assert.ok(!JSON.stringify(o.variables).includes('clave-real'));
  assert.ok(!JSON.stringify(o.receta).includes('clave-real'));
  assert.deepStrictEqual(o.dominios, ['afip.gob.ar', 'arca.gob.ar']);
});

test('guardarCredencial exige clave la primera vez y valida el CUIT', async () => {
  const repo = repoFalso({ credencial: null });
  let guardado = null;
  repo.guardarCredencial = async (cuit, d) => { guardado = { cuit, ...d }; };
  const { s } = servicio(repo, fisherboyFalso([TERMINADO]));
  await assert.rejects(s.guardarCredencial('20263630743', { cuitLogin: '20263630743' }, 'admin'), (e) => e.httpStatus === 400);
  await assert.rejects(s.guardarCredencial('123', { cuitLogin: '20263630743', clave: 'x' }, 'admin'), (e) => e.httpStatus === 400);
  await s.guardarCredencial('20-26363074-3', { cuitLogin: '20263630743', clave: 'nueva' }, 'admin');
  assert.strictEqual(guardado.cuit, '20263630743');
  assert.strictEqual(guardado.claveCifrada, 'cif:nueva');
});

test('si ARCA rechaza el login, la credencial queda bloqueada y no se reintenta', async () => {
  const repo = repoFalso();
  repo.marcarRechazada = async (cuit, motivo) => { repo.rechazo = { cuit, motivo }; };
  const fallo = { estado: 'error', error: "paso #7 (wait_url): la URL no llego a contener 'portal'", alerta: '',
    log: [{ n: 7, do: 'wait_url', contains: 'portal', verifica_login: true, ok: false, error: 'la URL no llego' }] };
  const { s, w } = servicio(repo, fisherboyFalso([fallo]));
  const c = await s.sincronizar('20263630743', { tipo: 'ambos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.rechazo.cuit, '20263630743');
  assert.match(repo.corridas[c.id].error, /ARCA rechazo el ingreso/);
  assert.strictEqual(w.eventos.filter(([e]) => e === 'mis_comprobantes_fallo').length, 1);
  // ambos tipos: no siguio con "recibidos" despues del rechazo
  assert.strictEqual(Object.keys(repo.corridas).length, 1);
});

test('credencial rechazada frena sincronizar hasta que se vuelva a cargar la clave', async () => {
  const repo = repoFalso({ credencial: { cuit: '20263630743', cuit_login: '20263630743', clave_cifrada: 'cif:x', rechazada_at: new Date(), rechazo_motivo: 'clave incorrecta' } });
  const { s } = servicio(repo, fisherboyFalso([TERMINADO]));
  await assert.rejects(s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' }),
    (e) => e.httpStatus === 409 && /volve a cargar la clave/i.test(e.message));
  const st = await s.estadoCredencial('20263630743');
  assert.ok(st.rechazada);
});

test('el rechazo tambien se detecta por el aviso de ARCA', async () => {
  const repo = repoFalso();
  repo.marcarRechazada = async (cuit, motivo) => { repo.rechazo = { cuit, motivo }; };
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'error', error: 'paso #9 (click): timeout', alerta: 'Clave o usuario incorrecto', log: [] }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.match(repo.rechazo.motivo, /Clave o usuario incorrecto/);
});

test('un error que no es de login no bloquea la credencial', async () => {
  const repo = repoFalso();
  repo.marcarRechazada = async () => { repo.rechazo = true; };
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'error', error: 'paso #16 (download): timeout', alerta: '', log: [{ n: 16, do: 'download', ok: false }] }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.rechazo, undefined);
});

test('la receta por defecto marca el paso que verifica el login', () => {
  assert.ok(RECETA_DEFAULT.pasos.some((p) => p.do === 'wait_url' && p.verifica_login === true));
});

test('cada sondeo renueva el latido de la corrida', async () => {
  const repo = repoFalso();
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'corriendo' }, { estado: 'corriendo' }, TERMINADO]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.ok(repo.latidos >= 3, `latidos: ${repo.latidos}`);
});

test('error despues de un tramo bueno avisa que quedaron datos parciales', async () => {
  const repo = repoFalso();
  const { s } = servicio(repo, fisherboyFalso([TERMINADO, { estado: 'error', error: 'paso #16 (download): timeout', log: [] }]));
  const c = await s.sincronizar('20263630743', { tipo: 'ambos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.match(repo.corridas[c.id].error, /Se guardaron 3 comprobantes/);
  assert.strictEqual(repo.corridas[c.id].cantidad, 3);
});

test('al arrancar, las corridas vivas huerfanas quedan en error', async () => {
  const repo = repoFalso();
  repo.marcarHuerfanas = async (motivo) => { repo.huerfanas = motivo; return 2; };
  const { s } = servicio(repo, fisherboyFalso([TERMINADO]));
  assert.strictEqual(await s.marcarHuerfanas(), 2);
  assert.match(repo.huerfanas, /reinicio/);
});
