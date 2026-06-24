'use strict';

// Arcanum — gateway REST para los Web Services de ARCA (ex-AFIP).
// Servidor HTTP nativo (sin frameworks), al estilo del resto de la suite Escriba.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { config } = require('./config');
const { sendJson, sendError, readJsonBody } = require('./lib/http');
const db = require('./db');
const catalog = require('./catalog');
const engine = require('./soap/engine');
const introspect = require('./soap/introspect');
const daemon = require('./daemon');
const users = require('./auth/users');
const session = require('./auth/session');
const oidc = require('./auth/oidc');
const tenants = require('./auth/tenants');
const wsaa = require('./auth/wsaa');
const tokenStore = require('./auth/tokenStore');
const wsfev1 = require('./services/wsfev1');
const padron = require('./services/padron');
const onboarding = require('./services/onboarding');
const comprobantes = require('./services/comprobantes');
const pdf = require('./services/pdf');
const metrics = require('./services/metrics');
const webhooks = require('./services/webhooks');

// Si no se definio API key, generamos una y la mostramos una sola vez.
let API_KEY = config.apiKey;
if (!API_KEY) {
  API_KEY = crypto.randomBytes(24).toString('hex');
  console.log('\n[arcanum] No se definio ARCANUM_API_KEY. Clave generada para esta instancia:');
  console.log(`[arcanum]   ${API_KEY}`);
  console.log('[arcanum] Guardala: la necesitas en el header X-API-Key.\n');
}

function apiKeyValid(req) {
  const provided = req.headers['x-api-key'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Autenticacion: acepta API key (rol admin, para n8n) o sesion de UI (con su rol).
function checkAuth(req) {
  if (apiKeyValid(req)) return { username: 'apikey', role: 'admin' };
  const sess = session.fromRequest(req);
  if (sess) return sess;
  throw Object.assign(new Error('No autenticado: pegá tu X-API-Key o inicia sesion'), { httpStatus: 401 });
}

function requireRole(principal, ...roles) {
  if (!roles.includes(principal.role)) {
    throw Object.assign(new Error(`Requiere rol: ${roles.join(' o ')}`), { httpStatus: 403 });
  }
}

// Scoping por CUIT: admin/superadmin y la API key ven todo. Un usuario con
// cuit_allow definido solo puede operar esos CUITs (cierra el IDOR multi-tenant).
// Sin cuit_allow (default) = todos, para el modelo "un contador, todos sus CUITs".
function assertCuitAllowed(principal, cuit) {
  if (['superadmin', 'admin'].includes(principal.role)) return;
  const allow = principal.cuitAllow;
  if (!allow || !allow.length) return;
  const c = tenants.normalizeCuit(cuit);
  if (!c || !allow.includes(c)) throw Object.assign(new Error('No autorizado para ese CUIT'), { httpStatus: 403 });
}
function scopedRequiresCuit(principal) {
  return !['superadmin', 'admin'].includes(principal.role) && principal.cuitAllow && principal.cuitAllow.length;
}

// Rate-limit en memoria para el login (anti fuerza bruta).
const loginFails = new Map(); // key -> { count, until }
function loginThrottle(key) {
  const rec = loginFails.get(key);
  if (rec && rec.until > Date.now()) {
    throw Object.assign(new Error('Demasiados intentos. Espera unos minutos.'), { httpStatus: 429 });
  }
}
function loginFailed(key) {
  const rec = loginFails.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) rec.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (rec.count - 5));
  loginFails.set(key, rec);
}
function loginOk(key) {
  loginFails.delete(key);
}

function notFound() {
  return Object.assign(new Error('Recurso no encontrado'), { httpStatus: 404 });
}

