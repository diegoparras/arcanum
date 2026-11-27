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
      if (typeof guardarClave !== 'function') throw new Error('no hay donde guardar la contrasena generada');
      ruta = guardarClave(pass);
    } catch (e) {
      return { username, generated: true, creado: false, error: String(e.message || e) };
    }
  }
  await db.query('INSERT INTO usuarios (username, pass_hash, role) VALUES ($1, $2, $3)', [
    username,
    hashPassword(pass),
    'superadmin',
  ]);
  return { username, generated: !provided, creado: true, ...(ruta ? { ruta } : {}) };
}

async function login(username, password) {
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow, activo FROM usuarios WHERE username = $1', [username]);
  if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
    throw Object.assign(new Error('Usuario o contrasena invalidos'), { httpStatus: 401 });
  }
  if (rows[0].activo === false) {
    throw Object.assign(new Error('Usuario desactivado: pedile a un superadmin que lo reactive'), { httpStatus: 403 });
  }
  await db.query('UPDATE usuarios SET last_login = now() WHERE username = $1', [username]);
  return { username: rows[0].username, role: rows[0].role, cuitAllow: rows[0].cuit_allow || null };
}

const ROLES = ['superadmin', 'admin', 'operador', 'lectura'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

/** Email normalizado (minusculas, sin espacios) o null. Invalido: 400. */
function normEmail(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const e = String(v).trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) throw err('Email invalido', 400);
  return e;
}

function normNombre(v) {
  if (v === undefined || v === null) return null;
  const n = String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  return n || null;
}

async function crear({ username, password, role, cuitAllow, email, nombre }) {
  if (!username || !password) throw Object.assign(new Error('Faltan usuario y contrasena'), { httpStatus: 400 });
  const r = ROLES.includes(role) ? role : 'operador';
  const allow = Array.isArray(cuitAllow) && cuitAllow.length ? cuitAllow.map((c) => String(c).replace(/[^0-9]/g, '')) : null;
  const mail = normEmail(email);
  try {
    await db.query('INSERT INTO usuarios (username, pass_hash, role, cuit_allow, email, nombre) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, hashPassword(password), r, allow, mail, normNombre(nombre)]);
  } catch (e) {
    if (e.code === '23505') throw err('Ya hay un usuario con ese nombre o ese email', 409);
    throw e;
  }
  return { username, role: r, cuitAllow: allow, email: mail };
}

async function listar() {
  const { rows } = await db.query(
    'SELECT username, email, nombre, role, origen, activo, cuit_allow, last_login, created_at FROM usuarios ORDER BY username',
  );
  return rows;
}

/**
 * Cambia email, nombre, rol o si esta activo (superadmin). Nadie se desactiva ni se baja el
 * rol a si mismo (para no quedarse afuera).
 */
async function actualizar(username, { email, nombre, role, activo } = {}, quien = null) {
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (email !== undefined) add('email', normEmail(email));
  if (nombre !== undefined) add('nombre', normNombre(nombre));
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw err(`Rol invalido: usa ${ROLES.join(', ')}`, 400);
    if (quien && quien === username && role !== 'superadmin') throw err('No podes bajarte el rol a vos mismo', 400);
    add('role', role);
  }
  if (activo !== undefined) {
    if (typeof activo !== 'boolean') throw err('"activo" tiene que ser true o false', 400);
    if (quien && quien === username && !activo) throw err('No podes desactivarte a vos mismo', 400);
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
  return rows[0];
}

module.exports = { hashPassword, verifyPassword, seedAdmin, login, crear, listar, actualizar, normEmail, normNombre, ROLES };
