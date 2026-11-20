'use strict';

// Constatacion masiva de comprobantes RECIBIDOS: que ARCA confirme que existen tal como dicen
// (WSCDC) y que el emisor no este en la base de apocrifos (WSAPOC). Sirve para no computar IVA
// de facturas truchas.
//
// Entradas: una lista (JSON), un CSV (formato propio o el de Mis Comprobantes recibidos), o
// "los recibidos de Mis Comprobantes que todavia no se constataron" de un CUIT.
// Secuencial con pausa: WSCDC no es para rafagas.

const { parsearCsv, normalizarFila, _numero: numero } = require('./mcParser');

const MAX_ITEMS = 500;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function ymd(f) {
  const s = String(f || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  if (/^\d{8}$/.test(s)) return s;
  const d = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return d ? `${d[3]}${d[2]}${d[1]}` : s;
}

function isoDe(f) {
  if (f instanceof Date) return f.toISOString().slice(0, 10);
  const s = ymd(f);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** Fila de mc_comprobantes (recibido) -> item a constatar. El emisor es la contraparte. */
function itemDesdeMc(f) {
  return {
    cuitEmisor: String(f.doc_nro || ''),
    puntoVenta: Number(f.punto_venta),
    tipoComprobante: Number(f.cbte_tipo),
    numero: Number(f.numero_desde),
    fecha: isoDe(f.fecha),
    importeTotal: Number(f.total),
    cae: f.cae ? String(f.cae) : null,
    docTipo: 80,
    docNro: String(f.cuit),
  };
}

/** CSV -> items. Acepta el formato propio (cuitEmisor;puntoVenta;tipo;numero;fecha;importe;cae)
 *  o el CSV de Mis Comprobantes recibidos. `cuitReceptor` es quien recibio los comprobantes. */
function parsearListaCsv(texto, cuitReceptor) {
  const filas = parsearCsv(texto);
  const clave = (h) => String(h).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return filas.map((f) => {
    const k = Object.fromEntries(Object.entries(f).map(([h, v]) => [clave(h), v]));
    if (k.cuitemisor) {
      return {
        cuitEmisor: String(k.cuitemisor).replace(/\D/g, ''),
        puntoVenta: Number(String(k.puntoventa || k.puntodeventa || '').replace(/\D/g, '')),
        tipoComprobante: Number(String(k.tipo || k.tipocomprobante || '').match(/\d+/)?.[0]),
        numero: Number(String(k.numero || '').replace(/\D/g, '')),
        fecha: isoDe(k.fecha),
        importeTotal: numero(k.importe || k.importetotal || k.total),
        cae: String(k.cae || k.codautorizacion || '').replace(/\D/g, '') || null,
        docTipo: 80,
        docNro: String(cuitReceptor),
      };
    }
    const n = normalizarFila(f, 'recibido');
    return {
      cuitEmisor: n.docNro, puntoVenta: n.puntoVenta, tipoComprobante: n.cbteTipo, numero: n.numeroDesde,
      fecha: n.fecha, importeTotal: n.total, cae: n.cae, docTipo: 80, docNro: String(cuitReceptor),
    };
  }).filter((it) => it.cuitEmisor && it.tipoComprobante && it.numero);
}

function depsPorDefecto() {
  const { config } = require('../config');
  return {
    constatar: (consultante, it) => require('./importar').constatar(consultante, it),
    apoc: (consultante, emisor) => require('./apoc').consultar(consultante, emisor, config.env),
  };
}

/** Constata una lista. Un error en un item no corta el resto: queda con valido=null y su error. */
async function constatarLista(cuitConsultante, items, { pausaMs = 400, deps = depsPorDefecto() } = {}) {
  if (!Array.isArray(items) || !items.length) throw err('La lista de comprobantes esta vacia', 400);
  if (items.length > MAX_ITEMS) throw err(`Hasta ${MAX_ITEMS} comprobantes por pedido`, 413);
  const apocPorEmisor = new Map();
  const resultados = [];
  for (const [i, it] of items.entries()) {
    const fila = { ...it };
    try {
      const r = await deps.constatar(cuitConsultante, { ...it, fecha: ymd(it.fecha) });
      Object.assign(fila, { valido: r.valido, resultado: r.resultado, observaciones: r.observaciones || [] });
    } catch (e) {
      Object.assign(fila, { valido: null, resultado: null, error: String(e.message || e).slice(0, 200) });
    }
    if (!apocPorEmisor.has(it.cuitEmisor)) {
      try {
        const a = await deps.apoc(cuitConsultante, it.cuitEmisor);
        apocPorEmisor.set(it.cuitEmisor, { consultado: true, esApocrifo: !!(a && a.esApocrifo), fechaCondicion: (a && a.fechaCondicion) || null });
      } catch {
        apocPorEmisor.set(it.cuitEmisor, { consultado: false, esApocrifo: null });
      }
    }
    fila.apoc = apocPorEmisor.get(it.cuitEmisor);
    resultados.push(fila);
    if (pausaMs && i < items.length - 1) await new Promise((r) => setTimeout(r, pausaMs));
  }
  return {
    cantidad: resultados.length,
    validos: resultados.filter((r) => r.valido === true).length,
    invalidos: resultados.filter((r) => r.valido === false).length,
    conError: resultados.filter((r) => r.valido === null).length,
    emisoresApocrifos: [...apocPorEmisor.values()].filter((a) => a.esApocrifo).length,
    resultados,
  };
}

/** Constata los recibidos de Mis Comprobantes que no se constataron y guarda el resultado. */
async function constatarRecibidos(cuit, { limite = 200, pausaMs = 400, deps } = {}) {
  const db = require('../db');
  const c = String(cuit || '').replace(/\D/g, '');
  const { rows } = await db.query(
    "SELECT * FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'recibido' AND constatacion IS NULL ORDER BY fecha DESC LIMIT $2",
    [c, Math.min(Number(limite) || 200, MAX_ITEMS)]);
  if (!rows.length) return { cantidad: 0, validos: 0, invalidos: 0, conError: 0, emisoresApocrifos: 0, pendientes: 0 };
  const r = await constatarLista(c, rows.map(itemDesdeMc), { pausaMs, ...(deps ? { deps } : {}) });
  for (const [i, res] of r.resultados.entries()) {
    if (res.valido === null) continue; // error transitorio: se reintenta la proxima vez
    await db.query('UPDATE mc_comprobantes SET constatacion = $2 WHERE id = $1', [rows[i].id, JSON.stringify({
      valido: res.valido, resultado: res.resultado, observaciones: res.observaciones, apoc: res.apoc, fecha: new Date().toISOString(),
    })]);
  }
  const { rows: pend } = await db.query(
    "SELECT count(*)::int AS n FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'recibido' AND constatacion IS NULL", [c]);
  const { resultados, ...resumen } = r;
  return { ...resumen, pendientes: pend[0].n, observados: resultados.filter((x) => x.valido === false || (x.apoc && x.apoc.esApocrifo)) };
}

/** Resumen de lo ya constatado (lo usa el MCP: no consulta a ARCA). */
async function resumenGuardado(cuit) {
  const db = require('../db');
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE constatacion IS NULL)::int AS pendientes,
            count(*) FILTER (WHERE (constatacion->>'valido') = 'true')::int AS validos,
            count(*) FILTER (WHERE (constatacion->>'valido') = 'false')::int AS invalidos,
            count(DISTINCT doc_nro) FILTER (WHERE (constatacion->'apoc'->>'esApocrifo') = 'true')::int AS emisores_apocrifos
       FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'recibido'`, [cuit]);
  const { rows: obs } = await db.query(
    `SELECT cbte_tipo, punto_venta, numero_desde, fecha, total, contraparte, doc_nro, constatacion
       FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'recibido'
        AND ((constatacion->>'valido') = 'false' OR (constatacion->'apoc'->>'esApocrifo') = 'true')
      ORDER BY fecha DESC LIMIT 50`, [cuit]);
  return { ...rows[0], observados: obs };
}

module.exports = { constatarLista, constatarRecibidos, parsearListaCsv, itemDesdeMc, resumenGuardado, MAX_ITEMS };
