'use strict';

// Parser de Mis Comprobantes: CSV con ';' y coma decimal, tipos "11 - Factura C", ZIP y vacio.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const mc = require('../src/services/mcParser');

const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'mc-emitidos.csv'), 'utf8');

// ZIP minimo (un archivo, deflate) armado a mano: local header + central directory + EOCD.
function zipDe(nombre, datos) {
  const comp = zlib.deflateRawSync(datos);
  const n = Buffer.from(nombre);
  const crc = zlib.crc32 ? zlib.crc32(datos) : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(datos.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(datos.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cuerpo = Buffer.concat([local, n, comp]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12); eocd.writeUInt32LE(cuerpo.length, 16);
  return Buffer.concat([cuerpo, central, n, eocd]);
}

test('parsea las 3 filas del CSV de Mis Comprobantes', () => {
  const filas = mc.desdeArchivo(Buffer.from(CSV), 'comprobantes.csv', 'emitido');
  assert.strictEqual(filas.length, 3);
  const b = filas.find((f) => f.cbteTipo === 6);
  assert.deepStrictEqual(
    { total: b.total, neto: b.netoGravado, iva: b.iva, pv: b.puntoVenta, nro: b.numeroDesde, doc: b.docNro, fecha: b.fecha },
    { total: 1210, neto: 1000, iva: 210, pv: 2, nro: 48, doc: '28111222', fecha: '2026-11-10' },
  );
});

test('tipo "13 - Nota de Credito C" queda en 13 y conserva CAE y contraparte', () => {
  const nc = mc.desdeArchivo(Buffer.from(CSV), 'c.csv', 'emitido').find((f) => f.cbteTipo === 13);
  assert.strictEqual(nc.cae, '76451234567891');
  assert.strictEqual(nc.contraparte, 'EMPRESA DE PRUEBA SA');
  assert.strictEqual(nc.total, 20000.5);
  assert.strictEqual(nc.tipo, 'emitido');
});

test('CSV solo con encabezado da cero filas', () => {
  assert.deepStrictEqual(mc.desdeArchivo(Buffer.from(CSV.split('\n')[0] + '\n'), 'c.csv', 'recibido'), []);
});

test('ZIP con el CSV adentro da las mismas filas', () => {
  const zip = zipDe('Mis Comprobantes Emitidos.csv', Buffer.from(CSV));
  assert.deepStrictEqual(mc.leerZip(zip).map((a) => a.nombre), ['Mis Comprobantes Emitidos.csv']);
  assert.strictEqual(mc.desdeArchivo(zip, 'comprobantes.zip', 'emitido').length, 3);
});

test('parsearCsv tolera BOM, comas como separador y comillas', () => {
  const filas = mc.parsearCsv('﻿Fecha,Denominación\r\n01/02/2026,"PEREZ, JUAN"\r\n');
  assert.deepStrictEqual(filas, [{ Fecha: '01/02/2026', 'Denominación': 'PEREZ, JUAN' }]);
});

test('importes con formato argentino y fecha ISO', () => {
  const f = mc.normalizarFila({ Fecha: '2026-03-04', Tipo: '1', 'Imp. Total': '1.234.567,89' }, 'recibido');
  assert.strictEqual(f.total, 1234567.89);
  assert.strictEqual(f.fecha, '2026-03-04');
  assert.strictEqual(f.cbteTipo, 1);
});

test('CSV en Latin-1 se lee igual', () => {
  const filas = mc.desdeArchivo(Buffer.from(CSV, 'latin1'), 'c.csv', 'emitido');
  assert.strictEqual(filas.length, 3);
  assert.strictEqual(filas.find((f) => f.cbteTipo === 6).numeroDesde, 48);
});

test('filas que no se entienden dan 422, no cero comprobantes', () => {
  assert.throws(() => mc.desdeArchivo(Buffer.from('Foo;Bar\n1;2\n'), 'c.csv', 'emitido'),
    (e) => e.httpStatus === 422 && /columnas/.test(e.message));
});

test('una pagina HTML en vez del CSV da 422', () => {
  assert.throws(() => mc.desdeArchivo(Buffer.from('<!doctype html><html><body>Sesion vencida</body></html>'), 'c.csv', 'emitido'),
    (e) => e.httpStatus === 422 && /página/.test(e.message));
});

// JSON de ajax.do?f=listaResultados (lo que pide la receta directo). Filas posicionales: las
// posiciones salen de las variables rowXxx del JS de cada pagina de ARCA (verificado en vivo,
// 49 columnas en Emitidos y 52 en Recibidos). Datos sinteticos.
function filaJson(largo, valores) {
  const f = Array(largo).fill(null);
  for (const [i, v] of Object.entries(valores)) f[Number(i)] = v;
  return f;
}
const EMITIDA = filaJson(49, {
  0: '18/11/2025', 1: '11', 3: '2', 4: '190', 5: '190', 7: 'E', 8: '75461234567890',
  10: '80', 11: '30500000001', 12: 'CLIENTE DE PRUEBA SA', 13: '1.000000', 14: '$',
  37: '3500000.00', 39: '0.00', 41: '0.00', 45: '0.00', 47: '3500000.00',
});
const RECIBIDA = filaJson(52, {
  0: '05/03/2026', 1: '1', 3: '7', 4: '1234', 5: '1234', 7: 'E', 8: '76111111111111',
  10: '80', 11: '30711111118', 12: 'PROVEEDOR DE PRUEBA SRL', 14: '80', 15: '20263630743', 16: '1.000000', 17: '$',
  40: '1000.00', 42: '50.00', 44: '25.00', 46: '12.34', 48: '210.00', 50: '1297.34',
});
const json = (data, extra = {}) => Buffer.from(JSON.stringify({ estado: 'ok', datos: { consulta: { estado: 'PR' }, data }, ...extra }));

test('JSON de Emitidos: posiciones de ARCA, montos con punto decimal y $ como pesos', () => {
  const [c] = mc.desdeArchivo(json([EMITIDA]), 'mis-comprobantes.json', 'emitido');
  assert.deepStrictEqual(c, {
    tipo: 'emitido', fecha: '2025-11-18', cbteTipo: 11, puntoVenta: 2, numeroDesde: 190, numeroHasta: 190,
    cae: '75461234567890', docTipo: 80, docNro: '30500000001', contraparte: 'CLIENTE DE PRUEBA SA',
    moneda: 'PES', tipoCambio: 1, netoGravado: 3500000, noGravado: 0, exento: 0, iva: 0, total: 3500000,
  });
});

test('JSON de Recibidos: la contraparte es el emisor y los importes estan en otras posiciones', () => {
  const [c] = mc.desdeArchivo(json([RECIBIDA]), 'mis-comprobantes.json', 'recibido');
  assert.strictEqual(c.contraparte, 'PROVEEDOR DE PRUEBA SRL');
  assert.strictEqual(c.docNro, '30711111118');
  assert.strictEqual(c.docTipo, 80);
  assert.deepStrictEqual([c.netoGravado, c.noGravado, c.exento, c.iva, c.total], [1000, 50, 25, 210, 1297.34]);
  assert.deepStrictEqual([c.cbteTipo, c.puntoVenta, c.numeroDesde, c.fecha, c.moneda], [1, 7, 1234, '2026-03-05', 'PES']);
});

test('JSON: punto decimal con tres decimales no se toma como separador de miles', () => {
  const fila = filaJson(49, { ...Object.fromEntries(EMITIDA.map((v, i) => [i, v])), 47: '100.500', 13: '1050.250000', 14: 'DOL' });
  const [c] = mc.desdeArchivo(json([fila]), 'x.json', 'emitido');
  assert.strictEqual(c.total, 100.5);
  assert.strictEqual(c.tipoCambio, 1050.25);
  assert.strictEqual(c.moneda, 'DOL');
});

test('JSON sin comprobantes da cero filas', () => {
  assert.deepStrictEqual(mc.desdeArchivo(json([]), 'x.json', 'emitido'), []);
});

test('JSON con error de ARCA o con columnas que no son las conocidas es un error, nunca un cero', () => {
  assert.throws(() => mc.desdeArchivo(Buffer.from(JSON.stringify({ estado: 'error', mensajeError: 'Rango invalido' })), 'x.json', 'emitido'),
    (e) => e.httpStatus === 422 && /Rango invalido/.test(e.message));
  assert.throws(() => mc.desdeArchivo(json([filaJson(30, { 0: '01/01/2026', 1: '11' })]), 'x.json', 'emitido'),
    (e) => e.httpStatus === 422 && /30 columnas/.test(e.message));
});
