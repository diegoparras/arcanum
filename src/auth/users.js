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
  const { rows } = await db.query('SELECT username, pass_hash, role, cuit_allow FROM usuarios WHERE username = $1', [username]);
  const ok = await verificarAsync(password, rows.length ? rows[0].pass_hash : SENUELO);
  if (!rows.length || !ok) {
    throw Object.assign(new Error('Usuario o contrasena invalidos'), { httpStatus: 401 });
  }
  await db.query('UPDATE usuarios SET last_login = now() WHERE username = $1', [username]);
  return { username: rows[0].username, role: rows[0].role, cuitAllow: rows[0].cuit_allow || null };
}

async function crear({ username, password, role, cuitAllow }) {
  if (!username || !password) throw Object.assign(new Error('Faltan usuario y contrasena'), { httpStatus: 400 });
  // Rol desconocido o CUIT mal tipeado: error, nunca un valor por defecto en silencio (M-10).
  const ROLES = ['superadmin', 'admin', 'operador', 'lectura'];
  if (!ROLES.includes(role)) throw Object.assign(new Error(`Rol invalido: usa ${ROLES.join(', ')}`), { httpStatus: 400 });
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

module.exports = { hashPassword, verifyPassword, seedAdmin, login, crear, listar };
