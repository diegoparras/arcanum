'use strict';

// Webhooks salientes: avisan a n8n (o lo que sea) ante eventos. Cada webhook se
// suscribe a una lista de eventos. El payload va firmado con HMAC-SHA256 en el
// header X-Arcanum-Signature para que el receptor pueda validar el origen.

const crypto = require('crypto');
const db = require('../db');
const { assertSafeUrl } = require('../lib/ssrfguard');

const EVENTOS = ['comprobante_emitido', 'comprobante_rechazado', 'cert_por_vencer', 'arca_caido', 'arca_restablecido'];

async function listar() {
  const { rows } = await db.query('SELECT id, url, eventos, activo, created_at FROM webhooks ORDER BY id');
  return rows;
}

async function crear({ url, eventos, secret }) {
  if (!url || !/^https?:\/\//.test(url)) throw err('URL invalida', 400);
  assertSafeUrl(url); // anti-SSRF: rechaza localhost / IPs privadas / metadata
  const evs = (eventos && eventos.length ? eventos : EVENTOS).filter((e) => EVENTOS.includes(e));
  const { rows } = await db.query(
    'INSERT INTO webhooks (url, eventos, secret) VALUES ($1, $2, $3) RETURNING id, url, eventos, activo',
    [url, evs, secret || null],
  );
  return rows[0];
}

async function eliminar(id) {
  await db.query('DELETE FROM webhooks WHERE id = $1', [parseInt(id, 10)]);
  return { eliminado: id };
}

/** Dispara un evento a todos los webhooks suscriptos (best-effort, no bloquea). */
async function emitir(evento, payload) {
  let rows = [];
  try {
    ({ rows } = await db.query('SELECT url, secret FROM webhooks WHERE activo = true AND $1 = ANY(eventos)', [evento]));
  } catch {
    return;
  }
  const body = JSON.stringify({ evento, ts: new Date().toISOString(), data: payload });
  await Promise.all(
    rows.map(async (w) => {
      const headers = { 'Content-Type': 'application/json' };
      if (w.secret) {
        headers['X-Arcanum-Signature'] = 'sha256=' + crypto.createHmac('sha256', w.secret).update(body).digest('hex');
      }
      try {
        assertSafeUrl(w.url); // defensa en profundidad por si el destino cambio
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        await fetch(w.url, { method: 'POST', headers, body, signal: ctrl.signal }).finally(() => clearTimeout(t));
      } catch (e) {
        console.error('[arcanum][webhook] fallo', e.message);
      }
    }),
  );
}

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

module.exports = { listar, crear, eliminar, emitir, EVENTOS };
