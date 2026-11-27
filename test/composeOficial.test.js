'use strict';

// docker-compose.yml oficial (auditoria 2026-11-26, M-13): tiene que pasarle al proceso lo que
// .env.example invita a completar, no publicar el puerto en todas las interfaces y no traer una
// contrasena de Postgres por defecto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(raiz, 'docker-compose.yml'), 'utf8');
const ejemplo = fs.readFileSync(path.join(raiz, '.env.example'), 'utf8');

test('cada variable ARCANUM_* de .env.example llega al contenedor', () => {
  const vars = [...ejemplo.matchAll(/^(ARCANUM_[A-Z_]+)=/gm)].map((m) => m[1]);
  assert.ok(vars.includes('ARCANUM_SESSION_SECRET'));
  const faltan = vars.filter((v) => !new RegExp(`\\b${v}:`).test(compose));
  assert.deepStrictEqual(faltan, [], 'variables de .env.example que el compose no le pasa a Arcanum');
});

test('el puerto se publica solo en 127.0.0.1 por defecto', () => {
  assert.match(compose, /"\$\{ARCANUM_BIND:-127\.0\.0\.1\}:8094:8094"/);
  assert.doesNotMatch(compose, /^\s*-\s*"8094:8094"/m);
});

test('Postgres no tiene contrasena por defecto', () => {
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:-/);
  assert.match(compose, /POSTGRES_PASSWORD:\?/);
});
