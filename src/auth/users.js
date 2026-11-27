'use strict';

// Usuarios locales con roles. Hash de contrasena con scrypt (sin dependencias).
// Roles: superadmin (todo, incluido editar catalogo) | admin | operador | lectura.

const crypto = require('crypto');
const db = require('../db');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  try {
    const [, saltHex, hashHex] = String(stored).split('$');
    const dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(dk, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

/** Igual que verifyPassword pero sin bloquear el hilo (scrypt asincrono). */
function verificarAsync(pw, stored) {
  return new Promise((resolve) => {
    try {
      const [, saltHex, hashHex] = String(stored).split('$');
      crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64, (e, dk) => {
        if (e) return resolve(false);
        try { resolve(crypto.timingSafeEqual(dk, Buffer.from(hashHex, 'hex'))); } catch { resolve(false); }
      });
    } catch { resolve(false); }
  });
}

// Hash senuelo: si el usuario no existe se verifica contra este, asi la respuesta tarda lo mismo
// y no delata que usuarios existen (auditoria 2026-11-26, M-04).
const SENUELO = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

/**
 * Crea el superadmin la primera vez (solo si no hay ningun usuario).
 * Sin ARCANUM_ADMIN_PASS genera una contrasena y la entrega a `guardarClave(pass) -> ruta`
 * (un archivo 0600 en el volumen): nunca se devuelve ni se loguea. Si no se puede guardar,
 * el usuario NO se crea: con ARCANUM_ADMIN_PASS y un reinicio se crea con esa.
 * @returns {null | { username, generated, creado, ruta?, error? }}
 */
async function seedAdmin({ guardarClave } = {}) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return null;
  const username = (process.env.ARCANUM_ADMIN_USER || 'admin').trim();
  const provided = process.env.ARCANUM_ADMIN_PASS;
  const pass = provided || crypto.randomBytes(12).toString('base64url');
  let ruta;
  if (!provided) {
    try {
      if (typeof guardarClave !== 'function') throw new Error('no hay donde guardar la contraseña generada');
      ruta = guardarClave(pass);
    } catch (e) {
      return { username, generated: true, creado: false, error: String(e.message || e) };
    }
  }
  // La contrasena generada se tiene que cambiar en el primer ingreso (B-07).
  await db.query('INSERT INTO usuarios (username, pass_hash, role, cuit_allow, debe_cambiar) VALUES ($1, $2, $3, $4, $5)', [
    username,
    hashPassword(pass),
    'superadmin',
    null,
    !provided,
  ]);
  return { username, generated: !provided, creado: true, ...(ruta ? { ruta } : {}) };
}

/** true si `stored` tiene la forma de un hash de scrypt de verdad (los usuarios que llegaron con
 *  un pase de la suite no tienen contrasena: su pass_hash es un marcador). */
function esHashScrypt(stored) {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(String(stored || ''));
}

async function login(username, password) {
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow, debe_cambiar, activo FROM usuarios WHERE username = $1', [username]);
  // Sin usuario, o sin contrasena (alta por un pase de la suite): se verifica contra el senuelo,
  // que nunca coincide y tarda lo mismo (M-04). Un usuario sin contrasena no entra por aca.
  const conClave = rows.length && esHashScrypt(rows[0].pass_hash);
  const ok = await verificarAsync(password, conClave ? rows[0].pass_hash : SENUELO);
  if (!conClave || !ok) {
    throw Object.assign(new Error('Usuario o contraseña inválidos'), { httpStatus: 401 });
  }
  if (rows[0].activo === false) {
    throw Object.assign(new Error('Usuario desactivado: pedile a un superadmin que lo reactive'), { httpStatus: 403 });
  }
  await db.query('UPDATE usuarios SET last_login = now() WHERE username = $1', [username]);
  return { username: rows[0].username, role: rows[0].role, cuitAllow: rows[0].cuit_allow || null, debeCambiar: !!rows[0].debe_cambiar };
}