// --- Rutas ---
async function route(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ej: ['api','wsfev1','status']
  const q = url.searchParams;

  // Publicas (sin API key)
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'arcanum', version: config.version, env: config.env });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) {
    return serveDashboard(res);
  }
  if (req.method === 'GET' && url.pathname === '/docs') {
    return serveDocsPage(res);
  }
  if (req.method === 'GET' && url.pathname === '/openapi.yaml') {
    return serveOpenapi(res);
  }
  // Metricas Prometheus: publicas (agregados, sin datos sensibles) para scrapers.
  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(await metrics.prometheus());
  }

  // Config de auth (publico): la UI lo usa para mostrar "Entrar con Lockatus".
  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    return sendJson(res, 200, { ok: true, oidc: oidc.enabled(), entorno: config.env });
  }
  // OIDC: inicio del login
  if (req.method === 'GET' && url.pathname === '/api/auth/oidc/login') {
    if (!oidc.enabled()) throw badRequest('Federacion OIDC no configurada');
    const redirectUri = oidcRedirect(req, url);
    const { url: authUrl, state, verifier } = await oidc.buildAuthUrl(redirectUri);
    res.setHeader('Set-Cookie', [
      `arcanum_oidc_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
      `arcanum_oidc_verifier=${verifier}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
    ]);
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }
  // OIDC: callback
  if (req.method === 'GET' && url.pathname === '/api/auth/oidc/callback') {
    const cookies = (req.headers.cookie || '').split(';').reduce((a, p) => {
      const i = p.indexOf('='); if (i > 0) a[p.slice(0, i).trim()] = p.slice(i + 1).trim(); return a;
    }, {});
    if (!url.searchParams.get('code') || url.searchParams.get('state') !== cookies.arcanum_oidc_state) {
      throw Object.assign(new Error('OIDC: state invalido'), { httpStatus: 400 });
    }
    const principal = await oidc.exchangeCode(url.searchParams.get('code'), cookies.arcanum_oidc_verifier, oidcRedirect(req, url));
    res.setHeader('Set-Cookie', [
      session.cookieHeader(session.sign(principal)),
      'arcanum_oidc_state=; Path=/; Max-Age=0',
      'arcanum_oidc_verifier=; Path=/; Max-Age=0',
    ]);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // Login de la UI (publico)
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const { username, password } = await readJsonBody(req);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const key = `${ip}:${username}`;
    loginThrottle(key);
    try {
      const principal = await users.login(username, password);
      loginOk(key);
      res.setHeader('Set-Cookie', session.cookieHeader(session.sign(principal)));
      return sendJson(res, 200, { ok: true, usuario: { username: principal.username, role: principal.role } });
    } catch (e) {
      loginFailed(key);
      throw e;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    res.setHeader('Set-Cookie', session.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
  }

  // A partir de aca, todo requiere autenticacion (API key o sesion).
  const principal = checkAuth(req);
  req._user = principal.username;
  req._ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;

  // GET /api/auth/me  -> quien soy
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    return sendJson(res, 200, { ok: true, usuario: principal });
  }

  // GET /api/tenants  -> CUITs con certificado cargado
  if (req.method === 'GET' && url.pathname === '/api/tenants') {
    let lista = await tenants.list(config.env);
    if (scopedRequiresCuit(principal)) lista = lista.filter((t) => principal.cuitAllow.includes(t.cuit));
    return sendJson(res, 200, { ok: true, tenants: lista, env: config.env });
  }

  // --- Catalogo de servicios ---
  // GET /api/services  -> lista completa con estado de activacion por CUIT (?cuit=)
  if (req.method === 'GET' && url.pathname === '/api/services') {
    return sendJson(res, 200, { ok: true, env: config.env, categorias: catalog.categorias(), servicios: catalog.list() });
  }
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'services' && seg[2] && !seg[3]) {
    const svc = catalog.get(seg[2]);
    if (!svc) throw notFound();
    return sendJson(res, 200, { ok: true, servicio: svc });
  }
  // GET /api/services/:id/operaciones -> introspeccion del WSDL en vivo
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'services' && seg[2] && seg[3] === 'operaciones') {
    return sendJson(res, 200, { ok: true, servicio: seg[2], operaciones: await introspect.operaciones(seg[2]) });
  }
  // Admin de catalogo (superadmin): crear/editar/borrar/restaurar
  if (seg[0] === 'api' && seg[1] === 'services' && req.method !== 'GET') {
    requireRole(principal, 'superadmin', 'admin');
    if (req.method === 'POST' && !seg[2]) {
      const def = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, servicio: await catalog.upsert(def, 'admin') });
    }
    if (req.method === 'PUT' && seg[2]) {
      const def = await readJsonBody(req);
      def.id = seg[2];
      return sendJson(res, 200, { ok: true, servicio: await catalog.upsert(def, 'admin') });
    }
    if (req.method === 'DELETE' && seg[2]) {
      return sendJson(res, 200, { ok: true, resultado: await catalog.remove(seg[2], 'admin') });
    }
    if (req.method === 'POST' && seg[2] && seg[3] === 'reset') {
      return sendJson(res, 200, { ok: true, servicio: await catalog.reset(seg[2], 'admin') });
    }
    if (req.method === 'POST' && seg[2] && seg[3] === 'enabled') {
      const { enabled } = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, servicio: await catalog.setEnabled(seg[2], enabled, 'admin') });
    }
  }

  // --- Passthrough generico: invocar cualquier operacion de cualquier servicio ---
  // POST /api/ws/:serviceId/:operacion   { cuit, params }
  if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'ws' && seg[2] && seg[3]) {
    const body = await readJsonBody(req);
    if (body.cuit) assertCuitAllowed(principal, body.cuit);
    const result = await engine.call(seg[2], seg[3], body.params || {}, { cuit: body.cuit, entorno: body.entorno });
    return sendJson(res, 200, { ok: true, servicio: seg[2], operacion: seg[3], resultado: result });
  }

  // GET /api/wsaa/:cuit/:service  -> fuerza/inspecciona el TA (diagnostico)
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'wsaa' && seg[2] && seg[3]) {
    const ta = await wsaa.getAccessTicket(seg[2], seg[3]);
    return sendJson(res, 200, { ok: true, token: ta.token.slice(0, 12) + '…', sign: '***', expirationTime: ta.expirationTime, service: ta.service });
  }
  // DELETE /api/wsaa/:cuit/:service -> invalida el TA cacheado
  if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'wsaa' && seg[2] && seg[3]) {
    await tokenStore.invalidate(tenants.normalizeCuit(seg[2]), seg[3], config.env);
    return sendJson(res, 200, { ok: true, mensaje: 'Ticket de acceso invalidado' });
  }

  // --- WSFEv1 ---
  if (seg[0] === 'api' && seg[1] === 'wsfev1') {
    // GET /api/wsfev1/status  (FEDummy)
    if (req.method === 'GET' && seg[2] === 'status') {
      return sendJson(res, 200, { ok: true, ...(await wsfev1.dummy()) });
    }
    // GET /api/wsfev1/parametros/:nombre?cuit=
    if (req.method === 'GET' && seg[2] === 'parametros' && seg[3]) {
      const cuit = requireQ(q, 'cuit');
      return sendJson(res, 200, { ok: true, parametro: seg[3], valores: await wsfev1.getParams(cuit, seg[3]) });
    }
    // GET /api/wsfev1/ultimo-autorizado?cuit=&puntoVenta=&tipoComprobante=
    if (req.method === 'GET' && seg[2] === 'ultimo-autorizado') {
      const cuit = requireQ(q, 'cuit');
      const pv = requireQ(q, 'puntoVenta');
      const tc = requireQ(q, 'tipoComprobante');
      return sendJson(res, 200, { ok: true, ...(await wsfev1.lastAuthorized(cuit, pv, tc)) });
    }
    // GET /api/wsfev1/consultar?cuit=&puntoVenta=&tipoComprobante=&numero=
    if (req.method === 'GET' && seg[2] === 'consultar') {
      const cuit = requireQ(q, 'cuit');
      const r = await wsfev1.consultar(cuit, requireQ(q, 'puntoVenta'), requireQ(q, 'tipoComprobante'), requireQ(q, 'numero'));
      return sendJson(res, 200, { ok: true, comprobante: r });
    }
    // POST /api/wsfev1/comprobantes   { cuit, ...comprobante }
    if (req.method === 'POST' && seg[2] === 'comprobantes') {
      requireRole(principal, 'superadmin', 'admin', 'operador');
      const inv = await readJsonBody(req);
      if (!inv.cuit) throw badRequest('Falta "cuit" (emisor) en el body');
      assertCuitAllowed(principal, inv.cuit);
      const result = await wsfev1.authorizeInvoice(inv.cuit, inv);
      return sendJson(res, result.aprobado ? 200 : 422, { ok: result.aprobado, comprobante: result });
    }
  }

  // --- Clientes (alta + ciclo de vida del certificado) ---
  if (seg[0] === 'api' && seg[1] === 'tenants' && seg.length > 1) {
    // Operaciones sensibles: nunca rol lectura; ademas scope por CUIT.
    if (req.method !== 'GET' || seg[3]) requireRole(principal, 'superadmin', 'admin', 'operador');
    if (seg[2]) assertCuitAllowed(principal, seg[2]);
    // POST /api/tenants  { cuit, nombre } -> genera CSR
    if (req.method === 'POST' && !seg[2]) {
      const { cuit, nombre } = await readJsonBody(req);
      assertCuitAllowed(principal, cuit);
      return sendJson(res, 200, { ok: true, ...(await onboarding.crearCliente(cuit, nombre)) });
    }
    // GET /api/tenants/:cuit/csr  -> recupera el CSR generado
    if (req.method === 'GET' && seg[2] && seg[3] === 'csr') {
      const csr = await onboarding.getCsr(seg[2]);
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': `attachment; filename="${seg[2]}.csr"` });
      return res.end(csr);
    }
    // POST /api/tenants/:cuit/certificate  { certPem } -> pega el .crt de ARCA
    if (req.method === 'POST' && seg[2] && seg[3] === 'certificate') {
      const { certPem } = await readJsonBody(req);
      return sendJson(res, 200, { ok: true, ...(await onboarding.cargarCertificado(seg[2], certPem)) });
    }
    // DELETE /api/tenants/:cuit
    if (req.method === 'DELETE' && seg[2]) {
      return sendJson(res, 200, { ok: true, ...(await onboarding.eliminarCliente(seg[2])) });
    }
  }

  // --- Metricas ---
  if (req.method === 'GET' && url.pathname === '/api/metrics') {
    return sendJson(res, 200, { ok: true, metricas: await metrics.resumen() });
  }

  // --- Comprobantes emitidos ---
  if (seg[0] === 'api' && seg[1] === 'comprobantes') {
    // Usuarios con scope por CUIT deben especificar un cuit autorizado.
    if (scopedRequiresCuit(principal) && (req.method === 'GET' && (!seg[2] || seg[2] === 'export.csv'))) {
      if (!q.get('cuit')) throw badRequest('Debes indicar un CUIT autorizado en ?cuit=');
      assertCuitAllowed(principal, q.get('cuit'));
    }
    // GET /api/comprobantes?cuit=&desde=&hasta=
    if (req.method === 'GET' && !seg[2]) {
      if (q.get('cuit')) assertCuitAllowed(principal, q.get('cuit'));
      const rows = await comprobantes.list({ cuit: q.get('cuit'), desde: q.get('desde'), hasta: q.get('hasta'), limit: q.get('limit') });
      return sendJson(res, 200, { ok: true, comprobantes: rows });
    }
    // GET /api/comprobantes/export.csv?...
    if (req.method === 'GET' && seg[2] === 'export.csv') {
      if (q.get('cuit')) assertCuitAllowed(principal, q.get('cuit'));
      const csv = await comprobantes.exportCsv({ cuit: q.get('cuit'), desde: q.get('desde'), hasta: q.get('hasta') });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="comprobantes.csv"' });
      return res.end(csv);
    }
    // GET /api/comprobantes/:cuit/:pv/:tipo/:nro/pdf
    if (req.method === 'GET' && seg[2] && seg[3] && seg[4] && seg[5] && seg[6] === 'pdf') {
      assertCuitAllowed(principal, seg[2]);
      const cmp = await comprobantes.get(seg[2], seg[3], seg[4], seg[5]);
      if (!cmp) throw notFound();
      const buf = await pdf.generar(cmp);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="cbte-${seg[3]}-${seg[5]}.pdf"` });
      return res.end(buf);
    }
  }

  // --- Usuarios (superadmin) ---
  if (seg[0] === 'api' && seg[1] === 'usuarios') {
    if (req.method === 'GET' && !seg[2]) {
      requireRole(principal, 'superadmin', 'admin');
      return sendJson(res, 200, { ok: true, usuarios: await users.listar() });
    }
    if (req.method === 'POST' && !seg[2]) {
      requireRole(principal, 'superadmin');
      return sendJson(res, 200, { ok: true, usuario: await users.crear(await readJsonBody(req)) });
    }
  }

  // --- Webhooks (configuracion del sistema: solo admin/superadmin) ---
  if (seg[0] === 'api' && seg[1] === 'webhooks') {
    requireRole(principal, 'superadmin', 'admin');
    if (req.method === 'GET' && !seg[2]) return sendJson(res, 200, { ok: true, webhooks: await webhooks.listar(), eventos: webhooks.EVENTOS });
    if (req.method === 'POST' && !seg[2]) return sendJson(res, 200, { ok: true, webhook: await webhooks.crear(await readJsonBody(req)) });
    if (req.method === 'DELETE' && seg[2]) return sendJson(res, 200, { ok: true, ...(await webhooks.eliminar(seg[2])) });
  }

  // --- Padron / Constancia ---
  // GET /api/padron/:alcance/:cuitConsulta?cuit=   (alcance: a13 | a5)
  if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'padron' && seg[2] && seg[3]) {
    const cuitRepre = requireQ(q, 'cuit');
    const datos = await padron.consultarPersona(seg[2], cuitRepre, seg[3]);
    return sendJson(res, 200, { ok: true, alcance: seg[2], cuit: seg[3], datos });
  }

  throw notFound();
}

function requireQ(q, name) {
  const v = q.get(name);
  if (!v) throw badRequest(`Falta el parametro de query "${name}"`);
  return v;
}
function badRequest(msg) {
  return Object.assign(new Error(msg), { httpStatus: 400 });
}
function oidcRedirect(req, url) {
  if (oidc.CFG.redirectUri) return oidc.CFG.redirectUri;
  const proto = req.headers['x-forwarded-proto'] || (config.isProd ? 'https' : 'http');
  return `${proto}://${req.headers.host || url.host}/api/auth/oidc/callback`;
}

function serveOpenapi(res) {
  const p = path.join(__dirname, '..', 'openapi.yaml');
  try {
    const yaml = fs.readFileSync(p, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
    res.end(yaml);
  } catch {
    sendError(res, Object.assign(new Error('openapi.yaml no encontrado'), { httpStatus: 404 }));
  }
}

function serveDashboard(res) {
  const p = path.join(__dirname, '..', 'public', 'index.html');
  try {
    const html = fs.readFileSync(p, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    sendError(res, Object.assign(new Error('UI no encontrada'), { httpStatus: 404 }));
  }
}

function serveDocsPage(res) {
  // Documentacion interactiva con Redoc (CDN). Solo la pagina de docs usa CDN;
  // la API en si no depende de nada externo.
  const html =
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<title>Arcanum — API ARCA</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '</head><body style="margin:0">' +
    '<redoc spec-url="/openapi.yaml"></redoc>' +
    '<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>' +
    '</body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function logRequest(req, res, url, startedAt) {
  if (!url.pathname.startsWith('/api/')) return;
  const seg = url.pathname.split('/').filter(Boolean);
  const service = seg[1] === 'ws' ? seg[2] : seg[1];
  const duration = Date.now() - startedAt;
  const ok = res.statusCode < 400;
  // No bloqueamos la respuesta: log best-effort.
  db.query(
    `INSERT INTO requests (cuit, service, http_method, path, status, ok, duration_ms, usuario, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [url.searchParams.get('cuit') || null, service || null, req.method, url.pathname, res.statusCode, ok, duration, req._user || null, req._ip || null],
  ).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.on('finish', () => logRequest(req, res, url, startedAt));
    await route(req, res, url);
  } catch (err) {
    sendError(res, err);
  }
});

async function start() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  console.log('[arcanum] conectando a Postgres...');
  await db.waitForDb();
  await db.migrate();
  await catalog.init();
  console.log(`[arcanum] catalogo: ${catalog.list().length} servicios cargados`);
  const seeded = await users.seedAdmin();
  if (seeded && seeded.generated) {
    console.log('\n[arcanum] Usuario superadmin creado: admin');
    console.log(`[arcanum]   contrasena: ${seeded.pass}`);
    console.log('[arcanum] Cambiala despues de entrar. (definí ARCANUM_ADMIN_PASS para fijarla)\n');
  }
  daemon.start();
  server.listen(config.port, () => {
    console.log(`[arcanum] v${config.version} escuchando en :${config.port} (entorno ARCA: ${config.env})`);
    console.log(`[arcanum] Docs: http://localhost:${config.port}/docs`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error('[arcanum] fallo el arranque:', e.message);
    process.exit(1);
  });
}

module.exports = { server, start };
