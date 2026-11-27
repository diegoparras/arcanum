'use strict';

// Listado paginado de los comprobantes ya bajados de Mis Comprobantes (tabla mc_comprobantes).
// Lo usan la API REST (GET /api/mis-comprobantes/:cuit/descargados) y la herramienta MCP
// listar_comprobantes_descargados. Solo lee la base: no entra a ARCA ni cambia nada.
//
// Paginación por cursor (keyset) sobre (fecha, id), del más nuevo al más viejo: estable aunque
// entren comprobantes nuevos entre una página y la siguiente.

const { condicionesListado } = require('./misComprobantes');

const LIMITE_DEFECTO = 50;
const LIMITE_MAXIMO = 200;
const SIN_FECHA = "DATE '0001-01-01'";

const NOMBRES = {
  1: 'Factura A', 2: 'Nota de Débito A', 3: 'Nota de Crédito A', 4: 'Recibo A',
  6: 'Factura B', 7: 'Nota de Débito B', 8: 'Nota de Crédito B', 9: 'Recibo B',
  11: 'Factura C', 12: 'Nota de Débito C', 13: 'Nota de Crédito C', 15: 'Recibo C',
  19: 'Factura E', 20: 'Nota de Débito E', 21: 'Nota de Crédito E',
  51: 'Factura M', 52: 'Nota de Débito M', 53: 'Nota de Crédito M',
  201: 'Factura de Crédito Electrónica MiPyME A', 202: 'Nota de Débito Electrónica MiPyME A', 203: 'Nota de Crédito Electrónica MiPyME A',
  206: 'Factura de Crédito Electrónica MiPyME B', 207: 'Nota de Débito Electrónica MiPyME B', 208: 'Nota de Crédito Electrónica MiPyME B',
  211: 'Factura de Crédito Electrónica MiPyME C', 212: 'Nota de Débito Electrónica MiPyME C', 213: 'Nota de Crédito Electrónica MiPyME C',
};

