'use strict';

// Sesiones del panel con estado (auditoria 2026-11-26, M-06). La cookie sigue firmada con HMAC
// (auth/session.js), pero ahora lleva un identificador de sesion registrado en la tabla
// `sesiones`:
//  - Cerrar sesion la revoca en el servidor: una cookie copiada deja de valer.
//  - Para usuarios locales, el rol y los CUITs se releen de la base: bajarle el rol a alguien o
//    borrarlo surte efecto en segundos, no cuando vence la cookie.
// Un cache corto (30 s) evita una consulta por pedido; revocar en esta instancia limpia el cache
// al instante.
// 2.2.1: una sesion federada (origen oidc) guarda ademas el email verificado que mando Lockatus,
// para abrir otras apps de la suite sin una ficha local. Las demas sesiones no guardan email: el
// suyo es el de la ficha del usuario.

const crypto = require('crypto');

const CACHE_MS = 30 * 1000;
const TTL_MS = 12 * 60 * 60 * 1000;

function crearSesiones({ db = null, ahora = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  const base = () => db || require('../db');
  const vigentes = new Map(); // sid -> { ok, email, hasta }
  const usuarios = new Map(); // username -> { u, hasta }

  /** { ok, email } de una sesion, del cache (30 s) o de la base. */
  async function leer(sid) {
    if (!sid) return { ok: false, email: null };
    const c = vigentes.get(sid);
    if (c && c.hasta > ahora()) return c;
    const { rows } = await base().query(
      'SELECT email FROM sesiones WHERE sid = $1 AND revocada_at IS NULL AND expira > now()', [sid]);
    const v = { ok: rows.length > 0, email: rows.length ? rows[0].email || null : null, hasta: ahora() + cacheMs };
    vigentes.set(sid, v);
    if (vigentes.size > 5000) vigentes.clear(); // tope de memoria
    return v;
  }

  return {
    /** Registra una sesion nueva y devuelve su identificador. */
    async crear(principal, origen) {
      const sid = crypto.randomBytes(18).toString('base64url');
      const expira = new Date(ahora() + TTL_MS);
      const email = origen === 'oidc' && typeof principal.email === 'string' && principal.email ? principal.email : null;
      await base().query(
        'INSERT INTO sesiones (sid, username, origen, expira, email) VALUES ($1, $2, $3, $4, $5)',
        [sid, String(principal.username || ''), origen, expira, email],
      );
      // Limpieza oportunista: las vencidas hace mas de un dia no sirven ni para auditar.
      base().query("DELETE FROM sesiones WHERE expira < now() - interval '1 day'").catch(() => {});
      vigentes.set(sid, { ok: true, email, hasta: ahora() + cacheMs });
      return sid;
    },

    /** true si la sesion existe, no vencio y no fue revocada. */
    async vigente(sid) {
      return (await leer(sid)).ok;
    },

    /** Email verificado de una sesion federada vigente (null si no es federada o no lo trajo). */
    async emailFederado(sid) {
      const c = await leer(sid);
      return c.ok ? c.email : null;
    },

    async revocar(sid) {
      if (!sid) return;
      vigentes.set(sid, { ok: false, email: null, hasta: ahora() + TTL_MS });
      await base().query('UPDATE sesiones SET revocada_at = now() WHERE sid = $1 AND revocada_at IS NULL', [sid]);
    },

    /** Tras cambiar la contrasena o borrar un usuario: sin esperar al cache de 30 s. */
    olvidarUsuario(username) {
      usuarios.delete(username);
      vigentes.clear(); // las sesiones revocadas en la base se releen en el proximo pedido
    },

    /** Rol, CUITs y si esta activo, de un usuario local (tambien el de un pase); null si ya no existe. */
    async usuarioLocal(username) {
      const c = usuarios.get(username);
      if (c && c.hasta > ahora()) return c.u;
      const { rows } = await base().query('SELECT username, role, cuit_allow, debe_cambiar, activo, email FROM usuarios WHERE username = $1', [username]);
      // activo (2.2.0): un usuario desactivado pierde sus sesiones abiertas, tambien las de un pase.
      // email (2.2.1): el de la ficha, para mostrarlo en /api/auth/me.
      const r = rows[0];
      const u = r ? {
        role: r.role, cuitAllow: r.cuit_allow || null, debeCambiar: !!r.debe_cambiar,
        ...(r.activo === false ? { activo: false } : {}), ...(r.email ? { email: r.email } : {}),
      } : null;
      usuarios.set(username, { u, hasta: ahora() + cacheMs });
      if (usuarios.size > 5000) usuarios.clear();
      return u;
    },
  };
}

let porDefecto = null;
const servicio = () => porDefecto || (porDefecto = crearSesiones());

module.exports = { crearSesiones, servicio, TTL_MS };
