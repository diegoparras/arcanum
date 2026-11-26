'use strict';

// Sesiones del panel con estado (auditoria 2026-11-26, M-06). La cookie sigue firmada con HMAC
// (auth/session.js), pero ahora lleva un identificador de sesion registrado en la tabla
// `sesiones`:
//  - Cerrar sesion la revoca en el servidor: una cookie copiada deja de valer.
//  - Para usuarios locales, el rol y los CUITs se releen de la base: bajarle el rol a alguien o
//    borrarlo surte efecto en segundos, no cuando vence la cookie.
// Un cache corto (30 s) evita una consulta por pedido; revocar en esta instancia limpia el cache
// al instante.

const crypto = require('crypto');

const CACHE_MS = 30 * 1000;
const TTL_MS = 12 * 60 * 60 * 1000;

function crearSesiones({ db = null, ahora = () => Date.now(), cacheMs = CACHE_MS } = {}) {
  const base = () => db || require('../db');
  const vigentes = new Map(); // sid -> { ok, hasta }
  const usuarios = new Map(); // username -> { u, hasta }

  return {
    /** Registra una sesion nueva y devuelve su identificador. */
    async crear(principal, origen) {
      const sid = crypto.randomBytes(18).toString('base64url');
      const expira = new Date(ahora() + TTL_MS);
      await base().query(
        'INSERT INTO sesiones (sid, username, origen, expira) VALUES ($1, $2, $3, $4)',
        [sid, String(principal.username || ''), origen, expira],
      );
      // Limpieza oportunista: las vencidas hace mas de un dia no sirven ni para auditar.
      base().query("DELETE FROM sesiones WHERE expira < now() - interval '1 day'").catch(() => {});
      vigentes.set(sid, { ok: true, hasta: ahora() + cacheMs });
      return sid;
    },

    /** true si la sesion existe, no vencio y no fue revocada. */
    async vigente(sid) {
      if (!sid) return false;
      const c = vigentes.get(sid);
      if (c && c.hasta > ahora()) return c.ok;
      const { rows } = await base().query(
        'SELECT 1 FROM sesiones WHERE sid = $1 AND revocada_at IS NULL AND expira > now()', [sid]);
      const ok = rows.length > 0;
      vigentes.set(sid, { ok, hasta: ahora() + cacheMs });
      if (vigentes.size > 5000) vigentes.clear(); // tope de memoria
      return ok;
    },

    async revocar(sid) {
      if (!sid) return;
      vigentes.set(sid, { ok: false, hasta: ahora() + TTL_MS });
      await base().query('UPDATE sesiones SET revocada_at = now() WHERE sid = $1 AND revocada_at IS NULL', [sid]);
    },

    /** Rol y CUITs actuales de un usuario local; null si ya no existe. */
    async usuarioLocal(username) {
      const c = usuarios.get(username);
      if (c && c.hasta > ahora()) return c.u;
      const { rows } = await base().query('SELECT username, role, cuit_allow FROM usuarios WHERE username = $1', [username]);
      const u = rows[0] ? { role: rows[0].role, cuitAllow: rows[0].cuit_allow || null } : null;
      usuarios.set(username, { u, hasta: ahora() + cacheMs });
      if (usuarios.size > 5000) usuarios.clear();
      return u;
    },
  };
}

let porDefecto = null;
const servicio = () => porDefecto || (porDefecto = crearSesiones());

module.exports = { crearSesiones, servicio, TTL_MS };
