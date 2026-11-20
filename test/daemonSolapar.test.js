'use strict';

// Las tareas de fondo no se apilan: si una vuelta sigue corriendo (ARCA lento), la siguiente se
// saltea en vez de abrir otra y agotar el pool de conexiones.

const { test } = require('node:test');
const assert = require('node:assert');

const { sinSolapar } = require('../src/daemon');

test('una vuelta en curso hace saltear la siguiente', async () => {
  let corridas = 0;
  let soltar;
  const lenta = sinSolapar(async () => { corridas += 1; await new Promise((r) => { soltar = r; }); return 'listo'; });
  const a = lenta();
  const b = await lenta();
  assert.strictEqual(b, undefined);
  soltar();
  assert.strictEqual(await a, 'listo');
  assert.strictEqual(corridas, 1);
  const c = lenta();
  soltar();
  assert.strictEqual(await c, 'listo');
  assert.strictEqual(corridas, 2);
});

test('un error no deja trabada la tarea', async () => {
  const f = sinSolapar(async () => { throw new Error('fallo'); });
  await assert.rejects(f(), /fallo/);
  await assert.rejects(f(), /fallo/);
});
