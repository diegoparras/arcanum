'use strict';

// CSV (auditoria 2026-11-26, B-03): una celda de texto que empieza con = + - @ (o tab / CR) se
// neutraliza con un apostrofo para que la planilla no la ejecute como formula. Los numeros, aun
// negativos, quedan como numeros.

const { test } = require('node:test');
const assert = require('node:assert');

const { celdaCsv } = require('../src/lib/csv');

test('formulas en texto se neutralizan', () => {
  assert.strictEqual(celdaCsv('=HYPERLINK("http://x","clic")', ';'), `"'=HYPERLINK(""http://x"",""clic"")"`);
  assert.strictEqual(celdaCsv('+cmd|calc', ';'), "'+cmd|calc");
  assert.strictEqual(celdaCsv('@SUM(A1)', ';'), "'@SUM(A1)");
  assert.strictEqual(celdaCsv('-2+3', ';'), "'-2+3");
  assert.strictEqual(celdaCsv('\t=1', ';'), "'\t=1");
});

test('numeros (tambien negativos y con decimales) quedan intactos', () => {
  assert.strictEqual(celdaCsv(-1500.5, ';'), '-1500.5');
  assert.strictEqual(celdaCsv('-1500.50', ';'), '-1500.50');
  assert.strictEqual(celdaCsv('-1500,50', ','), '"-1500,50"');
  assert.strictEqual(celdaCsv('20111111112', ';'), '20111111112');
});

test('separador, comillas, saltos y CR se entrecomillan', () => {
  assert.strictEqual(celdaCsv('a;b', ';'), '"a;b"');
  assert.strictEqual(celdaCsv('a,b', ','), '"a,b"');
  assert.strictEqual(celdaCsv('dice "hola"', ';'), '"dice ""hola"""');
  assert.strictEqual(celdaCsv('linea\rotra', ';'), '"linea\rotra"');
  assert.strictEqual(celdaCsv(null, ';'), '');
  assert.strictEqual(celdaCsv(new Date('2026-11-01T00:00:00Z'), ';'), '2026-11-01');
});

test('los tres exportadores usan el escapador comun', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['services/misComprobantes.js', 'services/lotes.js', 'services/comprobantes.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(src.includes("require('../lib/csv')"), `${f} no usa lib/csv`);
  }
});
