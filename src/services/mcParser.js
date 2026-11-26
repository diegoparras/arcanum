'use strict';

// Parser de lo que entrega Mis Comprobantes de ARCA: el JSON de ajax.do?f=listaResultados (lo que
// pide la receta), o lo que exporta la pantalla: CSV (separador ';' o ',', coma decimal,
// encabezados en castellano con o sin tildes) o un ZIP con el CSV adentro.
//
// Los encabezados se reconocen por palabra clave y no por posicion: ARCA ya cambio el orden y
// agrego columnas (por alicuota) mas de una vez, y asi seguimos leyendo lo que importa.

const zlib = require('zlib');

function sinTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** CSV -> array de objetos (claves = encabezados tal cual). */
function parsearCsv(texto) {
  let t = String(texto || '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const primera = t.split(/\r?\n/, 1)[0] || '';
  const sep = (primera.match(/;/g) || []).length >= (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      fila.push(campo); campo = '';
      if (fila.some((x) => x.trim() !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x.trim() !== '')) filas.push(fila);
  if (filas.length < 2) return [];
  const enc = filas[0].map((h) => h.trim());
  return filas.slice(1).map((f) => Object.fromEntries(enc.map((h, i) => [h, (f[i] || '').trim()])));
}

/** ZIP -> [{nombre, datos}]. Lee el directorio central; metodos 0 (stored) y 8 (deflate). */
function leerZip(buf) {
  const b = Buffer.from(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i -= 1) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('El ZIP de Mis Comprobantes esta danado'), { httpStatus: 422 });
  const total = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < total; k += 1) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = b.readUInt16LE(p + 10);
    const tamComp = b.readUInt32LE(p + 20);
    const lnNombre = b.readUInt16LE(p + 28);
    const lnExtra = b.readUInt16LE(p + 30);
    const lnComent = b.readUInt16LE(p + 32);
    const offLocal = b.readUInt32LE(p + 42);
    const nombre = b.slice(p + 46, p + 46 + lnNombre).toString('utf8');
    const ini = offLocal + 30 + b.readUInt16LE(offLocal + 26) + b.readUInt16LE(offLocal + 28);
    const crudo = b.slice(ini, ini + tamComp);
    if (!nombre.endsWith('/')) {
      if (metodo === 0) out.push({ nombre, datos: crudo });
      else if (metodo === 8) out.push({ nombre, datos: zlib.inflateRawSync(crudo) });
    }
    p += 46 + lnNombre + lnExtra + lnComent;
  }
  return out;
}

