'use strict';

// Conexion con un servicio de la suite (Fisherboy, Factorum): URL + token de servicio.
//
// El token es un secreto atado a un destino (auditoria 2026-11-26, A-07). Reglas:
//  - Cambiar la URL a otro host (protocolo, host o puerto distinto) exige cargar el token de
//    nuevo: el anterior nunca se manda a un destino para el que no se cargo. A Fisherboy, ademas
//    del token, viaja la clave fiscal de cada sincronizacion.
//  - Si la URL viene por entorno (FISHERBOY_URL, FACTORUM_URL), no se pisa desde el panel.
//  - El token del entorno solo se usa con la URL del entorno y nunca se copia a la base.
//  - La URL no puede ser metadata de la nube, link-local ni llevar usuario y clave; fuera de la
//    red interna tiene que ser https (el token viaja en cada pedido).
//  - Se puede borrar el token. Cada cambio de URL o de token avisa por webhook (sin el token).

const { isBlockedHost } = require('../lib/ssrfguard');

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

/** Host de la red interna: nombre sin puntos (servicio de Docker/EasyPanel), loopback o IP privada. */
function esInterno(host) {
  const h = host.toLowerCase();
  if (!h.includes('.') || h === 'localhost') return true;
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) && isBlockedHost(h); // privada, loopback o reservada
}

/** Normaliza y valida la URL de un servicio. Devuelve la URL sin barra final. Tira 400. */
function validarUrlServicio(raw, nombre) {
  const limpia = String(raw || '').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(limpia); } catch { throw err(`La URL de ${nombre} no es válida (ejemplo: http://${nombre.toLowerCase()}:8099)`, 400); }
  if (!['http:', 'https:'].includes(u.protocol)) throw err(`La URL de ${nombre} tiene que empezar con http:// o https://`, 400);
  if (u.username || u.password) throw err(`La URL de ${nombre} no puede llevar usuario ni clave: el token va aparte`, 400);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const n = host.split('.').map(Number);
  const metadata = host.endsWith('.internal') || (n.length === 4 && n.every(Number.isInteger) && ((n[0] === 169 && n[1] === 254) || n[0] === 0 || n[0] >= 224));
  if (metadata) throw err(`La URL de ${nombre} apunta a una dirección reservada (metadata de la nube o link-local)`, 400);
  if (u.protocol === 'http:' && !esInterno(host)) throw err(`Fuera de la red interna, la URL de ${nombre} tiene que ser https (el token viaja en cada pedido)`, 400);
  return limpia;
}

const destino = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`.toLowerCase(); } catch { return ''; } };

/**
 * @param {object} o
 * @param {string} o.clave    clave en la tabla settings ('fisherboy', 'factorum')
 * @param {string} o.nombre   para los mensajes ('Fisherboy')
 * @param {string} o.varUrl   variable de entorno de la URL
 * @param {string} o.varToken variable de entorno del token
 */
function crearConexion({ clave, nombre, varUrl, varToken, deps = {} }) {
  const db = () => deps.db || require('../db');
  const vault = () => deps.vault || require('../crypto/vault');
  const webhooks = () => deps.webhooks || require('./webhooks');
  const env = () => deps.env || process.env;
  let avisoUrl = false;

  async function guardada() {
    try {
      const { rows } = await db().query('SELECT value FROM settings WHERE key = $1', [clave]);
      return rows[0] && rows[0].value ? JSON.parse(rows[0].value) : {};
    } catch { return {}; } // sin tabla todavia: se usa el entorno
  }

  /** URL y token efectivos. El token del entorno solo acompana a la URL del entorno. */
  async function leer() {
    const g = await guardada();
    const urlEnv = String(env()[varUrl] || '').trim().replace(/\/+$/, '');
    const url = urlEnv || g.url || '';
    if (urlEnv && g.url && destino(g.url) !== destino(urlEnv) && !avisoUrl) {
      avisoUrl = true; // hasta 2.1.12 la URL guardada desde el panel le ganaba al entorno
      console.warn(`[arcanum] ${nombre}: se usa ${varUrl} (${urlEnv}); la URL guardada desde el panel (${g.url}) se ignora.`);
    }
    let token = '';
    if (g.tokenCifrado) {
      try { token = vault().decrypt(g.tokenCifrado); } catch { /* master key distinta */ }
    } else if (urlEnv && destino(url) === destino(urlEnv)) {
      token = env()[varToken] || '';
    }
    return { url, token };
  }

  /** Lo que ve el panel: nunca el token. */
  async function config() {
    const c = await leer();
    return { url: c.url, tokenCargado: !!c.token, urlDelEntorno: !!env()[varUrl] };
  }

  async function guardar({ url, token, borrarToken } = {}, usuario) {
    const g = await guardada();
    const urlEnv = String(env()[varUrl] || '').trim().replace(/\/+$/, '');
    const antes = (await leer()).url;
    let nueva = antes;
    if (url !== undefined && String(url).trim() !== '') {
      nueva = validarUrlServicio(url, nombre);
      if (urlEnv && destino(nueva) !== destino(urlEnv)) {
        throw err(`La URL de ${nombre} viene de la variable ${varUrl}: cambiala ahí, no desde el panel`, 409);
      }
    } else if (url !== undefined && !urlEnv) {
      nueva = ''; // URL vacia: se desconecta
    }
    const otroDestino = destino(nueva) !== destino(antes);
    let tokenCifrado = g.tokenCifrado || null;
    const tokenNuevo = token != null && String(token).trim() !== '';
    if (borrarToken || !nueva) tokenCifrado = null;
    else if (tokenNuevo) tokenCifrado = vault().encrypt(String(token).trim());
    else if (otroDestino && antes) {
      const habiaToken = !!g.tokenCifrado || !!env()[varToken];
      if (habiaToken) throw err(`Cambiaste el servidor de ${nombre}: volvé a cargar su token. El anterior no se manda a otro destino.`, 409);
    }
    await db().query(
      'INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()',
      [clave, JSON.stringify({ url: urlEnv ? '' : nueva, tokenCifrado }), usuario || null],
    );
    const tokenCambiado = tokenCifrado !== (g.tokenCifrado || null);
    if (otroDestino || tokenCambiado) {
      await webhooks().emitir('conexion_cambiada', { servicio: nombre, antes, despues: nueva, tokenCambiado, usuario: usuario || null }).catch(() => {});
    }
    return config();
  }

  return { leer, config, guardar };
}

module.exports = { crearConexion, validarUrlServicio };
