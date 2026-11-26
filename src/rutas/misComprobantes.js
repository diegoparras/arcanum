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
//   POST     /api/mis-comprobantes/corridas/:id/{evento,tomar-control,devolver}
//   GET      /api/mis-comprobantes/:cuit                comprobantes bajados (cualquier rol, con scope)
//   GET      /api/mis-comprobantes/:cuit/analisis       totales, graficos y subtotales (mismos filtros)
//   GET      /api/mis-comprobantes/:cuit/export.csv
//   GET      /api/mis-comprobantes/:cuit/corridas
//   GET      /api/mis-comprobantes/:cuit/rango?tipo=      proxima sincronizacion (incremental)
//   GET/PUT/DELETE /api/mis-comprobantes/:cuit/credencial   (PUT/DELETE admin+)
//   POST     /api/mis-comprobantes/:cuit/sincronizar    admin+ u operador con ese CUIT -> 202
//   POST/GET /api/mis-comprobantes/:cuit/constatar      arranca (202) / sigue la constatacion de recibidos (WSCDC + APOC)
//   POST     /api/constatacion                          { cuit, items | csv } constatacion masiva
//
// Los bodies no se registran en la auditoria (logRequest guarda solo la ruta y el estado), asi
// que ni la clave fiscal del PUT credencial ni lo que se tipea en la vista en vivo quedan en logs.

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed } = require('../auth/permisos');

const EVENTOS_HUMANOS = new Set(['click', 'doble', 'texto', 'tecla', 'scroll', 'atras', 'recargar']);

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

  async function corridaOperable(principal, id) {
    if (!/^\d+$/.test(String(id))) throw err('Corrida invalida', 400);
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
      if (cuit.length !== 11) throw err('Falta "cuit": quien recibio los comprobantes (con certificado y WSCDC)', 400);
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
      if (req.method === 'GET' && !seg[4]) return json(res, 200, { ok: true, corrida: c });
      if (req.method === 'GET' && seg[4] === 'captura' && !seg[5]) {
        const img = await servicio().captura(c.id);
        if (!img) throw err('Esta corrida no tiene pantalla guardada', 404);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(img);
        return true;
      }
      if (!c.token_fb) throw err('La corrida todavia no tiene navegador', 409);
      if (req.method === 'GET' && seg[4] === 'frame') {
        const fr = await fb().frame(c.token_fb, url.searchParams.get('desde') || 0);
        const cab = { 'Cache-Control': 'no-store' };
        for (const h of ['x-agent-estado', 'x-agent-seq', 'x-agent-url']) {
          if (fr.headers && fr.headers[h]) cab[h] = String(fr.headers[h]);
        }
        if (fr.status === 200) cab['Content-Type'] = 'image/jpeg';
        res.writeHead(fr.status === 200 || fr.status === 204 || fr.status === 202 ? fr.status : 502, cab);
        res.end(fr.status === 200 ? fr.body : undefined);
        return true;
      }
      if (req.method === 'POST' && seg[4] === 'evento') {
        const cmd = await readJsonBody(req);
        if (!cmd || !EVENTOS_HUMANOS.has(cmd.tipo)) throw err('Evento no permitido', 400);
        return json(res, 200, { ok: true, ...(await fb().evento(c.token_fb, cmd)) });
      }
      if (req.method === 'POST' && seg[4] === 'tomar-control') return json(res, 200, { ok: true, ...(await fb().tomarControl(c.token_fb)) });
      if (req.method === 'POST' && seg[4] === 'devolver') return json(res, 200, { ok: true, ...(await fb().devolver(c.token_fb)) });
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
    if (req.method === 'GET' && seg[3] === 'corridas') {
      return json(res, 200, { ok: true, corridas: await servicio().corridas(cuit, q.get('limite')) });
    }
    if (seg[3] === 'credencial') {
      if (req.method === 'GET') return json(res, 200, { ok: true, credencial: await servicio().estadoCredencial(cuit), diaria: require('../daemon').horaMcDiaria() });
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
    if (req.method === 'POST' && seg[3] === 'constatar') {
      puedeOperar(principal, cuit);
      const b = await readJsonBody(req);
      const pedidos = (b && typeof b.filtros === 'object' && b.filtros) || {};
      const filtros = {};
      for (const k of ['desde', 'hasta', 'clase', 'cbte', 'contraparte', 'q']) if (pedidos[k]) filtros[k] = String(pedidos[k]).slice(0, 80);
      const constatacion = await cons().iniciarConstatacion(cuit, { filtros, limite: b && b.limite, usuario: principal.username });
      return json(res, 202, { ok: true, constatacion });
    }
    if (req.method === 'GET' && seg[3] === 'constatar') {
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
