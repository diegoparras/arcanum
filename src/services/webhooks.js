'use strict';

// Webhooks salientes: avisan a n8n (o lo que sea) ante eventos. Cada webhook se
// suscribe a una lista de eventos. El payload va firmado con HMAC-SHA256 en el
// header X-Arcanum-Signature para que el receptor pueda validar el origen.

const crypto = require('crypto');
const db = require('../db');
const mailer = require('./mailer');
const { assertSafeUrl } = require('../lib/ssrfguard');

const EVENTOS = [
  'comprobante_emitido', 'comprobante_rechazado', 'cert_por_vencer', 'arca_caido', 'arca_restablecido',
  'comunicacion_nueva', // e-Ventanilla: llego una comunicacion de ARCA
  'clave_por_vencer', // una clave de API vence en menos de 7 dias
  'clave_anomala', // uso raro de una clave (barrido de CUITs, muchos rechazos)
  'mis_comprobantes_sincronizado', // termino una bajada de Mis Comprobantes
  'mis_comprobantes_fallo', // fallo una bajada, o necesita a una persona (captcha)
];

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

/** ¿Hay alguien escuchando este evento (webhook activo o email)? Evita trabajo inutil. */
async function hayInteresados(evento) {
  if (mailer.enabled()) return true;
  try {
    const { rows } = await db.query('SELECT 1 FROM webhooks WHERE activo = true AND $1 = ANY(eventos) LIMIT 1', [evento]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function enviar(w, body) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Arcanum-Webhook' };
  if (w.secret) {
    headers['X-Arcanum-Signature'] = 'sha256=' + crypto.createHmac('sha256', w.secret).update(body).digest('hex');
  }
  assertSafeUrl(w.url); // defensa en profundidad por si el destino cambio
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(w.url, { method: 'POST', headers, body, signal: ctrl.signal });
    return { status: r.status, ok: r.ok };
  } finally {
    clearTimeout(t);
  }
}

/** Dispara un evento a todos los webhooks suscriptos (best-effort, no bloquea). */
async function emitir(evento, payload) {
  mailer.notify(evento, payload).catch(() => {}); // email opcional, en paralelo
  let rows = [];
  try {
    ({ rows } = await db.query('SELECT url, secret FROM webhooks WHERE activo = true AND $1 = ANY(eventos)', [evento]));
  } catch {
    return;
  }
  const body = JSON.stringify({ evento, ts: new Date().toISOString(), data: payload });
  await Promise.all(
    rows.map(async (w) => {
      try {
        await enviar(w, body);
      } catch (e) {
        console.error('[arcanum][webhook] fallo', e.message);
      }
    }),
  );
}

/** Envia un evento "prueba" a UN webhook y devuelve lo que contesto el destino. */
async function probar(id) {
  const { rows } = await db.query('SELECT id, url, secret FROM webhooks WHERE id = $1', [parseInt(id, 10) || 0]);
  if (!rows.length) throw err('Webhook no encontrado', 404);
  const body = JSON.stringify({ evento: 'prueba', ts: new Date().toISOString(), data: { mensaje: 'Prueba de webhook de Arcanum' } });
  const t0 = Date.now();
  try {
    const r = await enviar(rows[0], body);
    return { entregado: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { entregado: false, error: e.name === 'AbortError' ? 'El destino no respondio en 8 s' : e.message, ms: Date.now() - t0 };
  }
}

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

module.exports = { listar, crear, eliminar, emitir, probar, hayInteresados, EVENTOS };
