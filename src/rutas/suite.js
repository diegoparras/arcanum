'use strict';

// Rutas de la suite Escriba (pase entre apps, ver docs/suite-pase.md y src/services/suite.js).
//
// Antes de la autenticacion general (cada una se autentica a su manera):
//   POST /api/suite/pase           solo una clave de API habilitada para la suite (nunca una sesion)
//   GET  /suite/entrar?pase=       publica: el pase es la credencial; abre la sesion y va a /
// Con sesion:
//   GET  /api/suite/apps           cualquier rol
//   POST /api/suite/abrir/:app     cualquier rol, tambien lectura (excepcion en permisos.js)
//   GET/PUT /api/suite/config      superadmin: URL publica de Arcanum y alta automatica
//   GET  /api/suite/auditoria      admin+
//
// El token del pase va en la URL de /suite/entrar, que no pasa por la auditoria de pedidos
// (solo registra /api/...). Igual se responde con Referrer-Policy: no-referrer y sin cache.

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole } = require('../auth/permisos');
const session = require('../auth/session');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function ipDe(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null;
}

/**
 * @param {object} deps
 *  - suite: crearSuite(...) (src/services/suite.js)
 *  - principalDeClave(req): principal de la clave presentada, null sin clave, tira 401 si es invalida
 *  - aplicarLimite(req, res, principal): limite por minuto de la clave (opcional)
 */
function crearRutas({ suite, principalDeClave, aplicarLimite } = {}) {
  const st = () => suite || require('../services/suite').servicio();

  async function publicas(req, res, url) {
    if (url.pathname === '/api/suite/pase') {
      if (req.method !== 'POST') return false;
      req._op = 'suite.pase';
      req._ip = ipDe(req);
      const clave = await principalDeClave(req);
      if (!clave) {
        throw Object.assign(new Error('Falta la clave: enviá X-API-Key o Authorization: Bearer <clave> (una clave de Arcanum habilitada para la suite).'), { httpStatus: 401 });
      }
      req._user = clave.username;
      if (aplicarLimite) aplicarLimite(req, res, clave);
      const cuerpo = await readJsonBody(req);
      return json(res, 200, await st().emitirPase(clave, cuerpo && typeof cuerpo === 'object' ? cuerpo : {}, { ip: req._ip }));
    }

    if (req.method === 'GET' && url.pathname === '/suite/entrar') {
      const cfg = await st().config().catch(() => ({ urlPublica: '' }));
      const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || /^https:/i.test(cfg.urlPublica || '');
      const principal = await st().canjearPase(url.searchParams.get('pase'), { ip: ipDe(req) }).catch((e) => {
        console.error('[arcanum] suite: no se pudo canjear un pase:', e.message);
        return null;
      });
      const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      if (!principal) {
        // Al login (la UI muestra el mensaje del contrato). Nunca a una URL de vuelta ajena.
        res.writeHead(302, { ...headers, Location: '/?suite=pase-vencido' });
        res.end();
        return true;
      }
      res.writeHead(302, { ...headers, 'Set-Cookie': session.cookieHeader(session.sign(principal), { https }), Location: '/' });
      res.end();
      return true;
    }
    return false;
  }

  async function privadas(req, res, url, seg, principal) {
    if (seg[0] !== 'api' || seg[1] !== 'suite') return false;
    req._op = `suite.${seg[2] || ''}`;

    if (req.method === 'GET' && seg[2] === 'apps' && !seg[3]) {
      if (principal.via === 'clave' || principal.via === 'maestra') return json(res, 200, { ok: true, apps: [] });
      return json(res, 200, { ok: true, apps: await st().apps() });
    }
    if (req.method === 'POST' && seg[2] === 'abrir' && seg[3] && !seg[4]) {
      return json(res, 200, await st().abrir(seg[3], principal, { ip: ipDe(req) }));
    }
    if (seg[2] === 'config' && !seg[3]) {
      requireRole(principal, 'superadmin');
      if (req.method === 'GET') return json(res, 200, { ok: true, suite: await st().config() });
      if (req.method === 'PUT') return json(res, 200, { ok: true, suite: await st().guardarConfig(await readJsonBody(req), principal.username) });
      return false;
    }
    if (req.method === 'GET' && seg[2] === 'auditoria' && !seg[3]) {
      requireRole(principal, 'superadmin', 'admin');
      return json(res, 200, { ok: true, eventos: await st().auditoria(url.searchParams.get('limite')) });
    }
    return false;
  }

  return { publicas, privadas };
}

module.exports = { crearRutas };
