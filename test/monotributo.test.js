'use strict';

// Topes de Monotributo: suma de los ultimos 12 meses (NC restan, sin duplicar lo emitido por
// Arcanum) y semaforo contra la categoria.

const { test } = require('node:test');
const assert = require('node:assert');

const mono = require('../src/services/monotributo');

const HASTA = new Date('2026-11-19T12:00:00Z');
const mc = (fecha, cbte, total, extra = {}) => ({ tipo: 'emitido', fecha, cbte_tipo: cbte, total: String(total), punto_venta: 1, numero_desde: Math.floor(Math.random() * 1e6), cae: null, tipo_cambio: '1', ...extra });

test('NC resta', () => {
  const r = mono.calcularIngresos([mc('2026-10-01', 11, 1000), mc('2026-10-05', 13, 300)], [], HASTA);
  assert.strictEqual(r.total, 700);
  assert.deepStrictEqual(r.porMes, { '2026-10': 700 });
});

test('fuera de 12 meses no cuenta', () => {
  const r = mono.calcularIngresos([mc('2025-11-19', 11, 999), mc('2025-11-20', 11, 100), mc('2026-11-19', 11, 1)], [], HASTA);
  assert.strictEqual(r.total, 101);
  assert.strictEqual(r.desde, '2025-11-20');
  assert.strictEqual(r.hasta, '2026-11-19');
});

test('recibidos no cuentan como ingresos', () => {
  const r = mono.calcularIngresos([mc('2026-10-01', 11, 1000, { tipo: 'recibido' })], [], HASTA);
  assert.strictEqual(r.total, 0);
});

test('propio repetido por CAE no suma dos veces', () => {
  const filas = [mc('2026-10-01', 11, 1000, { cae: '7645', punto_venta: 1, numero_desde: 5 })];
  const propios = [
    { tipo_cbte: 11, punto_venta: 1, numero: 5, cae: '7645', fecha: '2026-10-01', importe_total: '1000' },
    { tipo_cbte: 11, punto_venta: 1, numero: 6, cae: '7646', fecha: '2026-10-02', importe_total: '50' },
    { tipo_cbte: 11, punto_venta: 2, numero: 9, cae: null, fecha: '2026-10-03', importe_total: '25' },
  ];
  const r = mono.calcularIngresos(filas, propios, HASTA);
  assert.strictEqual(r.total, 1075);
  assert.strictEqual(r.propiosSumados, 2);
});

test('propio sin CAE se cruza por tipo, punto de venta y numero', () => {
  const filas = [mc('2026-10-01', 11, 1000, { punto_venta: 3, numero_desde: 40 })];
  const propios = [{ tipo_cbte: 11, punto_venta: 3, numero: 40, cae: null, fecha: '2026-10-01', importe_total: '1000' }];
  assert.strictEqual(mono.calcularIngresos(filas, propios, HASTA).total, 1000);
});

test('moneda extranjera se pasa a pesos con el tipo de cambio', () => {
  const r = mono.calcularIngresos([mc('2026-10-01', 11, 10, { tipo_cambio: '1000' })], [], HASTA);
  assert.strictEqual(r.total, 10000);
});

const CATS = { topes: { A: 100, B: 200, C: 300 } };

test('alerta 80 y 100', () => {
  assert.strictEqual(mono.evaluar(79, 'A', CATS).alerta, 'ok');
  assert.strictEqual(mono.evaluar(80, 'A', CATS).alerta, '80');
  const e = mono.evaluar(100.01, 'A', CATS);
  assert.strictEqual(e.alerta, '100');
  assert.strictEqual(e.tope, 100);
  assert.ok(e.usado > 1);
});

test('sugiere categoria siguiente', () => {
  assert.strictEqual(mono.evaluar(150, 'A', CATS).categoriaSugerida, 'B');
  assert.strictEqual(mono.evaluar(50, 'C', CATS).categoriaSugerida, 'A');
  const fuera = mono.evaluar(301, 'C', CATS);
  assert.strictEqual(fuera.categoriaSugerida, null);
  assert.strictEqual(fuera.excedeMaxima, true);
});

test('sin categoria actual igual sugiere', () => {
  const e = mono.evaluar(150, null, CATS);
  assert.strictEqual(e.tope, null);
  assert.strictEqual(e.categoriaSugerida, 'B');
  assert.strictEqual(e.alerta, 'sin_categoria');
});

test('semilla de categorias trae A a K y vigencia', () => {
  assert.deepStrictEqual(Object.keys(mono.CATEGORIAS_SEMILLA.topes), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  assert.strictEqual(mono.CATEGORIAS_SEMILLA.topes.A, 8992597.87);
  assert.match(mono.CATEGORIAS_SEMILLA.fuente, /verificar/);
});

test('letra de categoria desde la constancia', () => {
  assert.strictEqual(mono.letraCategoria({ idCategoria: 3, descripcionCategoria: 'C LOCACIONES DE SERVICIO' }), 'C');
  assert.strictEqual(mono.letraCategoria({ descripcionCategoria: 'Categoria H' }), 'H');
  assert.strictEqual(mono.letraCategoria(null), null);
});

test('avisos: una vez por mes y nivel, y recordatorio de recategorizacion en enero y julio', async () => {
  const marcas = {};
  const emitidos = [];
  const deps = {
    calcular: async (cuit) => ({ cuit, aplica: true, alerta: cuit === '20000000001' ? '80' : 'ok', categoria: 'A', usado: 0.85, ingresos: { total: 1 } }),
    leerMarca: async (k) => marcas[k] || null,
    guardarMarca: async (k, v) => { marcas[k] = v; },
    emitir: async (e, p) => { emitidos.push([e, p.motivo, p.cuit]); },
  };
  const cuits = ['20000000001', '20000000002'];
  await mono.revisarAvisos(cuits, { ...deps, hoy: new Date('2026-11-19T12:00:00Z') });
  await mono.revisarAvisos(cuits, { ...deps, hoy: new Date('2026-11-20T12:00:00Z') });
  assert.deepStrictEqual(emitidos, [['tope_monotributo', 'tope_80', '20000000001']]);
  await mono.revisarAvisos(cuits, { ...deps, hoy: new Date('2027-01-05T12:00:00Z') });
  assert.deepStrictEqual(emitidos.slice(1).map((e) => e[1]).sort(), ['recategorizacion', 'recategorizacion', 'tope_80']);
  await mono.revisarAvisos(cuits, { ...deps, hoy: new Date('2027-01-06T12:00:00Z') });
  assert.strictEqual(emitidos.length, 4);
});
