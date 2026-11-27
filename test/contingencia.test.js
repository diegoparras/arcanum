'use strict';

// Que cuenta como "ARCA no responde" (se puede encolar y reintentar) y que no (es final).

const { test } = require('node:test');
const assert = require('node:assert');

const { esIndisponibilidad } = require('../src/services/contingencia');
const { SoapError } = require('../src/soap/client');

const se = (msg, status, extra) => new SoapError(msg, status, extra);

test('un timeout es indisponibilidad', () => {
  assert.strictEqual(esIndisponibilidad(se('Timeout', 504, { tipo: 'timeout' })), true);
});
test('una conexion rechazada es indisponibilidad', () => {
  assert.strictEqual(esIndisponibilidad(se('No se pudo conectar', 502, { tipo: 'conexion' })), true);
});
test('HTTP 503 es indisponibilidad y HTTP 400 no', () => {
  assert.strictEqual(esIndisponibilidad(se('HTTP 503', 502, { tipo: 'http', status: 503 })), true);
  assert.strictEqual(esIndisponibilidad(se('HTTP 400', 502, { tipo: 'http', status: 400 })), false);
});
test('un fault NullReference no es indisponibilidad y uno de "servicio no disponible" si', () => {
  assert.strictEqual(esIndisponibilidad(se('ARCA rechazo la solicitud: System.NullReferenceException', 502, { tipo: 'fault' })), false);
  assert.strictEqual(esIndisponibilidad(se('ARCA rechazo la solicitud: Servicio no disponible temporalmente', 502, { tipo: 'fault' })), true);
});
test('un error de validacion (422) o desconocido no es indisponibilidad', () => {
  assert.strictEqual(esIndisponibilidad(se('Importes no cierran', 422)), false);
  assert.strictEqual(esIndisponibilidad(new Error('cualquier cosa')), false);
  assert.strictEqual(esIndisponibilidad(null), false);
});
