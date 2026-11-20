'use strict';

// Topes de Monotributo con TODO lo facturado: Mis Comprobantes emitidos (incluye lo hecho por
// fuera de Arcanum) mas lo emitido por Arcanum que todavia no aparezca ahi (se cruza por CAE o
// por tipo + punto de venta + numero, asi nada se cuenta dos veces). Ventana movil de 12 meses.
//
// Los topes cambian dos veces por ano (se actualizan por IPC). La semilla trae los ultimos
// conocidos al escribir esto y se editan en vivo (superadmin) en settings 'monotributo_categorias'.
// La UI muestra la vigencia y pide verificar los topes vigentes.

const { conSigno } = require('./tiposCbte');

const CATEGORIAS_SEMILLA = {
  vigencia: '2025-08',
  fuente: 'semilla de Arcanum: verificar los topes vigentes en arca.gob.ar',
  topes: {
    A: 8992597.87, B: 13175201.52, C: 18473166.15, D: 22934610.05, E: 26977793.60, F: 33809379.57,
    G: 40431835.35, H: 61344853.64, I: 68664410.05, J: 78632948.76, K: 94805682.90,
  },
};

function iso(d) { return d.toISOString().slice(0, 10); }
function fechaIso(v) {
  if (!v) return null;
  if (v instanceof Date) return iso(v);
  const m = String(v).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Ventana [hasta - 12 meses + 1 dia, hasta]. */
function ventana(hasta) {
  const h = new Date(Date.UTC(hasta.getUTCFullYear(), hasta.getUTCMonth(), hasta.getUTCDate()));
  const d = new Date(Date.UTC(h.getUTCFullYear() - 1, h.getUTCMonth(), h.getUTCDate() + 1));
  return { desde: iso(d), hasta: iso(h) };
}

/**
 * filasMc: mc_comprobantes (se usan solo las emitidas). propios: tabla comprobantes de Arcanum.
 * Devuelve { total, desde, hasta, porMes, propiosSumados }.
 */
function calcularIngresos(filasMc, propios, hasta) {
  const v = ventana(hasta);
  const dentro = (f) => f && f >= v.desde && f <= v.hasta;
  const porMes = {};
  let total = 0;
  const caes = new Set();
  const claves = new Set();
  const sumar = (fecha, monto) => {
    total += monto;
    const mes = fecha.slice(0, 7);
    porMes[mes] = +((porMes[mes] || 0) + monto).toFixed(2);
  };
  for (const f of filasMc || []) {
    if (f.tipo !== 'emitido') continue;
    const fecha = fechaIso(f.fecha);
    if (f.cae) caes.add(String(f.cae));
    claves.add(`${Number(f.cbte_tipo)}-${Number(f.punto_venta)}-${Number(f.numero_desde)}`);
    if (!dentro(fecha)) continue;
    const tc = Number(f.tipo_cambio) > 0 ? Number(f.tipo_cambio) : 1;
    sumar(fecha, conSigno(f.cbte_tipo, Number(f.total) * tc));
  }
  let propiosSumados = 0;
  for (const p of propios || []) {
    const fecha = fechaIso(p.fecha);
    if (!dentro(fecha)) continue;
    if (p.cae && caes.has(String(p.cae))) continue;
    if (claves.has(`${Number(p.tipo_cbte)}-${Number(p.punto_venta)}-${Number(p.numero)}`)) continue;
    const tc = Number(p.cotizacion) > 0 ? Number(p.cotizacion) : 1;
    sumar(fecha, conSigno(p.tipo_cbte, Number(p.importe_total) * tc));
    propiosSumados += 1;
  }
  return { total: +total.toFixed(2), desde: v.desde, hasta: v.hasta, porMes, propiosSumados };
}

/** Semaforo contra la categoria. alerta: ok | 80 | 100 | sin_categoria. */
function evaluar(total, categoriaActual, categorias) {
  const topes = (categorias && categorias.topes) || {};
  const letras = Object.keys(topes).sort();
  const sugerida = letras.find((l) => topes[l] >= total) || null;
  const out = {
    categoria: categoriaActual || null,
    tope: null,
    usado: null,
    alerta: 'sin_categoria',
    categoriaSugerida: sugerida,
    excedeMaxima: !sugerida,
    margen: null,
  };
  const tope = categoriaActual ? topes[categoriaActual] : undefined;
  if (tope) {
    out.tope = tope;
    out.usado = +(total / tope).toFixed(4);
    out.margen = +(tope - total).toFixed(2);
    out.alerta = total > tope ? '100' : total >= tope * 0.8 ? '80' : 'ok';
  }
  return out;
}

/** Letra de categoria desde categoriaMonotributo de la constancia A5. */
function letraCategoria(cat) {
  if (!cat) return null;
  const d = String(cat.descripcionCategoria || '').trim().toUpperCase();
  let m = d.match(/^([A-K])(\s|$)/);
  if (m) return m[1];
  m = d.match(/CATEGORI[AÍ]\s+([A-K])\b/);
  return m ? m[1] : null;
}

// --- con base de datos ---------------------------------------------------------
async function categorias() {
  const db = require('../db');
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'monotributo_categorias'");
    if (rows[0] && rows[0].value) return JSON.parse(rows[0].value);
  } catch { /* primera vez */ }
  return CATEGORIAS_SEMILLA;
}