const MIN_CLAVE = 12;
/** Politica de contrasenas (B-07): de 12 a 1024 caracteres y distinta del usuario. */
function validarClave(pw, username) {
  if (typeof pw !== 'string' || pw.length < MIN_CLAVE) throw Object.assign(new Error(`La contraseña tiene que tener al menos ${MIN_CLAVE} caracteres`), { httpStatus: 400 });
  if (pw.length > 1024) throw Object.assign(new Error('La contraseña es demasiado larga'), { httpStatus: 400 });
  if (username && pw.toLowerCase() === String(username).toLowerCase()) throw Object.assign(new Error('La contraseña no puede ser igual al usuario'), { httpStatus: 400 });
}

/**
 * Cambia la contrasena de un usuario local. Exige la actual; cierra todas sus otras sesiones
 * (la actual, `sidActual`, sigue). Si era la generada al instalar, borra el archivo donde quedo.
 */
async function cambiarClave(username, actual, nueva, sidActual) {
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow, debe_cambiar FROM usuarios WHERE username = $1', [username]);
  const conClave = rows.length && esHashScrypt(rows[0].pass_hash);
  const ok = await verificarAsync(actual, conClave ? rows[0].pass_hash : SENUELO);
  if (!conClave || !ok) throw Object.assign(new Error('La contraseña actual no es correcta'), { httpStatus: 401 });
  validarClave(nueva, username);
  if (nueva === actual) throw Object.assign(new Error('La contraseña nueva tiene que ser distinta de la actual'), { httpStatus: 400 });
  await db.query('UPDATE usuarios SET pass_hash = $2, debe_cambiar = false WHERE username = $1', [username, hashPassword(nueva)]);
  await db.query('UPDATE sesiones SET revocada_at = now() WHERE username = $1 AND sid <> $2 AND revocada_at IS NULL', [username, sidActual || '']);
  if (rows[0].debe_cambiar) {
    try {
      const { config } = require('../config');
      require('fs').rmSync(require('path').join(config.dataDir, 'admin-clave-inicial'), { force: true });
    } catch { /* si no se puede borrar, la contrasena ya no sirve */ }
  }
}

/** Borra un usuario local. No a uno mismo ni al ultimo superadmin. Corta sus sesiones. */
async function borrar(username, quien) {
  if (username === quien) throw Object.assign(new Error('No podés borrar tu propio usuario'), { httpStatus: 409 });
  const { rows } = await db.query('SELECT role FROM usuarios WHERE username = $1', [username]);
  if (!rows.length) throw Object.assign(new Error('No existe ese usuario'), { httpStatus: 404 });
  if (rows[0].role === 'superadmin') {
    const { rows: n } = await db.query("SELECT count(*)::int AS n FROM usuarios WHERE role = 'superadmin'");
    if (n[0].n <= 1) throw Object.assign(new Error('Es el único superadmin: creá otro antes de borrarlo'), { httpStatus: 409 });
  }
  await db.query('DELETE FROM usuarios WHERE username = $1', [username]);
  await db.query('UPDATE sesiones SET revocada_at = now() WHERE username = $1 AND revocada_at IS NULL', [username]);
}

