'use strict';

// Cliente de Fisherboy: Arcanum no trae navegador propio, usa la "sesion de agente" de
// Fisherboy (receta + IA + humano en vivo; ver fisherboy/docs/AGENT.md).
//
// Configuracion: FISHERBOY_URL + FISHERBOY_TOKEN (el API_TOKEN de Fisherboy), o lo que el
// superadmin cargue desde la UI (settings 'fisherboy', token cifrado con el vault). El token
// nunca vuelve por la API. Los bodies de estas llamadas NO se registran en ningun lado: el de
// iniciar() lleva la clave fiscal en `secretos`.

const http = require('http');
const https = require('https');

const TIMEOUT_MS = 15000;
const TIMEOUT_FRAME_MS = 8000;
const MAX_RESPUESTA = 25 * 1024 * 1024;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

// URL + token: ver services/conexiones.js (el token solo viaja al destino para el que se cargo).
const conexion = require('./conexiones').crearConexion({ clave: 'fisherboy', nombre: 'Fisherboy', varUrl: 'FISHERBOY_URL', varToken: 'FISHERBOY_TOKEN' });
const leerConfigDeBase = () => conexion.leer();

function pedir(cfg, method, ruta, { cuerpo, timeoutMs = TIMEOUT_MS, binario = false } = {}) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(cfg.url); } catch { return reject(err('Fisherboy no está configurado (URL inválida)', 503)); }
    const lib = base.protocol === 'https:' ? https : http;
    const datos = cuerpo === undefined ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = lib.request(new URL(ruta, base), {
      method,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: binario ? '*/*' : 'application/json',
        ...(datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}),
      },
    }, (res) => {
      const partes = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_RESPUESTA) { req.destroy(err('Respuesta de Fisherboy demasiado grande', 502)); return; }
        partes.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(partes) }));
    });
    req.on('timeout', () => req.destroy(err('Fisherboy no respondió a tiempo', 504)));
    req.on('error', (e) => reject(e.httpStatus ? e : err(`No se pudo contactar a Fisherboy (${e.code || e.message})`, 503)));
    if (datos) req.write(datos);
    req.end();
  });
}

function crearCliente({ leerConfig = leerConfigDeBase } = {}) {
  async function cfg() {
    const c = await leerConfig();
    if (!c || !c.url || !c.token) throw err('Fisherboy no está configurado: cargá FISHERBOY_URL y FISHERBOY_TOKEN', 503);
    return c;
  }

  async function json(method, ruta, cuerpo) {
    const r = await pedir(await cfg(), method, ruta, { cuerpo });
    let datos = {};
    try { datos = r.body.length ? JSON.parse(r.body.toString('utf8')) : {}; } catch { datos = {}; }
    if (r.status >= 400) {
      throw err(`Fisherboy: ${datos.detail || datos.error || `respondió ${r.status}`}`, r.status === 401 || r.status === 403 ? 502 : r.status);
    }
    return datos;
  }

  const t = (token) => encodeURIComponent(String(token));

  return {
    iniciar: (opts) => json('POST', '/api/agent/start', opts),
    estado: (token) => json('GET', `/api/agent/${t(token)}`),
    evento: (token, cmd) => json('POST', `/api/agent/${t(token)}/event`, cmd || {}),
    tomarControl: (token) => json('POST', `/api/agent/${t(token)}/takeover`, {}),
    devolver: (token) => json('POST', `/api/agent/${t(token)}/resume`, {}),
    ok: (token) => json('POST', `/api/agent/${t(token)}/ok`, {}),
    no: (token) => json('POST', `/api/agent/${t(token)}/no`, {}),
    cerrar: (token) => json('DELETE', `/api/agent/${t(token)}`),
    async frame(token, desde = 0) {
      const r = await pedir(await cfg(), 'GET', `/api/agent/${t(token)}/frame?desde=${Number(desde) || 0}`,
        { timeoutMs: TIMEOUT_FRAME_MS, binario: true });
      return { status: r.status, headers: r.headers, body: r.body };
    },
    async archivo(token, n) {
      const r = await pedir(await cfg(), 'GET', `/api/agent/${t(token)}/files/${Number(n)}`, { binario: true, timeoutMs: 60000 });
      if (r.status >= 400) throw err(`Fisherboy no entrego el archivo ${n} (${r.status})`, 502);
      return r.body;
    },
    /** Hay URL y token cargados (no prueba la conexion). La UI lo usa para mostrar o no
     *  lo que depende de Fisherboy. Ante cualquier error responde false. */
    async configurado() {
      try { const c = await leerConfig(); return !!(c && c.url && c.token); } catch { return false; }
    },
    async salud() {
      const r = await pedir(await cfg(), 'GET', '/healthz');
      return { ok: r.status === 200, ...(r.status === 200 ? JSON.parse(r.body.toString('utf8')) : {}) };
    },
  };
}

/** Config visible para la UI: nunca devuelve el token. */
const config = () => conexion.config();

/** { url, token, borrarToken }: ver las reglas en services/conexiones.js. */
const guardarConfig = (datos, usuario) => conexion.guardar(datos || {}, usuario);

const cliente = crearCliente();

module.exports = { crearCliente, config, guardarConfig, ...cliente };
