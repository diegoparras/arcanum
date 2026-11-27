'use strict';

// Listado paginado de los comprobantes ya bajados de Mis Comprobantes (REST y MCP).
const { test } = require('node:test');
const assert = require('node:assert');

const d = require('../src/services/descargados');

const FILA = {
  id: 418, cuit: '30777777773', tipo: 'recibido', fecha: new Date('2026-11-10T00:00:00Z'), cbte_tipo: 6, punto_venta: 2,
  numero_desde: '48', numero_hasta: '48', cae: '86000000000048', doc_tipo: 80, doc_nro: '20222222223',
  contraparte: 'Servicios Beta SA', moneda: 'PES', tipo_cambio: '1', neto_gravado: '1000', no_gravado: '0', exento: '0',
  iva: '210', total: '1210',
};

test('descargados: filtros aceptan emitidos/recibidos en plural o singular', () => {
  assert.strictEqual(d.normalizarFiltros({ tipo: 'emitidos' }).tipo, 'emitido');
  assert.strictEqual(d.normalizarFiltros({ tipo: 'recibido' }).tipo, 'recibido');
  assert.strictEqual(d.normalizarFiltros({}).tipo, undefined);
  assert.throws(() => d.normalizarFiltros({ tipo: 'todos' }), /tipo/);
});

test('descargados: filtros validan fechas, CUIT de contraparte y tipo de comprobante', () => {
  const f = d.normalizarFiltros({ desde: '2026-11-01', hasta: '2026-11-30', cuit: '20-22222222-3', tipoCbte: '6' });
  assert.strictEqual(f.desde, '2026-11-01');
  assert.strictEqual(f.hasta, '2026-11-30');
  assert.strictEqual(f.contraparte, '20222222223');
  assert.strictEqual(f.cbte, 6);
  assert.throws(() => d.normalizarFiltros({ desde: '01/11/2026' }), (e) => e.httpStatus === 400 && /desde/.test(e.message));
  assert.throws(() => d.normalizarFiltros({ tipoCbte: 'factura' }), /tipoCbte/);
  assert.throws(() => d.normalizarFiltros({ desde: '2026-12-01', hasta: '2026-11-01' }), /posterior/);
});

test('descargados: el limite tiene un valor por defecto y un tope', () => {
  assert.strictEqual(d.normalizarFiltros({}).limite, 50);
  assert.strictEqual(d.normalizarFiltros({ limite: '10' }).limite, 10);
  assert.strictEqual(d.normalizarFiltros({ limite: '9999' }).limite, 200);
  assert.strictEqual(d.normalizarFiltros({ limite: '9999' }, { tope: 50 }).limite, 50);
  assert.throws(() => d.normalizarFiltros({ limite: '0' }), /limite/);
});

test('descargados: cada fila sale con montos en numero, nombre del tipo e id estable', () => {
  const it = d.item(FILA);
  assert.strictEqual(it.id, '30777777773:recibido:6:2:48:20222222223');
  assert.strictEqual(it.tipo, 'recibido');
  assert.strictEqual(it.tipoComprobante, 6);
  assert.strictEqual(it.tipoNombre, 'Factura B');
  assert.strictEqual(it.comprobante, '0002-00000048');
  assert.strictEqual(it.puntoVenta, 2);
  assert.strictEqual(it.numero, 48);
  assert.strictEqual(it.fecha, '2026-11-10');
  assert.deepStrictEqual(it.contraparte, { cuit: '20222222223', documento: '20222222223', tipoDocumento: 80, nombre: 'Servicios Beta SA' });
  assert.deepStrictEqual(it.importes, { total: 1210, netoGravado: 1000, noGravado: 0, exento: 0, iva: 210 });
  assert.strictEqual(it.moneda, 'PES');
  assert.strictEqual(it.cotizacion, 1);
  assert.strictEqual(it.cae, '86000000000048');
  assert.ok(!('numeroHasta' in it), 'solo aparece cuando el comprobante es un rango');
  assert.strictEqual(d.item({ ...FILA }).id, it.id, 'el id no depende del id interno de la base');
});

test('descargados: contraparte sin CUIT (DNI) y montos vacios', () => {
  const it = d.item({ ...FILA, doc_tipo: 96, doc_nro: '30111222', iva: null, neto_gravado: null, numero_hasta: '52' });
  assert.strictEqual(it.contraparte.cuit, null);
  assert.strictEqual(it.contraparte.documento, '30111222');
  assert.strictEqual(it.importes.iva, null);
  assert.strictEqual(it.importes.netoGravado, null);
  assert.strictEqual(it.numeroHasta, 52);
});

test('descargados: el cursor va y vuelve, y uno roto es un 400', () => {
  const c = d.codificarCursor(FILA);
  assert.deepStrictEqual(d.leerCursor(c), { fecha: '2026-11-10', id: 418 });
  assert.throws(() => d.leerCursor('no-es-un-cursor'), (e) => e.httpStatus === 400 && /cursor/.test(e.message));
});

test('descargados: con cursor la consulta sigue despues del ultimo y pide uno de mas', () => {
  const f = d.normalizarFiltros({ tipo: 'recibidos', limite: '20', cursor: d.codificarCursor(FILA) });
  const { sql, vals } = d.consulta('30777777773', f);
  assert.match(sql, /ORDER BY COALESCE\(fecha, DATE '0001-01-01'\) DESC, id DESC/);
  assert.match(sql, /\(COALESCE\(fecha, DATE '0001-01-01'\), id\) < \(\$\d+::date, \$\d+\)/);
  assert.strictEqual(vals[vals.length - 1], 21);
  assert.ok(vals.includes('recibido'));
});

test('descargados: listar arma la pagina y el cursor siguiente', async () => {
  const filas = [1, 2, 3].map((n) => ({ ...FILA, id: 500 - n, numero_desde: String(n), numero_hasta: String(n) }));
  const r = await d.listar('30777777773', d.normalizarFiltros({ limite: '2' }), { query: async () => ({ rows: filas }) });
  assert.strictEqual(r.cantidad, 2);
  assert.strictEqual(r.comprobantes.length, 2);
  assert.ok(r.siguiente);
  assert.deepStrictEqual(d.leerCursor(r.siguiente), { fecha: '2026-11-10', id: 498 });
  assert.strictEqual(r.mensaje, undefined);
});

test('descargados: sin resultados lo dice con el periodo, sin inventar', async () => {
  const vacio = { query: async () => ({ rows: [] }) };
  const r = await d.listar('30777777773', d.normalizarFiltros({ desde: '2026-10-01', hasta: '2026-10-31' }), vacio);
  assert.strictEqual(r.cantidad, 0);
  assert.strictEqual(r.siguiente, null);
  assert.match(r.mensaje, /No hay comprobantes descargados entre 2026-10-01 y 2026-10-31/);
  const r2 = await d.listar('30777777773', d.normalizarFiltros({ tipo: 'emitidos' }), vacio);
  assert.match(r2.mensaje, /No hay comprobantes emitidos descargados/);
});