const ROLES = ['superadmin', 'admin', 'operador', 'lectura'];
// Email de la suite: sin espacios, comillas, < > ni separadores de direcciones (se muestra en el
// panel y viaja a la otra app de la suite como identidad de la persona).
const EMAIL_RE = /^[^\s@<>"'`(),;:\\[\]]+@[^\s@<>"'`(),;:\\[\]]+\.[^\s@<>"'`(),;:\\[\]]+$/;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

/** Email normalizado (minusculas, sin espacios alrededor) o null. Invalido: 400. */
function normEmail(v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v !== 'string') throw err('Email inválido', 400);
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw err('Email inválido', 400);
  return e;
}

/** Nombre visible: texto de hasta 120 caracteres, sin caracteres de control. */
function normNombre(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw err('"nombre" tiene que ser texto', 400);
  const n = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  return n || null;
}

/** Nombre de usuario de Arcanum: hasta 64 caracteres, sin espacios ni < > (M-10). */
function usuarioValido(username) {
  return typeof username === 'string' && username.length > 0 && username.length <= 64 && !/[<>\s]/.test(username);
}

async function crear({ username, password, role, cuitAllow, email, nombre }) {
  if (!username || !password) throw Object.assign(new Error('Faltan usuario y contraseña'), { httpStatus: 400 });
  if (!usuarioValido(username)) throw Object.assign(new Error('Usuario inválido (hasta 64 caracteres, sin espacios ni < >)'), { httpStatus: 400 });
  validarClave(password, username);
  // Rol desconocido o CUIT mal tipeado: error, nunca un valor por defecto en silencio (M-10).
  if (!ROLES.includes(role)) throw Object.assign(new Error(`Rol inválido: usá ${ROLES.join(', ')}`), { httpStatus: 400 });
  const r = role;
  const { listaCuits, sinCuitsParaAdmin } = require('./permisos');
  const allow = listaCuits(cuitAllow, 'cuitAllow');
  sinCuitsParaAdmin(r, allow);
  const mail = normEmail(email);
  const nom = normNombre(nombre);
  try {
    await db.query('INSERT INTO usuarios (username, pass_hash, role, cuit_allow, email, nombre) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, hashPassword(password), r, allow, mail, nom]);
  } catch (e) {
    if (e.code === '23505') throw err('Ya hay un usuario con ese nombre o ese email', 409);
    throw e;
  }
  return { username, role: r, cuitAllow: allow, ...(mail ? { email: mail } : {}) };
}

async function listar() {
  const { rows } = await db.query(
    'SELECT username, email, nombre, role, origen, activo, cuit_allow, last_login, created_at FROM usuarios ORDER BY username',
  );
  return rows;
}

/**
 * Cambia email, nombre, rol o si esta activo (superadmin). Nadie se desactiva ni se baja el
 * rol a si mismo (para no quedarse afuera). Desactivar corta todas las sesiones de esa persona,
 * tambien las abiertas con un pase de la suite.
 */
async function actualizar(username, { email, nombre, role, activo } = {}, quien = null) {
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const { rows: act } = await db.query('SELECT role, cuit_allow FROM usuarios WHERE username = $1', [username]);
  if (!act.length) throw err('Usuario no encontrado', 404);
  if (email !== undefined) add('email', normEmail(email));
  if (nombre !== undefined) add('nombre', normNombre(nombre));
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw err(`Rol inválido: usá ${ROLES.join(', ')}`, 400);
    if (quien && quien === username && role !== 'superadmin') throw err('No podés bajarte el rol a vos mismo', 400);
    // Igual que al crearlo: admin y superadmin ven todos los CUITs, una lista no se cumpliria (M-10).
    const { sinCuitsParaAdmin } = require('./permisos');
    sinCuitsParaAdmin(role, act[0].cuit_allow && act[0].cuit_allow.length ? act[0].cuit_allow : null);
    add('role', role);
  }
  if (activo !== undefined) {
    if (typeof activo !== 'boolean') throw err('"activo" tiene que ser true o false', 400);
    if (quien && quien === username && !activo) throw err('No podés desactivarte a vos mismo', 400);
    add('activo', activo);
  }
  if (!sets.length) throw err('No hay nada para cambiar', 400);
  vals.push(username);
  let rows;
  try {
    ({ rows } = await db.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE username = $${vals.length}
       RETURNING username, email, nombre, role, origen, activo, cuit_allow, last_login, created_at`, vals));
  } catch (e) {
    if (e.code === '23505') throw err('Ya hay otro usuario con ese email', 409);
    throw e;
  }
  if (!rows.length) throw err('Usuario no encontrado', 404);
  if (activo === false) {
    await db.query('UPDATE sesiones SET revocada_at = now() WHERE username = $1 AND revocada_at IS NULL', [username]);
  }
  return rows[0];
}

module.exports = {
  hashPassword, verifyPassword, seedAdmin, login, crear, listar, actualizar, cambiarClave, borrar, validarClave,
  normEmail, normNombre, usuarioValido, esHashScrypt, ROLES, MIN_CLAVE,
};
