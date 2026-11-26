'use strict';

// Login (auditoria 2026-11-26, M-04 y M-05): IP del proxy de confianza, limite por usuario y
// global, memoria acotada, y tiempo parejo exista o no el usuario.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { crearLimiteLogin, ipCliente, validarUsuario } = require('../src/auth/limiteLogin');

const req = (xff, remota = '10.0.0.2') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remota } });

test('IP: con un proxy de confianza se toma la ultima de X-Forwarded-For (la que agrega el proxy)', () => {
  assert.strictEqual(ipCliente(req('6.6.6.6, 203.0.113.9'), 1), '203.0.113.9');
  assert.strictEqual(ipCliente(req('203.0.113.9'), 1), '203.0.113.9');
  assert.strictEqual(ipCliente(req(null), 1), '10.0.0.2');
  assert.strictEqual(ipCliente(req('6.6.6.6'), 0), '10.0.0.2', 'sin proxies de confianza se ignora la cabecera');
});

test('usuario: string de 1 a 64 caracteres', () => {
  assert.strictEqual(validarUsuario('diego'), 'diego');
  for (const u of ['', 'x'.repeat(65), 42, null, { a: 1 }]) assert.throws(() => validarUsuario(u), (e) => e.httpStatus === 400);
});

test('5 fallos desde una IP traban esa IP para ese usuario; cambiar la IP no alcanza contra el limite por usuario', () => {
  let t = 0;
  const l = crearLimiteLogin({ ahora: () => t, porUsuario: 10 });
  for (let i = 0; i < 5; i++) { l.chequear('1.1.1.1', 'diego'); l.fallo('1.1.1.1', 'diego'); }
  assert.throws(() => l.chequear('1.1.1.1', 'diego'), (e) => e.httpStatus === 429);
  // Rotando IPs: a los 10 fallos del mismo usuario se traba para todas.
  for (let i = 0; i < 5; i++) { l.chequear(`2.2.2.${i}`, 'diego'); l.fallo(`2.2.2.${i}`, 'diego'); }
  assert.throws(() => l.chequear('9.9.9.9', 'diego'), (e) => e.httpStatus === 429);
  // Otro usuario sigue entrando.
  assert.doesNotThrow(() => l.chequear('9.9.9.9', 'ana'));
  t += 16 * 60_000;
  assert.doesNotThrow(() => l.chequear('9.9.9.9', 'diego'), 'el bloqueo vence');
});

test('limite global: una lluvia de fallos frena todo el login un rato', () => {
  let t = 0;
  const l = crearLimiteLogin({ ahora: () => t, global: 50 });
  for (let i = 0; i < 50; i++) l.fallo(`3.3.${i}.1`, `u${i}`);
  assert.throws(() => l.chequear('4.4.4.4', 'nuevo'), (e) => e.httpStatus === 429);
  t += 61_000;
  assert.doesNotThrow(() => l.chequear('4.4.4.4', 'nuevo'));
});

test('memoria acotada: no guarda mas de N claves ni el usuario en claro', () => {
  const l = crearLimiteLogin({ maxClaves: 100, global: 1e9 });
  for (let i = 0; i < 1000; i++) l.fallo(`5.5.${i % 250}.${i}`, 'usuario-' + i);
  assert.ok(l.tamano() <= 200, `guardo ${l.tamano()} claves`);
  assert.ok(!l.claves().some((k) => k.includes('usuario-')), 'las claves no llevan el usuario en claro');
});

test('un login correcto limpia los fallos de esa IP y usuario', () => {
  const l = crearLimiteLogin({});
  for (let i = 0; i < 4; i++) l.fallo('1.1.1.1', 'diego');
  l.exito('1.1.1.1', 'diego');
  for (let i = 0; i < 4; i++) l.fallo('1.1.1.1', 'diego');
  assert.doesNotThrow(() => l.chequear('1.1.1.1', 'diego'));
});

test('login: un usuario inexistente tambien corre scrypt (sin atajo que delate si existe)', async () => {
  const db = require('../src/db');
  const users = require('../src/auth/users');
  const original = { query: db.query, scrypt: crypto.scrypt };
  let derivaciones = 0;
  crypto.scrypt = (...a) => { derivaciones += 1; return original.scrypt(...a); };
  db.query = async () => ({ rows: [] });
  try {
    await assert.rejects(users.login('no-existe', 'x'), (e) => e.httpStatus === 401);
    assert.ok(derivaciones >= 1, 'no se derivo ninguna clave para el usuario inexistente');
  } finally { db.query = original.query; crypto.scrypt = original.scrypt; }
});
