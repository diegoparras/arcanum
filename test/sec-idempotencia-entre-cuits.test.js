'use strict';

// Auditoria de seguridad 2026-11-26, hallazgo A-03.
//
// La clave de idempotencia es global: `previoIdempotente` busca por `idempotency_key` sin mirar de
// que CUIT es el comprobante. La ruta solo valida el `cuit` del body contra el alcance de quien
// llama, asi que un operador de un cliente (o una clave de solo lectura, por la vista previa) recibe
// el comprobante completo de OTRO cliente si manda su clave de idempotencia. Las claves de los lotes
// son enumerables: `lote-<id>-item-<id>`.
//
// La base simulada tiene un solo comprobante, del CUIT A, y responde como responderia Postgres:
// si la consulta filtra por CUIT respeta el filtro, si no, devuelve la fila. Corregido en 2.1.11:
// la clave vale por (cuit, entorno); estos tests evitan que vuelva.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const wsfev1 = require('../src/services/wsfev1');
const { vistaPrevia } = require('../src/services/vistaPrevia');

const CUIT_A = '20111111112';
const CUIT_B = '20222222223';
const CLAVE = 'lote-7-item-31';
const AJENO = { cuit: CUIT_A, cae: '76000000000001', numero: 31, receptorNombre: 'CLIENTE RESERVADO DE A', importeTotal: 123456.78 };

async function conBaseSimulada(fn) {
  const original = { query: db.query, tx: db.tx, withLock: db.withLock };
  const sinDatos = async () => { throw Object.assign(new Error('base simulada: sin datos'), { httpStatus: 404 }); };
  db.tx = sinDatos;
  db.withLock = sinDatos;
  db.query = async (sql, params = []) => {
    if (/FROM\s+comprobantes/i.test(sql) && /idempotency_key/i.test(sql)) {
      const coincideClave = params.includes(CLAVE);
      const filtraPorCuit = /\bcuit\s*=/i.test(sql);
      const coincideCuit = !filtraPorCuit || params.includes(CUIT_A);
      return { rows: coincideClave && coincideCuit ? [{ raw: AJENO }] : [] };
    }
    // Cualquier otra consulta: no hay nada mas en esta base. El flujo sigue y falla por otro lado
    // (sin certificado, sin datos), que es lo esperado cuando la clave no es de este CUIT.
    return sinDatos();
  };
  try { return await fn(); } finally { Object.assign(db, original); }
}

test('A-03: emitir con el CUIT B y una clave de idempotencia del CUIT A no devuelve el comprobante de A', async () => {
  const r = await conBaseSimulada(() => wsfev1.authorizeInvoice(CUIT_B, {
    cuit: CUIT_B, puntoVenta: 1, tipoComprobante: 11, importeTotal: 1, idempotencyKey: CLAVE,
  }).catch((e) => ({ rechazado: e.message })));
  assert.notStrictEqual(r.cuit, CUIT_A, 'el operador del CUIT B recibio el comprobante del CUIT A');
  assert.ok(!JSON.stringify(r).includes(AJENO.receptorNombre), 'se filtro el receptor de un comprobante ajeno');
});

test('A-03: la vista previa (permitida al rol lectura) no muestra el comprobante de otro CUIT', async () => {
  const r = await conBaseSimulada(() => vistaPrevia(CUIT_B, {
    cuit: CUIT_B, puntoVenta: 1, tipoComprobante: 11, importeTotal: 1, idempotencyKey: CLAVE,
  }).catch((e) => ({ rechazado: e.message })));
  assert.ok(!r.comprobanteExistente || r.comprobanteExistente.cuit !== CUIT_A,
    'la vista previa devolvio en comprobanteExistente un comprobante del CUIT A');
});
