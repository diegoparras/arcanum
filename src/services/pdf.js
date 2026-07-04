'use strict';

// Representacion impresa legal del comprobante (RG 1415 / 5616 / 4892 / 5866):
//  - Datos del emisor (razon social, condicion IVA, CUIT, IIBB, inicio act.)
//  - Datos del receptor con su CONDICION FRENTE AL IVA (obligatoria)
//  - Discriminacion de IVA por alicuota (comprobantes A/M) o total (B/C)
//  - Periodo facturado (servicios), condicion de venta
//  - Leyendas: "A CONSUMIDOR FINAL" (RG 5866, >= umbral) y Ley 27.743 (B/C a CF)
//  - CAE + vencimiento, QR de ARCA (RG 4892) y codigo de barras Interleaved 2of5

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { config } = require('../config');
const { condicionIvaLabel } = require('./reglas-comprobante');

const TINTA = '#1c1a17';
const GRIS = '#6b6358';
const LINEA = '#c9c3b8';

const TIPOS = {
  1: 'FACTURA A', 2: 'NOTA DE DEBITO A', 3: 'NOTA DE CREDITO A',
  6: 'FACTURA B', 7: 'NOTA DE DEBITO B', 8: 'NOTA DE CREDITO B',
  11: 'FACTURA C', 12: 'NOTA DE DEBITO C', 13: 'NOTA DE CREDITO C',
  51: 'FACTURA M', 52: 'NOTA DE DEBITO M', 53: 'NOTA DE CREDITO M',
  19: 'FACTURA E (EXPORTACION)',
};
const LETRA = { 1: 'A', 2: 'A', 3: 'A', 6: 'B', 7: 'B', 8: 'B', 11: 'C', 12: 'C', 13: 'C', 51: 'M', 52: 'M', 53: 'M', 19: 'E' };
const EMISOR_COND = { RI: 'Responsable Inscripto', MONOTRIBUTO: 'Responsable Monotributo', MONOTRIBUTISTA: 'Responsable Monotributo', EXENTO: 'IVA Sujeto Exento' };
const DOC_TIPO = { 80: 'CUIT', 86: 'CUIL', 87: 'CDI', 96: 'DNI', 99: 'Consumidor Final' };

function money(n) {
  const x = Number(n || 0).toFixed(2);
  const [i, d] = x.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d;
}
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

// --- Codigo de barras Interleaved 2 of 5 (RG 1415) ---
const I25 = { 0: 'NNWWN', 1: 'WNNNW', 2: 'NWNNW', 3: 'WWNNN', 4: 'NNWNW', 5: 'WNWNN', 6: 'NWWNN', 7: 'NNNWW', 8: 'WNNWN', 9: 'NWNWN' };
function digitoVerificadorAfip(num) {
  // Modulo 10: posiciones impares (desde la derecha) x3 + pares, complemento a 10.
  let impares = 0;
  let pares = 0;
  const rev = num.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    const d = Number(rev[i]);
    if (i % 2 === 0) impares += d; else pares += d;
  }
  const total = impares * 3 + pares;
  return String((10 - (total % 10)) % 10);
}
function drawBarcode(doc, cmp) {
  try {
    const base =
      String(cmp.cuit).padStart(11, '0') +
      String(cmp.tipo_cbte).padStart(3, '0') +
      String(cmp.punto_venta).padStart(4, '0') +
      String(cmp.cae || '0').padStart(14, '0') +
      isoFecha(cmp.cae_vto).replace(/-/g, '').padStart(8, '0');
    let data = base + digitoVerificadorAfip(base);
    if (data.length % 2 !== 0) data = '0' + data;

    const x0 = 40;
    const y0 = 752;
    const height = 30;
    const narrow = 1.05;
    const wide = narrow * 3;
    let x = x0;
    const bar = (w, on) => { if (on) doc.rect(x, y0, w, height).fill(TINTA); x += w; };
    // Start: N N (barra-espacio-barra-espacio angostos)
    bar(narrow, true); bar(narrow, false); bar(narrow, true); bar(narrow, false);
    for (let i = 0; i < data.length; i += 2) {
      const b = I25[data[i]];
      const s = I25[data[i + 1]];
      for (let k = 0; k < 5; k++) {
        bar(b[k] === 'W' ? wide : narrow, true);
        bar(s[k] === 'W' ? wide : narrow, false);
      }
    }
    // Stop: W N N
    bar(wide, true); bar(narrow, false); bar(narrow, true);
    doc.fillColor(GRIS).fontSize(6).text(data, x0, y0 + height + 2);
  } catch {
    // El codigo de barras es best-effort: nunca debe romper el PDF.
  }
}

