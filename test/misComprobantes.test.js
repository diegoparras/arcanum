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

// --- avance visible y corte por falta de avance --------------------------------
const OK = (n) => ({ n, do: 'x', ok: true, origen: 'receta' });

test('progresoDe: paso siguiente al ultimo que salio bien', () => {
  const p = mc.progresoDe([OK(1), OK(2), OK(3)], RECETA_DEFAULT.pasos, {});
  assert.strictEqual(p.paso, 4);
  assert.strictEqual(p.total, RECETA_DEFAULT.pasos.length);
  assert.strictEqual(p.ia, 0);
  assert.match(p.descripcion, /clave fiscal/i);
  assert.ok(!/\{\{/.test(p.descripcion), 'sin placeholders');
});

test('progresoDe: paso que fallo, reintentos de la IA y variables reemplazadas', () => {
  const log = [...Array.from({ length: 12 }, (_, i) => OK(i + 1)),
    { n: 13, do: 'fill', ok: false, error: 'Element is not editable', origen: 'receta' },
    { do: 'ia:click', ok: false, origen: 'ia' }, { do: 'ia:fill', ok: true, origen: 'ia' }];
  const p = mc.progresoDe(log, RECETA_DEFAULT.pasos, { rango: '01/10/2026 - 25/11/2026' });
  assert.strictEqual(p.paso, 13);
  assert.strictEqual(p.ia, 2);
  assert.strictEqual(p.error, 'Element is not editable');
  assert.strictEqual(p.descripcion, 'Cargar el rango de fechas 01/10/2026 - 25/11/2026 en Fecha de Emision');
});

test('progresoDe: la descripcion nunca muestra un secreto', () => {
  const p = mc.progresoDe([OK(1), OK(2), OK(3)], RECETA_DEFAULT.pasos, { clave_fiscal: 'no-deberia' });
  assert.ok(!p.descripcion.includes('no-deberia'));
});

test('cada sondeo guarda el avance en la corrida', async () => {
  const repo = repoFalso();
  const log = [OK(1), OK(2)];
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'corriendo', log }, { ...TERMINADO, log }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  const p = repo.corridas[c.id].progreso;
  assert.strictEqual(p.paso, 3);
  assert.strictEqual(p.tipo, 'emitido');
  assert.ok(p.avance, 'marca de ultimo avance');
});

test('sin avance en el registro de Fisherboy, la corrida se corta con el paso trabado', async () => {
  const repo = repoFalso();
  const trabado = { estado: 'corriendo', log: [...Array.from({ length: 12 }, (_, i) => OK(i + 1)), { n: 13, do: 'fill', ok: false, error: 'Element is not editable', origen: 'receta' }] };
  const fb = fisherboyFalso([trabado]);
  const s = mc.crear({ repo, fisherboy: fb, vault, webhooks: webhooks(), esperaMs: 1, sinAvanceMs: 30 });
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  const f = repo.corridas[c.id];
  assert.strictEqual(f.estado, 'error');
  assert.match(f.error, /sin avance/i);
  assert.ok(f.error.includes(`paso 13 de ${RECETA_DEFAULT.pasos.length}`), f.error);
  assert.match(f.error, /not editable/);
  assert.deepStrictEqual(fb.cerrados, ['tok-1'], 'cierra la sesion de Fisherboy');
});

test('mientras una persona tiene el control no se corta por falta de avance', async () => {
  const repo = repoFalso();
  const h = { estado: 'humano', log: [OK(1)] };
  const estados = [h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, h, { ...TERMINADO, log: [OK(1)] }];
  const fb = fisherboyFalso(estados);
  fb.estado = async () => { await new Promise((r) => setTimeout(r, 3)); return estados.shift() || TERMINADO; };
  const s = mc.crear({ repo, fisherboy: fb, vault, webhooks: webhooks(), esperaMs: 1, sinAvanceMs: 20 });
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
});

// --- el OK que pide Fisherboy antes de lo que "no se deshace" (estado esperando_ok) ------
function conOk(estados) {
  const fb = fisherboyFalso(estados);
  fb.oks = []; fb.nos = [];
  fb.ok = async (t) => { fb.oks.push(t); return { ok: true }; };
  fb.no = async (t) => { fb.nos.push(t); return { ok: true }; };
  return fb;
}

test('esperando_ok para Buscar se aprueba solo: es una consulta, no cambia nada en ARCA', async () => {
  const repo = repoFalso();
  const pide = { estado: 'esperando_ok', ok_pedido: { texto: 'BUSCAR', motivo: '' }, log: [OK(1)] };
  const fb = conOk([pide, { ...TERMINADO, log: [OK(1)] }]);
  const { s, w } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.deepStrictEqual(fb.oks, ['tok-1']);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
  assert.ok(!w.eventos.some(([e]) => e === 'mis_comprobantes_fallo'), 'no molesta a nadie');
});

test('esperando_ok para otra cosa espera a una persona, avisa una vez y no se corta por falta de avance', async () => {
  const repo = repoFalso();
  const pide = { estado: 'esperando_ok', ok_pedido: { texto: 'Confirmar', motivo: 'la IA quiere confirmar' }, log: [OK(1)] };
  const estados = Array(15).fill(pide).concat([{ ...TERMINADO, log: [OK(1)] }]);
  const fb = conOk(estados);
  fb.estado = async () => { await new Promise((r) => setTimeout(r, 3)); return estados.shift() || TERMINADO; };
  const w = webhooks();
  const s = mc.crear({ repo, fisherboy: fb, vault, webhooks: w, esperaMs: 1, sinAvanceMs: 20 });
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  const vistos = [];
  const orig = repo.actualizarCorrida;
  repo.actualizarCorrida = async (id, campos) => { if (campos.estado) vistos.push(campos.estado); if (campos.progreso && campos.progreso.ok) vistos.push(campos.progreso.ok.texto); return orig(id, campos); };
  await s.seguir(c.id);
  assert.deepStrictEqual(fb.oks, [], 'no aprueba solo');
  assert.ok(vistos.includes('esperando_ok') && vistos.includes('Confirmar'), 'la corrida muestra que pide OK y para que');
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
  const avisos = w.eventos.filter(([e, p]) => e === 'mis_comprobantes_fallo' && p.necesitaHumano);
  assert.strictEqual(avisos.length, 1);
});

test('responderOk reenvia si/no a Fisherboy solo si la corrida esta esperando el OK', async () => {
  const repo = repoFalso();
  const fb = conOk([TERMINADO]);
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  Object.assign(repo.corridas[c.id], { estado: 'esperando_ok', token_fb: 'tok-9' });
  await s.responderOk(c.id, true);
  await s.responderOk(c.id, false);
  assert.deepStrictEqual([fb.oks, fb.nos], [['tok-9'], ['tok-9']]);
  repo.corridas[c.id].estado = 'corriendo';
  await assert.rejects(() => s.responderOk(c.id, true), /no esta esperando/i);
});

test('el paso que abre Mis Comprobantes no puede tomar el link al video de YouTube', () => {
  const p = RECETA_DEFAULT.pasos.find((x) => /Abrir el servicio/.test(x.objetivo || ''));
  assert.ok(!/^text=/.test(p.sel), p.sel);
  assert.match(p.sel, /youtu/);
});

// --- sincronizacion incremental: la primera trae 12 meses, las siguientes arrancan donde quedo ---
function conCobertura(cubierto) {
  const repo = repoFalso();
  repo.cubierto = async () => cubierto;
  return repo;
}
const HOY = () => new Date('2026-11-25T15:00:00Z'); // 12:00 en Argentina

test('primera sincronizacion: los ultimos 12 meses completos hasta hoy', async () => {
  const s = mc.crear({ repo: conCobertura({ emitido: null, recibido: null }), fisherboy: fisherboyFalso([TERMINADO]), vault, webhooks: webhooks(), ahora: HOY });
  assert.deepStrictEqual(await s.rangoSugerido('20263630743', 'ambos'),
    { desde: '2025-11-01', hasta: '2026-11-25', primera: true, cubierto: { emitido: null, recibido: null } });
});

test('siguientes: desde lo ultimo bajado menos 30 dias de solape (ARCA informa tarde algunos)', async () => {
  const s = mc.crear({ repo: conCobertura({ emitido: '2026-11-20', recibido: '2026-11-10' }), fisherboy: fisherboyFalso([TERMINADO]), vault, webhooks: webhooks(), ahora: HOY });
  const ambos = await s.rangoSugerido('20263630743', 'ambos');
  assert.deepStrictEqual([ambos.desde, ambos.hasta, ambos.primera], ['2026-10-11', '2026-11-25', false], 'toma el tipo mas atrasado');
  assert.strictEqual((await s.rangoSugerido('20263630743', 'emitidos')).desde, '2026-10-21');
  assert.strictEqual((await s.rangoSugerido('20263630743', 'recibidos')).desde, '2026-10-11');
});

test('si un tipo nunca se bajo, "ambos" vuelve a ser primera sincronizacion', async () => {
  const s = mc.crear({ repo: conCobertura({ emitido: '2026-11-20', recibido: null }), fisherboy: fisherboyFalso([TERMINADO]), vault, webhooks: webhooks(), ahora: HOY });
  const r = await s.rangoSugerido('20263630743', 'ambos');
  assert.deepStrictEqual([r.desde, r.primera], ['2025-11-01', true]);
  assert.strictEqual((await s.rangoSugerido('20263630743', 'emitidos')).primera, false);
});

test('sincronizar sin rango usa el sugerido (lo que usa la diaria)', async () => {
  const repo = conCobertura({ emitido: '2026-11-20', recibido: '2026-11-20' });
  const s = mc.crear({ repo, fisherboy: fisherboyFalso([TERMINADO]), vault, webhooks: webhooks(), ahora: HOY });
  const c = await s.sincronizar('20263630743', { tipo: 'ambos', origen: 'diaria' });
  assert.deepStrictEqual([c.desde, c.hasta], ['2026-10-21', '2026-11-25']);
});

test('el rango de fechas se carga con una tecla despues, para que el calendario de ARCA lo lea', () => {
  const pasos = RECETA_DEFAULT.pasos;
  const i = pasos.findIndex((p) => p.sel === '#fechaEmision' && p.do === 'fill');
  assert.ok(i >= 0);
  // fill solo cambia el valor; el daterangepicker de ARCA parsea el campo en keyup.
  assert.deepStrictEqual({ do: pasos[i + 1].do, sel: pasos[i + 1].sel }, { do: 'press', sel: '#fechaEmision' });
  assert.ok(pasos[i + 1].key && pasos[i + 1].key !== 'Enter' && pasos[i + 1].key !== 'Tab', 'una tecla que no envie ni mueva el foco');
});

test('la descarga usa el boton real de ARCA y reintenta una vez (el primer pedido puede dar 503)', () => {
  const pasos = RECETA_DEFAULT.pasos;
  const descargas = pasos.map((p, i) => [p, i]).filter(([p]) => p.do === 'download');
  assert.strictEqual(descargas.length, 2);
  for (const [p] of descargas) assert.strictEqual(p.sel, 'button[title="Exportar como CSV"]');
  const [[primera, i1], [segunda, i2]] = descargas;
  assert.strictEqual(primera.optional, true, 'si el primero falla, sigue sin pasarle el paso a la IA');
  assert.ok(!segunda.optional, 'el segundo es el que vale');
  assert.ok(pasos.slice(i1 + 1, i2).some((p) => p.do === 'wait'), 'espera entre intentos');
});

test('dos descargas del mismo periodo no duplican: se procesan las dos y el guardado deduplica', async () => {
  const repo = repoFalso();
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'terminado', archivos: [{ n: 0, nombre: 'a.zip' }, { n: 1, nombre: 'b.zip' }], log: [] }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
});

test('si la receta termina sin descargar, la corrida guarda el registro de Fisherboy', async () => {
  const repo = repoFalso();
  const log = [{ n: 16, do: 'download', ok: false, error: 'Page.click: Timeout 60000ms exceeded.', origen: 'receta' }, { do: 'ia:done', ok: true, origen: 'ia' }];
  const { s } = servicio(repo, fisherboyFalso([{ estado: 'terminado', archivos: [], log }]));
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  const f = repo.corridas[c.id];
  assert.match(f.error, /sin descargar/);
  assert.strictEqual(f.log.length, 2);
});
