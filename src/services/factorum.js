'use strict';

// Cliente de Factorum: el lector de facturas (QR, texto, OCR, IA opcional, controles y
// constatacion del CAE). Es un servicio aparte, en Go (ver su docs/API.md); Arcanum le hace de
// puerta con sus propios usuarios, roles y scope por CUIT.
//
// Configuracion: FACTORUM_URL + FACTORUM_TOKEN (el FACTORUM_API_KEY de Factorum), o lo que el
// superadmin cargue desde la UI (settings 'factorum', token cifrado con el vault). El token
// nunca vuelve por la API. Ni los archivos ni los bodies de estas llamadas se registran en
// ningun lado: llevan facturas de clientes.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TIMEOUT_MS = 15000;
const TIMEOUT_LARGO_MS = 120000; // verificar y subir lotes: OCR e IA pueden tardar
const MAX_RESPUESTA = 30 * 1024 * 1024;
const MAX_ARCHIVO = 20 * 1024 * 1024; // por archivo (Factorum acepta hasta 25 MB por defecto)
const MAX_LOTE = 60 * 1024 * 1024; // suma de los archivos de un lote
const MAX_ARCHIVOS = 200; // archivos por lote (un ZIP cuenta como uno)

// Topes del body JSON que llega a Arcanum (base64 pesa 4/3 del archivo).
const MAX_BODY_VERIFICAR = Math.ceil((MAX_ARCHIVO * 4) / 3) + 64 * 1024;
const MAX_BODY_LOTE = Math.ceil((MAX_LOTE * 4) / 3) + 256 * 1024;

const FILTROS = ['lote', 'estado', 'cliente', 'emisor', 'desde', 'hasta', 'q', 'limite', 'offset'];
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', zip: 'application/zip' };

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

// URL + token: ver services/conexiones.js (el token solo viaja al destino para el que se cargo).
const conexion = require('./conexiones').crearConexion({ clave: 'factorum', nombre: 'Factorum', varUrl: 'FACTORUM_URL', varToken: 'FACTORUM_TOKEN' });
const leerConfigDeBase = () => conexion.leer();

function pedir(cfg, method, ruta, { cuerpo, datos, tipo, timeoutMs = TIMEOUT_MS, binario = false } = {}) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(cfg.url); } catch { return reject(err('Factorum no está configurado (URL inválida)', 503)); }
    const lib = base.protocol === 'https:' ? https : http;
    let payload = datos || null;
    let contentType = tipo;
    if (cuerpo !== undefined) {
      payload = Buffer.from(JSON.stringify(cuerpo));
      contentType = 'application/json';
    }
    const req = lib.request(new URL(ruta, base), {
      method,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: binario ? '*/*' : 'application/json',
        ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const partes = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_RESPUESTA) { req.destroy(err('Respuesta de Factorum demasiado grande', 502)); return; }
        partes.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(partes) }));
    });
    req.on('timeout', () => req.destroy(err('Factorum no respondió a tiempo', 504)));
    req.on('error', (e) => reject(e.httpStatus ? e : err(`No se pudo contactar a Factorum (${e.code || e.message})`, 503)));
    if (payload) req.write(payload);
    req.end();
  });
}

