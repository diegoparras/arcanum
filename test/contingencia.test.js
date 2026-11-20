'use strict';

// Que cuenta como "ARCA no responde" (se puede encolar y reintentar) y que no (es final).

const { test } = require('node:test');
const assert = require('node:assert');

const { esIndisponibilidad } = require('../src/services/contingencia');
const { SoapError } = require('../src/soap/client');

const se = (msg, status, extra) => new SoapError(msg, status, extra);

test('timeout es indisponibilidad', () => {
  assert.strictEqual(esIndisponibilidad(se('Timeout', 504, { tipo: 'timeout' })), true);
});
test('conexion rechazada lo es', () => {
  assert.strictEqual(esIndisponibilidad(se('No se pudo conectar', 502, { tipo: 'conexion' })), true);
});
test('http 503 lo es y 400 no', () => {
  assert.strictEqual(esIndisponibilidad(se('HTTP 503', 502, { tipo: 'http', status: 503 })), true);
  assert.strictEqual(esIndisponibilidad(se('HTTP 400', 502, { tipo: 'http', status: 400 })), false);
});
test('fault NullReference no lo es, fault "servicio no disponible" si', () => {
  assert.strictEqual(esIndisponibilidad(se('ARCA rechazo la solicitud: System.NullReferenceException', 502, { tipo: 'fault' })), false);
  assert.strictEqual(esIndisponibilidad(se('ARCA rechazo la solicitud: Servicio no disponible temporalmente', 502, { tipo: 'fault' })), true);
});
test('validacion 422 no', () => {
  assert.strictEqual(esIndisponibilidad(se('Importes no cierran', 422)), false);
  assert.strictEqual(esIndisponibilidad(new Error('cualquier cosa')), false);
  assert.strictEqual(esIndisponibilidad(null), false);
});
