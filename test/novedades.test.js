'use strict';

// Novedades por version: salen del CHANGELOG.md (una sola fuente) y se muestran en el log de
// arranque (deploy en EasyPanel), en la UI al entrar despues de una actualizacion y en el Release.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const nov = require('../src/services/novedades');

const MUESTRA = `# Changelog

Formato basado en Keep a Changelog.

## [0.3.0] - 2026-11-21

### Nuevo
- **Novedades** en la UI: se ven al entrar
  despues de una actualizacion (\`GET /api/novedades\`).

### Corregido
- Un arreglo corto.

## [0.2.1] - 2026-11-20

### Corregido
- Otro arreglo.

## [0.2.0] - 2026-11-19

### Nuevo
- Algo grande.
`;

test('parsea versiones, fechas, secciones e items multilinea', () => {
  const v = nov.parsear(MUESTRA);
  assert.deepStrictEqual(v.map((x) => x.version), ['0.3.0', '0.2.1', '0.2.0']);
  assert.strictEqual(v[0].fecha, '2026-11-21');
  assert.deepStrictEqual(v[0].secciones.map((s) => s.titulo), ['Nuevo', 'Corregido']);
  assert.deepStrictEqual(v[0].secciones[0].items, ['**Novedades** en la UI: se ven al entrar despues de una actualizacion (`GET /api/novedades`).']);
});

test('desde la ultima version vista hasta la actual, de la mas nueva a la mas vieja', () => {
  const v = nov.parsear(MUESTRA);
  assert.deepStrictEqual(nov.desde(v, '0.2.0', '0.3.0').map((x) => x.version), ['0.3.0', '0.2.1']);
  assert.deepStrictEqual(nov.desde(v, '0.3.0', '0.3.0'), [], 'ya vista: nada que mostrar');
  assert.deepStrictEqual(nov.desde(v, null, '0.3.0').map((x) => x.version), ['0.3.0'], 'primera vez: solo la actual');
  assert.deepStrictEqual(nov.desde(v, '0.2.0', '0.2.1').map((x) => x.version), ['0.2.1'], 'nunca muestra versiones posteriores a la que corre');
  assert.deepStrictEqual(nov.desde(v, '0.10.0', '0.3.0'), [], 'compara como version, no como texto');
});

test('texto plano para el log y notas en markdown para el Release', () => {
  const [v] = nov.parsear(MUESTRA);
  assert.deepStrictEqual(nov.lineasLog(v), [
    'Nuevo: Novedades en la UI: se ven al entrar despues de una actualizacion (GET /api/novedades).',
    'Corregido: Un arreglo corto.',
  ]);
  const md = nov.notasMarkdown(v);
  assert.match(md, /^### Nuevo\n- \*\*Novedades\*\* en la UI/);
  assert.match(md, /### Corregido\n- Un arreglo corto\./);
});

test('cartel de arranque: primero la version, despues que cambia, cortado al ancho (sin scroll lateral)', () => {
  const v = nov.parsear(MUESTRA);
  const l = nov.cartelArranque('0.3.0', v, 60);
  assert.ok(l.every((x) => x.length <= 60), 'ningun renglon pasa el ancho');
  assert.match(l[0], /^=+$/);
  assert.strictEqual(l[1], 'ARCANUM v0.3.0  (2026-11-21)');
  assert.strictEqual(l[2], 'Que cambia en esta version:');
  assert.strictEqual(l[3], '- Nuevo: Novedades en la UI: se ven al entrar despues de una');
  assert.match(l[4], /^ {4}actualizacion/, 'la continuacion queda sangrada');
  assert.match(l[l.length - 1], /^=+$/);
  const sin = nov.cartelArranque('9.9.9', v, 60);
  assert.strictEqual(sin[1], 'ARCANUM v9.9.9');
  assert.strictEqual(sin[2], 'Sin notas para esta version en el CHANGELOG.');
});

test('el CHANGELOG real tiene la seccion de la version de package.json (cada deploy dice que cambia)', () => {
  const { version } = require('../package.json');
  const v = nov.parsear(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
  const actual = v.find((x) => x.version === version);
  assert.ok(actual, `falta "## [${version}]" en CHANGELOG.md`);
  assert.ok(actual.secciones.some((s) => s.items.length), `la seccion ${version} del CHANGELOG esta vacia`);
  assert.strictEqual(v[0].version, version, 'la version de package.json es la primera del CHANGELOG');
});
