'use strict';

// Rol de Arcanum a partir del claim de Lockatus. Lockatus declara para Arcanum los roles
// superadmin, admin, operador y lectura (y antes admin, editor y lector): cada uno tiene que caer
// en el suyo. Nunca dar mas permisos de los que dice el claim.

const { test } = require('node:test');
const assert = require('node:assert');
const { mapRole } = require('../src/auth/oidc');

test('roles de Lockatus -> roles de Arcanum', () => {
  assert.strictEqual(mapRole('superadmin'), 'superadmin');
  assert.strictEqual(mapRole('admin'), 'admin');
  assert.strictEqual(mapRole('operador'), 'operador');
  assert.strictEqual(mapRole('editor'), 'operador');
  assert.strictEqual(mapRole('lectura'), 'lectura');
  assert.strictEqual(mapRole('lector'), 'lectura', 'un lector de Lockatus no puede emitir en Arcanum');
  assert.strictEqual(mapRole(['lector']), 'lectura');
});

test('un rol desconocido o vacio no sube a operador: queda en lectura salvo que se configure otro', () => {
  assert.strictEqual(mapRole('cualquiera'), 'lectura');
  assert.strictEqual(mapRole(undefined), 'lectura');
});

test('se toma la palabra exacta, no una parte (subadministrador no es admin)', () => {
  assert.strictEqual(mapRole('subadministrador'), 'lectura');
  assert.strictEqual(mapRole('readonly-admin-viewer'), 'lectura');
});

// 2.2.1: el principal federado lleva el email verificado (para abrir Factorum sin ficha local).
const { principalDeClaims, emailVerificado } = require('../src/auth/oidc');

test('principal federado: email verificado o sin email_verified se toma, normalizado', () => {
  assert.deepStrictEqual(
    principalDeClaims({ sub: 's1', preferred_username: 'diegoparras', email: ' Diego@Ejemplo.COM ', email_verified: true, role: 'operador' }),
    { username: 'diegoparras', role: 'operador', federated: true, email: 'diego@ejemplo.com' },
  );
  // Sin email_verified (el proveedor no lo manda): se acepta.
  assert.strictEqual(principalDeClaims({ sub: 's1', preferred_username: 'diegoparras', email: 'diego@ejemplo.com' }).email, 'diego@ejemplo.com');
  assert.strictEqual(emailVerificado({ email: 'a@b.com', email_verified: 'true' }), 'a@b.com');
});

test('principal federado: con email_verified false (o "false") no lleva email', () => {
  for (const v of [false, 'false', 'FALSE']) {
    const p = principalDeClaims({ sub: 's1', preferred_username: 'diegoparras', email: 'diego@ejemplo.com', email_verified: v });
    assert.deepStrictEqual(p, { username: 'diegoparras', role: 'lectura', federated: true });
  }
});

test('principal federado: un email invalido no se toma, y el usuario cae en el email solo si esta verificado', () => {
  assert.strictEqual(principalDeClaims({ sub: 's1', preferred_username: 'x', email: 'no "es" <un@mail>' }).email, undefined);
  assert.strictEqual(principalDeClaims({ sub: 's1', preferred_username: 'x', email: 42 }).email, undefined);
  // Sin preferred_username: el email si esta verificado (como antes); si no, el sub.
  assert.strictEqual(principalDeClaims({ sub: 's1', email: 'Diego@Ejemplo.com' }).username, 'Diego@Ejemplo.com');
  assert.strictEqual(principalDeClaims({ sub: 's1', email: 'diego@ejemplo.com', email_verified: false }).username, 's1');
  assert.strictEqual(principalDeClaims({}).username, 'oidc-user');
});
