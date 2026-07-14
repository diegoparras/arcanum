'use strict';

// Datos fiscales del EMISOR, por CUIT (van en el encabezado legal del PDF).
// Se guardan en la DB (tenants.emisor, JSONB) y se editan desde la UI, en vez de
// un JSON estatico que obligue a redeployar. Si un CUIT no tiene datos cargados,
// se cae al emisor global por env (ARCANUM_EMISOR_*) y, en ultima instancia, al CUIT.

const db = require('../db');
const { config } = require('../config');
const { normalizeCuit } = require('../auth/tenants');

const CAMPOS = ['razonSocial', 'nombreFantasia', 'domicilio', 'condicionIva', 'iibb', 'inicioActividades', 'mipyme'];

function sanear(e = {}) {
  const out = {};
  for (const k of CAMPOS) {
    if (e[k] === undefined || e[k] === null) continue;
    out[k] = k === 'mipyme' ? !!e[k] : String(e[k]).slice(0, 200);
  }
  if (out.condicionIva) out.condicionIva = out.condicionIva.toUpperCase();
  return out;
}

/** Devuelve los datos del emisor para un CUIT (DB -> env global -> vacio). */
async function get(cuit, entorno = config.env) {
  const c = normalizeCuit(cuit);
  let fila = null;
  try {
    const r = await db.query('SELECT emisor FROM tenants WHERE cuit=$1 AND entorno=$2', [c, entorno]);
    fila = r.rows[0] && r.rows[0].emisor;
  } catch {
    fila = null;
  }
  const global = config.emisor || {};
  // El del tenant pisa al global campo por campo (no todo-o-nada).
  const merged = { ...global, ...(fila || {}) };
  const tieneAlgo = CAMPOS.some((k) => merged[k]);
  return tieneAlgo ? merged : {};
}

/** Guarda/actualiza los datos fiscales de un emisor. */
async function set(cuit, emisor, entorno = config.env) {
  const c = normalizeCuit(cuit);
  const data = sanear(emisor);
  const r = await db.query(
    'UPDATE tenants SET emisor=$1, updated_at=now() WHERE cuit=$2 AND entorno=$3 RETURNING cuit',
    [JSON.stringify(data), c, entorno],
  );
  if (!r.rows.length) {
    throw Object.assign(new Error(`No existe el cliente ${c} en ${entorno}`), { httpStatus: 404 });
  }
  return data;
}

module.exports = { get, set, CAMPOS };
