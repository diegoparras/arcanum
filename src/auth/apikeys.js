'use strict';

// Claves de API con rol, para integraciones (n8n, SecretarIA, scripts).
// - En la base se guarda solo el hash SHA-256: la clave en claro se muestra UNA vez,
//   al crearla. Son 192 bits aleatorios, asi que un hash rapido alcanza.
// - Cada clave tiene rol (lectura | operador | admin) y, opcionalmente, CUITs permitidos,
//   fecha de vencimiento y limite de pedidos por minuto.
// - Se dan de baja de a una (revoked_at) sin tocar las demas ni la clave maestra.
// - Rotar crea una clave nueva con los mismos permisos; la anterior sigue andando
//   unos dias de gracia y despues vence sola.
// - Se aceptan en X-API-Key o en Authorization: Bearer <clave>.
// - Suite Escriba: una clave puede quedar habilitada para pedir pases (POST /api/suite/pase) con un
//   rol tope propio, aparte de su rol (ver src/services/suite.js).

const crypto = require('crypto');
const db = require('../db');

const ROLES = ['lectura', 'operador', 'admin'];
const PREFIJO = 'ark_';
const MAX_VENCE_DIAS = 3650;
const GRACIA_DEFAULT = 7;
// Suite Escriba: una clave habilitada puede pedir pases para abrir sesiones de la UI (lo usa
// Factorum para entrar a Arcanum sin volver a loguearse). El rol de esas sesiones queda topeado
// por suite_rol_tope, aparte del rol de la clave (la de Factorum suele ser lectura para constatar).
const ROLES_TOPE = ['lectura', 'operador', 'admin', 'superadmin'];
const ROL_TOPE_DEFAULT = 'operador';

const COLS = 'id, nombre, role, prefix, cuit_allow, created_at, created_by, last_used, revoked_at, expires_at, rate_limit, rotated_from, suite, suite_rol_tope';

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

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

/** Dias hasta el vencimiento (entero, null = no vence, 0 o 1-n para dias corridos). */
function normDias(v, campo, max) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) throw err(`"${campo}" debe ser un número de 1 a ${max}`, 400);
  return n;
}

function normLimite(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 100000) throw err('"limitePorMinuto" debe ser un número de 1 a 100000', 400);
  return n;
}

/**
 * Flag de la suite y rol tope. Una clave con CUITs permitidos no puede topear en admin o
 * superadmin: en Arcanum esos roles ven todos los CUITs y la lista de la clave no se cumpliria.
 */
function normSuite({ suite, suiteRolTope } = {}, cuits = null) {
  // Igual que el rol y los CUITs (M-10): un valor que no se entiende es un 400, nunca un
  // valor por defecto en silencio. Ausente: sin suite y tope operador.
  if (suite !== undefined && suite !== null && typeof suite !== 'boolean') throw err('"suite" tiene que ser true o false', 400);
  const tope = suiteRolTope === undefined || suiteRolTope === null || suiteRolTope === '' ? ROL_TOPE_DEFAULT : suiteRolTope;
  if (typeof tope !== 'string' || !ROLES_TOPE.includes(tope)) throw err(`Rol tope inválido: usá ${ROLES_TOPE.join(', ')}`, 400);
  if (cuits && cuits.length && ['admin', 'superadmin'].includes(tope)) {
    throw err('Una clave con CUITs permitidos no puede tener rol tope admin ni superadmin: esos roles ven todos los CUITs', 400);
  }
  return { suite: suite === true, tope };
}

