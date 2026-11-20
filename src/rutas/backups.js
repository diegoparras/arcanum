'use strict';

// Backups y master key (solo superadmin):
//   GET  /api/backups                lista + huella de la master key + si se confirmo su resguardo
//   POST /api/backups                crea uno ahora
//   GET  /api/backups/:nombre        descarga (archivo cifrado)
//   GET  /api/sistema/master-key     { huella, respaldadaAt }
//   POST /api/sistema/master-key     { confirmo: true } -> "la guarde fuera del servidor"

const fs = require('fs');
const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole } = require('../auth/permisos');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function crearRutas({ backup, db } = {}) {
  const bk = () => backup || require('../services/backup');
  const base = () => db || require('../db');

  async function estadoMasterKey() {
    const { rows } = await base().query("SELECT value FROM settings WHERE key = 'master_key_respaldada_at'");
    const vault = require('../crypto/vault');
    return { huella: vault.huella(), respaldadaAt: rows[0] ? rows[0].value : null };
  }

  return async function manejar(req, res, url, seg, principal) {
    const esBackups = seg[0] === 'api' && seg[1] === 'backups';
    const esMk = seg[0] === 'api' && seg[1] === 'sistema' && seg[2] === 'master-key' && !seg[3];
    if (!esBackups && !esMk) return false;
    requireRole(principal, 'superadmin');
    req._op = esBackups ? 'backups' : 'master-key';

    if (esMk && req.method === 'GET') return json(res, 200, { ok: true, masterKey: await estadoMasterKey() });
    if (esMk && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (b.confirmo !== true) throw Object.assign(new Error('Falta { confirmo: true }'), { httpStatus: 400 });
      await base().query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('master_key_respaldada_at', now()::text, $1, now()) ON CONFLICT (key) DO UPDATE SET value = now()::text, updated_by = $1, updated_at = now()",
        [principal.username]);
      return json(res, 200, { ok: true, masterKey: await estadoMasterKey() });
    }
    if (esBackups && req.method === 'GET' && !seg[2]) {
      return json(res, 200, { ok: true, backups: bk().listar(bk().directorio()), masterKey: await estadoMasterKey() });
    }
    if (esBackups && req.method === 'POST' && !seg[2]) {
      return json(res, 200, { ok: true, backup: await bk().crear() });
    }
    if (esBackups && req.method === 'GET' && seg[2] && !seg[3]) {
      const ruta = bk().ruta(bk().directorio(), seg[2]);
      if (!fs.existsSync(ruta)) throw Object.assign(new Error('No existe ese backup'), { httpStatus: 404 });
      const datos = fs.readFileSync(ruta);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': datos.length, 'Content-Disposition': `attachment; filename="${seg[2]}"` });
      res.end(datos);
      return true;
    }
    return false;
  };
}

module.exports = { crearRutas };
