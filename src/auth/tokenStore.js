'use strict';

// Cache del Ticket de Acceso (Token + Sign) por CUIT + servicio + entorno, en
// Postgres. ARCA rechaza pedir un TA nuevo si el anterior sigue vigente, asi que
// reutilizamos hasta que falte poco para vencer. Para que dos requests (o dos
// instancias del contenedor) no disparen dos logins a la vez usamos advisory
// locks de Postgres: lock real, distribuido, no solo en memoria.

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

async function write(cuit, service, entorno, ta, client = db) {
  await client.query(
    `INSERT INTO access_tickets (cuit, service, entorno, token, sign, generation_time, expiration_time, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (cuit, service, entorno) DO UPDATE SET
       token = $4, sign = $5, generation_time = $6, expiration_time = $7, updated_at = now()`,
    [cuit, service, entorno, ta.token, ta.sign, ta.generationTime || null, ta.expirationTime],
  );
}

/**
 * Devuelve un TA vigente; si no hay, llama a `fetcher()` bajo advisory lock.
 */
async function getOrCreate(cuit, service, entorno, fetcher) {
  const cached = await read(cuit, service, entorno);
  if (cached) return cached;

  return db.tx(async (client) => {
    // Lock por (cuit, service, entorno): serializa el login concurrente.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(cuit, service, entorno)]);
    const again = await read(cuit, service, entorno, client);
    if (again) return again;
    const ta = await fetcher();
    await write(cuit, service, entorno, ta, client);
    return ta;
  });
}

async function invalidate(cuit, service, entorno) {
  await db.query('DELETE FROM access_tickets WHERE cuit = $1 AND service = $2 AND entorno = $3', [cuit, service, entorno]);
}

module.exports = { getOrCreate, invalidate, read };