function error(msg) {
  return Object.assign(new Error(msg), { httpStatus: 400 });
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filtros de la consulta (de la query string o de los argumentos MCP), validados.
 * Acepta: tipo (emitidos|recibidos, también en singular), desde, hasta, cuit (de la
 * contraparte), tipoCbte, limite y cursor.
 */
function normalizarFiltros(o = {}, { tope = LIMITE_MAXIMO } = {}) {
  const f = {};
  if (o.tipo != null && o.tipo !== '') {
    const t = String(o.tipo).toLowerCase().replace(/s$/, '');
    if (t !== 'emitido' && t !== 'recibido') throw error('"tipo" tiene que ser emitidos o recibidos');
    f.tipo = t;
  }
  for (const campo of ['desde', 'hasta']) {
    if (o[campo] == null || o[campo] === '') continue;
    if (!FECHA.test(String(o[campo])) || Number.isNaN(Date.parse(o[campo]))) throw error(`"${campo}" tiene que tener la forma AAAA-MM-DD`);
    f[campo] = String(o[campo]);
  }
  if (f.desde && f.hasta && f.desde > f.hasta) throw error('"desde" es posterior a "hasta"');
  if (o.cuit != null && o.cuit !== '') {
    const c = String(o.cuit).replace(/\D/g, '');
    if (!c || c.length > 13) throw error('"cuit" de la contraparte tiene que ser un CUIT o documento');
    f.contraparte = c;
  }
  if (o.tipoCbte != null && o.tipoCbte !== '') {
    if (!/^\d{1,4}$/.test(String(o.tipoCbte))) throw error('"tipoCbte" tiene que ser el código numérico del tipo (6 = Factura B)');
    f.cbte = Number(o.tipoCbte);
  }
  const limite = o.limite == null || o.limite === '' ? LIMITE_DEFECTO : Number(o.limite);
  if (!Number.isInteger(limite) || limite < 1) throw error('"limite" tiene que ser un entero mayor que 0');
  f.limite = Math.min(limite, tope);
  if (o.cursor) f.cursor = leerCursor(o.cursor);
  return f;
}

function fechaIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const num = (v) => (v == null || v === '' ? null : Number(v));

function codificarCursor(fila) {
  return Buffer.from(`${fechaIso(fila.fecha) || ''}|${fila.id}`).toString('base64url');
}

function leerCursor(s) {
  const m = Buffer.from(String(s), 'base64url').toString('utf8').match(/^(\d{4}-\d{2}-\d{2})?\|(\d{1,12})$/);
  if (!m) throw error('"cursor" inválido: usá el valor "siguiente" de la página anterior');
  return { fecha: m[1] || '0001-01-01', id: Number(m[2]) };
}

/** Una fila de mc_comprobantes, como la ve quien consume la API. */
function item(f) {
  const pv = Number(f.punto_venta);
  const numero = Number(f.numero_desde);
  const hasta = num(f.numero_hasta);
  const doc = f.doc_nro || null;
  const out = {
    id: [f.cuit, f.tipo, f.cbte_tipo, pv, numero, f.doc_nro || ''].join(':'),
    tipo: f.tipo,
    tipoComprobante: Number(f.cbte_tipo),
    tipoNombre: NOMBRES[f.cbte_tipo] || `Tipo ${f.cbte_tipo}`,
    comprobante: `${String(pv).padStart(4, '0')}-${String(numero).padStart(8, '0')}`,
    puntoVenta: pv,
    numero,
    fecha: fechaIso(f.fecha),
    contraparte: {
      cuit: doc && (Number(f.doc_tipo) === 80 || /^\d{11}$/.test(doc)) ? doc : null,
      documento: doc,
      tipoDocumento: num(f.doc_tipo),
      nombre: f.contraparte || null,
    },
    importes: { total: num(f.total), netoGravado: num(f.neto_gravado), noGravado: num(f.no_gravado), exento: num(f.exento), iva: num(f.iva) },
    moneda: f.moneda || null,
    cotizacion: num(f.tipo_cambio),
    cae: f.cae || null,
  };
  if (hasta != null && hasta !== numero) out.numeroHasta = hasta;
  return out;
}

/** SQL y parámetros de una página (pide una fila de más para saber si hay otra). */
function consulta(cuit, f) {
  const { where, vals } = condicionesListado(cuit, f);
  let cond = where;
  if (f.cursor) {
    vals.push(f.cursor.fecha, f.cursor.id);
    cond += ` AND (COALESCE(fecha, ${SIN_FECHA}), id) < ($${vals.length - 1}::date, $${vals.length})`;
  }
  vals.push(f.limite + 1);
  const sql = `SELECT * FROM mc_comprobantes WHERE ${cond} ORDER BY COALESCE(fecha, ${SIN_FECHA}) DESC, id DESC LIMIT $${vals.length}`;
  return { sql, vals };
}

function mensajeVacio(f) {
  const que = f.tipo ? `comprobantes ${f.tipo}s` : 'comprobantes';
  if (f.desde && f.hasta) return `No hay ${que} descargados entre ${f.desde} y ${f.hasta}.`;
  if (f.desde) return `No hay ${que} descargados desde ${f.desde}.`;
  if (f.hasta) return `No hay ${que} descargados hasta ${f.hasta}.`;
  return `No hay ${que} descargados con esos filtros.`;
}

/** Una página: { cantidad, comprobantes, siguiente, mensaje? }. */
async function listar(cuit, f, { query = (...a) => require('../db').query(...a) } = {}) {
  const { sql, vals } = consulta(cuit, f);
  const { rows } = await query(sql, vals);
  const pagina = rows.slice(0, f.limite);
  const out = {
    cantidad: pagina.length,
    comprobantes: pagina.map(item),
    siguiente: rows.length > f.limite ? codificarCursor(pagina[pagina.length - 1]) : null,
  };
  if (!pagina.length && !f.cursor) out.mensaje = mensajeVacio(f);
  return out;
}

/** Los filtros aplicados, para devolverlos junto con la página. */
function filtrosVisibles(f) {
  return {
    tipo: f.tipo ? `${f.tipo}s` : null, desde: f.desde || null, hasta: f.hasta || null,
    cuit: f.contraparte || null, tipoCbte: f.cbte || null, limite: f.limite,
  };
}

module.exports = {
  normalizarFiltros, item, codificarCursor, leerCursor, consulta, listar, filtrosVisibles,
  NOMBRES, LIMITE_DEFECTO, LIMITE_MAXIMO,
};
