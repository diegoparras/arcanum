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
