'use strict';

// Guarda anti-SSRF para destinos que carga un usuario (webhooks).
//
// Dos barreras (auditoria 2026-11-26, B-01):
//  1. Al guardar: la URL tiene que ser http(s), con un nombre de varias etiquetas (no un servicio
//     de la red interna como "postgres") y sin IP interna literal, en ninguna forma (IPv4, IPv6,
//     IPv4 mapeada en IPv6).
//  2. Al conectar: `lookupSeguro` resuelve el nombre y rechaza si ALGUNA de las IPs es interna, y
//     el socket se abre contra la IP ya validada. Un nombre publico que resuelve a 127.0.0.1 (o
//     que cambia de IP entre la validacion y el envio) no pasa. El envio no sigue redirecciones.

const dns = require('dns');
const net = require('net');

function err(message) {
  return Object.assign(new Error(message), { httpStatus: 400 });
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (base, bits) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits));
  return (
    inRange('0.0.0.0', 8) || // 0.0.0.0/8
    inRange('10.0.0.0', 8) || // privada
    inRange('100.64.0.0', 10) || // CGNAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local + metadata cloud
    inRange('172.16.0.0', 12) || // privada
    inRange('192.168.0.0', 16) || // privada
    inRange('192.0.0.0', 24) ||
    inRange('198.18.0.0', 15) || // benchmarking
    n >= ipv4ToInt('224.0.0.0') // multicast + reservado
  );
}

/** IPv6 expandida a 8 grupos de 16 bits, o null. */
function grupos6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // IPv4 al final (::ffff:1.2.3.4) -> dos grupos hex.
  const m = s.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const n = ipv4ToInt(m[2]);
    if (n === null) return null;
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltan = 8 - izq.length - der.length;
  if (partes.length === 1 && faltan !== 0) return null;
  if (faltan < 0) return null;
  const g = [...izq, ...Array(partes.length === 2 ? faltan : 0).fill('0'), ...der].map((x) => parseInt(x || '0', 16));
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}

/** true si la IP (v4 o v6, en cualquier forma) es interna, reservada o de metadata. */
function ipBloqueada(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) return isBlockedIpv4(s);
  const g = grupos6(s);
  if (!g) return true; // lo que no se entiende, no pasa
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4 mapeada (::ffff:a.b.c.d) o compatible (::a.b.c.d): se evalua la IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedIpv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  const p = g[0];
  return (p & 0xfe00) === 0xfc00 /* ULA fc00::/7 */ || (p & 0xffc0) === 0xfe80 /* link-local */
    || (p & 0xff00) === 0xff00 /* multicast */ || p === 0x2001 && g[1] === 0x0db8 /* documentacion */
    || p === 0x0064 && g[1] === 0xff9b; /* NAT64 */
}

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return ipBloqueada(h);
  return false;
}

/**
 * Valida una URL de destino al guardarla. Lanza si es interna o insegura. Devuelve la URL.
 * @param {string} raw
 * @param {{allowHttp?: boolean}} opts  permitir http:// (default true; webhooks lo permiten)
 */
function assertSafeUrl(raw, opts = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw err('URL inválida');
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp !== false && u.protocol === 'http:')) {
    throw err('Solo se permiten URLs http(s)');
  }
  if (u.username || u.password) throw err('La URL no puede llevar usuario ni clave');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHost(host)) throw err('Destino no permitido: apunta a una IP/host interno o reservado');
  if (!net.isIP(host) && !host.includes('.')) {
    throw err('Destino no permitido: un nombre sin dominio (ej. "postgres") es un servicio de la red interna');
  }
  return raw;
}

/** `lookup` para el socket: resuelve y rechaza si alguna IP es interna (antirebinding). */
function lookupSeguro(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { all: true }, (e, direcciones) => {
    if (e) return cb(e);
    const malas = (direcciones || []).filter((d) => ipBloqueada(d.address));
    if (!direcciones || !direcciones.length || malas.length) {
      return cb(Object.assign(new Error(`Destino no permitido: ${hostname} resuelve a una IP interna`), { code: 'EDESTINO', httpStatus: 400 }));
    }
    const pide = options && typeof options === 'object' ? options : {};
    if (pide.all) return cb(null, direcciones);
    return cb(null, direcciones[0].address, direcciones[0].family);
  });
}

let agente = null;
/** Agente undici que conecta solo a IPs validadas por lookupSeguro. */
function agenteSeguro() {
  if (!agente) {
    const { Agent } = require('undici');
    agente = new Agent({ connect: { lookup: lookupSeguro } });
  }
  return agente;
}

module.exports = { assertSafeUrl, isBlockedHost, ipBloqueada, lookupSeguro, agenteSeguro };
