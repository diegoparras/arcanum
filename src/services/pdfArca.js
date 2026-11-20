'use strict';

// Modelo "ARCA": copia de la representacion impresa que genera "Comprobantes en linea" (RCEL),
// medida sobre PDFs reales del facturador web. Es el modelo por defecto de Arcanum.
//
//  - Tres hojas iguales: ORIGINAL, DUPLICADO y TRIPLICADO (configurable).
//  - Recuadros de borde negro, letra con "COD. 0xx", emisor a la izquierda y comprobante a la
//    derecha, periodo facturado, receptor, tabla de items, totales en un recuadro fijo abajo.
//  - Importes como los muestra ARCA: sin separador de miles y con coma decimal (3570000,00).
//  - Pie: QR (RG 4892), isologo ARCA, "Comprobante Autorizado", pagina y CAE con vencimiento.

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { config } = require('../config');
const { condicionIvaLabel } = require('./reglas-comprobante');
const { ARCA_PATHS, LETRA, EMISOR_COND, DOC_TIPO, ymd, qrUrl } = require('./pdfComun');

const NEGRO = '#000000';
const GRIS_TABLA = '#cccccc';
const L = 14;
const R = 581;
const MID = 299;
const COPIAS = ['ORIGINAL', 'DUPLICADO', 'TRIPLICADO'];

const NOMBRE_TIPO = {
  1: 'FACTURA', 2: 'NOTA DE DEBITO', 3: 'NOTA DE CREDITO',
  6: 'FACTURA', 7: 'NOTA DE DEBITO', 8: 'NOTA DE CREDITO',
  11: 'FACTURA', 12: 'NOTA DE DEBITO', 13: 'NOTA DE CREDITO',
  51: 'FACTURA', 52: 'NOTA DE DEBITO', 53: 'NOTA DE CREDITO',
  19: 'FACTURA',
};
const IVA_PCT = { 3: '0%', 4: '10,5%', 5: '21%', 6: '27%', 8: '5%', 9: '2,5%' };
// Orden en que RCEL lista las alicuotas en los totales de una factura A.
const IVA_ORDEN = [6, 5, 4, 8, 9, 3];

/** Importe al estilo ARCA: sin separador de miles, coma decimal. */
function importe(n) {
  return Number(n || 0).toFixed(2).replace('.', ',');
}

function etiquetaValor(doc, x, y, etiqueta, valor, { tam = 8.5, negritaValor = false, ancho } = {}) {
  doc.font('Helvetica-Bold').fontSize(tam).fillColor(NEGRO).text(`${etiqueta} `, x, y, { continued: true, lineBreak: false });
  doc.font(negritaValor ? 'Helvetica-Bold' : 'Helvetica').text(String(valor ?? ''), ancho ? { width: ancho } : { lineBreak: false });
}

