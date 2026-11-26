'use strict';

// Analisis de lo bajado de Mis Comprobantes: totales, comparacion con el periodo anterior,
// evolucion por mes, principales clientes y proveedores, tipos de comprobante y subtotales por
// mes y contraparte. Funcion pura sobre las filas de mc_comprobantes: la ruta trae las filas del
// periodo (y del anterior) y esto calcula; asi se prueba sin base de datos.
//
// Importes en pesos: total * tipo_cambio, con signo (las notas de credito restan). "Neto" es
// total - IVA, que vale igual para A, B y C (en C el IVA viene en cero).

const { conSigno, esNotaCredito, esNotaDebito } = require('./tiposCbte');

const DIA = 86400000;
const TOP = 5;

function iso(d) { return d.toISOString().slice(0, 10); }
function fechaIso(v) {
  if (!v) return null;
  if (v instanceof Date) return iso(v);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function dia(s) { return new Date(`${s}T00:00:00Z`); }
const r2 = (n) => Math.round(n * 100) / 100;
function plano(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

/** Los ultimos 12 meses completos: del 1 del mes de hace 11 meses hasta hoy. */
function periodoPorDefecto(hoy = new Date()) {
  const desde = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 11, 1));
  return { desde: iso(desde), hasta: iso(hoy) };
}

/** El periodo de la misma cantidad de dias que termina el dia antes de `desde`. */
function periodoAnterior({ desde, hasta }) {
  const dias = Math.round((dia(hasta) - dia(desde)) / DIA) + 1;
  const h = new Date(dia(desde).getTime() - DIA);
  return { desde: iso(new Date(h.getTime() - (dias - 1) * DIA)), hasta: iso(h) };
}

