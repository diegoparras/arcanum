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

test('hora de la diaria: ARCANUM_MC_HORA valida, si no 6; y si los daemons estan apagados', () => {
  const { horaMcDiaria } = require('../src/daemon');
  assert.deepStrictEqual(horaMcDiaria({}), { hora: 6, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '4' }), { hora: 4, activa: true });
  // Un valor invalido no puede dejar la diaria sin correr nunca: vuelve al default.
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: 'abc' }), { hora: 6, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '24' }), { hora: 6, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '-1' }), { hora: 6, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_DAEMONS: '0' }), { hora: 6, activa: false });
});
