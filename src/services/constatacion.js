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

// Variantes del receptor para reintentar un rechazo. WSCDC exige el documento del receptor tal como
// lo informo el emisor, y en una factura B o C a una persona muchos comercios la hacen a su CUIL
// (mismo numero, otro tipo: lo usan las aseguradoras), a su DNI o como consumidor final, no a su
// CUIT. El CSV de Mis Comprobantes no dice cual uso: si ARCA rechaza con el CUIT, se prueban esas
// (CUIL y DNI solo para CUIT de persona humana).
const PREFIJOS_PERSONA = ['20', '23', '24', '27'];
// Sube cuando cambian las variantes: los "NO CONSTA" guardados con un criterio anterior vuelven a
// quedar pendientes una sola vez (1 = CUIT, DNI y consumidor final; 2 = suma CUIL).
const CRITERIO = 2;
function variantesReceptor(it) {
  const doc = String(it.docNro || '').replace(/\D/g, '');
  if (Number(it.docTipo) !== 80 || doc.length !== 11) return [];
  const v = [];
  if (PREFIJOS_PERSONA.includes(doc.slice(0, 2))) {
    v.push({ como: 'CUIL', docTipo: 86, docNro: doc });
    v.push({ como: 'DNI', docTipo: 96, docNro: String(Number(doc.slice(2, 10))) });
  }
  v.push({ como: 'consumidor_final', docTipo: 99, docNro: '0' });
  return v;
}

/** Constata una lista. Un error en un item no corta el resto: queda con valido=null y su error.
 *  `antes(i)` y `alItem(fila, i)` permiten seguir el progreso y guardar cada resultado al toque.
 *  `detener()` se consulta antes de cada comprobante: si da true, corta ahi (lo hecho queda). */
