'use strict';

// CAEA opcional por CUIT: quincenas, pedido (consultar antes de solicitar), emision local
// numerada, informar lo emitido, "sin movimiento" y avisos antes de la fecha tope.

const { test } = require('node:test');
const assert = require('node:assert');

const caea = require('../src/services/caea');

const HOY = new Date('2026-11-20T15:00:00Z');

test('quincena 15 y 16 de noviembre', () => {
  assert.deepStrictEqual(caea.quincena(new Date('2026-11-15T15:00:00Z')), { periodo: 202611, orden: 1 });
  assert.deepStrictEqual(caea.quincena(new Date('2026-11-16T15:00:00Z')), { periodo: 202611, orden: 2 });
  // 02:00 UTC del 16 = 23:00 del 15 en Argentina
  assert.deepStrictEqual(caea.quincena(new Date('2026-11-16T02:00:00Z')), { periodo: 202611, orden: 1 });
});

test('quincenas a pedir cruzan el mes y el ano', () => {
  assert.deepStrictEqual(caea.quincenasAPedir(HOY), [{ periodo: 202611, orden: 2 }, { periodo: 202612, orden: 1 }]);
  assert.deepStrictEqual(caea.quincenasAPedir(new Date('2026-12-20T15:00:00Z')), [{ periodo: 202612, orden: 2 }, { periodo: 202701, orden: 1 }]);
  assert.deepStrictEqual(caea.quincenasAPedir(new Date('2026-12-05T15:00:00Z')), [{ periodo: 202612, orden: 1 }, { periodo: 202612, orden: 2 }]);
});

function armar({ config = { cuit: '20263630743', activo: true, punto_venta: 9, minutos_espera: 30 }, caeas = [], ws = {}, comprobantesCaea = {} } = {}) {
  const repo = {
    guardados: [], informados: [], errores: [], sinMov: [], avisos: {}, persistidos: [],
    config: async () => config,
    caeas: async () => caeas,
    caea: async (cuit, periodo, orden) => caeas.find((c) => c.periodo === periodo && c.orden === orden) || null,
    guardarCaea: async (cuit, g) => { const c = { id: caeas.length + 1, cuit, ...g }; caeas.push(c); repo.guardados.push(c); return c; },
    vigente: async (cuit, fechaYmd) => caeas.find((c) => c.vig_desde <= fechaYmd && fechaYmd <= c.vig_hasta) || null,
    maxNumero: async () => 10,
    conLock: async (k, fn) => fn(),
    persistir: async (cuit, out) => { repo.persistidos.push(out); },
    pendientesInformar: async () => repo.pend || [],
    marcarInformado: async (id, r) => { repo.informados.push([id, r]); },
    marcarErrorInforme: async (id, msg) => { repo.errores.push([id, msg]); },
    cantidadConCaea: async (caeaCod) => comprobantesCaea[caeaCod] || 0,
    sinMovHecho: async () => false,
    guardarSinMov: async (id, pv, r) => { repo.sinMov.push([id, pv, r]); },
    avisoHecho: async (k) => !!repo.avisos[k],
    marcarAviso: async (k) => { repo.avisos[k] = true; },
  };
  const wsfev1 = {
    llamadas: [],
    caeaConsultar: async (cuit, p, o) => { wsfev1.llamadas.push(['consultar', p, o]); return ws.consultar ? ws.consultar(p, o) : null; },
    caeaSolicitar: async (cuit, p, o) => { wsfev1.llamadas.push(['solicitar', p, o]); return ws.solicitar(p, o); },
    lastAuthorized: async () => ({ ultimoNumero: ws.ultimoArca ?? 8 }),
    caeaInformar: async (cuit, inv, o) => { wsfev1.llamadas.push(['informar', o.numero]); return ws.informar ? ws.informar(inv, o) : { resultado: 'A' }; },
    caeaSinMovimiento: async (cuit, pv, cod) => { wsfev1.llamadas.push(['sinmov', pv, cod]); return { resultado: 'A' }; },
  };
  const webhooks = { ev: [], emitir: async (e, p) => { webhooks.ev.push([e, p]); } };
  const s = caea.crear({ repo, wsfev1, webhooks, ahora: () => HOY });
  return { s, repo, wsfev1, webhooks };
}

