'use strict';

// Sincronizacion diaria de Mis Comprobantes: corre una vez por dia, despues de la hora fijada
// (hora argentina), y pide el mes anterior completo mas el mes en curso.

const { test } = require('node:test');
const assert = require('node:assert');

const { tocaDiaria, rangoDiario } = require('../src/daemon');

test('toca la diaria despues de la hora argentina y una sola vez por dia', () => {
  // 08:59 UTC = 05:59 en Argentina -> todavia no (hora 6)
  assert.strictEqual(tocaDiaria(new Date('2026-11-19T08:59:00Z'), 6, null), false);
  assert.strictEqual(tocaDiaria(new Date('2026-11-19T09:00:00Z'), 6, null), true);
  assert.strictEqual(tocaDiaria(new Date('2026-11-19T15:00:00Z'), 6, '2026-11-19'), false);
  assert.strictEqual(tocaDiaria(new Date('2026-11-20T09:30:00Z'), 6, '2026-11-19'), true);
  // 01:00 UTC del 20 = 22:00 del 19 en Argentina: el "hoy" es el 19
  assert.strictEqual(tocaDiaria(new Date('2026-11-20T01:00:00Z'), 6, '2026-11-19'), false);
});

test('rango diario: primer dia del mes anterior hasta hoy (hora argentina)', () => {
  assert.deepStrictEqual(rangoDiario(new Date('2026-11-19T12:00:00Z')), { desde: '2026-10-01', hasta: '2026-11-19', hoy: '2026-11-19' });
  assert.deepStrictEqual(rangoDiario(new Date('2026-01-05T12:00:00Z')), { desde: '2025-12-01', hasta: '2026-01-05', hoy: '2026-01-05' });
});