/** Devuelve un Buffer con el PDF del comprobante. */
async function generar(cmp) {
  const raw = cmp.raw || {};
  const tipo = Number(cmp.tipo_cbte);
  const letra = LETRA[tipo] || 'X';
  const tipoNombre = TIPOS[tipo] || `COMPROBANTE TIPO ${tipo}`;
  const discrimina = letra === 'A' || letra === 'M'; // A/M discriminan IVA
  const emisor = config.emisor || {};

  const url = await qrUrl(cmp);
  const qrPng = await QRCode.toBuffer(url, { margin: 1, width: 220 });

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const L = 40;
  const R = 555;
  const MID = 300;

  // ---------- Encabezado con caja de letra ----------
  doc.rect(L, 55, R - L, 108).lineWidth(0.8).strokeColor(LINEA).stroke();
  doc.moveTo(MID, 84).lineTo(MID, 163).strokeColor(LINEA).stroke();
  doc.fontSize(7).font('Helvetica').fillColor(GRIS).text('ORIGINAL', L + 6, 60);
  // Caja de letra centrada, montada sobre el borde superior
  doc.rect(MID - 24, 42, 48, 42).fillAndStroke('#ffffff', TINTA);
  doc.fillColor(TINTA).fontSize(28).font('Helvetica-Bold').text(letra, MID - 24, 47, { width: 48, align: 'center' });
  doc.fontSize(7).font('Helvetica').fillColor(GRIS).text(`COD. ${String(tipo).padStart(2, '0')}`, MID - 40, 86, { width: 80, align: 'center' });

  // Columna izquierda: emisor
  let y = 74;
  const razon = emisor.razonSocial || `CUIT ${cmp.cuit}`;
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(15).text(razon, L + 10, y, { width: 218 });
  y += doc.heightOfString(razon, { width: 218 }) + 3;
  doc.font('Helvetica').fontSize(8.5).fillColor(GRIS);
  if (emisor.nombreFantasia) { doc.text(emisor.nombreFantasia, L + 10, y, { width: 258 }); y += 12; }
  if (emisor.domicilio) { doc.text(emisor.domicilio, L + 10, y, { width: 258 }); y += 12; }
  const condEmisor = EMISOR_COND[emisor.condicionIva] || 'Responsable Inscripto';
  doc.text(`Condicion frente al IVA: ${condEmisor}`, L + 10, y, { width: 258 }); y += 12;
  if (emisor.iibb) { doc.text(`Ingresos Brutos: ${emisor.iibb}`, L + 10, y); y += 12; }
  if (emisor.inicioActividades) { doc.text(`Inicio de actividades: ${ymd(emisor.inicioActividades)}`, L + 10, y); y += 12; }

  // Columna derecha: datos del comprobante (a la derecha de la caja de letra)
  const RX = MID + 30;
  let yr = 74;
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(13).text(tipoNombre, RX, yr, { width: R - RX - 4 }); yr += 20;
  doc.font('Helvetica').fontSize(9).fillColor(TINTA);
  doc.text(`Punto de Venta: ${String(cmp.punto_venta).padStart(5, '0')}`, RX, yr); yr += 13;
  doc.text(`Comp. Nro: ${String(cmp.numero).padStart(8, '0')}`, RX, yr); yr += 13;
  doc.text(`Fecha de Emision: ${ymd(cmp.fecha)}`, RX, yr); yr += 13;
  doc.text(`CUIT: ${cmp.cuit}`, RX, yr); yr += 13;

  // ---------- Periodo facturado (servicios) ----------
  y = 170;
  if (Number(raw.concepto) === 2 || Number(raw.concepto) === 3) {
    doc.rect(L, y, R - L, 22).strokeColor(LINEA).stroke();
    doc.fontSize(8.5).fillColor(TINTA).font('Helvetica')
      .text(`Periodo Facturado  Desde: ${ymd(raw.fechaServicioDesde) || ymd(cmp.fecha)}   Hasta: ${ymd(raw.fechaServicioHasta) || ymd(cmp.fecha)}   Vto. para el pago: ${ymd(raw.fechaVtoPago) || ymd(cmp.fecha)}`, L + 8, y + 7);
    y += 30;
  }

  // ---------- Receptor ----------
  const docTipoNom = DOC_TIPO[Number(cmp.doc_tipo)] || `Doc ${cmp.doc_tipo}`;
  let condRecId = raw.condicionIvaReceptor;
  let condRec = condicionIvaLabel(condRecId);
  if (!condRec) condRec = letra === 'A' ? 'Responsable Inscripto' : 'Consumidor Final';
  const boxH = 58;
  doc.rect(L, y, R - L, boxH).strokeColor(LINEA).stroke();
  doc.fontSize(8.5).fillColor(GRIS).font('Helvetica');
  doc.text(`${docTipoNom}:`, L + 8, y + 8);
  doc.fillColor(TINTA).text(`${cmp.doc_nro || '-'}`, L + 70, y + 8);
  if (raw.receptorNombre) { doc.fillColor(GRIS).text('Nombre / Razon Social:', L + 8, y + 22); doc.fillColor(TINTA).text(raw.receptorNombre, L + 130, y + 22, { width: R - L - 140 }); }
  doc.fillColor(GRIS).text('Condicion frente al IVA:', L + 8, y + 36);
  doc.fillColor(TINTA).text(condRec, L + 130, y + 36);
  doc.fillColor(GRIS).text('Condicion de venta:', MID + 60, y + 36);
  doc.fillColor(TINTA).text(raw.condicionVenta || 'Contado', MID + 160, y + 36);
  y += boxH + 12;

  // ---------- Tabla de conceptos ----------
  const cols = { desc: L + 6, cant: 320, punit: 370, sub: R - 6 };
  doc.rect(L, y, R - L, 20).fill('#f2efe9');
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold');
  doc.text('Descripcion', cols.desc, y + 6);
  doc.text('Cant.', cols.cant, y + 6);
  doc.text('P. Unitario', cols.punit, y + 6);
  doc.text('Subtotal', 470, y + 6, { width: 79, align: 'right' });
  y += 24;

  const base = Number(raw.importeNeto || 0) + Number(raw.importeNoGravado || 0) + Number(raw.importeExento || 0);
  const baseFila = discrimina ? Number(raw.importeNeto || 0) || base : Number(cmp.importe_total || 0);
  const conceptoNom = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' }[Number(raw.concepto)] || 'Productos / Servicios';
  doc.font('Helvetica').fontSize(9).fillColor(TINTA);
  doc.text(conceptoNom + ' segun detalle', cols.desc, y, { width: 260 });
  doc.text('1', cols.cant, y);
  doc.text(money(baseFila), cols.punit, y);
  doc.text(money(baseFila), 470, y, { width: 79, align: 'right' });
  y += 22;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(LINEA).stroke();
  y += 10;

  // ---------- Totales ----------
  const tx = 360;
  const tv = R;
  const rowTot = (label, val, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9).fillColor(bold ? TINTA : GRIS);
    doc.text(label, tx, y, { width: 110 });
    doc.fillColor(TINTA).text(`${cmp.moneda || 'PES'} ${money(val)}`, tx, y, { width: tv - tx, align: 'right' });
    y += bold ? 20 : 15;
  };
  if (discrimina) {
    rowTot('Neto Gravado', raw.importeNeto);
    if (Number(raw.importeNoGravado)) rowTot('No Gravado', raw.importeNoGravado);
    if (Number(raw.importeExento)) rowTot('Exento', raw.importeExento);
    const alic = Array.isArray(raw.alicuotasIva) ? raw.alicuotasIva : [];
    if (alic.length) {
      const IVA_PCT = { 3: '0%', 4: '10,5%', 5: '21%', 6: '27%', 8: '5%', 9: '2,5%' };
      for (const a of alic) rowTot(`IVA ${IVA_PCT[Number(a.id)] || ''}`, a.importe);
    } else if (Number(raw.importeIva)) {
      rowTot('IVA', raw.importeIva);
    }
    if (Number(raw.importeTributos)) rowTot('Otros Tributos', raw.importeTributos);
  } else {
    rowTot('Subtotal', cmp.importe_total);
  }
  rowTot('Importe Total', cmp.importe_total, true);

  // ---------- Leyendas ----------
  y += 6;
  const leyendas = [];
  const totalNum = Number(cmp.importe_total || 0);
  const esCF = condRecId === 5 || (!condRecId && (letra === 'B' || letra === 'C'));
  if (esCF && totalNum >= 10000000) leyendas.push('A CONSUMIDOR FINAL');
  if ((letra === 'B' || letra === 'C') && esCF) leyendas.push('Regimen de Transparencia Fiscal al Consumidor (Ley 27.743).');
  if (letra === 'C') leyendas.push('El presente comprobante no genera credito fiscal (RG s/ Monotributo / Exento).');
  if (leyendas.length) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TINTA);
    for (const lg of leyendas) { doc.text(lg, L, y, { width: R - L }); y += 12; }
  }

  // ---------- CAE + QR + barra ----------
  doc.image(qrPng, L, 655, { width: 84 });
  doc.font('Helvetica').fontSize(10).fillColor(GRIS).text('CAE N°:', 145, 665);
  doc.fillColor(TINTA).font('Helvetica-Bold').text(cmp.cae || '-', 205, 665);
  doc.font('Helvetica').fillColor(GRIS).text('Vto. CAE:', 145, 683);
  doc.fillColor(TINTA).font('Helvetica-Bold').text(ymd(cmp.cae_vto), 205, 683);
  doc.font('Helvetica').fontSize(8).fillColor(GRIS).text('Comprobante Autorizado por ARCA', 145, 705);

  drawBarcode(doc, cmp);

  doc.fontSize(7).fillColor('#9a9388').text('Generado por Arcanum — Escriba Suite', L, 792, { align: 'center', width: R - L });

  doc.end();
  return done;
}

module.exports = { generar, qrUrl };
