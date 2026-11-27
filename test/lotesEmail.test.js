'use strict';

// Lotes (auditoria 2026-11-26, B-12): el email es una sola direccion valida, nombre y periodo sin
// saltos de linea (van al cuerpo del correo), y "Solicitar" se manda una vez por dia por item.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const mailer = require('../src/services/mailer');
const lotes = require('../src/services/lotes');

const { normItem } = lotes._internos;

test('email: una sola direccion valida', () => {
  assert.strictEqual(normItem({ email: ' Ana@Ejemplo.com ' }).email, 'ana@ejemplo.com');
  for (const e of ['a@b.com, c@d.com', 'a@b.com;c@d.com', 'sin-arroba', 'a@b.com\nBcc: x@y.com', '<a@b.com>']) {
    assert.throws(() => normItem({ email: e }), (x) => x.httpStatus === 422, e);
  }
  assert.strictEqual(normItem({}).email, null);
});

test('nombre y periodo sin saltos de linea ni caracteres de control', () => {
  const it = normItem({ nombre: 'Juan\r\nPerez', periodo: '2026-11\n' });
  assert.strictEqual(it.nombre, 'Juan Perez');
  assert.strictEqual(it.periodo, '2026-11');
});

test('solicitar: una vez por dia por item', async () => {
  const original = { query: db.query, send: mailer.send };
  let enviados = 0;
  let solicitadoAt = null;
  db.query = async (sql) => {
    if (/SELECT \* FROM lote_items/i.test(sql)) return { rows: [{ id: 5, lote_id: 1, nombre: 'Ana', email: 'ana@ejemplo.com', estado: 'pendiente', solicitado_at: solicitadoAt }] };
    if (/UPDATE lote_items SET estado/i.test(sql)) { solicitadoAt = new Date(); return { rows: [] }; }
    return { rows: [] };
  };
  mailer.send = async () => { enviados += 1; };
  try {
    await lotes.solicitarItem(1, 5);
    await assert.rejects(lotes.solicitarItem(1, 5), (e) => e.httpStatus === 429);
    assert.strictEqual(enviados, 1);
  } finally { db.query = original.query; mailer.send = original.send; }
});
