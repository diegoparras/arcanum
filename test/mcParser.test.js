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