function numero(v) {
  const s = String(v == null ? '' : v).replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  let n;
  if (s.includes(',')) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ''));
  else n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function entero(v) {
  const m = String(v == null ? '' : v).match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function fecha(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Cada campo: funcion que decide si un encabezado normalizado es el suyo.
const CAMPOS = {
  fecha: (h) => h.startsWith('fecha'),
  cbteTipo: (h) => h === 'tipo' || h === 'tipo de comprobante' || h === 'tipo comprobante',
  puntoVenta: (h) => h.includes('punto de venta') || h === 'pto. vta.' || h === 'pto vta',
  numeroDesde: (h) => /^(numero|nro\.?) desde/.test(h) || h === 'numero' || h === 'nro.',
  numeroHasta: (h) => /^(numero|nro\.?) hasta/.test(h),
  cae: (h) => h.includes('autorizacion') || h === 'cae',
  docTipo: (h) => h.startsWith('tipo doc'),
  docNro: (h) => /^(nro\.?|numero) doc/.test(h),
  contraparte: (h) => h.startsWith('denominacion'),
  tipoCambio: (h) => h.startsWith('tipo cambio') || h.startsWith('tipo de cambio'),
  moneda: (h) => h === 'moneda',
  netoGravado: (h) => h.includes('neto gravado') && !h.includes('no gravado'),
  noGravado: (h) => h.includes('no gravado'),
  exento: (h) => h.includes('exent'),
  iva: (h) => h === 'iva' || h === 'imp. iva' || h === 'total iva',
  total: (h) => h === 'imp. total' || h === 'importe total' || h === 'total',
};

/** Una fila cruda del CSV -> comprobante normalizado. */
function normalizarFila(fila, tipo) {
  const v = {};
  for (const [h, valor] of Object.entries(fila || {})) {
    const n = sinTildes(h);
    for (const [campo, es] of Object.entries(CAMPOS)) {
      if (v[campo] === undefined && es(n)) { v[campo] = valor; break; }
    }
  }
  const desde = entero(v.numeroDesde);
  return {
    tipo,
    fecha: fecha(v.fecha),
    cbteTipo: entero(v.cbteTipo),
    puntoVenta: entero(v.puntoVenta),
    numeroDesde: desde,
    numeroHasta: entero(v.numeroHasta) || desde,
    cae: String(v.cae || '').replace(/\D/g, '') || null,
    docTipo: entero(v.docTipo),
    docNro: String(v.docNro || '').replace(/\D/g, '') || '',
    contraparte: String(v.contraparte || '').trim(),
    moneda: String(v.moneda || '').trim() || 'PES',
    tipoCambio: numero(v.tipoCambio) || 1,
    netoGravado: numero(v.netoGravado),
    noGravado: numero(v.noGravado),
    exento: numero(v.exento),
    iva: numero(v.iva),
    total: numero(v.total),
  };
}

// Posiciones de las filas del JSON de listaResultados. Salen de las variables rowXxx del JS de
// cada pagina de ARCA (comprobantesEmitidos.do / comprobantesRecibidos.do), verificadas en vivo:
// Emitidos trae 49 columnas y Recibidos 52 (suma CUIT y doc del emisor). Las columnas *Styled
// son el mismo valor con formato y se ignoran.
const COLUMNAS_JSON = {
  emitido: {
    largo: 49, fecha: 0, cbteTipo: 1, puntoVenta: 3, numeroDesde: 4, numeroHasta: 5, cae: 8,
    docTipo: 10, docNro: 11, contraparte: 12, tipoCambio: 13, moneda: 14,
    netoGravado: 37, noGravado: 39, exento: 41, iva: 45, total: 47,
  },
  recibido: {
    largo: 52, fecha: 0, cbteTipo: 1, puntoVenta: 3, numeroDesde: 4, numeroHasta: 5, cae: 8,
    docTipo: 10, docNro: 11, contraparte: 12, tipoCambio: 16, moneda: 17,
    netoGravado: 40, noGravado: 42, exento: 44, iva: 48, total: 50,
  },
};

/** Numero del JSON: punto decimal siempre ("100.500" es 100,5, no cien mil quinientos). */
function numeroJson(v) {
  const n = Number(v == null || v === '' ? 0 : v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Fila posicional del JSON de listaResultados -> comprobante normalizado. */
function normalizarFilaJson(fila, tipo) {
  const k = COLUMNAS_JSON[tipo];
  const v = (campo) => fila[k[campo]];
  const desde = entero(v('numeroDesde'));
  const moneda = String(v('moneda') || '').trim();
  return {
    tipo,
    fecha: fecha(v('fecha')),
    cbteTipo: entero(v('cbteTipo')),
    puntoVenta: entero(v('puntoVenta')),
    numeroDesde: desde,
    numeroHasta: entero(v('numeroHasta')) || desde,
    cae: String(v('cae') || '').replace(/\D/g, '') || null,
    docTipo: entero(v('docTipo')),
    docNro: String(v('docNro') || '').replace(/\D/g, '') || '',
    contraparte: String(v('contraparte') || '').trim(),
    moneda: !moneda || moneda === '$' ? 'PES' : moneda,
    tipoCambio: numeroJson(v('tipoCambio')) || 1,
    netoGravado: numeroJson(v('netoGravado')),
    noGravado: numeroJson(v('noGravado')),
    exento: numeroJson(v('exento')),
    iva: numeroJson(v('iva')),
    total: numeroJson(v('total')),
  };
}

/** JSON de listaResultados -> comprobantes, o null si el texto no es ese JSON. */
function desdeJson(texto, tipo) {
  let doc;
  try { doc = JSON.parse(texto); } catch { return null; }
  if (!doc || typeof doc !== 'object' || !('estado' in doc)) return null;
  if (doc.estado !== 'ok') {
    throw e422(`ARCA no devolvio los comprobantes: ${String(doc.mensajeError || doc.estado).slice(0, 200)}`);
  }
  const data = doc.datos && doc.datos.data;
  if (!Array.isArray(data)) throw e422('La respuesta de Mis Comprobantes no trae la lista de comprobantes');
  const k = COLUMNAS_JSON[tipo];
  if (!k) throw e422(`Tipo de Mis Comprobantes desconocido: ${tipo}`);
  const raras = data.find((f) => !Array.isArray(f) || f.length !== k.largo);
  if (raras) {
    throw e422(`Mis Comprobantes devolvio filas de ${Array.isArray(raras) ? raras.length : 0} columnas y se esperaban ${k.largo} (${tipo}s): ARCA puede haber cambiado el formato`);
  }
  const filas = data.map((f) => normalizarFilaJson(f, tipo));
  if (filas.some((c) => !c.cbteTipo || c.numeroDesde == null || !c.fecha)) {
    throw e422('Mis Comprobantes devolvio filas sin tipo, numero o fecha donde se esperaban: ARCA puede haber cambiado el formato');
  }
  return filas;
}

/** UTF-8, y si no es UTF-8 valido (ARCA a veces exporta en Latin-1), Latin-1. */
function decodificar(buf) {
  const t = buf.toString('utf8');
  return t.includes('�') ? buf.toString('latin1') : t;
}

function e422(message) {
  return Object.assign(new Error(message), { httpStatus: 422 });
}

/** Archivo de Mis Comprobantes (JSON, CSV o ZIP) -> comprobantes. Solo encabezado = [] (rango vacio); filas que
 *  no se entienden, o una pagina en vez de un CSV, son un error: nunca un "0" silencioso. */
function desdeArchivo(buf, nombre, tipo) {
  const b = Buffer.from(buf);
  const esZip = b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;
  if (!esZip && /\.xlsx?$/i.test(String(nombre || ''))) {
    throw e422('Mis Comprobantes entrego un Excel: la receta tiene que exportar CSV');
  }
  if (!esZip) {
    const deJson = desdeJson(decodificar(b), tipo);
    if (deJson) return deJson;
  }
  const textos = esZip
    ? leerZip(b).filter((a) => /\.(csv|txt)$/i.test(a.nombre)).map((a) => decodificar(a.datos))
    : [decodificar(b)];
  if (textos.some((t) => /^\s*</.test(t) && /<(html|body|!doctype)/i.test(t))) {
    throw e422('ARCA devolvio una pagina en vez del CSV (sesion vencida o error de ARCA)');
  }
  const crudas = textos.flatMap((t) => parsearCsv(t));
  const filas = crudas.map((f) => normalizarFila(f, tipo)).filter((c) => c.cbteTipo && c.numeroDesde != null);
  if (crudas.length && !filas.length) {
    throw e422('El CSV de Mis Comprobantes no tiene las columnas esperadas (tipo, numero, fecha): ARCA puede haber cambiado el formato');
  }
  return filas;
}

module.exports = { parsearCsv, leerZip, normalizarFila, desdeArchivo, COLUMNAS_JSON, _numero: numero };
