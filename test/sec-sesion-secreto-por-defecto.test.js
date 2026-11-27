'use strict';

// AUDITORIA 2026-11-26, hallazgo C-01 (critico): el secreto con que se firman las sesiones cae a
// una cadena fija del codigo ('arcanum-dev-secret') cuando el entorno no trae
// ARCANUM_SESSION_SECRET, ARCANUM_MASTER_KEY ni ARCANUM_API_KEY. Es justo la configuracion que
// Arcanum soporta "sin tocar nada": la clave de API y la master key se generan en el volumen,
// pero config.masterKey y config.apiKey solo miran el entorno y quedan vacias.
// Cualquiera que lea el repo (es MIT) puede firmar una cookie de superadmin.
//
// Corregido en 2.1.11 (src/auth/session.js): estos tests evitan que vuelva.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

function sesionSinSecretosEnElEntorno() {
  for (const k of ['ARCANUM_SESSION_SECRET', 'ARCANUM_MASTER_KEY', 'ARCANUM_API_KEY']) delete process.env[k];
  for (const m of ['../src/config', '../src/auth/session']) delete require.cache[require.resolve(m)];
  return require('../src/auth/session');
}

function cookieForjada(secreto, payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secreto).update(data).digest('base64url');
  return `${data}.${mac}`;
}

test('sin secretos en el entorno, una cookie firmada con la cadena fija del codigo no vale', () => {
  const session = sesionSinSecretosEnElEntorno();
  const token = cookieForjada('arcanum-dev-secret', { u: 'fantasma', r: 'superadmin', c: null, exp: Date.now() + 3600e3 });
  assert.strictEqual(
    session.verify(token), null,
    'se acepto una sesion de superadmin firmada con el secreto publico del repositorio',
  );
});

test('sin secretos en el entorno, el secreto de sesion no es el mismo en dos instalaciones', () => {
  // Dos procesos sin configuracion no pueden compartir secreto: lo firmado por uno no vale en otro.
  const a = sesionSinSecretosEnElEntorno().sign({ username: 'admin', role: 'superadmin' });
  const mac = a.split('.')[1];
  const esperadoConFijo = crypto.createHmac('sha256', 'arcanum-dev-secret').update(a.split('.')[0]).digest('base64url');
  assert.notStrictEqual(mac, esperadoConFijo, 'la firma sale de la cadena fija del codigo, igual en todas las instalaciones');
});