/** Prende o apaga "puede abrir sesiones de la suite" y cambia el rol tope de una clave activa. */
async function configurarSuite(id, { suite, suiteRolTope } = {}) {
  const i = parseInt(id, 10) || 0;
  const { rows: act } = await db.query(
    `SELECT ${COLS} FROM api_keys WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [i],
  );
  if (!act.length) throw err('Clave no encontrada, vencida o dada de baja', 404);
  if (typeof suite !== 'boolean') throw err('"suite" tiene que ser true o false', 400);
  const s = normSuite({ suite, suiteRolTope: suiteRolTope === undefined ? act[0].suite_rol_tope : suiteRolTope }, act[0].cuit_allow);
  const { rows } = await db.query(
    `UPDATE api_keys SET suite = $2, suite_rol_tope = $3 WHERE id = $1 RETURNING ${COLS}`, [i, s.suite, s.tope],
  );
  return fmt(rows[0]);
}

function estadoDe(r, ahora = Date.now()) {
  if (r.revoked_at) return 'dada_de_baja';
  if (r.expires_at && new Date(r.expires_at).getTime() <= ahora) return 'vencida';
  return 'activa';
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
    vence: r.expires_at || null,
    limitePorMinuto: r.rate_limit || null,
    rotadaDe: r.rotated_from || null,
    suite: !!r.suite,
    suiteRolTope: r.suite_rol_tope || ROL_TOPE_DEFAULT,
    estado: estadoDe(r),
    ...(r.usos_30d !== undefined ? { usos30d: Number(r.usos_30d) } : {}),
  };
}

function nuevaClave() {
  return PREFIJO + crypto.randomBytes(24).toString('hex');
}

/** Crea una clave. Devuelve la clave en claro (unica vez) + sus datos. */
async function crear({ nombre, rol, cuits, venceDias, limitePorMinuto, suite, suiteRolTope } = {}, creadaPor = null) {
  const n = String(nombre || '').trim().slice(0, 80);
  if (!n) throw err('Falta el nombre de la clave (ej. "SecretarIA")', 400);
  if (!ROLES.includes(rol)) throw err(`Rol inválido: usá ${ROLES.join(', ')}`, 400);
  const { listaCuits, sinCuitsParaAdmin } = require('./permisos');
  const listaCuit = listaCuits(cuits, 'cuits');
  sinCuitsParaAdmin(rol, listaCuit);
  const dias = normDias(venceDias, 'venceDias', MAX_VENCE_DIAS);
  const limite = normLimite(limitePorMinuto);
  const s = normSuite({ suite, suiteRolTope }, listaCuit);
  const clave = nuevaClave();
  const { rows } = await db.query(
    `INSERT INTO api_keys (nombre, key_hash, role, prefix, cuit_allow, created_by, expires_at, rate_limit, suite, suite_rol_tope)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(days => $7::int) END, $8, $9, $10)
     RETURNING ${COLS}`,
    [n, hash(clave), rol, clave.slice(0, 10), listaCuit, creadaPor, dias, limite, s.suite, s.tope],
  );
  return { ...fmt(rows[0]), clave };
}

async function listar() {
  const { rows } = await db.query(
    `SELECT ${COLS.split(', ').map((c) => `k.${c}`).join(', ')},
            (SELECT count(*) FROM requests r WHERE r.clave_id = k.id AND r.ts > now() - interval '30 days') AS usos_30d
     FROM api_keys k
     ORDER BY (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())) DESC, k.created_at DESC`,
  );
  return rows.map(fmt);
}

async function darDeBaja(id) {
  const { rows } = await db.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, nombre',
    [parseInt(id, 10) || 0],
  );
  if (!rows.length) throw err('Clave no encontrada o ya dada de baja', 404);
  return { id: rows[0].id, nombre: rows[0].nombre, dadaDeBaja: true };
}

/**
 * Rota una clave: crea una nueva con el mismo nombre, rol, CUITs, limite y politica de
 * vencimiento, y deja la anterior andando `graciaDias` mas (despues vence sola).
 */
async function rotar(id, { graciaDias } = {}, creadaPor = null) {
  const gracia = graciaDias === undefined || graciaDias === null || graciaDias === ''
    ? GRACIA_DEFAULT
    : parseInt(graciaDias, 10);
  if (!Number.isFinite(gracia) || gracia < 0 || gracia > 90) throw err('"graciaDias" debe ser un número de 0 a 90', 400);
  return db.tx(async (client) => {
    const { rows: viejas } = await client.query(
      `SELECT ${COLS} FROM api_keys WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE`,
      [parseInt(id, 10) || 0],
    );
    const v = viejas[0];
    if (!v) throw err('Clave no encontrada, vencida o dada de baja', 404);
    // Misma duracion que la original (si vencia), contada desde hoy.
    const duracionMs = v.expires_at ? new Date(v.expires_at).getTime() - new Date(v.created_at).getTime() : null;
    const clave = nuevaClave();
    const { rows } = await client.query(
      `INSERT INTO api_keys (nombre, key_hash, role, prefix, cuit_allow, created_by, expires_at, rate_limit, rotated_from, suite, suite_rol_tope)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::bigint IS NULL THEN NULL ELSE now() + ($7::bigint * interval '1 millisecond') END, $8, $9, $10, $11)
       RETURNING ${COLS}`,
      [v.nombre, hash(clave), v.role, clave.slice(0, 10), v.cuit_allow, creadaPor, duracionMs, v.rate_limit, v.id, !!v.suite, v.suite_rol_tope || ROL_TOPE_DEFAULT],
    );
    const { rows: vieja } = await client.query(
      `UPDATE api_keys SET expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + make_interval(days => $2::int))
       WHERE id = $1 RETURNING expires_at`,
      [v.id, gracia],
    );
    return { ...fmt(rows[0]), clave, anterior: { id: v.id, vence: vieja[0].expires_at } };
  });
}

/** Devuelve el principal de una clave vigente, o null si no existe, vencio o esta dada de baja. */
async function verificar(clave) {
  if (!clave || !String(clave).startsWith(PREFIJO)) return null;
  const { rows } = await db.query(
    `SELECT id, nombre, role, prefix, cuit_allow, last_used, rate_limit, expires_at, suite, suite_rol_tope FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
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
    limitePorMinuto: k.rate_limit || null,
    vence: k.expires_at || null,
    prefijo: k.prefix || null,
    // Suite Escriba: si la clave puede pedir pases (POST /api/suite/pase) y con que rol tope.
    suite: !!k.suite,
    suiteRolTope: k.suite_rol_tope || ROL_TOPE_DEFAULT,
  };
}