const GET = (p, o, cod) => ({ CAEA: cod, Periodo: p, Orden: o, FchVigDesde: o === 1 ? `${p}01` : `${p}16`, FchVigHasta: o === 1 ? `${p}15` : `${p}30`, FchTopeInf: o === 1 ? `${p}20` : `${p + 1}05` });

test('asegurar consulta antes de solicitar y "todavia no" no es error', async () => {
  const { s, wsfev1, webhooks, repo } = armar({
    ws: {
      consultar: (p, o) => (o === 2 ? GET(p, o, '31111111111111') : null),
      solicitar: () => { throw Object.assign(new Error('No se puede solicitar el CAEA antes del dia 27'), { httpStatus: 422 }); },
    },
  });
  const r = await s.asegurar('20263630743');
  assert.deepStrictEqual(wsfev1.llamadas.map((l) => l[0]), ['consultar', 'consultar', 'solicitar']);
  assert.strictEqual(repo.guardados.length, 1);
  assert.strictEqual(repo.guardados[0].caea, '31111111111111');
  assert.deepStrictEqual(r.map((x) => x.estado), ['obtenido', 'todavia_no']);
  assert.ok(webhooks.ev.some(([e]) => e === 'caea_obtenido'));
});

test('emitirConCaea numera sobre el maximo local o de ARCA, en el punto de venta CAEA', async () => {
  const caeas = [{ id: 1, caea: '32222222222222', periodo: 202611, orden: 2, vig_desde: '20261116', vig_hasta: '20261130', tope_inf: '20261205' }];
  const { s, repo } = armar({ caeas, ws: { ultimoArca: 8 } });
  const item = { id: 4, cuit: '20263630743', cuerpo: { puntoVenta: 1, tipoComprobante: 11, fecha: '20261120', importeTotal: 100, concepto: 1 } };
  const out = await s.emitirConCaea('20263630743', item);
  assert.strictEqual(out.numero, 11);
  assert.strictEqual(out.puntoVenta, 9);
  assert.strictEqual(out.cae, '32222222222222');
  assert.strictEqual(out.modo, 'CAEA');
  assert.strictEqual(out.informado, false);
  assert.match(out.fchHsGen, /^20261120\d{6}$/);
  assert.strictEqual(repo.persistidos.length, 1);
});

test('sin CAEA vigente es error', async () => {
  const { s } = armar({ caeas: [] });
  const item = { id: 4, cuit: '20263630743', cuerpo: { puntoVenta: 1, tipoComprobante: 11, fecha: '20261120', importeTotal: 100 } };
  await assert.rejects(s.emitirConCaea('20263630743', item), (e) => e.httpStatus === 409 && /CAEA vigente/.test(e.message));
});

test('informar marca informado y avisa los errores', async () => {
  const { s, repo, webhooks } = armar({ ws: { informar: (inv, o) => (o.numero === 12 ? { resultado: 'R', observaciones: [{ code: 1, message: 'mal' }] } : { resultado: 'A' }) } });
  repo.pend = [
    { id: 1, numero: 11, punto_venta: 9, tipo_cbte: 11, raw: { caea: 'X', fchHsGen: '20261120100000', fecha: '20261120' } },
    { id: 2, numero: 12, punto_venta: 9, tipo_cbte: 11, raw: { caea: 'X', fchHsGen: '20261120100500', fecha: '20261120' } },
  ];
  const r = await s.informarPendientes('20263630743');
  assert.deepStrictEqual(repo.informados.map((x) => x[0]), [1]);
  assert.deepStrictEqual(repo.errores.map((x) => x[0]), [2]);
  assert.ok(webhooks.ev.some(([e]) => e === 'caea_informe_error'));
  assert.deepStrictEqual(r, { informados: 1, errores: 1 });
});

test('sin movimiento solo para CAEA vencidos y sin comprobantes', async () => {
  const caeas = [
    { id: 1, caea: 'VENCIDO-SIN', vig_desde: '20261101', vig_hasta: '20261115', tope_inf: '20261120' },
    { id: 2, caea: 'VENCIDO-CON', vig_desde: '20261016', vig_hasta: '20261031', tope_inf: '20261105' },
    { id: 3, caea: 'VIGENTE', vig_desde: '20261116', vig_hasta: '20261130', tope_inf: '20261205' },
  ];
  const { s, wsfev1, repo } = armar({ caeas, comprobantesCaea: { 'VENCIDO-CON': 2 } });
  await s.informarSinMovimiento('20263630743');
  assert.deepStrictEqual(wsfev1.llamadas.filter((l) => l[0] === 'sinmov'), [['sinmov', 9, 'VENCIDO-SIN']]);
  assert.strictEqual(repo.sinMov.length, 1);
});

