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
  assert.deepStrictEqual(horaMcDiaria({}), { hora: 6, ventana: 120, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '4' }), { hora: 4, ventana: 120, activa: true });
  // Un valor invalido no puede dejar la diaria sin correr nunca: vuelve al default.
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: 'abc' }), { hora: 6, ventana: 120, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '24' }), { hora: 6, ventana: 120, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '-1' }), { hora: 6, ventana: 120, activa: true });
  assert.deepStrictEqual(horaMcDiaria({ ARCANUM_DAEMONS: '0' }), { hora: 6, ventana: 120, activa: false });
});

test('ventana de la diaria: ARCANUM_MC_VENTANA en minutos, 0 = todos a la hora fija', () => {
  const { horaMcDiaria } = require('../src/daemon');
  assert.strictEqual(horaMcDiaria({ ARCANUM_MC_VENTANA: '0' }).ventana, 0);
  assert.strictEqual(horaMcDiaria({ ARCANUM_MC_VENTANA: '45' }).ventana, 45);
  assert.strictEqual(horaMcDiaria({ ARCANUM_MC_VENTANA: 'mucho' }).ventana, 120);
  assert.strictEqual(horaMcDiaria({ ARCANUM_MC_VENTANA: '-5' }).ventana, 120);
  // Nunca pasa de la medianoche: a las 23 h la ventana se achica a 60 minutos.
  assert.strictEqual(horaMcDiaria({ ARCANUM_MC_HORA: '23', ARCANUM_MC_VENTANA: '300' }).ventana, 60);
});

test('cada CUIT tiene su minuto del dia: estable en el dia, distinto entre CUITs y entre dias', () => {
  const { minutoDelCuit } = require('../src/daemon');
  const cuits = ['20111111112', '27555555550', '30555555551', '30777777773', '33999999999', '20333333334'];
  const hoy = cuits.map((c) => minutoDelCuit(c, '2026-11-27', 120));
  for (const m of hoy) assert.ok(Number.isInteger(m) && m >= 0 && m < 120, `fuera de la ventana: ${m}`);
  assert.deepStrictEqual(cuits.map((c) => minutoDelCuit(c, '2026-11-27', 120)), hoy, 'el mismo dia da lo mismo (sobrevive un reinicio)');
  assert.ok(new Set(hoy).size > 1, 'no todos a la vez');
  const manana = cuits.map((c) => minutoDelCuit(c, '2026-11-28', 120));
  assert.notDeepStrictEqual(manana, hoy, 'cambia de un dia al otro');
  assert.strictEqual(minutoDelCuit('30777777773', '2026-11-27', 0), 0);
});

test('a cada CUIT le toca despues de su horario y una sola vez por dia', () => {
  const { tocaCuit } = require('../src/daemon');
  const seisYCuarto = 6 * 60 + 15;
  // 09:14 UTC = 06:14 en Argentina -> todavia no
  assert.strictEqual(tocaCuit(new Date('2026-11-27T09:14:00Z'), seisYCuarto, null), false);
  assert.strictEqual(tocaCuit(new Date('2026-11-27T09:15:00Z'), seisYCuarto, null), true);
  assert.strictEqual(tocaCuit(new Date('2026-11-27T13:00:00Z'), seisYCuarto, '2026-11-27'), false);
  assert.strictEqual(tocaCuit(new Date('2026-11-28T09:20:00Z'), seisYCuarto, '2026-11-27'), true);
});

test('horario del CUIT para mostrar en el panel', () => {
  const { horarioMc } = require('../src/daemon');
  const h = horarioMc({ hora: 6, ventana: 120 }, '30777777773', '2026-11-27');
  assert.ok(h.minutos >= 360 && h.minutos < 480);
  assert.match(h.texto, /^[67]:\d\d$/);
  assert.deepStrictEqual(horarioMc({ hora: 6, ventana: 0 }, '30777777773', '2026-11-27'), { minutos: 360, texto: '6:00' });
});
