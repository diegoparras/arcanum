'use strict';

// PDF: modelo visual elegible (por defecto el de ARCA, con ORIGINAL/DUPLICADO/TRIPLICADO) y
// nombre de archivo (por defecto el de ARCA: CUIT_TIPO_PV_NUMERO.pdf, o una plantilla).

const { test } = require('node:test');
const assert = require('node:assert');

const pdf = require('../src/services/pdf');

const CMP = {
  cuit: '20391171999', punto_venta: 1, tipo_cbte: 11, numero: 195, fecha: '2026-11-18',
  cae: '86463296080177', cae_vto: '2026-11-28', importe_total: 3570000, doc_tipo: 80, doc_nro: '30546666561',
  raw: {
    concepto: 2, condicionIvaReceptor: 4, receptorNombre: 'UNIVERSIDAD DE BUENOS AIRES', receptorDomicilio: 'Viamonte 444',
    condicionVenta: 'Otra', fechaServicioDesde: '2026-08-01', fechaServicioHasta: '2026-11-30', fechaVtoPago: '2026-11-18',
    items: [{ descripcion: 'Honorarios', cantidad: 1, precioUnitario: 3570000, subtotal: 3570000 }],
  },
};
const EMISOR = { razonSocial: 'EMISOR DE PRUEBA', domicilio: 'Calle 1', condicionIva: 'MONOTRIBUTO', iibb: 'Regimen Simplificado', inicioActividades: '2019-05-01' };
const paginas = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test('nombre de archivo por defecto: el de ARCA', () => {
  assert.strictEqual(pdf.nombreArchivo(CMP), '20391171999_011_00001_00000195.pdf');
});

test('nombre por plantilla con datos del comprobante', () => {
  assert.strictEqual(pdf.nombreArchivo(CMP, 'FACTURA {receptor} {letra}-{pv}-{numero}'),
    'FACTURA UNIVERSIDAD DE BUENOS AIRES C-00001-00000195.pdf');
  assert.strictEqual(pdf.nombreArchivo(CMP, 'Diplomatura Diseño: 2026/11'), 'Diplomatura Diseño- 2026-11.pdf');
  assert.strictEqual(pdf.nombreArchivo(CMP, 'ya-tiene.PDF'), 'ya-tiene.PDF');
  assert.strictEqual(pdf.nombreArchivo(CMP, '   '), '20391171999_011_00001_00000195.pdf');
});

test('Content-Disposition con acentos lleva filename* en UTF-8', () => {
  const cd = pdf.contentDisposition('Diseño.pdf');
  assert.match(cd, /^attachment; filename="Dise_o\.pdf"; filename\*=UTF-8''Dise%C3%B1o\.pdf$/);
});

test('modelo ARCA por defecto con original, duplicado y triplicado', async () => {
  const buf = await pdf.generar(CMP, EMISOR);
  assert.strictEqual(paginas(buf), 3);
  assert.strictEqual(paginas(await pdf.generar(CMP, EMISOR, { modelo: 'arca', copias: 1 })), 1);
});

test('modelo Arcanum sigue disponible (una hoja)', async () => {
  assert.strictEqual(paginas(await pdf.generar(CMP, EMISOR, { modelo: 'arcanum' })), 1);
});

test('factura A en modelo ARCA se genera (alicuotas y columnas de IVA)', async () => {
  const a = { ...CMP, tipo_cbte: 1, importe_total: 1210, raw: { ...CMP.raw, importeNeto: 1000, importeIva: 210, alicuotasIva: [{ id: 5, baseImponible: 1000, importe: 210 }] } };
  assert.strictEqual(paginas(await pdf.generar(a, { ...EMISOR, condicionIva: 'RI' }, { copias: 1 })), 1);
});

test('preferencias de PDF se validan', () => {
  assert.deepStrictEqual(pdf.preferencias({ modelo: 'arcanum', nombreArchivo: 'x {numero}' }), { modelo: 'arcanum', nombreArchivo: 'x {numero}' });
  assert.deepStrictEqual(pdf.preferencias(undefined), { modelo: 'arca', nombreArchivo: null });
  assert.throws(() => pdf.preferencias({ modelo: 'otro' }), (e) => e.httpStatus === 400);
});
