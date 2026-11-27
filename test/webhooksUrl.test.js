'use strict';

// Webhooks (auditoria 2026-11-26, M-11): se guarda la URL normalizada, no la cadena original.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const webhooks = require('../src/services/webhooks');

test('la URL se guarda normalizada: < y comillas quedan codificadas', async () => {
  const original = db.query;
  let guardada = null;
  db.query = async (sql, p) => { guardada = p[0]; return { rows: [{ id: 1, url: p[0], eventos: p[1], activo: true }] }; };
  try {
    await webhooks.crear({ url: 'https://hooks.ejemplo.com/h?x=<img src=x onerror="1">' });
    assert.ok(!/[<>"]/.test(guardada), guardada);
    assert.ok(guardada.startsWith('https://hooks.ejemplo.com/h?x=%3Cimg'));
  } finally { db.query = original; }
});
