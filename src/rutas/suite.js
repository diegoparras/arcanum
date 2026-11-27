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
//
// Seguridad de 2.1.x que el pase respeta tal cual:
//  - La sesion que abre /suite/entrar es la misma del login (tabla `sesiones`, revocable, con su
//    sid en la cookie), con origen "suite": en cada pedido se relee el usuario y vale lo mas
//    restrictivo entre lo que dio el pase y lo que tiene hoy en Arcanum (ver checkAuth).
//  - Cookie Secure con la misma regla del login (https informado por el proxy, prod o
//    ARCANUM_COOKIE_SECURE=1).
//  - POST /api/suite/abrir/:app pasa por el control CSRF del servidor como cualquier pedido con
//    sesion. POST /api/suite/pase es solo con clave: no lee la cookie y no aplica CSRF.
//  - IP del cliente: la del proxy de confianza (ipCliente), no la que dice el cliente.

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole } = require('../auth/permisos');
const session = require('../auth/session');
const { ipCliente } = require('../auth/limiteLogin');

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

/**
 * @param {object} deps
 *  - suite: crearSuite(...) (src/services/suite.js)
 *  - principalDeClave(req): principal de la clave presentada, null sin clave, tira 401 si es invalida
 *  - aplicarLimite(req, res, principal): limite por minuto de la clave (opcional)
 *  - sesiones: servicio de src/auth/sesiones.js (en tests, uno en memoria)
 */
function crearRutas({ suite, principalDeClave, aplicarLimite, sesiones } = {}) {
  const st = () => suite || require('../services/suite').servicio();
  const ses = () => sesiones || require('../auth/sesiones').servicio();

  async function publicas(req, res, url) {
    if (url.pathname === '/api/suite/pase') {
      if (req.method !== 'POST') return false;
      req._op = 'suite.pase';
      req._ip = ipCliente(req);
      // Solo la clave: una cookie de sesion no se mira (ni siquiera si viene).
      const clave = await principalDeClave(req);
      if (!clave) {
        throw Object.assign(new Error('Falta la clave: enviá X-API-Key o Authorization: Bearer <clave> (una clave de Arcanum habilitada para la suite).'), { httpStatus: 401 });
      }
      req._user = clave.username;
      if (aplicarLimite) aplicarLimite(req, res, clave);
      const cuerpo = await readJsonBody(req, { max: 8 * 1024 }); // un pedido de pase no pesa mas
      return json(res, 200, await st().emitirPase(clave, cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : {}, { ip: req._ip }));
    }

    if (req.method === 'GET' && url.pathname === '/suite/entrar') {
      const ip = ipCliente(req);
      const principal = await st().canjearPase(url.searchParams.get('pase'), { ip }).catch((e) => {
        console.error('[arcanum] suite: no se pudo canjear un pase:', e.message);
        return null;
      });
      const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      let cookie = null;
      if (principal) {
        // La misma sesion que abre el login (M-06): registrada, revocable y con su sid en la cookie.
        try {
          const sid = await ses().crear(principal, 'suite');
          cookie = session.cookieHeader(session.sign({ ...principal, sid, origen: 'suite' }), req);
        } catch (e) {
          console.error('[arcanum] suite: no se pudo abrir la sesion del pase:', e.message);
        }
      }
      if (!cookie) {
        // Al login (la UI muestra el mensaje del contrato). Nunca a una URL de vuelta ajena.
        res.writeHead(302, { ...headers, Location: '/?suite=pase-vencido' });
        res.end();
        return true;
      }
      res.writeHead(302, { ...headers, 'Set-Cookie': cookie, Location: '/' });
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
      return json(res, 200, await st().abrir(seg[3], principal, { ip: ipCliente(req) }));
    }
    if (seg[2] === 'config' && !seg[3]) {
      requireRole(principal, 'superadmin');
      if (req.method === 'GET') return json(res, 200, { ok: true, suite: await st().config() });
      if (req.method === 'PUT') return json(res, 200, { ok: true, suite: await st().guardarConfig(await readJsonBody(req, { max: 8 * 1024 }), principal.username) });
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
