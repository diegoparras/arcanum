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
  assert.ok(RECETA_DEFAULT.pasos.some((p) => p.do === 'fetch' && p.name));
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
  const nConsulta = RECETA_DEFAULT.pasos.findIndex((x) => x.do === 'fetch' && x.guardar === 'consulta') + 1;
  const log = [...Array.from({ length: nConsulta - 1 }, (_, i) => OK(i + 1)),
    { n: nConsulta, do: 'fetch', ok: false, error: 'la respuesta no es JSON (HTTP 200)', origen: 'receta' },
    { do: 'ia:click', ok: false, origen: 'ia' }, { do: 'ia:fill', ok: true, origen: 'ia' }];
  const p = mc.progresoDe(log, RECETA_DEFAULT.pasos, { rango: '01/10/2026 - 25/11/2026' });
  assert.strictEqual(p.paso, nConsulta);
  assert.strictEqual(p.ia, 2);
  assert.strictEqual(p.error, 'la respuesta no es JSON (HTTP 200)');
  assert.strictEqual(p.descripcion, 'Pedir a ARCA la consulta de comprobantes del rango 01/10/2026 - 25/11/2026');
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

test('Mis Comprobantes se abre por el buscador del portal, nunca por un link de la pagina', () => {
  // El carrusel de Novedades puede tener un video "Mis Comprobantes" que abre YouTube por codigo,
  // y la tarjeta de "Mas utilizados" depende de cada usuario: el buscador siempre esta.
  const pasos = RECETA_DEFAULT.pasos;
  const i = pasos.findIndex((p) => p.sel === '#buscadorInput');
  assert.ok(i > 0, 'usa el buscador');
  assert.deepStrictEqual([pasos[i].do, pasos[i].text], ['fill', 'Mis Comprobantes']);
  assert.strictEqual(pasos[i + 1].do, 'click');
  assert.match(pasos[i + 1].sel, /^li\[role="option"\]/);
  assert.strictEqual(pasos[i + 2].do, 'switch_tab');
  assert.ok(!pasos.some((p) => /^text=Mis Comprobantes$|a:has-text\("Mis Comprobantes"\)/.test(p.sel || '')), 'ningun link suelto');
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

test('la receta pide los datos a ARCA directo: sin calendario, sin Buscar, sin tabla ni CSV', () => {
  const pasos = RECETA_DEFAULT.pasos;
  assert.ok(!pasos.some((p) => p.sel === '#fechaEmision' || p.sel === '#buscarComprobantes' || p.sel === '#tablaDataTables'), 'nada de la pantalla de consulta');
  assert.ok(!pasos.some((p) => p.do === 'download'), 'sin exportar CSV');
  const i = pasos.findIndex((p) => p.do === 'click' && p.sel === '#btn{{var:tipo_boton}}');
  assert.ok(i >= 0, 'primero entra a la seccion: ARCA ata la consulta a la seccion abierta');
  const [gen, lista] = pasos.slice(i + 1).filter((p) => p.do === 'fetch');
  assert.match(gen.url, /^ajax\.do\?f=generarConsulta&t=\{\{var:t\}\}&fechaEmision=\{\{var:rango_url\}\}&tiposComprobantes=&cuitConsultada=\{\{var:cuit\}\}$/);
  assert.strictEqual(gen.guardar, 'consulta');
  assert.strictEqual(lista.url, 'ajax.do?f=listaResultados&id={{res:consulta.datos.idConsulta}}');
  assert.ok(lista.name && /\.json$/.test(lista.name), 'lo que vuelve queda como archivo para Arcanum');
  assert.strictEqual(pasos[pasos.length - 1], lista, 'es el ultimo paso');
});

test('las variables de la sesion llevan la seccion (E/R) y el rango ya codificado para la URL', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([TERMINADO, TERMINADO]);
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'ambos', desde: '2025-11-01', hasta: '2026-10-31' });
  await s.seguir(c.id);
  const [e, r] = fb.iniciados.map((o) => o.variables);
  assert.strictEqual(e.t, 'E');
  assert.strictEqual(r.t, 'R');
  assert.strictEqual(e.rango_url, '01%2F11%2F2025+-+31%2F10%2F2026');
  assert.strictEqual(decodeURIComponent(e.rango_url.replace(/\+/g, ' ')), '01/11/2025 - 31/10/2026');
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

test('la receta corre sin IA por defecto (RPA puro); ARCANUM_MC_IA=1 la habilita como respaldo', async () => {
  const correr = async (opts) => {
    const fb = fisherboyFalso([TERMINADO]);
    const s = mc.crear({ repo: repoFalso(), fisherboy: fb, vault, webhooks: webhooks(), esperaMs: 1, ...opts });
    const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
    await s.seguir(c.id);
    return fb.iniciados[0].ia;
  };
  assert.strictEqual(await correr({}), false);
  assert.strictEqual(await correr({ ia: true }), true);
  assert.strictEqual(mc.iaPorEntorno({}), false);
  assert.strictEqual(mc.iaPorEntorno({ ARCANUM_MC_IA: '1' }), true);
  assert.strictEqual(mc.iaPorEntorno({ ARCANUM_MC_IA: '0' }), false);
});

test('si la corrida falla, guarda la ultima pantalla de Fisherboy antes de cerrar la sesion', async () => {
  const repo = repoFalso();
  repo.capturas = {};
  repo.guardarCaptura = async (id, img) => { repo.capturas[id] = img; };
  const fb = fisherboyFalso([{ estado: 'error', error: 'paso #17 (wait_for): Timeout 60000ms exceeded' }]);
  const orden = [];
  fb.frame = async (t, desde) => { orden.push(['frame', t, desde]); return { status: 200, body: Buffer.from('JPEG-del-error') }; };
  const cerrar = fb.cerrar;
  fb.cerrar = async (t) => { orden.push(['cerrar', t]); return cerrar(t); };
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.strictEqual(String(repo.capturas[c.id]), 'JPEG-del-error');
  assert.deepStrictEqual(orden, [['frame', 'tok-1', 0], ['cerrar', 'tok-1']], 'la foto se pide antes de cerrar');
});

test('si no hay pantalla o Fisherboy no la da, el error de la corrida se guarda igual', async () => {
  for (const frame of [async () => ({ status: 204, body: Buffer.alloc(0) }), async () => { throw new Error('ECONNRESET'); }]) {
    const repo = repoFalso();
    repo.capturas = {};
    repo.guardarCaptura = async (id, img) => { repo.capturas[id] = img; };
    const fb = fisherboyFalso([{ estado: 'error', error: 'paso #17 (wait_for): Timeout' }]);
    fb.frame = frame;
    const { s } = servicio(repo, fb);
    const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
    await s.seguir(c.id);
    assert.strictEqual(repo.corridas[c.id].estado, 'error');
    assert.match(repo.corridas[c.id].error, /paso #17/);
    assert.deepStrictEqual(repo.capturas, {});
  }
});

test('una corrida que termina bien no pide ni guarda pantalla', async () => {
  const repo = repoFalso();
  repo.capturas = {};
  repo.guardarCaptura = async (id, img) => { repo.capturas[id] = img; };
  const fb = fisherboyFalso([TERMINADO]);
  let pedidas = 0;
  fb.frame = async () => { pedidas += 1; return { status: 200, body: Buffer.from('x') }; };
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'emitidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
  assert.strictEqual(pedidas, 0);
  assert.deepStrictEqual(repo.capturas, {});
});

test('analisis: trae del repo desde el periodo anterior y calcula con los filtros validados', async () => {
  const repo = repoFalso();
  let pedido;
  repo.paraAnalisis = async (cuit, desde, hasta) => {
    pedido = [cuit, desde, hasta];
    return [{ tipo: 'emitido', fecha: '2026-11-02', cbte_tipo: 11, doc_nro: '30500000001', contraparte: 'X', total: 100 }];
  };
  const s = mc.crear({ repo, fisherboy: fisherboyFalso([]), vault, webhooks: webhooks(), ahora: () => new Date('2026-11-25T15:00:00Z') });
  const a = await s.analisis('20-26363074-3', { tipo: 'emitido', clase: 'facturas', contraparte: '30500000001' });
  assert.deepStrictEqual(a.periodo, { desde: '2025-12-01', hasta: '2026-11-25' });
  assert.deepStrictEqual(pedido, ['20263630743', a.anterior.desde, '2026-11-25']);
  assert.strictEqual(a.kpis.facturado, 100);
  for (const malo of [{ clase: 'x' }, { tipo: 'todo' }, { cbte: 'abc' }, { desde: '2026-12-01', hasta: '2026-01-01' }, { desde: '2015-01-01', hasta: '2026-01-01' }]) {
    await assert.rejects(() => s.analisis('20263630743', malo), (e) => e.httpStatus === 400, JSON.stringify(malo));
  }
});

test('listado: los filtros del clic llegan como condiciones SQL con parametros (nunca texto pegado)', () => {
  const { condicionesListado } = mc;
  const { where, vals } = condicionesListado('20263630743', { tipo: 'recibido', desde: '2026-11-01', hasta: '2026-11-30', clase: 'nc', contraparte: '30711111118', q: "o'brien" });
  assert.match(where, /cuit = \$1/);
  assert.match(where, /tipo = \$2/);
  assert.match(where, /cbte_tipo = ANY\(\$\d+::int\[\]\)/);
  assert.match(where, /doc_nro = \$\d+/);
  assert.match(where, /contraparte ILIKE \$\d+/);
  assert.ok(!where.includes("o'brien"), 'el texto va como parametro');
  assert.ok(vals.includes('%o\'brien%'));
  assert.deepStrictEqual(vals.find(Array.isArray), [3, 8, 13, 21, 53, 110, 112, 113, 114, 203, 208, 213]);
  const fac = condicionesListado('20263630743', { clase: 'facturas' });
  assert.match(fac.where, /NOT \(cbte_tipo = ANY/);
});

test('hayComprobantes: con alcance por CUIT pregunta solo por esos; admin, por todos', async () => {
  const repo = repoFalso();
  const pedidos = [];
  repo.hayComprobantes = async (cuits) => { pedidos.push(cuits); return true; };
  const { s } = servicio(repo, fisherboyFalso([]));
  assert.strictEqual(await s.hayComprobantes({ role: 'operador', cuitAllow: ['30711111118'] }), true);
  assert.strictEqual(await s.hayComprobantes({ role: 'admin', cuitAllow: ['30711111118'] }), true);
  assert.strictEqual(await s.hayComprobantes({ role: 'lectura' }), true);
  assert.deepStrictEqual(pedidos, [['30711111118'], null, null]);
});

test('P-02: si el navegador sale de los dominios de ARCA, se corta la sesion', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([
    { estado: 'corriendo', url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml', log: [] },
    { estado: 'corriendo', url: 'https://sitio-ajeno.example/robo', log: [] },
    TERMINADO,
  ]);
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'recibidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.match(repo.corridas[c.id].error, /fuera de los dominios de ARCA/);
  assert.deepStrictEqual(fb.cerrados, ['tok-1']);
});

test('P-02: about:blank o sin URL no corta la sesion', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([{ estado: 'corriendo', url: 'about:blank', log: [] }, { estado: 'corriendo', log: [] }, TERMINADO]);
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'recibidos', desde: '2026-11-01', hasta: '2026-11-18' });
  await s.seguir(c.id);
  assert.strictEqual(repo.corridas[c.id].estado, 'terminado');
});

