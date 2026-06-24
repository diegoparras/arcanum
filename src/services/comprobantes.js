'use strict';

// Consulta y export de comprobantes emitidos (lo que guardamos al obtener CAE).

const db = require('../db');
const { config } = require('../config');
const { normalizeCuit } = require('../auth/tenants');

async function get(cuit, ptoVta, tipo, numero, entorno = config.env) {
  const { rows } = await db.query(
    `SELECT * FROM comprobantes WHERE cuit=$1 AND entorno=$2 AND punto_venta=$3 AND tipo_cbte=$4 AND numero=$5`,
    [normalizeCuit(cuit), entorno, parseInt(ptoVta, 10), parseInt(tipo, 10), parseInt(numero, 10)],
  );
  return rows[0] || null;
}

async function list({ cuit, desde, hasta, limit = 200, entorno = config.env } = {}) {
  const cond = ['entorno = $1'];
  const params = [entorno];
  if (cuit) {
    params.push(normalizeCuit(cuit));
    cond.push(`cuit = $${params.length}`);
  }
  if (desde) {
    params.push(desde);
    cond.push(`fecha >= $${params.length}`);
  }
  if (hasta) {
    params.push(hasta);
    cond.push(`fecha <= $${params.length}`);
  }
  params.push(Math.min(parseInt(limit, 10) || 200, 5000));
  const { rows } = await db.query(
    `SELECT cuit, punto_venta, tipo_cbte, numero, cae, cae_vto, fecha, importe_total, doc_tipo, doc_nro, resultado, created_at
     FROM comprobantes WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportCsv(filters) {
  const rows = await list({ ...filters, limit: 5000 });
  const headers = ['cuit', 'punto_venta', 'tipo_cbte', 'numero', 'cae', 'cae_vto', 'fecha', 'importe_total', 'doc_tipo', 'doc_nro', 'resultado'];
  const lines = [headers.join(';')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h] instanceof Date ? r[h].toISOString().slice(0, 10) : r[h])).join(';'));
  }
  return lines.join('\n');
}

module.exports = { get, list, exportCsv };
