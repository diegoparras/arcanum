'use strict';

// Rutas REST de Mis Comprobantes y de la conexion con Fisherboy.
//
//   GET/PUT  /api/fisherboy/config                      superadmin (el token nunca vuelve)
//   GET      /api/fisherboy/salud                       admin+
//   GET      /api/mis-comprobantes/receta               admin+
//   PUT/DEL  /api/mis-comprobantes/receta               superadmin (DELETE = restaurar)
//   GET      /api/mis-comprobantes/corridas/:id         quien pueda operar ese CUIT
//   GET      /api/mis-comprobantes/corridas/:id/frame   vista en vivo (JPEG, 204 si no cambio)
//   GET      /api/mis-comprobantes/corridas/:id/captura pantalla del robot al fallar (JPEG, 404 si no hay)
//   POST     /api/mis-comprobantes/corridas/:id/{evento,tomar-control,devolver,cancelar}
//   GET      /api/mis-comprobantes/:cuit                comprobantes bajados (cualquier rol, con scope)
//   GET      /api/mis-comprobantes/:cuit/descargados    listado paginado por cursor (integraciones, MCP)
//   GET      /api/mis-comprobantes/:cuit/analisis       totales, graficos y subtotales (mismos filtros)
//   GET      /api/mis-comprobantes/:cuit/export.csv
//   GET      /api/mis-comprobantes/:cuit/corridas
//   GET      /api/mis-comprobantes/:cuit/recibidos?desde=&hasta=  recibidos del rango y cobertura (conciliacion de Factorum)
//   GET      /api/mis-comprobantes/:cuit/rango?tipo=      proxima sincronizacion (incremental)
//   GET/PUT/DELETE /api/mis-comprobantes/:cuit/credencial   (PUT/DELETE admin+)
//   POST     /api/mis-comprobantes/:cuit/sincronizar    admin+ u operador con ese CUIT -> 202
//   POST/GET /api/mis-comprobantes/:cuit/constatar      arranca (202) / sigue la constatacion de recibidos (WSCDC + APOC)
//   POST     /api/mis-comprobantes/:cuit/constatar/detener  la corta: lo constatado queda, el resto sigue pendiente
//   POST     /api/constatacion                          { cuit, items | csv } constatacion masiva
//
// Los bodies no se registran en la auditoria (logRequest guarda solo la ruta y el estado), asi
// que ni la clave fiscal del PUT credencial ni lo que se tipea en la vista en vivo quedan en logs.

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed } = require('../auth/permisos');

const EVENTOS_HUMANOS = new Set(['click', 'doble', 'texto', 'tecla', 'scroll', 'atras', 'recargar']);

// Vista en vivo (auditoria 2026-11-26, A-02). El navegador de Fisherboy ya entro a ARCA con la
// clave fiscal, que solo carga un admin. Admin y superadmin lo manejan siempre. Un operador:
//  - toma el control solo cuando la corrida pidio una persona (esperando_humano);
//  - manda eventos mientras ARCA pide una persona o despues de tomar el control el mismo (nunca
//    con el control en manos de otro);
//  - y solo con el navegador en el login de ARCA o en Mis Comprobantes (no en el portal, desde
//    donde se llega a cualquier servicio del contribuyente). La URL es la ultima que informo
//    Fisherboy en la vista en vivo; sin URL conocida, no.
const esAdmin = (p) => p && (p.role === 'admin' || p.role === 'superadmin');
function paginaPermitida(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.protocol !== 'https:') return false;
  if (/^auth\.(afip|arca)\.gob\.ar$/.test(x.hostname)) return true;
  return /^fes\.(afip|arca)\.gob\.ar$/.test(x.hostname) && x.pathname.startsWith('/mcmp/');
}
const lugar = (u) => { try { const x = new URL(String(u)); return (x.hostname + x.pathname).slice(0, 160); } catch { return '?'; } };

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function puedeOperar(principal, cuit) {
  requireRole(principal, 'superadmin', 'admin', 'operador');
  assertCuitAllowed(principal, cuit);
}

