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

async function login(username, password) {
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow, debe_cambiar FROM usuarios WHERE username = $1', [username]);
  const ok = await verificarAsync(password, rows.length ? rows[0].pass_hash : SENUELO);
  if (!rows.length || !ok) {
    throw Object.assign(new Error('Usuario o contraseña inválidos'), { httpStatus: 401 });
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
  const ok = await verificarAsync(actual, rows.length ? rows[0].pass_hash : SENUELO);
  if (!rows.length || !ok) throw Object.assign(new Error('La contraseña actual no es correcta'), { httpStatus: 401 });
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

async function crear({ username, password, role, cuitAllow }) {
  if (!username || !password) throw Object.assign(new Error('Faltan usuario y contraseña'), { httpStatus: 400 });
  if (typeof username !== 'string' || username.length > 64 || /[<>\s]/.test(username)) throw Object.assign(new Error('Usuario inválido (hasta 64 caracteres, sin espacios ni < >)'), { httpStatus: 400 });
  validarClave(password, username);
  // Rol desconocido o CUIT mal tipeado: error, nunca un valor por defecto en silencio (M-10).
  const ROLES = ['superadmin', 'admin', 'operador', 'lectura'];
  if (!ROLES.includes(role)) throw Object.assign(new Error(`Rol inválido: usá ${ROLES.join(', ')}`), { httpStatus: 400 });
  const r = role;
  const { listaCuits, sinCuitsParaAdmin } = require('./permisos');
  const allow = listaCuits(cuitAllow, 'cuitAllow');
  sinCuitsParaAdmin(r, allow);
  await db.query('INSERT INTO usuarios (username, pass_hash, role, cuit_allow) VALUES ($1, $2, $3, $4)', [username, hashPassword(password), r, allow]);
  return { username, role: r, cuitAllow: allow };
}

async function listar() {
  const { rows } = await db.query('SELECT username, role, last_login, created_at FROM usuarios ORDER BY username');
  return rows;
}

module.exports = { hashPassword, verifyPassword, seedAdmin, login, crear, listar, cambiarClave, borrar, validarClave, MIN_CLAVE };
