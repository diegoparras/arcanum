'use strict';

// Validacion de datos que despues se muestran en el panel (auditoria 2026-11-26, A-04 a A-06).
// La UI ya escapa todo; esto es la segunda barrera: lo que no tiene forma de dato valido no se guarda.

const { test } = require('node:test');
const assert = require('node:assert');

const { validarNombre } = require('../src/auth/tenants');
const { parseQr, validarComprobante } = require('../src/services/importar');
const { validarRecibido } = require('../src/services/lotes');

const qr = (o) => 'https://www.arca.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(o)).toString('base64');
const QR_OK = { ver: 1, fecha: '2026-11-01', cuit: 20111111112, ptoVta: 3, tipoCmp: 11, nroCmp: 41, importe: 1500, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 20222222223, tipoCodAut: 'E', codAut: 76000000000001 };
const status = (code) => (e) => e.httpStatus === code;

test('nombre de cliente: acepta razones sociales reales', () => {
  assert.strictEqual(validarNombre('  Pérez & Cía. S.R.L. (sucursal "Norte")  '), 'Pérez & Cía. S.R.L. (sucursal "Norte")');
  assert.strictEqual(validarNombre("O'Higgins Ñandú S.A."), "O'Higgins Ñandú S.A.");
  assert.strictEqual(validarNombre(null), null);
  assert.strictEqual(validarNombre('   '), null);
});

test('nombre de cliente: rechaza < > y caracteres de control, y los demasiado largos', () => {
  assert.throws(() => validarNombre('cliente <img src=x onerror=alert(1)>'), status(422));
  assert.throws(() => validarNombre('a>b'), status(422));
  assert.throws(() => validarNombre('linea\nnueva'), status(422));
  assert.throws(() => validarNombre('x'.repeat(201)), status(422));
});

test('QR: un QR valido de ARCA sigue importando igual', () => {
  const d = parseQr(qr(QR_OK));
  assert.strictEqual(d.cae, '76000000000001');
  assert.strictEqual(d.cuitEmisor, '20111111112');
  assert.strictEqual(d.fecha, '20261101');
});

test('QR: CAE que no son 14 digitos o CUIT que no son 11 se rechazan sin repetir el valor', () => {
  const carga = '7<img src=x onerror=alert(1)>';
  assert.throws(() => parseQr(qr({ ...QR_OK, codAut: carga })), (e) => e.httpStatus === 422 && !e.message.includes('<img'));
  assert.throws(() => parseQr(qr({ ...QR_OK, cuit: '20111111112<b>' })), (e) => e.httpStatus === 422 && !e.message.includes('<b>'));
  assert.throws(() => parseQr(qr({ ...QR_OK, codAut: 123 })), status(422));
});

test('comprobante cargado a mano: misma validacion que el QR', () => {
  const base = { cuitEmisor: '20111111112', puntoVenta: 3, tipoComprobante: 11, numero: 41, fecha: '20261101', importeTotal: 1500, cae: '76000000000001', docNro: '0' };
  assert.doesNotThrow(() => validarComprobante(base));
  assert.throws(() => validarComprobante({ ...base, cae: 'abc' }), status(422));
  assert.throws(() => validarComprobante({ ...base, fecha: '2026-11-01<x>' }), status(422));
  assert.throws(() => validarComprobante({ ...base, numero: NaN }), status(422));
  assert.throws(() => validarComprobante({ ...base, docNro: '20<x>' }), status(422));
});

test('lote, marcar recibido: CAE y numero solo digitos; vacios se aceptan', () => {
  assert.deepStrictEqual(validarRecibido({ cae: ' 76000000000001 ', numero: '41' }), { cae: '76000000000001', numero: '41' });
  assert.deepStrictEqual(validarRecibido({}), { cae: null, numero: null });
  assert.throws(() => validarRecibido({ cae: '7<img src=x onerror=1>' }), status(422));
  assert.throws(() => validarRecibido({ numero: '1"><b>' }), status(422));
});
