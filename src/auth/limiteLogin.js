'use strict';

// Limite de intentos de login (auditoria 2026-11-26, M-04 y M-05).
//
//  - IP del cliente: la ultima de X-Forwarded-For que agrego un proxy de confianza
//    (ARCANUM_PROXIES, 1 por defecto: el de EasyPanel). Lo que el cliente pone a la izquierda no
//    cuenta; antes se tomaba la primera y cambiarla reseteaba el limite.
//  - Tres limites: por IP y usuario (5 fallos, espera creciente), por usuario sin importar la IP
//    (10 fallos, 15 min) y global (muchos fallos por minuto frenan todo el login un minuto).
//  - Memoria acotada: claves con hash (nunca el usuario en claro) y tope de entradas.

const crypto = require('crypto');

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

/** IP del cliente segun la cantidad de proxies de confianza delante de Arcanum. */
function ipCliente(req, proxies = Number(process.env.ARCANUM_PROXIES ?? 1)) {
  const remota = (req.socket && req.socket.remoteAddress) || '?';
  if (!proxies) return remota;
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!xff.length) return remota;
  return xff[Math.max(0, xff.length - proxies)] || remota;
}

/** Nombre de usuario de un login: string de 1 a 64 caracteres. */
function validarUsuario(u) {
  if (typeof u !== 'string' || !u.length || u.length > 64) throw err('Usuario invalido', 400);
  return u;
}

const h = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 22);

function crearLimiteLogin({ ahora = () => Date.now(), porUsuario = 10, global = 200, maxClaves = 10000 } = {}) {
  const fallos = new Map(); // clave -> { n, hasta, visto }
  let ventanaGlobal = { desde: 0, n: 0, hasta: 0 };

  function podar() {
    if (fallos.size <= maxClaves) return;
    const t = ahora();
    for (const [k, v] of fallos) if (v.hasta <= t && t - v.visto > 15 * 60_000) fallos.delete(k);
    // Si sigue lleno, se descartan las mas viejas (Map conserva el orden de insercion).
    while (fallos.size > maxClaves) fallos.delete(fallos.keys().next().value);
  }
  const claveIp = (ip, u) => 'i:' + h(ip + '\n' + String(u).toLowerCase());
  const claveUsuario = (u) => 'u:' + h(String(u).toLowerCase());

  function sumar(clave, umbral, espera) {
    const t = ahora();
    const r = fallos.get(clave) || { n: 0, hasta: 0, visto: t };
    r.n += 1;
    r.visto = t;
    if (r.n >= umbral) r.hasta = t + espera(r.n - umbral);
    fallos.delete(clave); // reinsertar al final: lo mas reciente queda ultimo
    fallos.set(clave, r);
  }

  return {
    chequear(ip, usuario) {
      const t = ahora();
      if (ventanaGlobal.hasta > t) throw err('Demasiados intentos de inicio de sesion. Proba en un minuto.', 429);
      for (const k of [claveIp(ip, usuario), claveUsuario(usuario)]) {
        const r = fallos.get(k);
        if (r && r.hasta > t) throw err('Demasiados intentos. Espera unos minutos.', 429);
      }
    },
    fallo(ip, usuario) {
      const t = ahora();
      sumar(claveIp(ip, usuario), 5, (extra) => Math.min(15 * 60_000, 30_000 * 2 ** extra));
      sumar(claveUsuario(usuario), porUsuario, () => 15 * 60_000);
      if (t - ventanaGlobal.desde > 60_000) ventanaGlobal = { desde: t, n: 0, hasta: 0 };
      ventanaGlobal.n += 1;
      if (ventanaGlobal.n >= global) ventanaGlobal.hasta = t + 60_000;
      podar();
    },
    exito(ip, usuario) {
      fallos.delete(claveIp(ip, usuario));
      fallos.delete(claveUsuario(usuario));
    },
    tamano: () => fallos.size,
    claves: () => [...fallos.keys()],
  };
}

module.exports = { crearLimiteLogin, ipCliente, validarUsuario };