function crearRutas({ mc, fisherboy, constatacion } = {}) {
  const servicio = () => mc || require('../services/misComprobantes').servicio();
  const fb = () => fisherboy || require('../services/fisherboy');
  const cons = () => constatacion || require('../services/constatacion');
  // Por corrida: ultima URL que mostro el navegador y quien tomo el control (en memoria: una
  // instancia; tras un reinicio el operador vuelve a tomarlo).
  const vivo = new Map();
  const estadoVivo = (id) => { if (!vivo.has(id)) vivo.set(id, { url: null, control: null }); return vivo.get(id); };

  async function corridaOperable(principal, id) {
    if (!/^\d+$/.test(String(id))) throw err('Corrida inválida', 400);
    const c = await servicio().corrida(Number(id));
    if (!c) throw err('No existe esa corrida', 404);
    puedeOperar(principal, c.cuit);
    return c;
  }

  return async function manejar(req, res, url, seg, principal) {
    if (seg[0] !== 'api') return false;

    // --- conexion con Fisherboy ---
    if (seg[1] === 'fisherboy' && seg[2] === 'config' && !seg[3]) {
      requireRole(principal, 'superadmin');
      const fbMod = require('../services/fisherboy');
      if (req.method === 'GET') return json(res, 200, { ok: true, fisherboy: await fbMod.config() });
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        return json(res, 200, { ok: true, fisherboy: await fbMod.guardarConfig(b, principal.username) });
      }
    }
    if (req.method === 'GET' && seg[1] === 'fisherboy' && seg[2] === 'salud' && !seg[3]) {
      requireRole(principal, 'superadmin', 'admin');
      try {
        return json(res, 200, { ok: true, fisherboy: await fb().salud() });
      } catch (e) {
        return json(res, 200, { ok: true, fisherboy: { ok: false, error: e.message } });
      }
    }

    // --- constatacion masiva (WSCDC + APOC) de una lista o un CSV ---
    if (req.method === 'POST' && seg[1] === 'constatacion' && !seg[2]) {
      const b = await readJsonBody(req);
      const cuit = String(b.cuit || '').replace(/\D/g, '');
      if (cuit.length !== 11) throw err('Falta "cuit": quien recibió los comprobantes (con certificado y WSCDC)', 400);
      // Solo consulta y no guarda nada: alcanza con cualquier rol, siempre dentro de sus CUITs.
      assertCuitAllowed(principal, cuit);
      req._cuit = cuit;
      req._op = 'constatacion';
      const items = typeof b.csv === 'string' ? cons().parsearListaCsv(b.csv, cuit) : b.items;
      return json(res, 200, { ok: true, constatacion: await cons().constatarLista(cuit, items) });
    }

    if (seg[1] !== 'mis-comprobantes') return false;
    req._op = 'mis-comprobantes';

    // --- receta ---
    if (seg[2] === 'receta' && !seg[3]) {
      if (req.method === 'GET') {
        requireRole(principal, 'superadmin', 'admin');
        return json(res, 200, { ok: true, receta: await servicio().receta() });
      }
      requireRole(principal, 'superadmin');
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        return json(res, 200, { ok: true, receta: await servicio().guardarReceta(b, principal.username) });
      }
      if (req.method === 'DELETE') return json(res, 200, { ok: true, receta: await servicio().restaurarReceta() });
      return false;
    }

    // --- una corrida y su vista en vivo ---
    if (seg[2] === 'corridas' && seg[3]) {
      const c = await corridaOperable(principal, seg[3]);
      req._cuit = c.cuit;
      if (req.method === 'GET' && !seg[4]) {
        // Sin el token de la sesion de Fisherboy ni el log crudo del robot (B-02).
        const { token_fb: _t, log: _l, ...publica } = c; // eslint-disable-line no-unused-vars
        return json(res, 200, { ok: true, corrida: publica });
      }
      if (req.method === 'GET' && seg[4] === 'captura' && !seg[5]) {
        const img = await servicio().captura(c.id);
        if (!img) throw err('Esta corrida no tiene pantalla guardada', 404);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(img);
        return true;
      }
      if (!c.token_fb) throw err('La corrida todavía no tiene navegador', 409);
      if (req.method === 'GET' && seg[4] === 'frame') {
        const fr = await fb().frame(c.token_fb, url.searchParams.get('desde') || 0);
        const cab = { 'Cache-Control': 'no-store' };
        for (const h of ['x-agent-estado', 'x-agent-seq', 'x-agent-url']) {
          if (fr.headers && fr.headers[h]) cab[h] = String(fr.headers[h]);
        }
        if (cab['x-agent-url']) estadoVivo(c.id).url = cab['x-agent-url'];
        if (fr.status === 200) cab['Content-Type'] = 'image/jpeg';
        res.writeHead(fr.status === 200 || fr.status === 204 || fr.status === 202 ? fr.status : 502, cab);
        res.end(fr.status === 200 ? fr.body : undefined);
        return true;
      }
      if (req.method === 'POST' && seg[4] === 'evento') {
        const cmd = await readJsonBody(req);
        if (!cmd || !EVENTOS_HUMANOS.has(cmd.tipo)) throw err('Evento no permitido', 400);
        const v = estadoVivo(c.id);
        req._op = `evento:${cmd.tipo} @ ${v.url ? lugar(v.url) : '?'}`; // nunca lo tipeado
        if (!esAdmin(principal)) {
          // En esperando_humano Fisherboy ya espera a una persona (no hace falta tomar el control);
          // en humano, solo quien lo tomo. Si lo tomo otro, tampoco.
          const suyo = c.estado === 'esperando_humano' ? (!v.control || v.control === principal.username)
            : c.estado === 'humano' && v.control === principal.username;
          if (!suyo) {
            throw err('Para manejar el navegador primero tomá el control, cuando ARCA pida una persona', 403);
          }
          if (!paginaPermitida(v.url)) {
            throw err('Un operador solo puede manejar el login de ARCA y Mis Comprobantes. Para el resto, pedíselo a un admin.', 403);
          }
        }
        return json(res, 200, { ok: true, ...(await fb().evento(c.token_fb, cmd)) });
      }
      if (req.method === 'POST' && seg[4] === 'tomar-control') {
        req._op = 'tomar-control';
        if (!esAdmin(principal) && c.estado !== 'esperando_humano') {
          throw err('Un operador puede tomar el control solo cuando ARCA pide una persona (captcha o segundo factor)', 403);
        }
        const r = await fb().tomarControl(c.token_fb);
        estadoVivo(c.id).control = principal.username;
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'POST' && seg[4] === 'devolver') {
        req._op = 'devolver';
        const r = await fb().devolver(c.token_fb);
        estadoVivo(c.id).control = null;
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'POST' && seg[4] === 'cancelar') {
        req._op = 'cancelar';
        return json(res, 200, await servicio().cancelar(c.id, principal.username));
      }
      if (req.method === 'POST' && (seg[4] === 'ok' || seg[4] === 'no')) {
        await servicio().responderOk(c.id, seg[4] === 'ok');
        return json(res, 200, { ok: true });
      }
      return false;
    }

    // --- por CUIT ---
    const cuit = String(seg[2] || '').replace(/\D/g, '');
    if (cuit.length !== 11) return false;
    req._cuit = cuit;
    assertCuitAllowed(principal, cuit);
    const q = url.searchParams;
    const filtros = { tipo: q.get('tipo') || undefined, desde: q.get('desde') || undefined, hasta: q.get('hasta') || undefined, limite: q.get('limite') || undefined };
    // Los del clic en el analisis: filtran igual el analisis, el listado y el CSV.
    for (const k of ['clase', 'cbte', 'contraparte', 'q']) if (q.get(k)) filtros[k] = q.get(k);

    if (req.method === 'GET' && !seg[3]) {
      return json(res, 200, { ok: true, cuit, comprobantes: await servicio().listar(cuit, filtros) });
    }
    if (req.method === 'GET' && seg[3] === 'descargados' && !seg[4]) {
      // Listado paginado para integraciones (SecretarIA, n8n): montos en número, cursor estable.
      const descargados = require('../services/descargados');
      const f = descargados.normalizarFiltros(Object.fromEntries(['tipo', 'desde', 'hasta', 'cuit', 'tipoCbte', 'limite', 'cursor'].map((k) => [k, q.get(k)])));
      return json(res, 200, { ok: true, cuit, filtros: descargados.filtrosVisibles(f), ...(await descargados.listar(cuit, f)) });
    }
    if (req.method === 'GET' && seg[3] === 'analisis' && !seg[4]) {
      const f = Object.fromEntries(Object.entries(filtros).filter(([k, v]) => k !== 'limite' && v !== undefined));
      return json(res, 200, { ok: true, cuit, analisis: await servicio().analisis(cuit, f) });
    }
    if (req.method === 'GET' && seg[3] === 'export.csv') {
      const csv = await servicio().exportarCsv(cuit, filtros);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mis-comprobantes-${cuit}.csv"` });
      res.end(csv);
      return true;
    }
    // Para la conciliacion de Factorum: los recibidos del rango (hasta 20.000) y que periodo esta
    // bajado. Es un GET: alcanza con el rol lectura, siempre dentro de los CUITs de la clave.
    if (req.method === 'GET' && seg[3] === 'recibidos' && !seg[4]) {
      req._op = 'mis-comprobantes:recibidos';
      const r = await servicio().recibidos(cuit, { desde: q.get('desde'), hasta: q.get('hasta'), limite: q.get('limite') || undefined });
      // Sin sangria: con miles de filas el JSON con espacios pesa el doble.
      const body = JSON.stringify({ ok: true, ...r });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    if (req.method === 'GET' && seg[3] === 'corridas') {
      return json(res, 200, { ok: true, corridas: await servicio().corridas(cuit, q.get('limite')) });
    }
    if (seg[3] === 'credencial') {
      if (req.method === 'GET') {
        // Franja de la diaria y el minuto que le toca hoy a este CUIT (cambia cada dia).
        const daemon = require('../daemon');
        const cfg = daemon.horaMcDiaria();
        const fin = cfg.hora * 60 + cfg.ventana;
        const diaria = { ...cfg, hasta: `${Math.floor(fin / 60)}:${String(fin % 60).padStart(2, '0')}`, hoy: daemon.horarioMc(cfg, cuit, daemon.rangoDiario(new Date()).hoy).texto };
        return json(res, 200, { ok: true, credencial: await servicio().estadoCredencial(cuit), diaria });
      }
      requireRole(principal, 'superadmin', 'admin');
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        const credencial = await servicio().guardarCredencial(cuit, { cuitLogin: b.cuitLogin, clave: b.clave, sincronizar: b.sincronizar }, principal.username);
        return json(res, 200, { ok: true, credencial });
      }
      if (req.method === 'DELETE') {
        await servicio().borrarCredencial(cuit);
        return json(res, 200, { ok: true });
      }
      return false;
    }
    // Constatar los recibidos pendientes (con los filtros del analisis) corre en segundo plano:
    // POST lo arranca (202) y GET devuelve el progreso.
    if (req.method === 'POST' && seg[3] === 'constatar' && seg[4] === 'detener') {
      puedeOperar(principal, cuit);
      return json(res, 200, { ok: true, constatacion: cons().detenerConstatacion(cuit) });
    }
    if (req.method === 'POST' && seg[3] === 'constatar' && !seg[4]) {
      puedeOperar(principal, cuit);
      const b = await readJsonBody(req);
      const pedidos = (b && typeof b.filtros === 'object' && b.filtros) || {};
      const filtros = {};
      for (const k of ['desde', 'hasta', 'clase', 'cbte', 'contraparte', 'q']) if (pedidos[k]) filtros[k] = String(pedidos[k]).slice(0, 80);
      const constatacion = await cons().iniciarConstatacion(cuit, { filtros, limite: b && b.limite, usuario: principal.username });
      return json(res, 202, { ok: true, constatacion });
    }
    if (req.method === 'GET' && seg[3] === 'constatar' && !seg[4]) {
      return json(res, 200, { ok: true, constatacion: cons().estadoConstatacion(cuit) });
    }
    if (req.method === 'GET' && seg[3] === 'rango') {
      return json(res, 200, { ok: true, rango: await servicio().rangoSugerido(cuit, q.get('tipo') || 'ambos') });
    }
    if (req.method === 'POST' && seg[3] === 'sincronizar') {
      puedeOperar(principal, cuit);
      const b = await readJsonBody(req);
      const corrida = await servicio().sincronizar(cuit, { tipo: b.tipo || 'ambos', desde: b.desde, hasta: b.hasta, origen: 'manual', usuario: principal.username });
      servicio().lanzar(corrida.id);
      return json(res, 202, { ok: true, corrida });
    }
    return false;
  };
}

module.exports = { crearRutas, EVENTOS_HUMANOS };
