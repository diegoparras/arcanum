'use strict';

// Claves de API con rol, para integraciones (n8n, SecretarIA, scripts).
// - En la base se guarda solo el hash SHA-256: la clave en claro se muestra UNA vez,
//   al crearla. Son 192 bits aleatorios, asi que un hash rapido alcanza.
// - Cada clave tiene rol (lectura | operador | admin) y, opcionalmente, CUITs permitidos.
// - Se dan de baja de a una (revoked_at) sin tocar las demas ni la clave maestra.
// - Se aceptan en X-API-Key o en Authorization: Bearer <clave>.

const crypto = require('crypto');
const db = require('../db');
const { normalizeCuit } = require('./tenants');

const ROLES = ['lectura', 'operador', 'admin'];
const PREFIJO = 'ark_';

function hash(clave) {
  return crypto.createHash('sha256').update(String(clave)).digest('hex');
}

/** Clave presentada en el request: X-API-Key o Authorization: Bearer <clave>. */
function extraerClave(headers = {}) {
  const x = headers['x-api-key'];
  if (x && String(x).trim()) return String(x).trim();
  const m = String(headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : '';
}

function normCuits(lista) {
  if (!Array.isArray(lista)) return null;
  const out = lista.map((c) => normalizeCuit(c)).filter((c) => /^\d{11}$/.test(c));
  return out.length ? [...new Set(out)] : null;
}

function fmt(r) {
  return {
    id: r.id,
    nombre: r.nombre,
    rol: r.role,
    prefijo: r.prefix ? `${r.prefix}…` : null,
    cuits: r.cuit_allow && r.cuit_allow.length ? r.cuit_allow : null,
    creada: r.created_at,
    creadaPor: r.created_by || null,
    ultimoUso: r.last_used || null,
    dadaDeBaja: r.revoked_at || null,
  };
}

/** Crea una clave. Devuelve la clave en claro (unica vez) + sus datos. */
async function crear({ nombre, rol, cuits } = {}, creadaPor = null) {
  const n = String(nombre || '').trim().slice(0, 80);
  if (!n) throw Object.assign(new Error('Falta el nombre de la clave (ej. "SecretarIA")'), { httpStatus: 400 });
  if (!ROLES.includes(rol)) {
    throw Object.assign(new Error(`Rol invalido: usa ${ROLES.join(', ')}`), { httpStatus: 400 });
  }
  const clave = PREFIJO + crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO api_keys (nombre, key_hash, role, prefix, cuit_allow, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, nombre, role, prefix, cuit_allow, created_at, created_by, last_used, revoked_at`,
    [n, hash(clave), rol, clave.slice(0, 10), normCuits(cuits), creadaPor],
  );
  return { ...fmt(rows[0]), clave };
}

async function listar() {
  const { rows } = await db.query(
    `SELECT id, nombre, role, prefix, cuit_allow, created_at, created_by, last_used, revoked_at
     FROM api_keys ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
  );
  return rows.map(fmt);
}

async function darDeBaja(id) {
  const { rows } = await db.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, nombre',
    [parseInt(id, 10) || 0],
  );
  if (!rows.length) throw Object.assign(new Error('Clave no encontrada o ya dada de baja'), { httpStatus: 404 });
  return { id: rows[0].id, nombre: rows[0].nombre, dadaDeBaja: true };
}

/** Devuelve el principal de una clave vigente, o null si no existe o esta dada de baja. */
async function verificar(clave) {
  if (!clave || !String(clave).startsWith(PREFIJO)) return null;
  const { rows } = await db.query(
    'SELECT id, nombre, role, cuit_allow, last_used FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [hash(clave)],
  );
  const k = rows[0];
  if (!k) return null;
  // Ultimo uso, como mucho una escritura por minuto por clave (best-effort).
  if (!k.last_used || Date.now() - new Date(k.last_used).getTime() > 60_000) {
    db.query('UPDATE api_keys SET last_used = now() WHERE id = $1', [k.id]).catch(() => {});
  }
  return {
    username: `clave:${k.nombre}`,
    role: k.role,
    cuitAllow: k.cuit_allow && k.cuit_allow.length ? k.cuit_allow : null,
    via: 'clave',
    claveId: k.id,
  };
}

module.exports = { crear, listar, darDeBaja, verificar, extraerClave, hash, ROLES, PREFIJO };
