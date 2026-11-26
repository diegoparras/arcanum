'use strict';

// Rutas REST de Factorum (facturas recibidas). Arcanum hace de puerta: sus usuarios, roles y
// scope por CUIT; Factorum solo ve el token de servicio de Arcanum.
//
//   GET/PUT  /api/factorum/config                  superadmin (el token nunca vuelve)
//   GET      /api/factorum/salud                   cualquier rol (la UI muestra la pestana si da ok)
//   POST     /api/factorum/verificar               operador+  { nombre, contenido_base64, cuit_consultante?, ia? }
//   GET      /api/factorum/lotes                   cualquier rol (con scope: solo los de sus CUITs)
//   POST     /api/factorum/lotes                   operador+  { archivos: [{ nombre, contenido_base64 }], cliente_cuit?, nombre?, ia?, constatar? } -> 202
//   GET      /api/factorum/lotes/:id               cualquier rol, con scope
//   GET      /api/factorum/comprobantes            cualquier rol; filtros de Factorum (cliente con scope)
//   GET      /api/factorum/comprobantes/:id        cualquier rol, con scope
//   PATCH    /api/factorum/comprobantes/:id        operador+  { campos, aprobar } (el usuario lo pone Arcanum)
//   GET      /api/factorum/comprobantes/:id/archivo  el archivo original (binario)
//   GET      /api/factorum/resumen                 totales por alicuota, tipo y estado
//   GET      /api/factorum/export.xlsx|export.csv  binario, mismos filtros
//
// Ni los archivos ni los bodies se registran (logRequest guarda solo ruta y estado).

const { sendJson, readJsonBody } = require('../lib/http');
const { requireRole, assertCuitAllowed, scopedRequiresCuit } = require('../auth/permisos');
const { normalizeCuit } = require('../auth/tenants');

// Tipos que se sirven tal cual; cualquier otro va como descarga (nunca HTML del mismo origen).
const TIPOS_ARCHIVO = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function json(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

function puedeOperar(principal) {
  requireRole(principal, 'superadmin', 'admin', 'operador');
}

function cuitDe(valor, campo) {
  const c = normalizeCuit(valor);
  if (!/^\d{11}$/.test(c)) throw err(`"${campo}" debe ser un CUIT de 11 digitos`, 400);
  return c;
}

/**
 * Cliente (CUIT) con el que se filtra o se sube, respetando el scope. Si viene, tiene que estar
 * permitido. Si no viene y el principal esta acotado a CUITs: con uno solo se usa ese; con
 * varios hay que indicarlo (si no, veria los comprobantes de todos los clientes).
 */
function clienteDelAlcance(principal, valor, campo = 'cliente') {
  if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
    const c = cuitDe(valor, campo);
    assertCuitAllowed(principal, c);
    return c;
  }
  if (!scopedRequiresCuit(principal)) return undefined;
  if (principal.cuitAllow.length === 1) return principal.cuitAllow[0];
  throw err(`Indica "${campo}": tu usuario o clave esta limitado a ${principal.cuitAllow.length} CUITs (${principal.cuitAllow.join(', ')})`, 400);
}

/**
 * CUIT con certificado con el que Factorum constata en Arcanum. Si no viene y el principal
 * tiene un unico CUIT permitido, se usa ese. Acotado a varios: hay que indicarlo (si no,
 * Factorum usaria su ARCANUM_CUIT_CONSULTANTE, que puede ser de otro cliente).
 */
function consultanteDelAlcance(principal, valor) {
  if (valor !== undefined && valor !== null && String(valor).trim() !== '') {
    const c = cuitDe(valor, 'cuit_consultante');
    assertCuitAllowed(principal, c);
    return c;
  }
  const allow = principal.cuitAllow || [];
  if (allow.length === 1) return allow[0];
  if (scopedRequiresCuit(principal)) {
    throw err(`Indica "cuit_consultante": tu usuario o clave esta limitado a ${allow.length} CUITs (${allow.join(', ')})`, 400);
  }
  return undefined;
}

/** Un lote o comprobante de Factorum: con scope, su cliente tiene que estar permitido. */
function assertRecursoEnAlcance(principal, cuit) {
  if (!scopedRequiresCuit(principal)) return;
  if (!cuit) throw err('No autorizado: no tiene un cliente asignado', 403);
  assertCuitAllowed(principal, cuit);
}

