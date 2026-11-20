'use strict';

// Datos del encabezado legal del PDF: lo que ARCA expone (padron A5) se completa solo; lo que no
// (Ingresos Brutos, inicio de actividades) se informa como faltante. Nunca se pisa lo cargado a mano.

const { test } = require('node:test');
const assert = require('node:assert');

const di = require('../src/services/datosImpresion');
const { condicionEmisor } = require('../src/services/pdfComun');

const A5_MONO = {
  datosGenerales: {
    apellido: 'PARRAS', nombre: 'DIEGO', estadoClave: 'ACTIVO',
    domicilioFiscal: { direccion: 'AV CORRIENTES 1234 Piso:2', localidad: 'SAN NICOLAS', descripcionProvincia: 'CIUDAD AUTONOMA BUENOS AIRES' },
  },
  datosMonotributo: { categoriaMonotributo: { idCategoria: 'H', descripcionCategoria: 'H LOCACIONES DE SERVICIO' } },
};
const A5_RI = {
  datosGenerales: { razonSocial: 'EMPRESA SA', domicilioFiscal: { direccion: 'SAN MARTIN 50', descripcionProvincia: 'MENDOZA' } },
  datosRegimenGeneral: { impuesto: [{ idImpuesto: 30 }] },
};

test('ficha del padron: nombre, domicilio y condicion frente al IVA', () => {
  assert.deepStrictEqual(di.fichaDesdePadron(A5_MONO), {
    nombre: 'PARRAS, DIEGO',
    domicilio: 'AV CORRIENTES 1234 Piso:2 - SAN NICOLAS, CIUDAD AUTONOMA BUENOS AIRES',
    condicionIva: 'MONOTRIBUTO',
  });
  assert.deepStrictEqual(di.fichaDesdePadron(A5_RI), { nombre: 'EMPRESA SA', domicilio: 'SAN MARTIN 50 - MENDOZA', condicionIva: 'RI' });
  assert.deepStrictEqual(di.fichaDesdePadron({}), { nombre: null, domicilio: null, condicionIva: null });
});

test('condicion del emisor: la cargada manda; sin dato se deduce de la letra (nunca RI en una C)', () => {
  assert.strictEqual(condicionEmisor({ condicionIva: 'EXENTO' }, 11), 'IVA Sujeto Exento');
  assert.strictEqual(condicionEmisor({}, 11), 'Responsable Monotributo');
  assert.strictEqual(condicionEmisor({}, 13), 'Responsable Monotributo');
  assert.strictEqual(condicionEmisor({}, 1), 'Responsable Inscripto');
  assert.strictEqual(condicionEmisor({}, 6), 'Responsable Inscripto');
});

test('faltantes del emisor para el PDF', () => {
  assert.deepStrictEqual(di.faltantesEmisor({ razonSocial: 'X', condicionIva: 'RI' }).map((f) => f.campo), ['domicilio', 'iibb', 'inicioActividades']);
  assert.deepStrictEqual(di.faltantesEmisor({ razonSocial: 'X', domicilio: 'Y', condicionIva: 'RI', iibb: 'Exento', inicioActividades: '2017-05-15' }), []);
});

function emisoresFalsos(inicial) {
  const e = { dato: { ...inicial }, guardados: [] };
  e.get = async () => ({ ...e.dato });
  e.set = async (cuit, d) => { e.guardados.push(d); e.dato = { ...d }; return d; };
  return e;
}