function pagina(doc, cmp, emisor, copia, qrPng) {
  const raw = cmp.raw || {};
  const tipo = Number(cmp.tipo_cbte);
  const letra = LETRA[tipo] || 'X';
  const esA = letra === 'A' || letra === 'M';
  doc.lineWidth(0.8).strokeColor(NEGRO);

  // ---------- ORIGINAL / DUPLICADO / TRIPLICADO ----------
  doc.rect(L, 30, R - L, 22).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(NEGRO).text(copia, L, 36, { width: R - L, align: 'center' });

  // ---------- Encabezado ----------
  doc.rect(L, 52, R - L, 121).stroke();
  doc.rect(MID - 24, 52, 48, 44).fillAndStroke('#ffffff', NEGRO);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(24).text(letra, MID - 24, 56, { width: 48, align: 'center' });
  doc.fontSize(6.5).text(`COD. ${String(tipo).padStart(3, '0')}`, MID - 24, 84, { width: 48, align: 'center' });
  doc.moveTo(MID, 96).lineTo(MID, 173).stroke();

  // Emisor (izquierda)
  const razon = emisor.razonSocial || `CUIT ${cmp.cuit}`;
  doc.font('Helvetica-Bold').fontSize(10).text(razon, L + 8, 70, { width: MID - 24 - L - 16, align: 'center' });
  let y = 112;
  etiquetaValor(doc, L + 8, y, 'Razón Social:', razon);
  y = 132;
  doc.font('Helvetica-Bold').fontSize(8.5).text('Domicilio Comercial:', L + 8, y, { width: 90 });
  doc.font('Helvetica').text(emisor.domicilio || '', L + 98, y, { width: MID - L - 106 });
  const condEmisor = EMISOR_COND[String(emisor.condicionIva || '').toUpperCase()] || 'Responsable Inscripto';
  etiquetaValor(doc, L + 8, 161, 'Condición frente al IVA:', condEmisor, { negritaValor: true });

  // Comprobante (derecha)
  const RX = MID + 42;
  doc.font('Helvetica-Bold').fontSize(20).text(NOMBRE_TIPO[tipo] || 'COMPROBANTE', RX, 60);
  doc.fontSize(8.5).text('Punto de Venta:', RX, 94, { continued: true }).fontSize(9.5).text(`  ${String(cmp.punto_venta).padStart(5, '0')}`, { continued: true })
    .fontSize(8.5).text('      Comp. Nro:', { continued: true }).fontSize(9.5).text(`  ${String(cmp.numero).padStart(8, '0')}`);
  doc.fontSize(8.5).text('Fecha de Emisión:', RX, 109, { continued: true }).fontSize(9.5).text(`  ${ymd(cmp.fecha)}`);
  etiquetaValor(doc, RX, 130, 'CUIT:', cmp.cuit);
  etiquetaValor(doc, RX, 141, 'Ingresos Brutos:', emisor.iibb || '');
  etiquetaValor(doc, RX, 152, 'Fecha de Inicio de Actividades:', emisor.inicioActividades ? ymd(emisor.inicioActividades) : '');

  // ---------- Periodo facturado (servicios) ----------
  y = 173;
  const servicios = Number(raw.concepto) === 2 || Number(raw.concepto) === 3;
  if (servicios) {
    doc.rect(L, y, R - L, 20).stroke();
    const py = y + 6;
    doc.font('Helvetica-Bold').fontSize(9).text('Período Facturado Desde:', L + 8, py, { continued: true })
      .font('Helvetica').text(`   ${ymd(raw.fechaServicioDesde || cmp.fecha)}`, { lineBreak: false });
    doc.font('Helvetica-Bold').text('Hasta:', 214, py, { continued: true }).font('Helvetica').text(` ${ymd(raw.fechaServicioHasta || cmp.fecha)}`, { lineBreak: false });
    doc.font('Helvetica-Bold').text('Fecha de Vto. para el pago:', 366, py, { continued: true }).font('Helvetica').text(` ${ymd(raw.fechaVtoPago || cmp.fecha)}`, { lineBreak: false });
    y += 20;
  }

  // ---------- Receptor ----------
  doc.rect(L, y, R - L, 58).stroke();
  const docTipo = Number(cmp.doc_tipo);
  const docNom = DOC_TIPO[docTipo] && docTipo !== 99 ? DOC_TIPO[docTipo] : 'Doc.';
  etiquetaValor(doc, L + 6, y + 7, `${docNom}:`, docTipo === 99 ? '' : cmp.doc_nro);
  doc.font('Helvetica-Bold').fontSize(7.5).text('Apellido y Nombre / Razón Social: ', 223, y + 7, { continued: true })
    .font('Helvetica').fontSize(8).text(raw.receptorNombre || raw.razonSocialReceptor || (docTipo === 99 ? 'CONSUMIDOR FINAL' : ''), { width: R - 360 });
  const condRecId = raw.condicionIvaReceptor != null ? Number(raw.condicionIvaReceptor) : null;
  const condRec = condRecId ? condicionIvaLabel(condRecId) : (docTipo === 99 ? 'Consumidor Final' : '');
  doc.font('Helvetica-Bold').fontSize(7.5).text('Condición frente al IVA:', L + 6, y + 25);
  doc.font('Helvetica').fontSize(7.5).text(condRec || '', L + 108, y + 25, { width: 190 });
  doc.font('Helvetica-Bold').fontSize(7.5).text('Domicilio:', 312, y + 25, { continued: true })
    .font('Helvetica').text(` ${raw.receptorDomicilio || ''}`, { width: R - 320 });
  doc.font('Helvetica-Bold').fontSize(7.5).text('Condición de venta:', L + 6, y + 43, { continued: true })
    .font('Helvetica').text(`    ${raw.condicionVenta || 'Contado'}`, { lineBreak: false });
  y += 58 + 8;

  // ---------- Tabla de items ----------
  const col = esA
    ? [['Código', L, 40], ['Producto / Servicio', 54, 128], ['Cantidad', 182, 44], ['U. Medida', 226, 42], ['Precio Unit.', 268, 58],
      ['% Bonif', 326, 34], ['Subtotal', 360, 66], ['Alícuota IVA', 426, 54], ['Subtotal c/IVA', 480, R - 480]]
    : [['Código', L, 40], ['Producto / Servicio', 54, 143], ['Cantidad', 197, 64], ['U. Medida', 261, 44], ['Precio Unit.', 305, 77],
      ['% Bonif', 382, 35], ['Imp. Bonif.', 417, 73], ['Subtotal', 490, R - 490]];
  doc.rect(L, y, R - L, 17).fillAndStroke(GRIS_TABLA, NEGRO);
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(7);
  for (const [i, [t, x, w]] of col.entries()) {
    if (i > 0) doc.moveTo(x, y).lineTo(x, y + 17).stroke();
    doc.text(t, x + 3, y + 5, { width: w - 6, align: i <= 1 ? 'left' : 'center', lineBreak: false });
  }
  y += 22;

  const items = Array.isArray(raw.items) && raw.items.length ? raw.items : [{
    descripcion: { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' }[Number(raw.concepto)] || 'Productos / Servicios',
    cantidad: 1,
    precioUnitario: esA ? Number(raw.importeNeto || cmp.importe_total) : Number(cmp.importe_total),
    subtotal: esA ? Number(raw.importeNeto || cmp.importe_total) : Number(cmp.importe_total),
  }];
  const alicuotaUnica = Array.isArray(raw.alicuotasIva) && raw.alicuotasIva.length === 1 ? Number(raw.alicuotasIva[0].id) : null;
  doc.font('Helvetica').fontSize(7.5);
  for (const it of items.slice(0, 14)) {
    const desc = String(it.descripcion || it.desc || '');
    const wDesc = col[1][2] - 6;
    const alto = Math.max(10, doc.heightOfString(desc, { width: wDesc }));
    const sub = Number(it.subtotal ?? (Number(it.cantidad ?? 1) * Number(it.precioUnitario ?? 0)));
    const bonifPct = Number(it.bonifPct ?? 0);
    const celdas = esA
      ? [it.codigo || '', desc, importe(it.cantidad ?? 1), it.unidadMedida || 'unidades', importe(it.precioUnitario ?? sub), importe(bonifPct), importe(sub),
        IVA_PCT[Number(it.alicuotaIva ?? alicuotaUnica)] || '', importe(it.subtotalConIva ?? (sub * (1 + (parseFloat(String(IVA_PCT[Number(it.alicuotaIva ?? alicuotaUnica)] || '0').replace(',', '.')) / 100))))]
      : [it.codigo || '', desc, importe(it.cantidad ?? 1), it.unidadMedida || 'unidades', importe(it.precioUnitario ?? sub), importe(bonifPct),
        importe(it.importeBonificacion ?? 0), importe(sub)];
    for (const [i, [, x, w]] of col.entries()) {
      const centro = i === 3;
      doc.text(String(celdas[i]), x + 3, y, { width: w - 6, align: i === 1 || i === 0 ? 'left' : centro ? 'left' : 'right' });
    }
    y += alto + 3;
  }
  if (items.length > 14) doc.font('Helvetica-Oblique').text(`... y ${items.length - 14} item(s) mas`, col[1][1] + 3, y);

  // ---------- Totales (recuadro fijo, como RCEL) ----------
  const TY = esA ? 492 : 519;
  const TH = 613 - TY;
  doc.rect(L, TY, R - L, TH).stroke();
  let ty = TY + (esA ? 12 : 22);
  const fila = (etiqueta, valor, total = false) => {
    doc.font('Helvetica-Bold').fontSize(total ? 10 : 8.5).fillColor(NEGRO);
    doc.text(`${etiqueta}: $`, 300, ty, { width: 198, align: 'right' });
    doc.text(importe(valor), 500, ty, { width: R - 504, align: 'right' });
    ty += total ? 20 : esA ? 11.5 : 20;
  };
  if (esA) {
    const porId = Object.fromEntries((raw.alicuotasIva || []).map((a) => [Number(a.id), Number(a.importe)]));
    fila('Importe Neto Gravado', raw.importeNeto);
    for (const id of IVA_ORDEN) fila(`IVA ${IVA_PCT[id]}`, porId[id] || 0);
    fila('Importe Otros Tributos', raw.importeTributos || 0);
    fila('Importe Total', cmp.importe_total, true);
  } else {
    fila('Subtotal', Number(cmp.importe_total) - Number(raw.importeTributos || 0));
    fila('Importe Otros Tributos', raw.importeTributos || 0);
    fila('Importe Total', cmp.importe_total, true);
  }
  // Factura B a consumidor final: Regimen de Transparencia Fiscal (Ley 27.743).
  if (letra === 'B' && (condRecId === 5 || (!condRecId && docTipo === 99))) {
    doc.font('Helvetica-Bold').fontSize(7.5).text('Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)', L + 10, TY + 12, { width: 260 });
    doc.font('Helvetica').text(`IVA Contenido: $ ${importe(raw.importeIva || 0)}`, L + 10, TY + 30);
    doc.text(`Otros Impuestos Nacionales Indirectos: $ ${importe(raw.importeTributos || 0)}`, L + 10, TY + 42);
  }
  if (raw.moneda && raw.moneda !== 'PES') {
    doc.font('Helvetica').fontSize(7.5).text(`Moneda: ${raw.moneda}   Cotización: $ ${importe(raw.cotizacion || 1)}`, L + 10, TY + TH - 16);
  }

  // ---------- Pie ----------
  doc.image(qrPng, 25, 657, { width: 72 });
  doc.save().translate(114, 659).scale(0.23);
  for (const d of ARCA_PATHS) doc.path(d).fill(NEGRO);
  doc.restore();
  doc.font('Helvetica').fontSize(3.4).fillColor(NEGRO).text('AGENCIA DE RECAUDACIÓN', 104, 676, { width: 75, align: 'center', lineBreak: false });
  doc.text('Y CONTROL ADUANERO', 104, 681, { width: 75, align: 'center', lineBreak: false });
  doc.font('Helvetica-BoldOblique').fontSize(8.5).text('Comprobante Autorizado', 114, 695);
  doc.fontSize(5.3).text('Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación', 114, 713, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8.5).text('Pág. 1/1', 268, 662, { lineBreak: false });
  const esCaea = (cmp.raw || {}).modo === 'CAEA';
  doc.font('Helvetica-Bold').fontSize(9.5).text(esCaea ? 'CAEA N°:' : 'CAE N°:', 350, 656, { width: 134, align: 'right' });
  doc.font('Helvetica').text(String(cmp.cae || ''), 488, 656, { lineBreak: false });
  doc.font('Helvetica-Bold').text(esCaea ? 'Fecha de Vto. de CAEA:' : 'Fecha de Vto. de CAE:', 300, 672, { width: 184, align: 'right' });
  doc.font('Helvetica').text(ymd(cmp.cae_vto), 488, 672, { lineBreak: false });
}

async function generar(cmp, emisorDe, { copias = 3 } = {}) {
  const emisor = (emisorDe && Object.keys(emisorDe).length ? emisorDe : config.emisor) || {};
  const qrPng = await QRCode.toBuffer(await qrUrl(cmp), { margin: 1, width: 220 });
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const partes = [];
  doc.on('data', (c) => partes.push(c));
  const fin = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(partes))));
  const n = Math.min(Math.max(parseInt(copias, 10) || 3, 1), 3);
  for (const copia of COPIAS.slice(0, n)) {
    doc.addPage({ size: 'A4', margin: 0 });
    pagina(doc, cmp, emisor, copia, qrPng);
  }
  doc.end();
  return fin;
}

module.exports = { generar, importe };