async function constatarLista(cuitConsultante, items, { pausaMs = 400, deps = depsPorDefecto(), antes, alItem, detener } = {}) {
  if (!Array.isArray(items) || !items.length) throw err('La lista de comprobantes esta vacia', 400);
  if (items.length > MAX_ITEMS) throw err(`Hasta ${MAX_ITEMS} comprobantes por pedido`, 413);
  const apocPorEmisor = new Map();
  const resultados = [];
  const esperar = () => (pausaMs ? new Promise((r) => setTimeout(r, pausaMs)) : null);
  let detenida = false;
  for (const [i, it] of items.entries()) {
    if (detener && detener()) { detenida = true; break; }
    const fila = { ...it };
    if (antes) antes(i);
    try {
      const r = await deps.constatar(cuitConsultante, { ...it, fecha: ymd(it.fecha) });
      Object.assign(fila, { valido: r.valido, resultado: r.resultado, observaciones: r.observaciones || [] });
    } catch (e) {
      Object.assign(fila, { valido: null, resultado: null, error: String(e.message || e).slice(0, 200) });
    }
    if (fila.valido === false) {
      const variantes = variantesReceptor(it);
      if (variantes.length) fila.receptorProbado = ['CUIT'];
      for (const v of variantes) {
        await esperar();
        fila.receptorProbado.push(v.como);
        try {
          const r = await deps.constatar(cuitConsultante, { ...it, docTipo: v.docTipo, docNro: v.docNro, fecha: ymd(it.fecha) });
          if (r.valido) {
            Object.assign(fila, { valido: true, resultado: r.resultado, observaciones: r.observaciones || [],
              receptor: { como: v.como, docTipo: v.docTipo, docNro: v.docNro } });
            break;
          }
        } catch { /* una variante que falla no cambia el rechazo original */ }
      }
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
    if (alItem) await alItem(fila, i);
    if (i < items.length - 1) await esperar();
  }
  return {
    detenida,
    cantidad: resultados.length,
    validos: resultados.filter((r) => r.valido === true).length,
    invalidos: resultados.filter((r) => r.valido === false).length,
    conError: resultados.filter((r) => r.valido === null).length,
    emisoresApocrifos: [...apocPorEmisor.values()].filter((a) => a.esApocrifo).length,
    resultados,
  };
}

// ---- Constatar los recibidos de Mis Comprobantes en segundo plano -----------------------
// Uno por comprobante contra ARCA, con pausa: con cientos de recibidos son minutos, demasiado
// para un pedido HTTP (el proxy lo corta y la pantalla no muestra nada). Corre aparte, de a un
// trabajo por CUIT, guarda cada resultado apenas lo tiene (si se corta, lo hecho queda) y la UI
// consulta el progreso. Un error de ARCA no se guarda: ese comprobante sigue pendiente.

const trabajos = new Map();

function repoPorDefecto() {
  const db = require('../db');
  return {
    async pendientes(cuit, filtros, limite) {
      const { condicionesListado, filtrosExtra } = require('./misComprobantes');
      const f = filtrosExtra(filtros);
      for (const k of ['desde', 'hasta']) {
        if (!filtros[k]) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(filtros[k]))) throw err(`Fecha invalida: ${filtros[k]} (use AAAA-MM-DD)`, 400);
        f[k] = filtros[k];
      }
      const { where, vals } = condicionesListado(cuit, { ...f, tipo: 'recibido' });
      vals.push(limite);
      const { rows } = await db.query(
        `SELECT * FROM mc_comprobantes WHERE ${where} AND (constatacion IS NULL OR ((constatacion->>'valido') = 'false' AND COALESCE((constatacion->>'criterio')::int, 0) < ${CRITERIO})) ORDER BY fecha DESC, id DESC LIMIT $${vals.length}`, vals);
      return rows;
    },
    async guardar(id, constatacion) {
      await db.query('UPDATE mc_comprobantes SET constatacion = $2 WHERE id = $1', [id, JSON.stringify(constatacion)]);
    },
    async contarPendientes(cuit) {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'recibido' AND (constatacion IS NULL OR ((constatacion->>'valido') = 'false' AND COALESCE((constatacion->>'criterio')::int, 0) < ${CRITERIO}))`, [cuit]);
      return rows[0].n;
    },
  };
}

/** Lo que ve la UI: sin la promesa interna ni datos de mas. */
function foto(t) {
  if (!t) return null;
  const vista = Object.fromEntries(Object.entries(t).filter(([k]) => !['promesa', 'apocrifos', 'detener'].includes(k)));
  return { ...vista, emisoresApocrifos: t.apocrifos.size };
}

/**
 * Arranca la constatacion de los recibidos pendientes de `cuit` que pasan `filtros` (los mismos
 * del analisis: desde, hasta, contraparte, cbte, clase, q). Devuelve el estado inicial al toque.
 * 409 si ya hay una corriendo para ese CUIT.
 */
async function iniciarConstatacion(cuit, { filtros = {}, limite = MAX_ITEMS, pausaMs = 400, deps, repo = repoPorDefecto(), usuario } = {}) {
  const c = String(cuit || '').replace(/\D/g, '');
  const previo = trabajos.get(c);
  if (previo && previo.estado === 'corriendo') {
    throw Object.assign(err(`Ya se estan constatando los recibidos de este CUIT (${previo.hechos} de ${previo.total})`, 409), { constatacion: foto(previo) });
  }
  const filas = await repo.pendientes(c, filtros, Math.min(Number(limite) || MAX_ITEMS, MAX_ITEMS));
  const t = {
    estado: filas.length ? 'corriendo' : 'terminado', total: filas.length, hechos: 0,
    validos: 0, invalidos: 0, conError: 0, apocrifos: new Set(), actual: null, error: null, pendientes: null, detener: false, deteniendo: false,
    usuario: usuario || null, iniciada: new Date().toISOString(), terminada: filas.length ? null : new Date().toISOString(),
  };
  trabajos.set(c, t);
  if (!filas.length) {
    t.pendientes = await repo.contarPendientes(c).catch(() => null);
    t.promesa = Promise.resolve();
    return foto(t);
  }
  t.promesa = (async () => {
    try {
      const r = await constatarLista(c, filas.map(itemDesdeMc), {
        pausaMs,
        detener: () => t.detener,
        ...(deps ? { deps } : {}),
        antes: (i) => {
          const f = filas[i];
          t.actual = { comprobante: `${String(f.punto_venta).padStart(4, '0')}-${String(f.numero_desde).padStart(8, '0')}`, contraparte: f.contraparte || f.doc_nro || '' };
        },
        alItem: async (res, i) => {
          t.hechos = i + 1;
          if (res.valido === true) t.validos += 1;
          else if (res.valido === false) t.invalidos += 1;
          else t.conError += 1;
          if (res.apoc && res.apoc.esApocrifo) t.apocrifos.add(res.cuitEmisor);
          if (res.valido === null) return; // error transitorio: se reintenta la proxima vez
          await repo.guardar(filas[i].id, {
            valido: res.valido, resultado: res.resultado, observaciones: res.observaciones, apoc: res.apoc,
            ...(res.receptorProbado ? { receptorProbado: res.receptorProbado } : {}),
            criterio: CRITERIO,
            ...(res.receptor ? { receptor: res.receptor } : {}),
            fecha: new Date().toISOString(),
          });
        },
      });
      t.estado = r.detenida ? 'detenido' : 'terminado';
    } catch (e) {
      t.estado = 'error';
      t.error = String(e.message || e).slice(0, 300);
    }
    t.actual = null;
    t.terminada = new Date().toISOString();
    t.pendientes = await repo.contarPendientes(c).catch(() => null);
  })();
  return foto(t);
}

/**
 * Pide cortar la constatacion que esta corriendo para ese CUIT. Corta entre un comprobante y el
 * siguiente: lo constatado queda guardado y el resto sigue pendiente para la proxima vez.
 */
function detenerConstatacion(cuit) {
  const t = trabajos.get(String(cuit || '').replace(/\D/g, ''));
  if (!t || t.estado !== 'corriendo') throw err('No hay una constatacion corriendo para este CUIT', 409);
  t.detener = true;
  t.deteniendo = true;
  return foto(t);
}

/** Estado de la ultima constatacion de ese CUIT (corriendo o terminada), o null. */
function estadoConstatacion(cuit) {
  return foto(trabajos.get(String(cuit || '').replace(/\D/g, '')));
}

/** Para tests: espera a que termine la que esta corriendo. */
async function esperarConstatacion(cuit) {
  const t = trabajos.get(String(cuit || '').replace(/\D/g, ''));
  if (t && t.promesa) await t.promesa;
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

module.exports = { CRITERIO, constatarLista, iniciarConstatacion, detenerConstatacion, estadoConstatacion, esperarConstatacion, parsearListaCsv, itemDesdeMc, resumenGuardado, MAX_ITEMS };
