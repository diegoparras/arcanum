'use strict';

// Cola de emision: recuperacion segura de cortes ambiguos, ventana de fecha, reintentos con
// espera creciente, rechazos finales y arranque. Repo y WSFEv1 son dobles (sin DB ni red).

const { test } = require('node:test');
const assert = require('node:assert');

const cola = require('../src/services/colaEmision');
const { SoapError } = require('../src/soap/client');

const AHORA = new Date('2026-11-20T15:00:00Z');
const caido = () => new SoapError('Timeout llamando a ARCA', 504, { tipo: 'timeout' });

function repoFalso() {
  const r = { items: {}, sig: 1 };
  r.insertar = async (it) => {
    const ya = Object.values(r.items).find((x) => x.idempotency_key === it.idempotency_key);
    if (ya) return ya;
    const id = r.sig++; r.items[id] = { id, estado: 'pendiente', intentos: 0, numero_intentado: null, creado_at: AHORA, ...it };
    return r.items[id];
  };
  r.obtener = async (id) => r.items[id] || null;
  r.tomar = async (id) => {
    const it = r.items[id];
    if (!it || it.estado !== 'pendiente') return null;
    it.estado = 'procesando'; return it;
  };
  r.actualizar = async (id, campos) => Object.assign(r.items[id], campos);
  r.reabrir = async (id, campos) => (['pendiente', 'requiere_humano'].includes(r.items[id].estado) ? Object.assign(r.items[id], campos) : null);
  r.pendientesListos = async () => Object.values(r.items).filter((x) => x.estado === 'pendiente').map((x) => x.id);
  r.reencolarProcesando = async () => {
    let n = 0;
    for (const it of Object.values(r.items)) if (it.estado === 'procesando') { it.estado = 'pendiente'; n += 1; }
    return n;
  };
  return r;
}

function wsfeFalso({ consulta = null, autoriza } = {}) {
  const w = { emitidos: [], adoptados: [], consultas: [] };
  w.consultar = async (cuit, pv, tipo, n) => {
    w.consultas.push(n);
    if (consulta instanceof Error) throw consulta;
    if (!consulta) throw new SoapError('Comprobante no encontrado en ARCA', 404);
    return consulta;
  };
  w.authorizeInvoice = async (cuit, inv) => {
    w.emitidos.push(inv);
    if (autoriza) return autoriza(inv);
    return { aprobado: true, resultado: 'A', cae: '7777', numero: 41, cuit };
  };
  w.registrarAdoptado = async (cuit, c, cuerpo, idem) => { w.adoptados.push({ c, idem }); };
  return w;
}

const hooks = () => { const h = { ev: [] }; h.emitir = async (e, p) => { h.ev.push([e, p]); }; return h; };

const INV = { cuit: '20263630743', puntoVenta: 1, tipoComprobante: 11, concepto: 1, importeTotal: 100, tipoDocReceptor: 99, nroDocReceptor: '0' };

function armar(opts = {}) {
  const repo = repoFalso();
  const wsfev1 = wsfeFalso(opts);
  const webhooks = hooks();
  let ahora = opts.ahora || AHORA;
  const s = cola.crear({ repo, wsfev1, webhooks, ahora: () => ahora });
  return { s, repo, wsfev1, webhooks, avanzar: (ms) => { ahora = new Date(ahora.getTime() + ms); } };
}

test('encolar fija la fecha, genera la clave y no duplica', async () => {
  const { s } = armar();
  const a = await s.encolar('20263630743', { ...INV }, { usuario: 'u' });
  assert.strictEqual(a.cuerpo.fecha, '20261120');
  assert.match(a.idempotency_key, /^cola-[0-9a-f]{16,}$/);
  const b = await s.encolar('20263630743', { ...INV, idempotencyKey: a.idempotency_key }, {});
  assert.strictEqual(b.id, a.id);
});

test('el corte ambiguo lo resuelve la emision (vuelo): la cola no consulta por su cuenta', async () => {
  const { s, wsfev1 } = armar({ autoriza: () => ({ aprobado: true, adoptado: true, cae: '5555', numero: 40 }) });
  const it = await s.encolar('20263630743', { ...INV }, { numeroIntentado: 40 });
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'emitido');
  assert.strictEqual(fin.resultado.cae, '5555');
  assert.strictEqual(wsfev1.consultas.length, 0);
});

