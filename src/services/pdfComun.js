'use strict';

// Piezas compartidas por los modelos de PDF (ARCA y Arcanum): isologo, tipos, fechas y el QR.

// Isologo ARCA: paths SVG oficiales (viewBox 0 0 240 66). pdfkit dibuja el path
// data nativamente, asi que embebemos el vector real sin dependencias extra.
const ARCA_PATHS = [
  'M25.276,5.12L0.543,60.825h13.202l4.958-11.939h25.788l4.958,11.939h13.525L38.001,5.12H25.276z M22.776,39.096l8.82-21.236l8.82,21.236H22.763H22.776z',
  'M105.364,42.876c3.609-1.562,6.391-3.851,8.357-6.842c1.966-2.992,2.949-6.587,2.949-10.787c0-4.199-0.983-7.725-2.949-10.745c-1.967-3.02-4.748-5.352-8.357-6.966c-3.61-1.616-7.895-2.43-12.88-2.43H68.382v55.705h12.964V45.205h11.139c0.196,0,0.365-0.014,0.562-0.026l10.815,15.616h13.835l-12.402-17.919c0,0,0.056-0.016,0.084-0.03L105.364,42.876z M100.672,18.126c2.01,1.671,3.021,4.045,3.021,7.121c0,3.076-1.012,5.463-3.021,7.164c-2.021,1.7-4.985,2.542-8.904,2.542H81.346V15.612h10.422c3.919,0,6.896,0.829,8.904,2.5V18.126z',
  'M141.067,20.079c1.588-1.587,3.469-2.823,5.646-3.694c2.177-0.87,4.564-1.306,7.164-1.306c2.753,0,5.31,0.562,7.667,1.671c2.361,1.11,4.466,2.753,6.321,4.93l8.343-7.641c-2.653-3.23-5.939-5.688-9.86-7.36c-3.917-1.671-8.299-2.5-13.118-2.5c-4.298,0-8.287,0.703-11.966,2.107c-3.681,1.404-6.897,3.413-9.622,6.012c-2.724,2.598-4.846,5.646-6.361,9.158c-1.518,3.497-2.263,7.345-2.263,11.546c0,4.198,0.76,8.033,2.263,11.545c1.516,3.497,3.623,6.56,6.319,9.158c2.697,2.599,5.898,4.605,9.58,6.01c3.679,1.406,7.667,2.107,11.967,2.107c4.874,0,9.27-0.843,13.201-2.542c3.921-1.699,7.207-4.172,9.86-7.401l-8.343-7.642c-1.855,2.178-3.96,3.835-6.321,4.973c-2.357,1.137-4.914,1.715-7.667,1.715c-2.6,0-4.987-0.437-7.164-1.309c-2.178-0.869-4.059-2.105-5.646-3.707s-2.824-3.469-3.693-5.646c-0.871-2.177-1.306-4.593-1.306-7.247c0-2.655,0.435-5.071,1.306-7.248c0.869-2.177,2.105-4.059,3.693-5.646V20.079z',
  'M225.931,60.825h13.526L214.47,5.12h-12.725L177.01,60.825h13.204l4.957-11.939h25.787l4.959,11.939H225.931z M199.245,39.096l8.819-21.236l8.82,21.236h-17.655H199.245z',
];

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
    moneda: (cmp.raw && cmp.raw.moneda) || cmp.moneda || 'PES',
    ctz: Number((cmp.raw && cmp.raw.cotizacion) || cmp.cotizacion || 1),
    tipoDocRec: Number(cmp.doc_tipo) || 99,
    nroDocRec: Number(cmp.doc_nro) || 0,
    // 'E' = CAE, 'A' = CAEA (RG 4892).
    tipoCodAut: cmp.raw && cmp.raw.modo === 'CAEA' ? 'A' : 'E',
    codAut: Number(cmp.cae),
  };
  const p = Buffer.from(JSON.stringify(data)).toString('base64');
  return 'https://www.afip.gob.ar/fe/qr/?p=' + p;
}

module.exports = { ARCA_PATHS, TIPOS, LETRA, EMISOR_COND, DOC_TIPO, money, ymd, isoFecha, qrUrl };
