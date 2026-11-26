'use strict';

// Informativos de la auditoria 2026-11-26: I-01 (fechas de e-Ventanilla validadas antes de ir al
// XML) e I-02 (el ZIP de Mis Comprobantes se descomprime con tope).

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

test('I-01: e-Ventanilla solo acepta fechas AAAA-MM-DD validas', () => {
  const { _internos } = require('../src/services/eventanilla');
  assert.deepStrictEqual(_internos.rangoFechas('2026-11-01', '2026-11-20'), { desde: '2026-11-01', hasta: '2026-11-20' });
  // Lo que pasa de 10 caracteres se recorta (ya era asi): '2026-11-01<x>' queda en '2026-11-01'.
  assert.strictEqual(_internos.rangoFechas('2026-11-01<x>', '2026-11-20').desde, '2026-11-01');
  for (const [d, h] of [['2026-11-01', '</f>'], ['2026-13-01', '2026-11-20'], ['<a>b</a>', '2026-11-20']]) {
    assert.throws(() => _internos.rangoFechas(d, h), (e) => e.httpStatus === 400, `${d} ${h}`);
  }
});

test('I-02: un ZIP que descomprime a mas del tope se rechaza', () => {
  const { leerZip } = require('../src/services/mcParser');
  const enorme = zlib.deflateRawSync(Buffer.alloc(60 * 1024 * 1024, 65)); // 60 MB de "A" (comprime a casi nada)
  const nombre = Buffer.from('a.csv');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(enorme.length, 18); local.writeUInt16LE(nombre.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(enorme.length, 20); central.writeUInt16LE(nombre.length, 28); central.writeUInt32LE(0, 42);
  const offCentral = local.length + nombre.length + enorme.length;
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10); fin.writeUInt32LE(central.length + nombre.length, 12); fin.writeUInt32LE(offCentral, 16);
  const zip = Buffer.concat([local, nombre, enorme, central, nombre, fin]);
  assert.throws(() => leerZip(zip), /grande|tope|buffer/i);
});
