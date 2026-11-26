'use strict';

// Auditoria de pedidos (auditoria 2026-11-26, M-12): sin filas por pedidos anonimos rechazados,
// ruta truncada y CUIT solo si es un CUIT.

const { test } = require('node:test');
const assert = require('node:assert');

const { filaAuditoria } = require('../src/lib/auditoria');

const req = (extra = {}) => ({ method: 'GET', ...extra });
const url = (p) => new URL('http://x' + p);

test('un pedido anonimo rechazado (401/404 sin usuario) no deja fila', () => {
  assert.strictEqual(filaAuditoria(req(), { statusCode: 401 }, url('/api/x/' + 'a'.repeat(14000)), 5), null);
  assert.strictEqual(filaAuditoria(req(), { statusCode: 404 }, url('/api/nada'), 5), null);
});

test('un intento de login (anonimo) si se registra, para poder investigar', () => {
  const f = filaAuditoria(req({ method: 'POST', _ip: '203.0.113.9' }), { statusCode: 401 }, url('/api/auth/login'), 5);
  assert.ok(f);
  assert.strictEqual(f.path, '/api/auth/login');
});

test('la ruta se trunca y el CUIT de la query solo vale si son 11 digitos', () => {
  const f = filaAuditoria(req({ _user: 'ana' }), { statusCode: 200 }, url('/api/x/' + 'b'.repeat(2000) + '?cuit=NO-ES-UN-CUIT'), 5);
  assert.ok(f.path.length <= 300);
  assert.strictEqual(f.cuit, null);
  const g = filaAuditoria(req({ _user: 'ana' }), { statusCode: 200 }, url('/api/padron?cuit=20111111112'), 5);
  assert.strictEqual(g.cuit, '20111111112');
});

test('la operacion tambien se acota', () => {
  const f = filaAuditoria(req({ _user: 'ana', _op: 'x'.repeat(500) }), { statusCode: 200 }, url('/api/a'), 5);
  assert.ok(f.operation.length <= 200);
});
