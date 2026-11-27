'use strict';

// B-17 (auditoria 2026-11-26): el CI no publica sin pasar tests, lint y audit; las acciones van
// fijadas por SHA con permisos minimos; la imagen instala con el lock, no trae npm y /app no es
// escribible por el usuario que ejecuta.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(raiz, '.github', 'workflows', 'docker-publish.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(raiz, 'Dockerfile'), 'utf8');

test('cada accion de GitHub esta fijada por SHA de 40 caracteres', () => {
  const usos = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(usos.length >= 6);
  const sueltas = usos.filter((u) => !/@[0-9a-f]{40}$/.test(u));
  assert.deepStrictEqual(sueltas, [], 'acciones fijadas por etiqueta');
});

test('el build depende de un job que corre tests, lint y npm audit', () => {
  assert.match(wf, /needs:\s*verificar/);
  assert.match(wf, /npm ci/);
  assert.match(wf, /npm test/);
  assert.match(wf, /npm run lint/);
  assert.match(wf, /npm audit/);
});

test('permisos: solo lectura por defecto; escritura solo en el job que publica', () => {
  const global = wf.split(/\njobs:/)[0];
  assert.match(global, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(global, /packages:\s*write/);
});

test('imagen: npm ci con lock, sin npm en la imagen final, /app no es del usuario node', () => {
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.doesNotMatch(dockerfile, /npm install/);
  assert.doesNotMatch(dockerfile, /package-lock\.json\*/);
  assert.match(dockerfile, /rm -rf[^\n]*\/usr\/local\/lib\/node_modules\/npm/);
  assert.doesNotMatch(dockerfile, /chown[^\n]*\/app/);
});