function mesesEntre(desde, hasta) {
  const out = [];
  let a = Number(desde.slice(0, 4));
  let m = Number(desde.slice(5, 7));
  const fin = hasta.slice(0, 7);
  for (;;) {
    const k = `${a}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= fin || out.length >= 240) break;
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return out;
}

function pasaTexto(f, q) {
  const t = plano(q).trim();
  if (!t) return true;
  if (plano(f.contraparte).includes(t)) return true;
  const digitos = t.replace(/\D/g, '');
  return digitos.length >= 3 && String(f.doc_nro || '').includes(digitos);
}

/** Fila -> importes en pesos con signo, o null si no pasa los filtros. */
function preparar(f, filtros) {
  const fecha = fechaIso(f.fecha);
  if (!fecha) return null;
  const tipo = f.tipo === 'recibido' ? 'recibido' : 'emitido';
  if (filtros.tipo && filtros.tipo !== tipo) return null;
  const cbte = Number(f.cbte_tipo);
  if (filtros.cbte && cbte !== Number(filtros.cbte)) return null;
  if (filtros.clase === 'nc' && !esNotaCredito(cbte)) return null;
  if (filtros.clase === 'nd' && !esNotaDebito(cbte)) return null;
  if (filtros.clase === 'facturas' && (esNotaCredito(cbte) || esNotaDebito(cbte))) return null;
  const docNro = String(f.doc_nro || '');
  if (filtros.contraparte && docNro !== String(filtros.contraparte)) return null;
  if (filtros.q && !pasaTexto(f, filtros.q)) return null;
  const tc = Number(f.tipo_cambio) > 0 ? Number(f.tipo_cambio) : 1;
  const total = conSigno(cbte, Number(f.total || 0) * tc);
  const iva = conSigno(cbte, Number(f.iva || 0) * tc);
  return { fecha, mes: fecha.slice(0, 7), tipo, cbte, docNro, nombre: String(f.contraparte || '').trim(), total, iva, neto: total - iva };
}

function ranking(filas) {
  const por = new Map();
  for (const f of filas) {
    const k = f.docNro || f.nombre;
    const x = por.get(k) || { docNro: f.docNro, nombre: f.nombre, total: 0, cantidad: 0 };
    x.total += f.total;
    x.cantidad += 1;
    if (!x.nombre && f.nombre) x.nombre = f.nombre;
    por.set(k, x);
  }
  const todos = [...por.values()].map((x) => ({ ...x, total: r2(x.total) })).sort((a, b) => b.total - a.total);
  const items = todos.slice(0, TOP);
  const resto = todos.slice(TOP);
  const general = todos.reduce((s, x) => s + x.total, 0);
  return {
    items,
    otros: { total: r2(resto.reduce((s, x) => s + x.total, 0)), cantidad: resto.reduce((s, x) => s + x.cantidad, 0), contrapartes: resto.length },
    concentracion: items.length && general > 0 ? +(items[0].total / general).toFixed(4) : null,
  };
}

function agruparSubtotales(filas) {
  const grupos = new Map();
  for (const f of filas) {
    const k = `${f.mes}|${f.tipo}`;
    const g = grupos.get(k) || { mes: f.mes, tipo: f.tipo, cantidad: 0, neto: 0, iva: 0, total: 0, por: new Map() };
    g.cantidad += 1; g.neto += f.neto; g.iva += f.iva; g.total += f.total;
    const ck = f.docNro || f.nombre;
    const x = g.por.get(ck) || { docNro: f.docNro, nombre: f.nombre, cantidad: 0, neto: 0, iva: 0, total: 0 };
    x.cantidad += 1; x.neto += f.neto; x.iva += f.iva; x.total += f.total;
    g.por.set(ck, x);
    grupos.set(k, g);
  }
  const redondear = (x) => ({ ...x, neto: r2(x.neto), iva: r2(x.iva), total: r2(x.total) });
  return [...grupos.values()]
    .sort((a, b) => (a.mes === b.mes ? (a.tipo === 'emitido' ? -1 : 1) : a.mes < b.mes ? 1 : -1))
    .map(({ por, ...g }) => ({ ...redondear(g), contrapartes: [...por.values()].map(redondear).sort((a, b) => b.total - a.total) }));
}

/**
 * filas: mc_comprobantes del periodo y del anterior. opciones: { desde, hasta, tipo, clase,
 * cbte, contraparte, q }. Devuelve todo lo que muestra la vista Analisis.
 */
function analizar(filas, opciones = {}) {
  const periodo = { desde: opciones.desde, hasta: opciones.hasta };
  const anterior = periodoAnterior(periodo);
  const filtros = { tipo: opciones.tipo, clase: opciones.clase, cbte: opciones.cbte, contraparte: opciones.contraparte, q: opciones.q };
  const dentro = [];
  const antes = [];
  for (const f of filas || []) {
    const p = preparar(f, filtros);
    if (!p) continue;
    if (p.fecha >= periodo.desde && p.fecha <= periodo.hasta) dentro.push(p);
    else if (p.fecha >= anterior.desde && p.fecha <= anterior.hasta) antes.push(p);
  }
  const em = dentro.filter((f) => f.tipo === 'emitido');
  const re = dentro.filter((f) => f.tipo === 'recibido');
  const suma = (l, k) => r2(l.reduce((s, f) => s + f[k], 0));

  const facturado = suma(em, 'total');
  const comprado = suma(re, 'total');
  const facturadoAnterior = suma(antes.filter((f) => f.tipo === 'emitido'), 'total');
  const compradoAnterior = suma(antes.filter((f) => f.tipo === 'recibido'), 'total');
  const kpis = {
    facturado,
    facturadoAnterior,
    variacion: facturadoAnterior > 0 ? +((facturado - facturadoAnterior) / facturadoAnterior).toFixed(4) : null,
    notasCredito: r2(em.filter((f) => esNotaCredito(f.cbte)).reduce((s, f) => s - f.total, 0)) || 0,
    comprado,
    compradoAnterior,
    ivaDebito: suma(em, 'iva'),
    ivaCredito: suma(re, 'iva'),
    resultado: r2(facturado - comprado),
    cantEmitidos: em.length,
    cantRecibidos: re.length,
  };

  const porMes = mesesEntre(periodo.desde, periodo.hasta).map((mes) => {
    const e = em.filter((f) => f.mes === mes);
    const r = re.filter((f) => f.mes === mes);
    return { mes, emitido: suma(e, 'total'), recibido: suma(r, 'total'), cantEmitidos: e.length, cantRecibidos: r.length };
  });

  const tipos = new Map();
  for (const f of dentro) {
    const k = `${f.tipo}-${f.cbte}`;
    const x = tipos.get(k) || { tipo: f.tipo, cbteTipo: f.cbte, cantidad: 0, total: 0 };
    x.cantidad += 1;
    x.total += f.total;
    tipos.set(k, x);
  }
  const porTipo = [...tipos.values()].map((x) => ({ ...x, total: r2(x.total) }))
    .sort((a, b) => (a.tipo === b.tipo ? a.cbteTipo - b.cbteTipo : a.tipo === 'emitido' ? -1 : 1));

  return {
    periodo,
    anterior,
    kpis,
    porMes,
    clientes: ranking(em),
    proveedores: ranking(re),
    porTipo,
    subtotales: agruparSubtotales(dentro),
    total: { cantidad: dentro.length, neto: suma(dentro, 'neto'), iva: suma(dentro, 'iva'), total: suma(dentro, 'total') },
  };
}

module.exports = { analizar, periodoPorDefecto, periodoAnterior };
