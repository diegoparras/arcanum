'use strict';

// Los estaticos (escriba-ui.css) se cachean un dia en el navegador. Sin la version en la URL,
// despues de un deploy el navegador seguia usando el CSS viejo hasta 24 h.

const test = require('node:test');
const assert = require('node:assert');
const { conVersionEnEstaticos } = require('../src/lib/estaticos');

test('agrega ?v=<version> a los CSS locales del HTML', () => {
  const html = '<link rel="stylesheet" href="./escriba-ui.css"><link rel="stylesheet" href="./otro.css">';
  assert.strictEqual(
    conVersionEnEstaticos(html, '0.10.10'),
    '<link rel="stylesheet" href="./escriba-ui.css?v=0.10.10"><link rel="stylesheet" href="./otro.css?v=0.10.10">',
  );
});

test('no toca CSS externos, ni los que ya traen query, ni otras etiquetas', () => {
  const html = '<link rel="stylesheet" href="https://cdn.example.com/x.css">'
    + '<link rel="stylesheet" href="./a.css?v=1"><a href="./guia.css.html">x</a><img src="./logo.svg">';
  assert.strictEqual(conVersionEnEstaticos(html, '2.0.0'), html);
});

test('la version se escapa para la URL', () => {
  assert.strictEqual(
    conVersionEnEstaticos('<link href="./a.css">', '1.0.0 beta&x'),
    '<link href="./a.css?v=1.0.0%20beta%26x">',
  );
});

test('sin version deja el HTML igual', () => {
  const html = '<link href="./a.css">';
  assert.strictEqual(conVersionEnEstaticos(html, ''), html);
  assert.strictEqual(conVersionEnEstaticos(html, undefined), html);
});
