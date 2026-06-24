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

/** Crea el usuario admin la primera vez. Devuelve la clave si la genero. */
async function seedAdmin() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return null;
  const username = (process.env.ARCANUM_ADMIN_USER || 'admin').trim();
  const provided = process.env.ARCANUM_ADMIN_PASS;
  const pass = provided || crypto.randomBytes(9).toString('base64url');
  await db.query('INSERT INTO usuarios (username, pass_hash, role) VALUES ($1, $2, $3)', [
    username,
    hashPassword(pass),
    'superadmin',
  ]);
  return { username, generated: !provided, pass: provided ? undefined : pass };
}

async function login(username, password) {
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow FROM usuarios WHERE username = $1', [username]);
  if (!rows.length || !verifyPassword(password, rows[0].pass_hash)) {
    throw Object.assign(new Error('Usuario o contrasena invalidos'), { httpStatus: 401 });
  }
  await db.query('UPDATE usuarios SET last_login = now() WHERE username = $1', [username]);
  return { username: rows[0].username, role: rows[0].role, cuitAllow: rows[0].cuit_allow || null };
}

async function crear({ username, password, role, cuitAllow }) {
  if (!username || !password) throw Object.assign(new Error('Faltan usuario y contrasena'), { httpStatus: 400 });
  const r = ['superadmin', 'admin', 'operador', 'lectura'].includes(role) ? role : 'operador';
  const allow = Array.isArray(cuitAllow) && cuitAllow.length ? cuitAllow.map((c) => String(c).replace(/[^0-9]/g, '')) : null;
  await db.query('INSERT INTO usuarios (username, pass_hash, role, cuit_allow) VALUES ($1, $2, $3, $4)', [username, hashPassword(password), r, allow]);
  return { username, role: r, cuitAllow: allow };
}

async function listar() {
  const { rows } = await db.query('SELECT username, role, last_login, created_at FROM usuarios ORDER BY username');
  return rows;
}

module.exports = { hashPassword, verifyPassword, seedAdmin, login, crear, listar };
