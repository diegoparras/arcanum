'use strict';

// Cache del Ticket de Acceso (Token + Sign) por CUIT + servicio + entorno, en
// Postgres. ARCA rechaza pedir un TA nuevo si el anterior sigue vigente, asi que
// reutilizamos hasta que falte poco para vencer. Los pedidos concurrentes de una
// instancia comparten un solo login (ver getOrCreate).

const db = require('../db');
const { config } = require('../config');

function lockKey(cuit, service, entorno) {
  return `${cuit}:${service}:${entorno}`;
}

async function read(cuit, service, entorno, client = db) {
  const { rows } = await client.query(
    'SELECT token, sign, generation_time, expiration_time FROM access_tickets WHERE cuit = $1 AND service = $2 AND entorno = $3',
    [cuit, service, entorno],
  );
  if (!rows.length) return null;
  const ta = rows[0];
  const expMs = new Date(ta.expiration_time).getTime();
  if (Number.isFinite(expMs) && Date.now() < expMs - config.tokenRenewMarginMs) {
    return {
      token: ta.token,
      sign: ta.sign,
      generationTime: ta.generation_time,
      expirationTime: ta.expiration_time,
      service,
      cuit,
    };
  }
  return null;
}

// Devuelve el TA cacheado mientras NO este vencido (ignora el margen de
// renovacion). Se usa como fallback cuando ARCA rechaza un re-login temprano.
async function readRaw(cuit, service, entorno) {
  const { rows } = await db.query(
    'SELECT token, sign, generation_time, expiration_time FROM access_tickets WHERE cuit = $1 AND service = $2 AND entorno = $3',
    [cuit, service, entorno],
  );
  if (!rows.length) return null;
  const ta = rows[0];
  if (new Date(ta.expiration_time).getTime() <= Date.now()) return null;
  return { token: ta.token, sign: ta.sign, generationTime: ta.generation_time, expirationTime: ta.expiration_time, service, cuit };
}

async function write(cuit, service, entorno, ta, client = db) {
  await client.query(
    `INSERT INTO access_tickets (cuit, service, entorno, token, sign, generation_time, expiration_time, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (cuit, service, entorno) DO UPDATE SET
       token = $4, sign = $5, generation_time = $6, expiration_time = $7, updated_at = now()`,
    [cuit, service, entorno, ta.token, ta.sign, ta.generationTime || null, ta.expirationTime],
  );
}

// Logins a WSAA en curso, por (cuit, service, entorno). Los pedidos concurrentes de esta instancia
// esperan el mismo login en vez de disparar otro.
const enCurso = new Map();

/**
 * Devuelve un TA vigente; si no hay, llama a `fetcher()` una sola vez por clave.
 *
 * El login a WSAA NO corre dentro de una transaccion (auditoria 2026-11-26, M-03): antes tenia
 * tomada una conexion del pool mientras esperaba a ARCA, y con ARCA lento 10 pedidos dejaban a
 * toda la aplicacion sin base. Si otra instancia pide el mismo TA a la vez, ARCA rechaza el
 * segundo login ("ya posee un TA valido") y wsaa.js usa el guardado (readRaw).
 */
async function getOrCreate(cuit, service, entorno, fetcher) {
  const cached = await read(cuit, service, entorno);
  if (cached) return cached;
  const clave = lockKey(cuit, service, entorno);
  if (enCurso.has(clave)) return enCurso.get(clave);
  const p = (async () => {
    const ta = await fetcher();
    await write(cuit, service, entorno, ta);
    return ta;
  })();
  enCurso.set(clave, p);
  try { return await p; } finally { enCurso.delete(clave); }
}

async function invalidate(cuit, service, entorno) {
  await db.query('DELETE FROM access_tickets WHERE cuit = $1 AND service = $2 AND entorno = $3', [cuit, service, entorno]);
}

module.exports = { getOrCreate, invalidate, read, readRaw };