async function guardarCategorias(c, usuario) {
  const db = require('../db');
  const topes = c && c.topes;
  if (!topes || typeof topes !== 'object' || !Object.keys(topes).length) {
    throw Object.assign(new Error('Faltan los topes por categoria (topes: { A: ..., B: ... })'), { httpStatus: 400 });
  }
  const limpio = {};
  for (const [k, v] of Object.entries(topes)) {
    if (!/^[A-K]$/.test(k) || !(Number(v) > 0)) throw Object.assign(new Error(`Tope invalido para ${k}`), { httpStatus: 400 });
    limpio[k] = Number(v);
  }
  const valor = { vigencia: String(c.vigencia || '').slice(0, 20) || null, fuente: String(c.fuente || 'cargado a mano').slice(0, 200), topes: limpio };
  await db.query(
    "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('monotributo_categorias',$1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()",
    [JSON.stringify(valor), usuario || null]);
  return valor;
}

/** Categoria actual del padron A5 (necesita un CUIT con certificado para consultar). */
async function categoriaDelPadron(cuit) {
  const { config } = require('../config');
  const tenants = require('../auth/tenants');
  const padron = require('./padron');
  const lista = (await tenants.list(config.env)).filter((t) => t.tieneCertificado);
  if (!lista.length) return { letra: null, esMonotributo: null, motivo: 'No hay ningun CUIT con certificado para consultar el padron' };
  const repre = lista.find((t) => t.cuit === cuit) ? cuit : lista[0].cuit;
  const { datos } = await padron.consultarPersonaConMeta('a5', repre, cuit, {});
  const cat = datos && datos.datosMonotributo && datos.datosMonotributo.categoriaMonotributo;
  return { letra: letraCategoria(cat), esMonotributo: !!cat, descripcion: cat ? cat.descripcionCategoria || null : null };
}

async function topes(cuit, { categoria, hasta = new Date() } = {}) {
  const db = require('../db');
  const c = String(cuit || '').replace(/\D/g, '');
  if (c.length !== 11) throw Object.assign(new Error('CUIT invalido'), { httpStatus: 400 });
  let padron = { letra: null, esMonotributo: null };
  if (!categoria) {
    try { padron = await categoriaDelPadron(c); } catch (e) { padron = { letra: null, esMonotributo: null, motivo: e.message }; }
    if (padron.esMonotributo === false) return { cuit: c, aplica: false, motivo: 'El padron no lo muestra como monotributista' };
  }
  const v = ventana(hasta);
  const { rows: filas } = await db.query(
    "SELECT tipo, fecha, cbte_tipo, punto_venta, numero_desde, cae, total, tipo_cambio FROM mc_comprobantes WHERE cuit = $1 AND tipo = 'emitido' AND fecha >= ($2::date - interval '1 day')",
    [c, v.desde]);
  const { rows: propios } = await db.query(
    "SELECT tipo_cbte, punto_venta, numero, cae, fecha, importe_total, COALESCE(raw->>'cotizacion', raw->>'MonCotiz') AS cotizacion FROM comprobantes WHERE cuit = $1 AND entorno = 'prod' AND resultado = 'A' AND fecha >= $2::date",
    [c, v.desde]).catch(() => ({ rows: [] }));
  const ingresos = calcularIngresos(filas, propios, hasta);
  const cats = await categorias();
  const letra = categoria ? String(categoria).toUpperCase() : padron.letra;
  return {
    cuit: c,
    aplica: true,
    ingresos,
    ...evaluar(ingresos.total, letra, cats),
    categoriaDesde: categoria ? 'indicada' : padron.letra ? 'padron' : null,
    advertenciaPadron: padron.motivo || null,
    comprobantesMc: filas.length,
    vigenciaTopes: cats.vigencia || null,
    fuenteTopes: cats.fuente || null,
  };
}

/**
 * Aviso diario (daemon): webhook `tope_monotributo` cuando un CUIT cruza el 80% o el 100% de su
 * categoria (una vez por mes y nivel), y recordatorio de recategorizacion en enero y julio (una
 * vez por semestre). Las marcas de "ya avisado" viven en settings.
 */
async function revisarAvisos(cuits, deps = {}) {
  const db = require('../db');
  const {
    hoy = new Date(),
    calcular = (c) => topes(c),
    emitir = (e, p) => require('./webhooks').emitir(e, p),
    leerMarca = async (k) => (await db.query('SELECT value FROM settings WHERE key = $1', [k])).rows[0]?.value || null,
    guardarMarca = async (k, v) => db.query(
      'INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,\'daemon\',now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()', [k, v]),
  } = deps;
  const mes = iso(hoy).slice(0, 7);
  const semestre = hoy.getUTCMonth() === 0 || hoy.getUTCMonth() === 6 ? mes : null;
  for (const cuit of cuits) {
    let r;
    try { r = await calcular(cuit); } catch { continue; }
    if (!r || !r.aplica) continue;
    const base = { cuit, categoria: r.categoria, usado: r.usado, total: r.ingresos && r.ingresos.total, categoriaSugerida: r.categoriaSugerida || null };
    if (r.alerta === '80' || r.alerta === '100') {
      const k = `mono_aviso:${cuit}:${mes}:${r.alerta}`;
      if (!(await leerMarca(k))) {
        await emitir('tope_monotributo', { ...base, motivo: `tope_${r.alerta}` });
        await guardarMarca(k, iso(hoy));
      }
    }
    if (semestre) {
      const k = `mono_recat:${cuit}:${semestre}`;
      if (!(await leerMarca(k))) {
        await emitir('tope_monotributo', { ...base, motivo: 'recategorizacion' });
        await guardarMarca(k, iso(hoy));
      }
    }
  }
}

module.exports = { CATEGORIAS_SEMILLA, calcularIngresos, evaluar, letraCategoria, ventana, categorias, guardarCategorias, topes, revisarAvisos };
