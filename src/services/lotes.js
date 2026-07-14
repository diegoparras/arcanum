'use strict';

// Facturador masivo: lotes de solicitudes con seguimiento y "semaforo" de aging.
//   - Cargas un lote (JSON o CSV): una fila por profesional/cliente a facturar.
//   - Cada item tiene un estado: pendiente -> (emitido | recibido | rechazado).
//   - "Emitir" saca el CAE por WSFEv1 en el acto; "recibido" registra que el
//     profesional emitio y te mando su comprobante; "solicitar" manda el mail.
//   - El aging (dias pendiente) da verde (<5) / amarillo (5-15) / rojo (>15).
//
// Mejora sobre un facturador que solo trackea: la emision es real (nuestro WSFEv1)
// y el numero de comprobante se resuelve solo (ultimo autorizado + 1).

const db = require('../db');
const wsfev1 = require('./wsfev1');
const mailer = require('./mailer');
const { config } = require('../config');
const { normalizeCuit } = require('../auth/tenants');

const ESTADOS = ['pendiente', 'solicitado', 'emitido', 'recibido', 'rechazado'];

function aging(item) {
  if (['emitido', 'recibido', 'rechazado'].includes(item.estado)) return { semaforo: null, dias: null };
  const ref = item.solicitado_at || item.created_at;
  const dias = Math.max(0, Math.floor((Date.now() - new Date(ref).getTime()) / 86400000));
  const semaforo = dias < 5 ? 'VERDE' : dias <= 15 ? 'AMARILLO' : 'ROJO';
  return { semaforo, dias };
}

function n(x) { if (x === '' || x === null || x === undefined) return null; const v = Number(x); return Number.isFinite(v) ? v : null; }
function pInt(x) { if (x === '' || x === null || x === undefined) return null; const v = parseInt(x, 10); return Number.isFinite(v) ? v : null; }

// Infiere el id de alicuota IVA de ARCA desde la tasa (o usa el explicito).
function alicuotaId(neto, iva, explicit) {
  if (explicit != null) return parseInt(explicit, 10);
  if (!(iva > 0) || !(neto > 0)) return 5;
  const pct = Math.round((iva / neto) * 1000) / 10;
  const M = { 0: 3, 2.5: 9, 5: 8, 10.5: 4, 21: 5, 27: 6 };
  return M[pct] != null ? M[pct] : 5;
}

/** CUIT dueno de un lote (para chequear authz por CUIT antes de operar). */
async function cuitDe(loteId) {
  const r = await db.query('SELECT cuit FROM lotes WHERE id=$1', [loteId]);
  if (!r.rows.length) throw Object.assign(new Error('Lote no encontrado'), { httpStatus: 404 });
  return r.rows[0].cuit;
}

// CSV: cabecera con nombre,cuit,docTipo,docNro,email,concepto,periodo,tipoComprobante,puntoVenta,importeNeto,importeIva,importeTotal
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = lines[0].split(sep).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(sep);
    const o = {};
    head.forEach((h, i) => { o[h] = (cols[i] || '').trim(); });
    return o;
  });
}

function normItem(raw) {
  return {
    nombre: raw.nombre || raw.razonSocial || null,
    cuit: raw.cuit ? normalizeCuit(raw.cuit) : null,
    doc_tipo: pInt(raw.docTipo) != null ? pInt(raw.docTipo) : (raw.cuit ? 80 : 99),
    doc_nro: raw.docNro != null ? String(raw.docNro) : (raw.cuit ? normalizeCuit(raw.cuit) : '0'),
    email: raw.email || null,
    concepto: pInt(raw.concepto) != null ? pInt(raw.concepto) : 1,
    periodo: raw.periodo || null,
    tipo_comprobante: pInt(raw.tipoComprobante),
    punto_venta: pInt(raw.puntoVenta),
    importe_neto: n(raw.importeNeto),
    importe_iva: n(raw.importeIva),
    importe_total: n(raw.importeTotal),
  };
}