function leerJson(body) {
  try { return body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { return {}; }
}

/** Error de Factorum -> error de Arcanum. 401/403 de Factorum es un problema de configuracion (502). */
function errorDe(r) {
  const d = leerJson(r.body);
  if (r.status === 401 || r.status === 403) return err('Factorum rechazó el token de Arcanum: revisá FACTORUM_TOKEN', 502);
  return err(`Factorum: ${d.error || d.detail || `respondió ${r.status}`}`, r.status >= 500 ? 502 : r.status);
}

function idValido(id, que = 'id') {
  if (!/^\d+$/.test(String(id))) throw err(`${que} inválido`, 400);
  return String(id);
}

/** Solo los filtros que entiende Factorum, sin vacios. */
function query(filtros = {}, permitidos = FILTROS) {
  const q = new URLSearchParams();
  for (const k of permitidos) {
    const v = filtros[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v).trim());
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Nombre de archivo apto para una cabecera multipart (sin comillas, saltos ni rutas). */
function nombreSeguro(nombre) {
  const base = String(nombre || '').split(/[\\/]/).pop().replace(/[\r\n"\u0000-\u001f]/g, '').trim();
  return base.slice(0, 200) || 'archivo';
}

function mimeDe(nombre) {
  const ext = String(nombre).toLowerCase().split('.').pop();
  return MIME[ext] || 'application/octet-stream';
}

/** Buffer de un archivo que llega como Buffer o como base64. */
function contenidoDe(a) {
  if (Buffer.isBuffer(a.contenido)) return a.contenido;
  const b64 = String(a.contenidoBase64 || a.contenido_base64 || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw err(`Falta el contenido de ${nombreSeguro(a.nombre)}`, 400);
  if (Math.floor((b64.length * 3) / 4) > MAX_ARCHIVO + 4) throw err(`${nombreSeguro(a.nombre)} supera ${MAX_ARCHIVO / 1024 / 1024} MB`, 413);
  return Buffer.from(b64, 'base64');
}

function multipart(campos, archivos) {
  const limite = `----arcanum${crypto.randomBytes(12).toString('hex')}`;
  const partes = [];
  for (const [k, v] of Object.entries(campos)) {
    if (v === undefined || v === null || v === '') continue;
    partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v).replace(/[\r\n]/g, ' ')}\r\n`));
  }
  for (const a of archivos) {
    const n = nombreSeguro(a.nombre);
    partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="archivos"; filename="${n}"\r\nContent-Type: ${mimeDe(n)}\r\n\r\n`));
    partes.push(a.buffer);
    partes.push(Buffer.from('\r\n'));
  }
  partes.push(Buffer.from(`--${limite}--\r\n`));
  return { datos: Buffer.concat(partes), tipo: `multipart/form-data; boundary=${limite}` };
}

const bool = (v) => (v === undefined || v === null ? undefined : (v === true || v === 'true' || v === 1 || v === '1' ? 'true' : 'false'));

function crearCliente({ leerConfig = leerConfigDeBase } = {}) {
  async function cfg() {
    const c = await leerConfig();
    if (!c || !c.url || !c.token) throw err('Factorum no está configurado: cargá FACTORUM_URL y FACTORUM_TOKEN (o la URL y el token en Ajustes)', 503);
    return c;
  }

  async function json(method, ruta, opts = {}) {
    const r = await pedir(await cfg(), method, ruta, opts);
    if (r.status >= 400) throw errorDe(r);
    return leerJson(r.body);
  }

  async function binario(ruta) {
    const r = await pedir(await cfg(), 'GET', ruta, { binario: true, timeoutMs: 60000 });
    if (r.status >= 400) throw errorDe(r);
    return {
      contentType: r.headers['content-type'] || 'application/octet-stream',
      contentDisposition: r.headers['content-disposition'] || null,
      body: r.body,
    };
  }

  return {
    async salud({ timeoutMs } = {}) {
      const r = await pedir(await cfg(), 'GET', '/healthz', timeoutMs ? { timeoutMs } : {});
      const d = leerJson(r.body);
      return { ...d, ok: r.status === 200 && d.ok !== false };
    },

    /**
     * Suite Escriba: pide a Factorum un pase para que esta persona entre sin loguearse
     * (POST /api/suite/pase, ver docs/suite-pase.md). Devuelve { url, vence }. Los errores de
     * Factorum vuelven con su mensaje; un 401 es el token de Arcanum (502, para que la UI no lo
     * tome como la sesion de Arcanum vencida). La URL nunca se loguea: lleva el pase.
     */
    async pase({ email, nombre, rol, cuits } = {}) {
      const cuerpo = { app: 'arcanum', email, nombre: nombre || email, rol, cuits: cuits && cuits.length ? cuits : null };
      const r = await pedir(await cfg(), 'POST', '/api/suite/pase', { cuerpo, timeoutMs: TIMEOUT_MS });
      const d = leerJson(r.body);
      if (r.status === 401) throw err('Factorum rechazo el token de Arcanum: revisa FACTORUM_TOKEN', 502);
      if (r.status === 404 && !d.error) throw err('Factorum no tiene el pase de la suite: actualizalo', 502);
      if (r.status >= 400) {
        const msg = d.error || d.detail || `respondio ${r.status}`;
        throw err(`Factorum: ${msg}`, r.status >= 500 ? 502 : r.status);
      }
      let destino = null;
      try { destino = new URL(String(d.url || '')); } catch { destino = null; }
      if (!d.ok || !destino || !['http:', 'https:'].includes(destino.protocol)) {
        throw err('Factorum no devolvio la direccion para entrar', 502);
      }
      return { url: destino.toString(), vence: d.vence || null };
    },

    /** Veredicto de una factura (no guarda nada: guardar=false). */
    async verificar({ nombre, contenidoBase64, cuitConsultante, ia } = {}) {
      if (!nombre) throw err('Falta "nombre" del archivo', 400);
      const buffer = contenidoDe({ nombre, contenidoBase64 });
      if (!buffer.length) throw err('El archivo está vacío', 400);
      if (buffer.length > MAX_ARCHIVO) throw err(`El archivo supera ${MAX_ARCHIVO / 1024 / 1024} MB`, 413);
      const cuerpo = { nombre: nombreSeguro(nombre), contenido_base64: buffer.toString('base64'), guardar: false };
      if (cuitConsultante) cuerpo.cuit_consultante = String(cuitConsultante);
      if (typeof ia === 'boolean') cuerpo.ia = ia;
      return json('POST', '/api/verificar', { cuerpo, timeoutMs: TIMEOUT_LARGO_MS });
    },

    /** Sube un lote (multipart): archivos [{ nombre, contenido: Buffer | contenidoBase64 }]. */
    async crearLote({ archivos, clienteCuit, nombre, ia, constatar } = {}) {
      if (!Array.isArray(archivos) || !archivos.length) throw err('Falta al menos un archivo', 400);
      if (archivos.length > MAX_ARCHIVOS) throw err(`Hasta ${MAX_ARCHIVOS} archivos por lote (un ZIP cuenta como uno)`, 413);
      let total = 0;
      const lista = archivos.map((a) => {
        const buffer = contenidoDe(a || {});
        if (buffer.length > MAX_ARCHIVO) throw err(`${nombreSeguro(a.nombre)} supera ${MAX_ARCHIVO / 1024 / 1024} MB`, 413);
        total += buffer.length;
        return { nombre: a.nombre, buffer };
      });
      if (total > MAX_LOTE) throw err(`El lote supera ${MAX_LOTE / 1024 / 1024} MB: partilo en varios`, 413);
      const { datos, tipo } = multipart({ cliente_cuit: clienteCuit, nombre, ia: bool(ia), constatar: bool(constatar) }, lista);
      return json('POST', '/api/lotes', { datos, tipo, timeoutMs: TIMEOUT_LARGO_MS });
    },

    lotes: async (filtros = {}) => json('GET', `/api/lotes${query(filtros, ['limite', 'offset'])}`),
    lote: async (id) => json('GET', `/api/lotes/${idValido(id, 'Lote')}`),
    comprobantes: async (filtros = {}) => json('GET', `/api/comprobantes${query(filtros)}`),
    comprobante: async (id) => json('GET', `/api/comprobantes/${idValido(id, 'Comprobante')}`),
    corregir: async (id, cuerpo) => json('PATCH', `/api/comprobantes/${idValido(id, 'Comprobante')}`, { cuerpo: cuerpo || {} }),
    resumen: async (filtros = {}) => json('GET', `/api/resumen${query(filtros)}`),

    /** Excel o CSV tal como lo arma Factorum. */
    async exportar(formato, filtros = {}) {
      if (!['xlsx', 'csv'].includes(formato)) throw err('Formato inválido: xlsx o csv', 400);
      return binario(`/api/export.${formato}${query(filtros)}`);
    },

    /** Archivo original de un documento (descomprimido y descifrado por Factorum). */
    archivo: async (docId) => binario(`/api/documentos/${idValido(docId, 'Documento')}/archivo`),
  };
}

/** Config visible para la UI: nunca devuelve el token. */
const config = () => conexion.config();

/** { url, token, borrarToken }: ver las reglas en services/conexiones.js. */
const guardarConfig = (datos, usuario) => conexion.guardar(datos || {}, usuario);

const cliente = crearCliente();

module.exports = {
  crearCliente, config, guardarConfig, ...cliente,
  LIMITES: { MAX_ARCHIVO, MAX_LOTE, MAX_ARCHIVOS, MAX_BODY_VERIFICAR, MAX_BODY_LOTE, TIMEOUT_MS, TIMEOUT_LARGO_MS },
};