function filtrosDe(q) {
  const f = {};
  for (const k of ['lote', 'estado', 'emisor', 'desde', 'hasta', 'q', 'limite', 'offset']) {
    const v = q.get(k);
    if (v !== null && v !== '') f[k] = v;
  }
  if (f.estado && !['ok', 'revisar', 'error', 'aprobado'].includes(f.estado)) throw err('"estado" debe ser ok, revisar, error o aprobado', 400);
  for (const k of ['desde', 'hasta']) {
    if (f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k])) throw err(`"${k}" debe tener la forma AAAA-MM-DD`, 400);
  }
  if (f.emisor) f.emisor = cuitDe(f.emisor, 'emisor');
  return f;
}

function nombreDescarga(nombre) {
  return String(nombre || 'archivo').replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'archivo';
}

function enviarBinario(res, archivo, { nombre, adjunto }) {
  const tipo = String(archivo.contentType || '').split(';')[0].trim().toLowerCase();
  const seguro = TIPOS_ARCHIVO.has(tipo) || (adjunto && /^(text\/csv|application\/vnd\.openxmlformats)/.test(tipo));
  const modo = adjunto || !seguro ? 'attachment' : 'inline';
  res.writeHead(200, {
    'Content-Type': seguro ? archivo.contentType : 'application/octet-stream',
    'Content-Disposition': `${modo}; filename="${nombreDescarga(nombre)}"`,
    'Content-Length': archivo.body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.end(archivo.body);
  return true;
}

function crearRutas({ factorum } = {}) {
  const fa = () => factorum || require('../services/factorum');
  const limites = () => (factorum && factorum.LIMITES) || require('../services/factorum').LIMITES;
  // Antes de leer (y decodificar) un cuerpo de hasta 80 MB, que Factorum este conectado (B-16).
  async function exigirConfigurado() {
    const c = await fa().config();
    if (!c || !c.url || !c.tokenCargado) throw err('Factorum no esta configurado: carga su URL y su token en Ajustes', 503);
  }

  async function comprobanteEnAlcance(principal, id) {
    if (!/^\d+$/.test(String(id))) throw err('Comprobante invalido', 400);
    const r = await fa().comprobante(id);
    const c = r && r.comprobante;
    if (!c) throw err('No existe ese comprobante', 404);
    assertRecursoEnAlcance(principal, c.cliente_cuit);
    return r;
  }

  return async function manejar(req, res, url, seg, principal) {
    if (seg[0] !== 'api' || seg[1] !== 'factorum') return false;
    req._op = 'factorum';
    const q = url.searchParams;

    // --- conexion ---
    if (seg[2] === 'config' && !seg[3]) {
      requireRole(principal, 'superadmin');
      if (req.method === 'GET') return json(res, 200, { ok: true, factorum: await fa().config() });
      if (req.method === 'PUT') {
        const b = await readJsonBody(req);
        return json(res, 200, { ok: true, factorum: await fa().guardarConfig(b, principal.username) });
      }
      return false;
    }
    if (req.method === 'GET' && seg[2] === 'salud' && !seg[3]) {
      try {
        return json(res, 200, { ok: true, factorum: await fa().salud() });
      } catch (e) {
        return json(res, 200, { ok: true, factorum: { ok: false, error: e.message } });
      }
    }

    // --- verificar una factura (no guarda nada) ---
    if (req.method === 'POST' && seg[2] === 'verificar' && !seg[3]) {
      puedeOperar(principal);
      await exigirConfigurado();
      const b = await readJsonBody(req, { max: limites().MAX_BODY_VERIFICAR });
      const cuitConsultante = consultanteDelAlcance(principal, b.cuit_consultante);
      if (cuitConsultante) req._cuit = cuitConsultante;
      const r = await fa().verificar({
        nombre: b.nombre,
        contenidoBase64: b.contenido_base64,
        cuitConsultante,
        ia: typeof b.ia === 'boolean' ? b.ia : undefined,
      });
      return json(res, 200, r);
    }

    // --- lotes ---
    if (seg[2] === 'lotes' && !seg[3]) {
      if (req.method === 'GET') {
        const r = await fa().lotes({ limite: q.get('limite'), offset: q.get('offset') });
        if (!scopedRequiresCuit(principal)) return json(res, 200, r);
        const lotes = (r.lotes || []).filter((l) => l.cliente_cuit && principal.cuitAllow.includes(l.cliente_cuit));
        return json(res, 200, { ...r, lotes, total: lotes.length });
      }
      if (req.method === 'POST') {
        puedeOperar(principal);
        await exigirConfigurado();
        const b = await readJsonBody(req, { max: limites().MAX_BODY_LOTE });
        const clienteCuit = clienteDelAlcance(principal, b.cliente_cuit, 'cliente_cuit');
        if (clienteCuit) req._cuit = clienteCuit;
        if (!Array.isArray(b.archivos) || !b.archivos.length) throw err('Falta "archivos": [{ nombre, contenido_base64 }]', 400);
        const archivos = b.archivos.map((a) => ({ nombre: a && a.nombre, contenidoBase64: a && a.contenido_base64 }));
        const r = await fa().crearLote({
          archivos,
          clienteCuit,
          nombre: b.nombre ? String(b.nombre).slice(0, 200) : undefined,
          ia: typeof b.ia === 'boolean' ? b.ia : undefined,
          constatar: typeof b.constatar === 'boolean' ? b.constatar : undefined,
        });
        return json(res, 202, r);
      }
      return false;
    }
    if (req.method === 'GET' && seg[2] === 'lotes' && seg[3] && !seg[4]) {
      if (!/^\d+$/.test(seg[3])) throw err('Lote invalido', 400);
      const r = await fa().lote(seg[3]);
      if (!r || !r.lote) throw err('No existe ese lote', 404);
      assertRecursoEnAlcance(principal, r.lote.cliente_cuit);
      return json(res, 200, r);
    }

    // --- comprobantes ---
    if (seg[2] === 'comprobantes') {
      if (req.method === 'GET' && !seg[3]) {
        const cliente = clienteDelAlcance(principal, q.get('cliente'));
        if (cliente) req._cuit = cliente;
        return json(res, 200, await fa().comprobantes({ ...filtrosDe(q), cliente }));
      }
      if (!seg[3]) return false;
      if (req.method === 'GET' && !seg[4]) return json(res, 200, await comprobanteEnAlcance(principal, seg[3]));
      if (req.method === 'PATCH' && !seg[4]) {
        puedeOperar(principal);
        const actual = await comprobanteEnAlcance(principal, seg[3]);
        if (actual.comprobante.cliente_cuit) req._cuit = actual.comprobante.cliente_cuit;
        const b = await readJsonBody(req);
        const campos = b.campos && typeof b.campos === 'object' && !Array.isArray(b.campos) ? b.campos : {};
        // Factorum (Go) decodifica sin distinguir mayusculas: "Cliente_Cuit" moveria el comprobante
        // sin pasar por el chequeo de alcance de abajo. Solo se acepta la forma exacta (P-04).
        for (const k of Object.keys(campos)) {
          if (k !== 'cliente_cuit' && k.replace(/[^a-z]/gi, '').toLowerCase() === 'clientecuit') {
            throw err(`Campo invalido: "${k.slice(0, 40)}" (usa cliente_cuit)`, 400);
          }
          if (!/^[a-z0-9_]{1,40}$/.test(k)) throw err(`Campo invalido: "${k.slice(0, 40)}"`, 400);
        }
        if (Object.prototype.hasOwnProperty.call(campos, 'cliente_cuit')) {
          // Moverlo a otro cliente tambien tiene que respetar el scope.
          assertCuitAllowed(principal, cuitDe(campos.cliente_cuit, 'cliente_cuit'));
        }
        const r = await fa().corregir(seg[3], { campos, aprobar: b.aprobar === true, usuario: principal.username });
        return json(res, 200, r);
      }
      if (req.method === 'GET' && seg[4] === 'archivo' && !seg[5]) {
        const { comprobante: c } = await comprobanteEnAlcance(principal, seg[3]);
        if (!c.documento_id) throw err('Ese comprobante no tiene archivo original', 404);
        const archivo = await fa().archivo(c.documento_id);
        return enviarBinario(res, archivo, { nombre: c.archivo || `comprobante-${c.id}`, adjunto: q.get('descargar') === '1' });
      }
      return false;
    }

    // --- resumen y exportar ---
    if (req.method === 'GET' && seg[2] === 'resumen' && !seg[3]) {
      const cliente = clienteDelAlcance(principal, q.get('cliente'));
      if (cliente) req._cuit = cliente;
      return json(res, 200, await fa().resumen({ ...filtrosDe(q), cliente }));
    }
    if (req.method === 'GET' && (seg[2] === 'export.xlsx' || seg[2] === 'export.csv') && !seg[3]) {
      const cliente = clienteDelAlcance(principal, q.get('cliente'));
      if (cliente) req._cuit = cliente;
      const formato = seg[2].split('.')[1];
      const archivo = await fa().exportar(formato, { ...filtrosDe(q), cliente });
      return enviarBinario(res, archivo, { nombre: `facturas-recibidas${cliente ? `-${cliente}` : ''}.${formato}`, adjunto: true });
    }
    return false;
  };
}

module.exports = { crearRutas, clienteDelAlcance, consultanteDelAlcance, assertRecursoEnAlcance };
