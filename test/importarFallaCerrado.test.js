'use strict';

// Importar comprobante (auditoria 2026-11-26, M-09): si no se pudo constatar con ARCA no se guarda
// (antes se guardaba como "Autorizado"), y una emision propia nunca queda tapada por un importado.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const db = require('../src/db');
const engine = require('../src/soap/engine');
const importar = require('../src/services/importar');

const BASE = { cuitEmisor: '30999999995', puntoVenta: 9902, tipoComprobante: 1, numero: 77, fecha: '2026-11-20', importeTotal: 999999.99, cae: '12345678901234' };

test('si la constatacion no se pudo hacer, no se importa nada (503)', async () => {
  const original = { query: db.query, call: engine.call };
  const inserts = [];
  db.query = async (sql) => { if (/INSERT INTO comprobantes/i.test(sql)) inserts.push(sql); return { rows: [] }; };
  engine.call = async () => { throw Object.assign(new Error('El certificado no tiene WSCDC asociado'), { httpStatus: 403 }); };
  try {
    await assert.rejects(importar.importar('20111111112', BASE), (e) => e.httpStatus === 503 && /no se import/i.test(e.message));
    assert.deepStrictEqual(inserts, []);
  } finally { Object.assign(db, { query: original.query }); engine.call = original.call; }
});

test('constatado por ARCA si se importa', async () => {
  const original = { query: db.query, call: engine.call };
  const inserts = [];
  db.query = async (sql) => { if (/INSERT INTO comprobantes/i.test(sql)) inserts.push(sql); return { rows: [] }; };
  engine.call = async () => ({ ComprobanteConstatarResult: { Resultado: 'A' } });
  try {
    const r = await importar.importar('20111111112', BASE);
    assert.strictEqual(r.constatacion.valido, true);
    assert.strictEqual(inserts.length, 1);
  } finally { db.query = original.query; engine.call = original.call; }
});

test('las emisiones propias reemplazan un importado que ocupe el mismo numero', () => {
  const { CONFLICTO_EMISION } = require('../src/services/sqlComprobantes');
  assert.match(CONFLICTO_EMISION, /DO UPDATE SET/);
  assert.match(CONFLICTO_EMISION, /WHERE comprobantes\.origen = 'importado'/);
  for (const f of ['wsfev1.js', 'wsfex.js', 'wsmtxca.js', 'syncEmitidos.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', f), 'utf8');
    assert.ok(!/ON CONFLICT \(cuit, entorno, punto_venta, tipo_cbte, numero\) DO NOTHING/.test(src), `${f} todavia descarta la emision si hay un importado`);
    assert.ok(src.includes('CONFLICTO_EMISION'), `${f} no usa CONFLICTO_EMISION`);
  }
});
