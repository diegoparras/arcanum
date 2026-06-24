'use strict';

// Genera el PDF legal del comprobante con el QR obligatorio de ARCA (RG 4892).
// El QR codifica una URL https://www.afip.gob.ar/fe/qr/?p=<base64(json)>.

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const TIPOS = {
  1: 'FACTURA A', 2: 'NOTA DE DEBITO A', 3: 'NOTA DE CREDITO A',
  6: 'FACTURA B', 7: 'NOTA DE DEBITO B', 8: 'NOTA DE CREDITO B',
  11: 'FACTURA C', 12: 'NOTA DE DEBITO C', 13: 'NOTA DE CREDITO C',
  51: 'FACTURA M', 19: 'FACTURA E (EXPORTACION)',
};
const LETRA = { 1: 'A', 2: 'A', 3: 'A', 6: 'B', 7: 'B', 8: 'B', 11: 'C', 12: 'C', 13: 'C', 51: 'M', 19: 'E' };

function ymd(d) {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}
function isoFecha(d) {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '');
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

async function qrUrl(cmp) {
  const data = {
    ver: 1,
    fecha: isoFecha(cmp.fecha),
    cuit: Number(cmp.cuit),
    ptoVta: Number(cmp.punto_venta),
    tipoCmp: Number(cmp.tipo_cbte),
    nroCmp: Number(cmp.numero),
    importe: Number(cmp.importe_total),
    moneda: cmp.moneda || 'PES',
    ctz: 1,
    tipoDocRec: Number(cmp.doc_tipo) || 99,
    nroDocRec: Number(cmp.doc_nro) || 0,
    tipoCodAut: 'E',
    codAut: Number(cmp.cae),
  };
  const p = Buffer.from(JSON.stringify(data)).toString('base64');
  return 'https://www.afip.gob.ar/fe/qr/?p=' + p;
}

/** Devuelve un Buffer con el PDF del comprobante. */
async function generar(cmp) {
  const url = await qrUrl(cmp);
  const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const tipoNombre = TIPOS[cmp.tipo_cbte] || `COMPROBANTE TIPO ${cmp.tipo_cbte}`;
  const letra = LETRA[cmp.tipo_cbte] || 'X';

  // Encabezado
  doc.fontSize(20).fillColor('#1c1a17').text(tipoNombre, { align: 'left' });
  doc.fontSize(40).fillColor('#27408b').text(letra, 480, 40);
  doc.moveTo(40, 90).lineTo(555, 90).strokeColor('#e7e2d9').stroke();

  doc.fontSize(11).fillColor('#1c1a17');
  doc.text(`Punto de venta: ${String(cmp.punto_venta).padStart(5, '0')}    Comprobante Nro: ${String(cmp.numero).padStart(8, '0')}`, 40, 100);
  doc.text(`Fecha de emision: ${ymd(cmp.fecha)}`, 40, 118);

  // Emisor / receptor
  doc.moveDown(2);
  doc.fontSize(11).fillColor('#6b6358').text('CUIT Emisor', 40, 150);
  doc.fillColor('#1c1a17').text(cmp.cuit, 40, 165);
  doc.fillColor('#6b6358').text('Receptor', 300, 150);
  doc.fillColor('#1c1a17').text(`Doc ${cmp.doc_tipo}: ${cmp.doc_nro}`, 300, 165);

  // Importe
  doc.moveTo(40, 200).lineTo(555, 200).strokeColor('#e7e2d9').stroke();
  doc.fontSize(13).fillColor('#6b6358').text('Importe Total', 40, 215);
  doc.fontSize(22).fillColor('#1c1a17').text(`${cmp.moneda || 'PES'} ${Number(cmp.importe_total).toFixed(2)}`, 40, 232);

  // CAE + QR
  doc.fontSize(11).fillColor('#6b6358').text('CAE Nro:', 40, 300);
  doc.fillColor('#1c1a17').text(cmp.cae || '-', 110, 300);
  doc.fillColor('#6b6358').text('Vencimiento CAE:', 40, 318);
  doc.fillColor('#1c1a17').text(ymd(cmp.cae_vto), 160, 318);

  doc.image(qrPng, 360, 290, { width: 150 });
  doc.fontSize(8).fillColor('#6b6358').text('Comprobante autorizado por ARCA', 360, 445, { width: 150, align: 'center' });

  doc.fontSize(8).fillColor('#9a9388').text('Generado por Arcanum — Escriba Suite', 40, 780, { align: 'center', width: 515 });

  doc.end();
  return done;
}

module.exports = { generar, qrUrl };
