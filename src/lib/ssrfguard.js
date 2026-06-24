'use strict';

// Guarda anti-SSRF: rechaza URLs que apunten a localhost, IPs privadas/reservadas
// o metadata de cloud. Se usa antes de cualquier fetch hacia destinos provistos
// por el usuario (webhooks) y como validacion al guardar.

function err(message) {
  return Object.assign(new Error(message), { httpStatus: 400 });
}

// Rangos IPv4 privados/reservados (CIDR -> [base, bits]).
const BLOCKED_V4 = [
  [0, 8], [10, 8], [127, 8], [169254 << 0, 16], // 169.254/16 se chequea aparte
];

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
    n >= ipv4ToInt('224.0.0.0') // multicast + reservado
  );
}

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '[::1]' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // loopback / ULA / link-local v6
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isBlockedIpv4(h);
  return false;
}

/**
 * Valida una URL de destino. Lanza si es interna/insegura. Devuelve la URL ok.
 * @param {string} raw
 * @param {{allowHttp?: boolean}} opts  permitir http:// (default true; webhooks lo permiten)
 */
function assertSafeUrl(raw, opts = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw err('URL invalida');
  }
  if (u.protocol !== 'https:' && !(opts.allowHttp !== false && u.protocol === 'http:')) {
    throw err('Solo se permiten URLs http(s)');
  }
  if (isBlockedHost(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw err('Destino no permitido: apunta a una IP/host interno o reservado');
  }
  return raw;
}

module.exports = { assertSafeUrl, isBlockedHost };
