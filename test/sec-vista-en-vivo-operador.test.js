'use strict';

// AUDITORIA 2026-11-26, hallazgo A-02 (alto): la vista en vivo deja que un operador tome el
// control del navegador de Fisherboy en cualquier momento de una corrida, no solo cuando el
// robot pidio una persona (captcha). La corrida ya paso el login de ARCA con la clave fiscal que
// cargo un admin y que el operador no conoce: con tomar-control + eventos de click y teclado el
// operador maneja el portal de ARCA como el contribuyente (otros servicios, delegaciones,
// presentaciones), y nada de lo que hace queda en la auditoria (los bodies no se registran).
//
// Lo esperado: fuera del estado "esperando_humano", tomar el control exige admin o superadmin.
// Corregido en 2.1.13 (rutas/misComprobantes.js): este test evita que vuelva.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas } = require('../src/rutas/misComprobantes');
const { sendError } = require('../src/lib/http');

const CUIT = '30711111118';
const OPERADOR = { username: 'op', role: 'operador', cuitAllow: [CUIT] };

function dobles(estado) {
  const fb = { llamadas: [] };
  fb.tomarControl = async (t) => { fb.llamadas.push(['takeover', t]); return { ok: true, estado: 'humano' }; };
  fb.evento = async (t, cmd) => { fb.llamadas.push(['evento', t, cmd]); return { ok: true }; };
  const mc = { corrida: async (id) => ({ id: Number(id), cuit: CUIT, estado, token_fb: 'tok-1' }) };
  return { mc, fisherboy: fb };
}

async function conServidor(principal, deps, fn) {
  const manejar = crearRutas(deps);
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal);
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('un operador no toma el control de una corrida que no pidio una persona', async () => {
  const deps = dobles('corriendo');
  await conServidor(OPERADOR, deps, async (base) => {
    const r = await fetch(`${base}/api/mis-comprobantes/corridas/9/tomar-control`, { method: 'POST' });
    assert.ok([403, 409].includes(r.status), `tomar-control devolvio ${r.status} a un operador con la corrida en "corriendo"`);
    assert.deepStrictEqual(deps.fisherboy.llamadas, [], 'el pedido llego a Fisherboy');
  });
});