test('si no se puede verificar el intento anterior, el item queda pendiente', async () => {
  const { s } = armar({ autoriza: () => { throw new SoapError('No se pudo verificar en ARCA si el intento anterior se emitio', 503, { tipo: 'verificacion' }); } });
  const it = await s.encolar('20263630743', { ...INV }, { numeroIntentado: 40 });
  assert.strictEqual((await s.procesar(it.id)).estado, 'pendiente');
});

test('un rechazo de un item con intento ambiguo pide una persona (puede tener CAE)', async () => {
  const { s } = armar({ autoriza: () => ({ aprobado: false, resultado: 'R', observaciones: [{ code: 10016, message: 'numero' }] }) });
  const it = await s.encolar('20263630743', { ...INV }, { numeroIntentado: 40 });
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'requiere_humano');
  assert.match(fin.ultimo_error, /revis/i);
});

test('fuera de ventana pasa a requiere_humano sin emitir', async () => {
  const { s, wsfev1, webhooks } = armar();
  const it = await s.encolar('20263630743', { ...INV, fecha: '2026-11-14' }, {});
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'requiere_humano');
  assert.match(fin.ultimo_error, /fecha/i);
  assert.strictEqual(wsfev1.emitidos.length, 0);
  assert.ok(webhooks.ev.some(([e]) => e === 'cola_requiere_humano'));
  assert.strictEqual(webhooks.ev[0][0], 'comprobante_encolado');
  // servicios aceptan 10 dias
  const serv = await s.encolar('20263630743', { ...INV, concepto: 2, fecha: '2026-11-14' }, {});
  assert.strictEqual((await s.procesar(serv.id)).estado, 'emitido');
});

test('fechaHoy re-fecha solo a pedido', async () => {
  const { s, wsfev1 } = armar();
  const it = await s.encolar('20263630743', { ...INV, fecha: '2026-11-01' }, {});
  await s.procesar(it.id);
  const sinCambio = await s.reintentar(it.id, {});
  assert.strictEqual(sinCambio.estado, 'requiere_humano');
  const fin = await s.reintentar(it.id, { fechaHoy: true });
  assert.strictEqual(fin.estado, 'emitido');
  assert.strictEqual(wsfev1.emitidos[0].fecha, '20261120');
});

test('indisponible reprograma con espera creciente', async () => {
  const { s } = armar({ autoriza: () => { const e = caido(); e.numeroIntentado = 41; throw e; } });
  const it = await s.encolar('20263630743', { ...INV }, {});
  const a = await s.procesar(it.id);
  assert.strictEqual(a.estado, 'pendiente');
  assert.strictEqual(a.intentos, 1);
  assert.strictEqual(a.numero_intentado, 41);
  assert.strictEqual(a.proximo_intento_at.getTime(), AHORA.getTime() + 60000);
  const b = await s.procesar(it.id);
  assert.strictEqual(b.proximo_intento_at.getTime(), AHORA.getTime() + 2 * 60000);
  assert.deepStrictEqual(cola.ESPERAS_MIN, [1, 2, 5, 10, 30, 60]);
  assert.strictEqual(cola.proximoIntento(99, AHORA).getTime(), AHORA.getTime() + 60 * 60000);
});

test('rechazo es final', async () => {
  const { s } = armar({ autoriza: () => ({ aprobado: false, resultado: 'R', observaciones: [{ code: 10016, message: 'Fecha' }] }) });
  const it = await s.encolar('20263630743', { ...INV }, {});
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'rechazado');
  assert.strictEqual(fin.resultado.resultado, 'R');
});

test('un error de validacion es final y uno inesperado pide a una persona', async () => {
  const { s } = armar({ autoriza: () => { throw new SoapError('Importes no cierran', 422); } });
  const it = await s.encolar('20263630743', { ...INV }, {});
  assert.strictEqual((await s.procesar(it.id)).estado, 'rechazado');
  const x = armar({ autoriza: () => { throw new Error('certificado vencido'); } });
  const it2 = await x.s.encolar('20263630743', { ...INV }, {});
  assert.strictEqual((await x.s.procesar(it2.id)).estado, 'requiere_humano');
});

test('procesando vuelve a pendiente al arrancar', async () => {
  const { s, repo } = armar();
  const it = await s.encolar('20263630743', { ...INV }, {});
  repo.items[it.id].estado = 'procesando';
  assert.strictEqual(await s.reencolarProcesando(), 1);
  assert.strictEqual(repo.items[it.id].estado, 'pendiente');
});