test('completar emisor: llena solo lo vacio, no pisa lo cargado a mano y dice que falta', async () => {
  di._reset();
  const emisores = emisoresFalsos({ razonSocial: 'MI NOMBRE DE FANTASIA LEGAL', iibb: 'Exento' });
  const consultas = [];
  const consultar = async (repre, cuit) => { consultas.push([repre, cuit]); return di.fichaDesdePadron(A5_MONO); };
  const r = await di.completarEmisor('20263630743', { emisores, consultar });
  assert.deepStrictEqual(consultas, [['20263630743', '20263630743']]);
  assert.strictEqual(r.emisor.razonSocial, 'MI NOMBRE DE FANTASIA LEGAL');
  assert.strictEqual(r.emisor.domicilio, 'AV CORRIENTES 1234 Piso:2 - SAN NICOLAS, CIUDAD AUTONOMA BUENOS AIRES');
  assert.strictEqual(r.emisor.condicionIva, 'MONOTRIBUTO');
  assert.strictEqual(r.emisor.iibb, 'Exento');
  assert.deepStrictEqual(r.completados, ['domicilio', 'condicionIva']);
  assert.deepStrictEqual(r.faltan.map((f) => f.campo), ['inicioActividades']);
  assert.strictEqual(emisores.guardados.length, 1);
});

test('completar emisor: con lo del padron ya cargado no consulta ARCA', async () => {
  di._reset();
  const emisores = emisoresFalsos({ razonSocial: 'A', domicilio: 'B', condicionIva: 'RI' });
  let consultado = false;
  const r = await di.completarEmisor('20263630743', { emisores, consultar: async () => { consultado = true; return {}; } });
  assert.strictEqual(consultado, false);
  assert.deepStrictEqual(r.completados, []);
  assert.strictEqual(emisores.guardados.length, 0);
});

test('completar emisor: si el padron falla no rompe, avisa y no reintenta enseguida', async () => {
  di._reset();
  const emisores = emisoresFalsos({});
  let llamadas = 0;
  const consultar = async () => { llamadas += 1; throw new Error('El certificado no tiene ws_sr_constancia_inscripcion'); };
  const r = await di.completarEmisor('20263630743', { emisores, consultar });
  assert.match(r.error, /constancia/);
  assert.deepStrictEqual(r.completados, []);
  await di.completarEmisor('20263630743', { emisores, consultar });
  assert.strictEqual(llamadas, 1, 'una falla del padron se recuerda un rato: no se reintenta en cada PDF o emision');
  const forzado = await di.completarEmisor('20263630743', { emisores, consultar, forzar: true });
  assert.strictEqual(llamadas, 2, 'el boton "Traer de ARCA" fuerza la consulta');
  assert.ok(forzado.error);
});

test('completar receptor: con CUIT trae nombre y domicilio que falten; respeta lo que vino', async () => {
  di._reset();
  const consultar = async () => di.fichaDesdePadron(A5_RI);
  const r = await di.completarReceptor('20263630743', { tipoDocReceptor: 80, nroDocReceptor: '30500010912', receptorNombre: 'Empresa (como la llama el cliente)' }, { consultar });
  assert.deepStrictEqual(r, { receptorDomicilio: 'SAN MARTIN 50 - MENDOZA' }, 'devuelve solo lo que agrega: el nombre que vino no se toca');
});

test('completar receptor: sin CUIT, o con todo cargado, no consulta; si falla devuelve lo que habia', async () => {
  di._reset();
  let llamadas = 0;
  const consultar = async () => { llamadas += 1; throw new Error('caido'); };
  assert.deepStrictEqual(await di.completarReceptor('20263630743', { tipoDocReceptor: 96, nroDocReceptor: '30111222' }, { consultar }), {});
  assert.deepStrictEqual(await di.completarReceptor('20263630743', { tipoDocReceptor: 80, nroDocReceptor: '30500010912', receptorNombre: 'A', receptorDomicilio: 'B' }, { consultar }), {});
  assert.strictEqual(llamadas, 0);
  assert.deepStrictEqual(await di.completarReceptor('20263630743', { tipoDocReceptor: 80, nroDocReceptor: '30500010912' }, { consultar }), {});
});

test('completar receptor: un padron lento no frena la emision', async () => {
  di._reset();
  const t0 = Date.now();
  const r = await di.completarReceptor('20263630743', { tipoDocReceptor: 80, nroDocReceptor: '30500010912' },
    { consultar: () => new Promise((res) => setTimeout(() => res(di.fichaDesdePadron(A5_RI)), 2000)), espera: 100 });
  assert.deepStrictEqual(r, {});
  assert.ok(Date.now() - t0 < 1000);
});