test('aviso a dos dias del tope, una sola vez', async () => {
  const caeas = [{ id: 1, caea: 'X', vig_desde: '20261101', vig_hasta: '20261115', tope_inf: '20261122' }];
  const { s, repo, webhooks } = armar({ caeas });
  repo.pend = [{ id: 7, numero: 3, punto_venta: 9, tipo_cbte: 11, raw: { caea: 'X' } }];
  await s.avisos('20263630743');
  await s.avisos('20263630743');
  assert.strictEqual(webhooks.ev.filter(([e]) => e === 'caea_informe_pendiente').length, 1);
});

test('corresponde usar CAEA solo prendido y pasados los minutos de espera', async () => {
  const caeas = [{ id: 1, caea: 'V', vig_desde: '20261116', vig_hasta: '20261130', tope_inf: '20261205' }];
  const reciente = { cuit: '20263630743', creado_at: new Date(HOY.getTime() - 10 * 60000), cuerpo: { fecha: '20261120' } };
  const viejo = { ...reciente, creado_at: new Date(HOY.getTime() - 31 * 60000) };
  assert.strictEqual(await armar({ caeas }).s.corresponde(reciente, HOY), false);
  assert.strictEqual(await armar({ caeas }).s.corresponde(viejo, HOY), true);
  assert.strictEqual(await armar({ caeas, config: { activo: false, punto_venta: 9, minutos_espera: 30 } }).s.corresponde(viejo, HOY), false);
  assert.strictEqual(await armar({ caeas, config: null }).s.corresponde(viejo, HOY), false);
});

test('CAEA apagado igual informa "sin movimiento" y avisa lo pendiente', async () => {
  const caeas = [{ id: 1, caea: 'VIEJO', punto_venta: 9, vig_desde: '20261101', vig_hasta: '20261115', tope_inf: '20261122' }];
  const { s, wsfev1, webhooks } = armar({ caeas, config: { cuit: '20263630743', activo: false, punto_venta: 4, minutos_espera: 30 } });
  await s.informarSinMovimiento('20263630743');
  assert.deepStrictEqual(wsfev1.llamadas.filter((l) => l[0] === 'sinmov'), [['sinmov', 9, 'VIEJO']], 'usa el punto de venta con el que se pidio');
  const { s: s2, repo: r2, webhooks: w2 } = armar({ caeas, config: { activo: false, punto_venta: 9, minutos_espera: 30 } });
  r2.pend = [{ id: 7, numero: 3, punto_venta: 9, tipo_cbte: 11, raw: { caea: 'VIEJO' } }];
  await s2.avisos('20263630743');
  assert.ok(w2.ev.some(([e]) => e === 'caea_informe_pendiente'));
  assert.ok(webhooks);
});

test('un "sin movimiento" rechazado no queda como hecho y avisa el error', async () => {
  const caeas = [{ id: 1, caea: 'X', punto_venta: 9, vig_desde: '20261101', vig_hasta: '20261115', tope_inf: '20261122' }];
  const { s, repo, wsfev1, webhooks } = armar({ caeas });
  wsfev1.caeaSinMovimiento = async () => ({ resultado: 'R', errores: [{ code: 1, message: 'no' }] });
  await s.informarSinMovimiento('20263630743');
  assert.strictEqual(repo.sinMov.length, 0);
  assert.ok(webhooks.ev.some(([e]) => e === 'caea_informe_error'));
});

test('el daemon informa a todo CUIT con CAEA pedidos, aunque este apagado', async () => {
  const { s, repo } = armar();
  repo.cuitsConCaea = async () => ['20263630743', '30711111118'];
  assert.deepStrictEqual(await s.paraInformar(), ['20263630743', '30711111118']);
});

test('al pedir un CAEA se guarda el punto de venta con el que se pidio', async () => {
  const { s, repo } = armar({ ws: { consultar: () => null, solicitar: (p, o) => GET(p, o, `C${o}`) } });
  await s.asegurar('20263630743');
  assert.ok(repo.guardados.every((g) => g.punto_venta === 9));
});