test('B-13: un rango de mas de 3 anios se rechaza (cada anio es un login con la clave fiscal)', async () => {
  const { s } = servicio(repoFalso(), fisherboyFalso([TERMINADO]));
  await assert.rejects(s.sincronizar('20263630743', { tipo: 'recibidos', desde: '1990-01-01', hasta: '2026-11-18' }), (e) => e.httpStatus === 400 && /3 a/.test(e.message));
  await s.sincronizar('20263630743', { tipo: 'recibidos', desde: '2024-01-01', hasta: '2026-11-18' });
});

test('B-13: una corrida en curso se puede cancelar y la sesion se cierra', async () => {
  const repo = repoFalso();
  const fb = fisherboyFalso([{ estado: 'corriendo', log: [] }]); // nunca termina sola
  const { s } = servicio(repo, fb);
  const c = await s.sincronizar('20263630743', { tipo: 'recibidos', desde: '2026-11-01', hasta: '2026-11-18' });
  const p = s.seguir(c.id);
  await new Promise((r) => setTimeout(r, 20));
  await s.cancelar(c.id, 'ana');
  await p;
  assert.strictEqual(repo.corridas[c.id].estado, 'error');
  assert.match(repo.corridas[c.id].error, /Cancelada por ana/);
  assert.deepStrictEqual(fb.cerrados, ['tok-1']);
  await assert.rejects(s.cancelar(c.id, 'ana'), (e) => e.httpStatus === 409, 'ya no esta en curso');
});

test('B-16: el analisis acepta hasta 2 anios y frena si hay demasiadas filas', async () => {
  const repo = repoFalso();
  repo.paraAnalisis = async () => Array.from({ length: 100001 }, () => ({ tipo: 'emitido', fecha: '2026-01-01', total: 1 }));
  const { s } = servicio(repo, fisherboyFalso([TERMINADO]));
  await assert.rejects(s.analisis('20263630743', { desde: '2022-01-01', hasta: '2026-11-18' }), (e) => e.httpStatus === 400 && /2 a/.test(e.message));
  await assert.rejects(s.analisis('20263630743', { desde: '2026-01-01', hasta: '2026-11-18' }), (e) => e.httpStatus === 413);
});
