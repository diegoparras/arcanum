'use strict';

// Sincronizar emitidos con ARCA: trae lo hecho por fuera de Arcanum (incluidos huecos del medio),
// corta por fecha y por tope, detecta diferencias y no toca puntos de venta CAEA o bloqueados.

const { test } = require('node:test');
const assert = require('node:assert');

const sync = require('../src/services/syncEmitidos');

const HOY = new Date('2026-11-20T15:00:00Z');

function armar({ pvs = [{ Nro: 1, EmisionTipo: 'CAE', Bloqueado: 'N', FchBaja: 'NULL' }], ultimos = {}, arca = {}, locales = {} } = {}) {
  const consultados = [];
  const insertados = [];
  const wsfev1 = {
    getParams: async () => pvs,
    lastAuthorized: async (cuit, pv, tipo) => ({ ultimoNumero: ultimos[`${pv}-${tipo}`] || 0 }),
    consultar: async (cuit, pv, tipo, n) => {
      consultados.push(`${pv}-${tipo}-${n}`);
      const c = arca[`${pv}-${tipo}-${n}`];
      if (!c) throw Object.assign(new Error('no existe'), { httpStatus: 404 });
      return { puntoVenta: pv, tipoComprobante: tipo, numero: n, cae: `CAE${n}`, importeTotal: 100, docNro: '0', resultado: 'A', ...c };
    },
  };
  const repo = {
    locales: async (cuit, pv, tipo) => locales[`${pv}-${tipo}`] || {},
    insertar: async (cuit, c) => { insertados.push(`${c.puntoVenta}-${c.tipoComprobante}-${c.numero}`); },
  };
  const webhooks = { ev: [], emitir: async (e, p) => { webhooks.ev.push([e, p]); } };
  const s = sync.crear({ wsfev1, repo, webhooks, ahora: () => HOY });
  return { s, consultados, insertados, webhooks };
}

test('trae los que faltan, incluidos los huecos del medio', async () => {
  const { s, consultados, insertados, webhooks } = armar({
    ultimos: { '1-11': 12 },
    locales: { '1-11': { 12: { fecha: '2026-11-19', cae: 'CAE12', importe: 100 }, 10: { fecha: '2026-11-10', cae: 'CAE10', importe: 100 } } },
    arca: { '1-11-12': { fecha: '20261119' }, '1-11-11': { fecha: '20261115' }, '1-11-9': { fecha: '20250101' } },
  });
  const r = await s.sincronizar('20263630743', { tipos: [11] });
  assert.deepStrictEqual(insertados, ['1-11-11']);
  assert.ok(consultados.includes('1-11-11') && consultados.includes('1-11-9'));
  assert.strictEqual(r.traidos, 1);
  assert.deepStrictEqual(r.porPuntoVenta, { 1: 1 });
  assert.ok(webhooks.ev.some(([e]) => e === 'emitidos_por_fuera'));
});

test('primera vez baja hasta la fecha limite', async () => {
  const arca = {};
  for (let n = 1; n <= 5; n += 1) arca[`1-11-${n}`] = { fecha: n >= 3 ? '20261101' : '20250101' };
  const { s, insertados } = armar({ ultimos: { '1-11': 5 }, arca });
  const r = await s.sincronizar('20263630743', { tipos: [11], dias: 90 });
  assert.deepStrictEqual(insertados, ['1-11-5', '1-11-4', '1-11-3']);
  assert.strictEqual(r.pendiente, false);
});

test('respeta el tope de consultas y deja pendiente', async () => {
  const arca = {};
  for (let n = 1; n <= 10; n += 1) arca[`1-11-${n}`] = { fecha: '20261115' };
  const { s, consultados } = armar({ ultimos: { '1-11': 10 }, arca });
  const r = await s.sincronizar('20263630743', { tipos: [11], tope: 4 });
  assert.strictEqual(consultados.length, 4);
  assert.strictEqual(r.pendiente, true);
});

test('detecta diferencia de CAE o importe en el ultimo local', async () => {
  const { s } = armar({
    ultimos: { '1-11': 7 },
    locales: { '1-11': { 7: { fecha: '2026-11-19', cae: 'OTRO', importe: 100 } } },
    arca: { '1-11-7': { fecha: '20261119', cae: 'CAE7' }, '1-11-6': { fecha: '20240101' } },
  });
  const r = await s.sincronizar('20263630743', { tipos: [11] });
  assert.strictEqual(r.diferencias.length, 1);
  assert.match(r.diferencias[0].motivo, /CAE/);
});

test('ignora puntos de venta CAEA, bloqueados y dados de baja', async () => {
  const { s, consultados } = armar({
    pvs: [
      { Nro: 2, EmisionTipo: 'CAEA', Bloqueado: 'N', FchBaja: 'NULL' },
      { Nro: 3, EmisionTipo: 'CAE', Bloqueado: 'S', FchBaja: 'NULL' },
      { Nro: 4, EmisionTipo: 'CAE', Bloqueado: 'N', FchBaja: '20240101' },
    ],
    ultimos: { '2-11': 3, '3-11': 3, '4-11': 3 },
  });
  const r = await s.sincronizar('20263630743', { tipos: [11] });
  assert.deepStrictEqual(consultados, []);
  assert.strictEqual(r.traidos, 0);
});
