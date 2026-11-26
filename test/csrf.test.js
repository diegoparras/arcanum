'use strict';

// CSRF (auditoria 2026-11-26, M-07): con sesion por cookie, un pedido que escribe tiene que venir
// del propio panel (Sec-Fetch-Site / Origin) y con cuerpo JSON declarado. Las claves de API no
// usan cookie y no se ven afectadas.

const { test } = require('node:test');
const assert = require('node:assert');

const { chequearCsrf } = require('../src/lib/csrf');

const req = (method, headers = {}) => ({ method, headers: { host: 'arcanum.ejemplo.com', ...headers } });
const SESION = { via: 'sesion' };
const CLAVE = { via: 'clave' };
const status = (code) => (e) => e.httpStatus === code;

test('GET nunca se frena', () => {
  assert.doesNotThrow(() => chequearCsrf(req('GET', { 'sec-fetch-site': 'cross-site' }), SESION));
});

test('el panel (same-origin, JSON) pasa', () => {
  assert.doesNotThrow(() => chequearCsrf(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '2' }), SESION));
  assert.doesNotThrow(() => chequearCsrf(req('PUT', { origin: 'https://arcanum.ejemplo.com', 'content-type': 'application/json; charset=utf-8', 'content-length': '2' }), SESION));
});

test('desde una app hermana (same-site) o ajena (cross-site) se rechaza', () => {
  assert.throws(() => chequearCsrf(req('POST', { 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }), SESION), status(403));
  assert.throws(() => chequearCsrf(req('POST', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }), SESION), status(403));
  assert.throws(() => chequearCsrf(req('DELETE', { origin: 'https://otra.ejemplo.com' }), SESION), status(403));
});

test('un cuerpo text/plain (el truco para evitar el preflight) se rechaza', () => {
  assert.throws(() => chequearCsrf(req('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain', 'content-length': '40' }), SESION), status(415));
  assert.throws(() => chequearCsrf(req('POST', { 'content-length': '40' }), SESION), status(415));
});

test('un POST sin cuerpo del panel (logout, acciones) pasa sin Content-Type', () => {
  assert.doesNotThrow(() => chequearCsrf(req('POST', { 'sec-fetch-site': 'same-origin' }), SESION));
});

test('las claves de API no pasan por este control', () => {
  assert.doesNotThrow(() => chequearCsrf(req('POST', { 'content-type': 'text/plain', 'content-length': '40', origin: 'https://n8n.ejemplo.com' }), CLAVE));
});