test('cancelar solo lo que no salio', async () => {
  const { s } = armar();
  const it = await s.encolar('20263630743', { ...INV }, {});
  await s.procesar(it.id);
  await assert.rejects(s.cancelar(it.id), (e) => e.httpStatus === 409);
  const otro = await s.encolar('20263630743', { ...INV, importeTotal: 5 }, {});
  assert.strictEqual((await s.cancelar(otro.id)).estado, 'cancelado');
});

test('fuera de ventana con 5 y 10 dias', () => {
  const hoy = new Date('2026-11-20T15:00:00Z');
  assert.strictEqual(cola.fueraDeVentana('20261115', 1, hoy), false);
  assert.strictEqual(cola.fueraDeVentana('20261114', 1, hoy), true);
  assert.strictEqual(cola.fueraDeVentana('20261110', 2, hoy), false);
  assert.strictEqual(cola.fueraDeVentana('20261109', 3, hoy), true);
});

function caeaFalso(corresponde) {
  const c = { usados: [] };
  c.corresponde = async () => corresponde;
  c.emitirConCaea = async (cuit, item) => { c.usados.push(item.id); return { aprobado: true, modo: 'CAEA', cae: 'CAEA1', numero: 1 }; };
  return c;
}

function armarConCaea(caea, opts = {}) {
  const repo = repoFalso();
  const wsfev1 = wsfeFalso(opts);
  const s = cola.crear({ repo, wsfev1, webhooks: hooks(), ahora: () => AHORA, caea });
  return { s, repo, wsfev1 };
}

test('cola usa CAEA si ARCA sigue sin responder y paso la espera', async () => {
  const caea = caeaFalso(true);
  const { s } = armarConCaea(caea, { autoriza: () => { throw caido(); } });
  const it = await s.encolar('20263630743', { ...INV }, {});
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'emitido');
  assert.strictEqual(fin.modo, 'CAEA');
  assert.deepStrictEqual(caea.usados, [it.id]);
});

test('cola no usa CAEA si esta apagado o todavia no corresponde', async () => {
  const caea = caeaFalso(false);
  const { s } = armarConCaea(caea, { autoriza: () => { throw caido(); } });
  const it = await s.encolar('20263630743', { ...INV }, {});
  assert.strictEqual((await s.procesar(it.id)).estado, 'pendiente');
  assert.deepStrictEqual(caea.usados, []);
});

test('cola no usa CAEA si ARCA ya respondio', async () => {
  const caea = caeaFalso(true);
  const { s, wsfev1 } = armarConCaea(caea);
  const it = await s.encolar('20263630743', { ...INV }, {});
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'emitido');
  assert.notStrictEqual(fin.modo, 'CAEA');
  assert.strictEqual(wsfev1.emitidos.length, 1);
  assert.deepStrictEqual(caea.usados, []);
});

test('cola nunca usa CAEA si hubo un intento ambiguo con CAE', async () => {
  const caea = caeaFalso(true);
  const { s } = armarConCaea(caea, { consulta: caido(), autoriza: () => { throw caido(); } });
  const it = await s.encolar('20263630743', { ...INV }, { numeroIntentado: 40 });
  const fin = await s.procesar(it.id);
  assert.strictEqual(fin.estado, 'pendiente');
  assert.deepStrictEqual(caea.usados, []);
});

test('nunca CAEA con una emision en vuelo pendiente aunque el item no tenga numero intentado', async () => {
  const caea = caeaFalso(true);
  const repo = repoFalso();
  const wsfev1 = wsfeFalso({ autoriza: () => { throw caido(); } });
  wsfev1.hayVuelo = async () => true;
  const s = cola.crear({ repo, wsfev1, webhooks: hooks(), ahora: () => AHORA, caea });
  const it = await s.encolar('20263630743', { ...INV }, {});
  assert.strictEqual((await s.procesar(it.id)).estado, 'pendiente');
  assert.deepStrictEqual(caea.usados, []);
});

test('reintentar o cancelar no pisan un item que el daemon ya tomo', async () => {
  const { s, repo } = armar();
  const it = await s.encolar('20263630743', { ...INV }, {});
  // el daemon lo toma entre la lectura y la escritura de la accion manual
  const obtenerOriginal = repo.obtener;
  repo.obtener = async (id) => { const x = await obtenerOriginal(id); const copia = { ...x }; repo.items[id].estado = 'procesando'; return copia; };
  await assert.rejects(s.reintentar(it.id, {}), (e) => e.httpStatus === 409);
  await assert.rejects(s.cancelar(it.id), (e) => e.httpStatus === 409);
  assert.strictEqual(repo.items[it.id].estado, 'procesando');
});
