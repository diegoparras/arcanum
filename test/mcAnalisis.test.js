'use strict';

// Analisis de Mis Comprobantes: totales con signo (las NC restan), moneda extranjera a pesos,
// comparacion con el periodo anterior, principales contrapartes, meses sin movimiento y los
// filtros que usa el clic de la vista (contraparte, mes, clase, tipo, texto).

const { test } = require('node:test');
const assert = require('node:assert');
const { analizar, periodoPorDefecto } = require('../src/services/mcAnalisis');

let n = 0;
function c(tipo, fecha, total, extra = {}) {
  n += 1;
  return { tipo, fecha, cbte_tipo: 11, punto_venta: 4, numero_desde: n, doc_nro: '30500000001', contraparte: 'CLIENTE UNO SA', moneda: 'PES', tipo_cambio: 1, iva: 0, total, ...extra };
}
const P = { desde: '2026-09-01', hasta: '2026-11-30' };

test('facturado resta las notas de credito y pasa la moneda extranjera a pesos', () => {
  const r = analizar([
    c('emitido', '2026-11-02', 1000),
    c('emitido', '2026-11-03', 200, { cbte_tipo: 13 }),
    c('emitido', '2026-10-10', 10, { moneda: 'DOL', tipo_cambio: 1000 }),
  ], P);
  assert.strictEqual(r.kpis.facturado, 10800);
  assert.strictEqual(r.kpis.notasCredito, 200);
  assert.strictEqual(r.kpis.cantEmitidos, 3);
});

test('comprado, IVA debito y credito, y resultado bruto', () => {
  const r = analizar([
    c('emitido', '2026-11-02', 1210, { cbte_tipo: 1, iva: 210 }),
    c('recibido', '2026-11-05', 605, { cbte_tipo: 1, iva: 105, doc_nro: '30711111118', contraparte: 'PROVEEDOR ALFA' }),
    c('recibido', '2026-11-06', 121, { cbte_tipo: 3, iva: 21, doc_nro: '30711111118', contraparte: 'PROVEEDOR ALFA' }),
  ], P);
  assert.strictEqual(r.kpis.comprado, 484);
  assert.strictEqual(r.kpis.ivaDebito, 210);
  assert.strictEqual(r.kpis.ivaCredito, 84);
  assert.strictEqual(r.kpis.resultado, 1210 - 484);
});

test('compara contra el periodo anterior de la misma duracion', () => {
  const r = analizar([
    c('emitido', '2026-11-02', 1500),
    c('emitido', '2026-07-15', 1000),
    c('emitido', '2026-05-01', 999999),
  ], P);
  assert.deepStrictEqual(r.anterior, { desde: '2026-06-02', hasta: '2026-08-31' });
  assert.strictEqual(r.kpis.facturadoAnterior, 1000);
  assert.strictEqual(r.kpis.variacion, 0.5);
  assert.strictEqual(analizar([c('emitido', '2026-11-02', 1)], P).kpis.variacion, null, 'sin base no hay porcentaje');
});

test('por mes: todos los meses del periodo, tambien los vacios, con emitido y recibido separados', () => {
  const r = analizar([c('emitido', '2026-11-02', 100), c('recibido', '2026-09-20', 40, { doc_nro: '30711111118' })], P);
  assert.deepStrictEqual(r.porMes.map((m) => [m.mes, m.emitido, m.recibido]), [['2026-09', 0, 40], ['2026-10', 0, 0], ['2026-11', 100, 0]]);
});

test('principales clientes: los 5 mayores y el resto en otros, con su CUIT para filtrar', () => {
  const filas = [];
  for (let i = 1; i <= 7; i += 1) filas.push(c('emitido', '2026-11-02', i * 100, { doc_nro: `2000000000${i}`, contraparte: `CLIENTE ${i}` }));
  const r = analizar(filas, P);
  assert.deepStrictEqual(r.clientes.items.map((x) => x.docNro), ['20000000007', '20000000006', '20000000005', '20000000004', '20000000003']);
  assert.deepStrictEqual(r.clientes.otros, { total: 300, cantidad: 2, contrapartes: 2 });
  assert.strictEqual(r.clientes.items[0].nombre, 'CLIENTE 7');
  assert.strictEqual(r.clientes.concentracion, +(700 / 2800).toFixed(4));
  assert.deepStrictEqual(r.proveedores.items, []);
});

test('por tipo de comprobante, con la NC en negativo', () => {
  const r = analizar([c('emitido', '2026-11-02', 100), c('emitido', '2026-11-02', 30, { cbte_tipo: 13 })], P);
  assert.deepStrictEqual(r.porTipo.map((t) => [t.tipo, t.cbteTipo, t.cantidad, t.total]), [['emitido', 11, 1, 100], ['emitido', 13, 1, -30]]);
});

test('subtotales por mes y lado, con las contrapartes adentro y el total general', () => {
  const r = analizar([
    c('emitido', '2026-11-02', 121, { iva: 21 }),
    c('emitido', '2026-11-09', 100, { doc_nro: '20000000009', contraparte: 'OTRO' }),
    c('recibido', '2026-11-03', 50, { doc_nro: '30711111118', contraparte: 'PROV' }),
    c('emitido', '2026-10-02', 10),
  ], P);
  assert.deepStrictEqual(r.subtotales.map((s) => [s.mes, s.tipo, s.cantidad, s.total]), [['2026-11', 'emitido', 2, 221], ['2026-11', 'recibido', 1, 50], ['2026-10', 'emitido', 1, 10]]);
  const nov = r.subtotales[0];
  assert.deepStrictEqual(nov.contrapartes.map((x) => [x.docNro, x.neto, x.iva, x.total]), [['30500000001', 100, 21, 121], ['20000000009', 100, 0, 100]]);
});

test('filtros del clic: contraparte, clase, tipo y texto (nombre o CUIT, sin importar tildes)', () => {
  const filas = [
    c('emitido', '2026-11-02', 100),
    c('emitido', '2026-11-02', 20, { cbte_tipo: 13 }),
    c('emitido', '2026-11-02', 7, { doc_nro: '20000000009', contraparte: 'Fundación Ñandú' }),
    c('recibido', '2026-11-02', 50, { doc_nro: '30711111118', contraparte: 'PROV' }),
  ];
  assert.strictEqual(analizar(filas, { ...P, contraparte: '30500000001' }).kpis.cantEmitidos, 2);
  assert.strictEqual(analizar(filas, { ...P, clase: 'nc' }).kpis.notasCredito, 20);
  assert.strictEqual(analizar(filas, { ...P, clase: 'facturas' }).kpis.notasCredito, 0);
  assert.strictEqual(analizar(filas, { ...P, tipo: 'recibido' }).kpis.cantEmitidos, 0);
  assert.strictEqual(analizar(filas, { ...P, q: 'fundacion nandu' }).kpis.facturado, 7);
  assert.strictEqual(analizar(filas, { ...P, q: '3071111' }).kpis.comprado, 50);
  assert.strictEqual(analizar(filas, { ...P, cbte: 13 }).kpis.cantEmitidos, 1);
});

test('fuera del periodo no cuenta, y las fechas pueden venir como Date', () => {
  const r = analizar([c('emitido', new Date('2026-11-02T00:00:00Z'), 5), c('emitido', '2026-12-01', 9)], P);
  assert.strictEqual(r.kpis.facturado, 5);
});

test('periodo por defecto: los ultimos 12 meses completos hasta hoy', () => {
  assert.deepStrictEqual(periodoPorDefecto(new Date('2026-11-25T15:00:00Z')), { desde: '2025-12-01', hasta: '2026-11-25' });
});