/** Uso de una clave en los ultimos `dias`: totales, por operacion, por dia y ultimos pedidos. */
async function uso(id, dias = 30) {
  const i = parseInt(id, 10) || 0;
  const d = Math.min(Math.max(parseInt(dias, 10) || 30, 1), 365);
  const { rows: k } = await db.query(`SELECT ${COLS} FROM api_keys WHERE id = $1`, [i]);
  if (!k.length) throw err('Clave no encontrada', 404);
  const desde = `now() - make_interval(days => ${d})`;
  const [tot, ops, serie, ult] = await Promise.all([
    db.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE NOT ok) AS errores,
              count(*) FILTER (WHERE status = 429) AS limitados, count(*) FILTER (WHERE status = 403) AS denegados,
              round(avg(duration_ms)) AS latencia, count(DISTINCT cuit) AS cuits
       FROM requests WHERE clave_id = $1 AND ts > ${desde}`, [i]),
    db.query(
      `SELECT service, coalesce(operation, http_method || ' ' || path) AS operacion, count(*) AS n,
              count(*) FILTER (WHERE NOT ok) AS errores, round(avg(duration_ms)) AS latencia
       FROM requests WHERE clave_id = $1 AND ts > ${desde}
       GROUP BY 1, 2 ORDER BY n DESC LIMIT 30`, [i]),
    db.query(
      `SELECT ts::date AS dia, count(*) AS n, count(*) FILTER (WHERE NOT ok) AS errores
       FROM requests WHERE clave_id = $1 AND ts > ${desde} GROUP BY 1 ORDER BY 1`, [i]),
    db.query(
      `SELECT ts, http_method, path, service, operation, status, duration_ms, cuit
       FROM requests WHERE clave_id = $1 ORDER BY ts DESC LIMIT 25`, [i]),
  ]);
  const t = tot.rows[0];
  return {
    clave: fmt(k[0]),
    dias: d,
    total: Number(t.total),
    errores: Number(t.errores),
    limitados: Number(t.limitados),
    denegados: Number(t.denegados),
    latenciaMedia: Number(t.latencia) || 0,
    cuitsDistintos: Number(t.cuits),
    porOperacion: ops.rows.map((r) => ({ servicio: r.service, operacion: r.operacion, n: Number(r.n), errores: Number(r.errores), latenciaMedia: Number(r.latencia) || 0 })),
    porDia: serie.rows.map((r) => ({ dia: r.dia, n: Number(r.n), errores: Number(r.errores) })),
    ultimos: ult.rows.map((r) => ({ ts: r.ts, metodo: r.http_method, ruta: r.path, servicio: r.service, operacion: r.operation, status: r.status, ms: r.duration_ms, cuit: r.cuit })),
  };
}

/**
 * Claves activas que vencen dentro de `dias` y todavia no se avisaron (marca el aviso).
 * La usa el daemon de vencimientos para el webhook clave_por_vencer.
 */
async function porVencerSinAviso(dias = 7) {
  const { rows } = await db.query(
    `UPDATE api_keys SET aviso_vence_at = now()
     WHERE revoked_at IS NULL AND expires_at IS NOT NULL
       AND expires_at > now() AND expires_at < now() + make_interval(days => $1::int)
       AND (aviso_vence_at IS NULL OR aviso_vence_at < expires_at - make_interval(days => $1::int))
     RETURNING id, nombre, role, expires_at`,
    [dias],
  );
  return rows.map((r) => ({ id: r.id, nombre: r.nombre, rol: r.role, vence: r.expires_at, dias: Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 86400000) }));
}

module.exports = {
  crear, listar, darDeBaja, rotar, verificar, uso, porVencerSinAviso, configurarSuite,
  extraerClave, hash, estadoDe, normSuite, ROLES, ROLES_TOPE, ROL_TOPE_DEFAULT, PREFIJO, GRACIA_DEFAULT,
};
