'use strict';

// Tests de los modulos agregados (v0.5.0-0.6.1): funciones puras, sin DB ni red.

const { test } = require('node:test');
const assert = require('node:assert');

const reglas = require('../src/services/reglas-comprobante');
const { parseQr } = require('../src/services/importar');
const { toXml } = require('../src/soap/engine');
const lotes = require('../src/services/lotes');
const { parseCsv, normItem, alicuotaId, n, pInt } = lotes._internos;

// ---------- reglas-comprobante ----------
test('reglas: emisor RI a receptor RI -> Factura A con IVA', () => {
  const r = reglas.sugerirComprobante({ emisorCondicion: 'RI', receptorCondicionId: 1 });
  assert.strictEqual(r.letra, 'A');
  assert.strictEqual(r.tipoComprobante, 1);
  assert.strictEqual(r.requiereIva, true);
});
test('reglas: emisor RI a consumidor final -> Factura B', () => {
  const r = reglas.sugerirComprobante({ emisorCondicion: 'RI', receptorCondicionId: 5 });
  assert.strictEqual(r.letra, 'B');
  assert.strictEqual(r.tipoComprobante, 6);
});
test('reglas: emisor monotributo -> siempre Factura C sin IVA', () => {
  const r = reglas.sugerirComprobante({ emisorCondicion: 'MONOTRIBUTO', receptorCondicionId: 1 });
  assert.strictEqual(r.letra, 'C');
  assert.strictEqual(r.requiereIva, false);
});
test('reglas: sin condicion de emisor -> no sugiere letra', () => {
  const r = reglas.sugerirComprobante({ emisorCondicion: '', receptorCondicionId: 1 });
  assert.strictEqual(r.letra, null);
});
test('reglas: mapea tipoContribuyente del padron al id de condicion IVA', () => {
  assert.strictEqual(reglas.idDesdeTipoContribuyente('RESPONSABLE_INSCRIPTO'), 1);
  assert.strictEqual(reglas.idDesdeTipoContribuyente('MONOTRIBUTISTA'), 6);
  assert.strictEqual(reglas.idDesdeTipoContribuyente('EXENTO'), 4);
});

// ---------- importar.parseQr ----------
function qrUrl(data) {
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(data)).toString('base64');
}
test('parseQr: decodifica una URL de QR de ARCA', () => {
  const d = parseQr(qrUrl({ ver: 1, fecha: '2026-07-08', cuit: 20263630743, ptoVta: 1, tipoCmp: 11, nroCmp: 42, importe: 1210.5, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 30500010912, tipoCodAut: 'E', codAut: 75123456789012 }));
  assert.strictEqual(d.cuitEmisor, '20263630743');
  assert.strictEqual(d.numero, 42);
  assert.strictEqual(d.cae, '75123456789012');
  assert.strictEqual(d.importeTotal, 1210.5);
});
test('parseQr: acepta base64 directo (sin URL)', () => {
  const b64 = Buffer.from(JSON.stringify({ cuit: 1, codAut: 9, ptoVta: 1, nroCmp: 1, tipoCmp: 11, importe: 1 })).toString('base64');
  assert.strictEqual(parseQr(b64).cae, '9');
});
test('parseQr: rechaza basura', () => {
  assert.throws(() => parseQr('no-es-un-qr'), /no es un QR/i);
});
test('parseQr: rechaza QR sin cuit/codAut', () => {
  assert.throws(() => parseQr(qrUrl({ ver: 1, ptoVta: 1 })), /campos esperados/i);
});

// ---------- engine.toXml (validacion de claves anti-inyeccion XML) ----------
test('toXml: serializa objetos y arrays anidados', () => {
  assert.strictEqual(toXml({ a: 1, b: { c: 2 } }), '<a>1</a><b><c>2</c></b>');
  assert.strictEqual(toXml({ items: [1, 2] }), '<items>1</items><items>2</items>');
});
test('toXml: escapa los VALORES', () => {
  assert.strictEqual(toXml({ a: '<x>&' }), '<a>&lt;x&gt;&amp;</a>');
});
test('toXml: rechaza CLAVES invalidas (inyeccion XML)', () => {
  assert.throws(() => toXml({ 'x><ar:Otro>hack': 1 }), /Clave invalida/);
  assert.throws(() => toXml({ '<script>': 1 }), /Clave invalida/);
});

// ---------- lotes: helpers puros ----------
test('lotes.n / pInt: rechazan NaN (devuelven null)', () => {
  assert.strictEqual(n('12,50'), null); // coma decimal es-AR no es numero JS
  assert.strictEqual(n('abc'), null);
  assert.strictEqual(n('100.5'), 100.5);
  assert.strictEqual(n(''), null);
  assert.strictEqual(pInt('FC'), null);
  assert.strictEqual(pInt('11'), 11);
});
test('lotes.alicuotaId: infiere el id de alicuota desde la tasa', () => {
  assert.strictEqual(alicuotaId(1000, 210), 5); // 21%
  assert.strictEqual(alicuotaId(1000, 105), 4); // 10,5%
  assert.strictEqual(alicuotaId(1000, 270), 6); // 27%
  assert.strictEqual(alicuotaId(1000, 0), 5); // sin iva -> default
  assert.strictEqual(alicuotaId(1000, 210, 8), 8); // explicito gana
});
test('lotes.aging: semaforo por dias pendiente', () => {
  const dias = (d) => new Date(Date.now() - d * 86400000).toISOString();
  assert.strictEqual(lotes.aging({ estado: 'pendiente', created_at: dias(2) }).semaforo, 'VERDE');
  assert.strictEqual(lotes.aging({ estado: 'pendiente', created_at: dias(10) }).semaforo, 'AMARILLO');
  assert.strictEqual(lotes.aging({ estado: 'pendiente', created_at: dias(20) }).semaforo, 'ROJO');
  assert.strictEqual(lotes.aging({ estado: 'emitido', created_at: dias(20) }).semaforo, null);
});
test('lotes.parseCsv: parsea cabecera + filas (coma o punto y coma)', () => {
  const rows = parseCsv('nombre,cuit,importeTotal\nPerez,20111111112,100\nGomez,27222222223,200');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].nombre, 'Perez');
  assert.strictEqual(rows[1].importeTotal, '200');
});
test('lotes.normItem: importe no numerico -> null (no NaN)', () => {
  const it = normItem({ nombre: 'X', cuit: '20111111112', importeTotal: '12,50', tipoComprobante: 'FC' });
  assert.strictEqual(it.importe_total, null);
  assert.strictEqual(it.tipo_comprobante, null);
  assert.strictEqual(it.doc_tipo, 80); // tiene cuit -> default 80
});
