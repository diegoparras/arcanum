'use strict';

// Utilidades HTTP compartidas: respuestas JSON y lectura de body con limite.

const MAX_BODY = 2 * 1024 * 1024; // 2 MB

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err.httpStatus || 500;
  // Si ya se mandaron las cabeceras no hay forma de responder un error: se corta la conexion.
  // Intentar escribir de nuevo tira ERR_HTTP_HEADERS_SENT y, sin manejador, cae el proceso (M-02).
  if (res.headersSent) {
    console.error('[arcanum] error con la respuesta ya empezada:', err.message);
    if (typeof res.destroy === 'function') res.destroy();
    return;
  }
  // Un 500 sin httpStatus es un error no previsto: el detalle va al log con un id y el cliente
  // recibe un mensaje generico (B-04). Los errores con httpStatus (incluidos 502/503 de ARCA) son
  // mensajes pensados para el usuario y se devuelven tal cual.
  const interno = !err.httpStatus;
  const id = interno ? require('crypto').randomBytes(4).toString('hex') : null;
  const payload = {
    ok: false,
    error: interno ? `Error interno (ref. ${id}).` : (err.message || 'Error interno'),
  };
  if (!interno && err.extra && err.extra.errors) payload.detalles = err.extra.errors;
  if (status >= 500) {
    console.error('[arcanum]' + (id ? ` [ref. ${id}]` : ''), err.stack || err.message);
  }
  sendJson(res, status, payload);
}

/** Body JSON con tope (2 MB por defecto; `max` lo sube para rutas que reciben archivos). */
function readJsonBody(req, { max = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('Body demasiado grande'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON inválido en el body'), { httpStatus: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function readTextBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body demasiado grande'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { sendJson, sendError, readJsonBody, readTextBody };
