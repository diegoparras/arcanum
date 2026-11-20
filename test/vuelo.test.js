'use strict';

// Emision en vuelo: un intento con la misma idempotencyKey resuelve primero el intento anterior
// (adoptar si ARCA lo tiene y es esta venta; liberar solo con "no existe"; si no se puede saber,
// no emitir). Cubre reintentos del cliente, de la cola y reinicios a mitad de FECAESolicitar.

const { test } = require('node:test');
const assert = require('node:assert');

const vuelo = require('../src/services/vuelo');
const { SoapError } = require('../src/soap/client');
const { esIndisponibilidad } = require('../src/services/contingencia');

const V = { idempotency_key: 'K', cuit: '20111111112', punto_venta: 1, tipo_cbte: 11, numero: 41, importe_total: 100, doc_nro: '0', fecha: '20261120' };
const C = { numero: 41, cae: '777', importeTotal: 100, docNro: '0', fecha: '20261120', resultado: 'A' };

test('adopta si ARCA tiene ese numero con esta venta (total, receptor y fecha)', async () => {
  const r = await vuelo.resolver(V, { consultar: async () => C });
  assert.strictEqual(r.estado, 'adoptar');
  assert.strictEqual(r.consultado.cae, '777');
});

test('no adopta si la fecha o el total no coinciden: el numero es de otra venta', async () => {
  assert.strictEqual((await vuelo.resolver(V, { consultar: async () => ({ ...C, fecha: '20261119' }) })).estado, 'libre');
  assert.strictEqual((await vuelo.resolver(V, { consultar: async () => ({ ...C, importeTotal: 99 }) })).estado, 'libre');
});

test('solo "no existe" (602 o 404) libera el numero', async () => {
  const no602 = new SoapError('No existen datos', 422, { errors: [{ code: 602, message: 'No existen datos' }] });
  assert.strictEqual((await vuelo.resolver(V, { consultar: async () => { throw no602; } })).estado, 'libre');
  assert.strictEqual((await vuelo.resolver(V, { consultar: async () => { throw new SoapError('no', 404); } })).estado, 'libre');
});

test('un error interno de ARCA al verificar no emite: se reintenta despues', async () => {
  const interno = new SoapError('Error interno', 422, { errors: [{ code: 501, message: 'Error interno de aplicacion' }] });
  await assert.rejects(vuelo.resolver(V, { consultar: async () => { throw interno; } }), (e) => esIndisponibilidad(e) && /verificar/.test(e.message));
  await assert.rejects(vuelo.resolver(V, { consultar: async () => { throw new Error('db caida'); } }), (e) => esIndisponibilidad(e));
});

test('sin vuelo previo no hay nada que resolver', async () => {
  assert.strictEqual((await vuelo.resolver(null, { consultar: async () => { throw new Error('no deberia consultar'); } })).estado, 'libre');
});
