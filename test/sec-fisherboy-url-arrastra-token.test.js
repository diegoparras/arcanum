'use strict';

// Auditoria de seguridad 2026-11-26, hallazgo A-07.
//
// `guardarConfig` de Fisherboy (y el gemelo de Factorum) acepta cualquier URL http(s) y, si el
// pedido no trae token, vuelve a guardar el token anterior junto con la URL nueva. Desde ese
// momento todo pedido sale con `Authorization: Bearer <token>` hacia el host nuevo, y la proxima
// sincronizacion de Mis Comprobantes le manda ademas la clave fiscal en claro (`secretos`).
// Alcanza con una sesion de superadmin (o con forjarla, hallazgo C-01): no hace falta conocer el
// token ni la master key.
//
// El test guarda URL + token del Fisherboy legitimo, despues cambia SOLO la URL a otro host y pide
// el estado de salud. Corregido en 2.1.13 (services/conexiones.js): estos tests evitan que vuelva.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.ARCANUM_MASTER_KEY = crypto.randomBytes(32).toString('hex');
process.env.ARCANUM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arcanum-sec-'));
delete process.env.FISHERBOY_URL;
delete process.env.FISHERBOY_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const db = require('../src/db');
const fisherboy = require('../src/services/fisherboy');

/** Servidor local que anota la cabecera Authorization de cada pedido. */
function hostFalso() {
  const vistos = [];
  const srv = http.createServer((req, res) => {
    vistos.push(req.headers.authorization || '');
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end('{"ok":true}');
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${srv.address().port}`,
    vistos,
    cerrar: () => { srv.closeAllConnections(); srv.close(); },
  })));
}

test('A-07: cambiar solo la URL de Fisherboy no le entrega el token de servicio al host nuevo', async () => {
  const settings = new Map();
  const original = db.query;
  db.query = async (sql, params = []) => {
    // La clave de settings puede venir literal en el SQL o como primer parametro ($1).
    if (/^\s*SELECT value FROM settings/i.test(sql)) {
      const clave = (/key = '([a-z_]+)'/i.exec(sql) || [])[1] || params[0];
      return { rows: settings.has(clave) ? [{ value: settings.get(clave) }] : [] };
    }
    if (/^\s*INSERT INTO settings/i.test(sql)) {
      const literal = (/VALUES \('([a-z_]+)'/i.exec(sql) || [])[1];
      if (literal) settings.set(literal, params[0]); else settings.set(params[0], params[1]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  const legitimo = await hostFalso();
  const otro = await hostFalso();
  const token = 'fb-' + crypto.randomBytes(12).toString('hex');
  try {
    await fisherboy.guardarConfig({ url: legitimo.url, token }, 'superadmin');
    await fisherboy.salud();
    assert.deepStrictEqual(legitimo.vistos, [`Bearer ${token}`], 'control: el Fisherboy legitimo recibe su token');

    // El cambio de host sin token nuevo deberia rechazarse o dejar la config sin token.
    await fisherboy.guardarConfig({ url: otro.url }, 'superadmin').catch(() => {});
    await fisherboy.salud().catch(() => {});

    assert.ok(
      !otro.vistos.includes(`Bearer ${token}`),
      'el host nuevo recibio el token de servicio de Fisherboy sin que nadie lo volviera a cargar',
    );
  } finally {
    db.query = original;
    legitimo.cerrar();
    otro.cerrar();
  }
});
