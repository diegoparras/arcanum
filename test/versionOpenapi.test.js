'use strict';

// La version de la documentacion de la API acompana a la del paquete (estuvo congelada en 0.10.6).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('openapi.yaml lleva la misma version que package.json', () => {
  const pkg = require('../package.json');
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8');
  const m = /^\s{2}version:\s*(\S+)\s*$/m.exec(yaml);
  assert.ok(m, 'openapi.yaml sin info.version');
  assert.strictEqual(m[1], pkg.version, 'al subir la version, actualizá tambien info.version de openapi.yaml');
});