/** Crea un lote con sus items (desde JSON {items:[...]} o CSV). */
async function crear(cuit, { nombre, perfil, items, csv }) {
  const c = normalizeCuit(cuit);
  const filas = (Array.isArray(items) ? items : csv ? parseCsv(csv) : []).map(normItem).filter((i) => i.importe_total != null || i.cuit || i.nombre);
  if (!filas.length) throw Object.assign(new Error('El lote no tiene items (pasa `items[]` o `csv`)'), { httpStatus: 422 });
  return db.tx(async (client) => {
    const lote = (await client.query('INSERT INTO lotes (cuit, entorno, nombre, perfil) VALUES ($1,$2,$3,$4) RETURNING *',
      [c, config.env, nombre || 'Lote', perfil === 'asociacion' ? 'asociacion' : 'pyme'])).rows[0];
    for (const it of filas) {
      await client.query(
        `INSERT INTO lote_items (lote_id, nombre, cuit, doc_tipo, doc_nro, email, concepto, periodo,
           tipo_comprobante, punto_venta, importe_neto, importe_iva, importe_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [lote.id, it.nombre, it.cuit, it.doc_tipo, it.doc_nro, it.email, it.concepto, it.periodo,
          it.tipo_comprobante, it.punto_venta, it.importe_neto, it.importe_iva, it.importe_total],
      );
    }
    return { ...lote, items: filas.length };
  });
}

function resumen(items) {
  const r = { total: items.length, pendientes: 0, emitidos: 0, recibidos: 0, rechazados: 0, rojo: 0, amarillo: 0, verde: 0 };
  for (const it of items) {
    if (it.estado === 'emitido') r.emitidos++;
    else if (it.estado === 'recibido') r.recibidos++;
    else if (it.estado === 'rechazado') r.rechazados++;
    else {
      r.pendientes++;
      const a = aging(it);
      if (a.semaforo === 'ROJO') r.rojo++; else if (a.semaforo === 'AMARILLO') r.amarillo++; else r.verde++;
    }
  }
  return r;
}

/** Lista los lotes del entorno con su resumen de aging. */
async function listar(cuit) {
  const rows = (await db.query(
    `SELECT l.*, coalesce(json_agg(json_build_object('estado',i.estado,'created_at',i.created_at,'solicitado_at',i.solicitado_at))
       FILTER (WHERE i.id IS NOT NULL), '[]') AS items
     FROM lotes l LEFT JOIN lote_items i ON i.lote_id=l.id
     WHERE l.entorno=$1 ${cuit ? 'AND l.cuit=$2' : ''}
     GROUP BY l.id ORDER BY l.created_at DESC`,
    cuit ? [config.env, normalizeCuit(cuit)] : [config.env],
  )).rows;
  return rows.map((l) => ({ id: l.id, cuit: l.cuit, nombre: l.nombre, perfil: l.perfil, created_at: l.created_at, resumen: resumen(l.items) }));
}

/** Detalle de un lote con cada item + su aging. */
async function detalle(id) {
  const lote = (await db.query('SELECT * FROM lotes WHERE id=$1', [id])).rows[0];
  if (!lote) throw Object.assign(new Error('Lote no encontrado'), { httpStatus: 404 });
  const items = (await db.query('SELECT * FROM lote_items WHERE lote_id=$1 ORDER BY id', [id])).rows
    .map((it) => ({ ...it, aging: aging(it) }));
  return { ...lote, items, resumen: resumen(items) };
}

async function getItem(loteId, itemId) {
  const it = (await db.query('SELECT * FROM lote_items WHERE id=$1 AND lote_id=$2', [itemId, loteId])).rows[0];
  if (!it) throw Object.assign(new Error('Item no encontrado'), { httpStatus: 404 });
  return it;
}

/** Emite el comprobante de un item por WSFEv1 y guarda el CAE. */
async function emitirItem(loteId, itemId, extra = {}) {
  const lote = (await db.query('SELECT * FROM lotes WHERE id=$1', [loteId])).rows[0];
  if (!lote) throw Object.assign(new Error('Lote no encontrado'), { httpStatus: 404 });
  const it = await getItem(loteId, itemId);
  if (it.estado === 'emitido') return { ...it, yaEmitido: true };

  const tipo = it.tipo_comprobante || extra.tipoComprobante;
  const pv = it.punto_venta || extra.puntoVenta;
  if (!tipo || !pv) throw Object.assign(new Error('El item necesita tipoComprobante y puntoVenta'), { httpStatus: 422 });
  // Si solo se cargo el total (caso tipico Factura C / monotributo), el neto = total
  // y no hay IVA. Si vino el desglose, se respeta.
  const total = Number(it.importe_total ?? 0);
  let neto = it.importe_neto != null ? Number(it.importe_neto) : null;
  let iva = it.importe_iva != null ? Number(it.importe_iva) : null;
  if (neto == null && iva == null) { neto = total; iva = 0; }
  else { neto = neto ?? 0; iva = iva ?? 0; }

  const inv = {
    puntoVenta: pv,
    tipoComprobante: tipo,
    concepto: it.concepto || 1,
    tipoDocReceptor: it.doc_tipo || 99,
    nroDocReceptor: it.doc_nro || '0',
    condicionIvaReceptor: extra.condicionIvaReceptor,
    importeNeto: neto,
    importeIva: iva,
    importeTotal: total,
    alicuotasIva: iva > 0 ? [{ id: alicuotaId(neto, iva, it.alicuota_id ?? extra.alicuotaId), baseImponible: neto, importe: iva }] : [],
    idempotencyKey: `lote-${loteId}-item-${itemId}`,
    receptorNombre: it.nombre,
  };
  const r = await wsfev1.authorizeInvoice(lote.cuit, inv);
  if (!r.aprobado) throw Object.assign(new Error('ARCA rechazo la emision: ' + (r.errores?.[0]?.message || r.observaciones?.[0]?.message || 'ver detalle')), { httpStatus: 422, extra: r });
  await db.query(
    `UPDATE lote_items SET estado='emitido', cae=$1, numero=$2, cae_vto=to_date($3,'YYYYMMDD'), resuelto_at=now() WHERE id=$4`,
    [r.cae, r.numero, r.caeVencimiento, itemId],
  );
  return { ...it, estado: 'emitido', cae: r.cae, numero: r.numero, comprobante: r };
}

/** Emite TODOS los pendientes de un lote (best-effort, informa por item). */
async function emitirLote(loteId, extra = {}) {
  const { items } = await detalle(loteId);
  const pend = items.filter((i) => i.estado === 'pendiente' || i.estado === 'solicitado');
  const resultados = [];
  for (const it of pend) {
    try {
      const r = await emitirItem(loteId, it.id, extra);
      resultados.push({ id: it.id, ok: true, cae: r.cae, numero: r.numero });
    } catch (e) {
      resultados.push({ id: it.id, ok: false, error: e.message });
    }
  }
  return { total: pend.length, emitidos: resultados.filter((r) => r.ok).length, resultados };
}

/** Marca un item como "recibido" (el profesional emitio y te mando su comprobante). */
async function marcarRecibido(loteId, itemId, datos = {}) {
  await getItem(loteId, itemId);
  await db.query(
    'UPDATE lote_items SET estado=$1, cae=$2, numero=$3, nota=$4, resuelto_at=now() WHERE id=$5 AND lote_id=$6',
    [datos.estado === 'rechazado' ? 'rechazado' : 'recibido', datos.cae || null, datos.numero || null, datos.nota || null, itemId, loteId],
  );
  return getItem(loteId, itemId);
}

/** Manda el mail de solicitud al profesional y marca la fecha. */
async function solicitarItem(loteId, itemId) {
  const it = await getItem(loteId, itemId);
  if (!it.email) throw Object.assign(new Error('El item no tiene email'), { httpStatus: 422 });
  await mailer.send(
    it.email,
    `Solicitud de comprobante${it.periodo ? ' — ' + it.periodo : ''}`,
    `Hola ${it.nombre || ''},\n\nTe solicitamos el comprobante correspondiente${it.periodo ? ' al periodo ' + it.periodo : ''}${it.importe_total ? ' por $' + Number(it.importe_total).toFixed(2) : ''}.\n\nGracias.`,
  );
  await db.query("UPDATE lote_items SET estado=CASE WHEN estado='pendiente' THEN 'solicitado' ELSE estado END, solicitado_at=now() WHERE id=$1", [itemId]);
  return getItem(loteId, itemId);
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function exportCsv(loteId) {
  const { items } = await detalle(loteId);
  const cols = ['id', 'nombre', 'cuit', 'estado', 'periodo', 'importe_total', 'cae', 'numero', 'diasPendiente', 'semaforo'];
  const lines = [cols.join(',')];
  for (const it of items) {
    lines.push([it.id, it.nombre, it.cuit, it.estado, it.periodo, it.importe_total, it.cae, it.numero, it.aging.dias ?? '', it.aging.semaforo ?? ''].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

module.exports = { crear, listar, detalle, emitirItem, emitirLote, marcarRecibido, solicitarItem, exportCsv, aging, cuitDe, ESTADOS };
