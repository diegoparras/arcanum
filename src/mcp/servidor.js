'use strict';

// Servidor MCP (Model Context Protocol) de SOLO CONSULTA.
// Transporte Streamable HTTP sin estado: cada POST /mcp trae un mensaje JSON-RPC 2.0
// (o un lote) y se contesta con JSON. No hay sesiones ni stream SSE.
//
// Este modulo es solo el protocolo: las herramientas se inyectan (ver herramientas.js),
// asi se testea sin red ni base. Cada herramienta: { nombre, titulo, descripcion,
// esquema (JSON Schema de los argumentos), ejecutar(args, ctx) -> datos }.

const VERSIONES = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXTO = 19000; // el cliente lee hasta 20.000 caracteres por respuesta

function negociarVersion(pedida) {
  return VERSIONES.includes(pedida) ? pedida : VERSIONES[0];
}

function rpcResultado(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

// Texto de la respuesta: JSON con indentacion. Si excede el maximo, se recorta y se avisa.
function aTexto(datos) {
  const s = typeof datos === 'string' ? datos : JSON.stringify(datos, null, 2);
  if (s.length <= MAX_TEXTO) return s;
  return `${s.slice(0, MAX_TEXTO)}\n[respuesta recortada: superaba ${MAX_TEXTO} caracteres]`;
}

function mensajeDeError(e) {
  const m = (e && e.message) || 'Error interno';
  return String(m).slice(0, 1000);
}

function conTimeout(promesa, ms) {
  let timer;
  const corte = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ARCA no respondio a tiempo (mas de ${Math.round(ms / 1000)} s). Proba de nuevo en unos minutos.`));
    }, ms);
  });
  return Promise.race([promesa, corte]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} o
 * @param {string} o.nombre        nombre del servidor (serverInfo.name)
 * @param {string} o.version       version de la app
 * @param {Array}  o.herramientas  definiciones de herramientas (solo lectura)
 * @param {number} [o.timeoutMs]   corte por llamada (el cliente corta a los 90 s)
 * @param {string} [o.instrucciones]
 */
// Tope de mensajes en un lote JSON-RPC (auditoria 2026-11-26, M-01).
const MAX_LOTE = 10;

function crearServidor({ nombre, titulo, version, herramientas, timeoutMs = 80000, instrucciones }) {
  const porNombre = new Map(herramientas.map((h) => [h.nombre, h]));

  const definiciones = () =>
    herramientas.map((h) => ({
      name: h.nombre,
      title: h.titulo,
      description: h.descripcion,
      inputSchema: h.esquema,
      // Todas las herramientas son de consulta: no modifican nada en ARCA ni en Arcanum.
      annotations: { title: h.titulo, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }));

  async function llamar(id, params, ctxPedido) {
    const h = porNombre.get(params && params.name);
    if (!h) return rpcError(id, -32602, `Herramienta desconocida: ${params && params.name}`);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    // Contexto propio de esta llamada (hereda principal y ganchos del pedido): el CUIT que marca una
    // herramienta no se pisa con el de otra del mismo lote.
    const ctx = Object.create(ctxPedido || {});
    // Cada herramienta pasa por el limite de la clave, no solo el pedido HTTP (auditoria 2026-11-26, M-01).
    if (typeof ctx.antesDeHerramienta === 'function') {
      try { ctx.antesDeHerramienta(h.nombre, args); } catch (e) { return rpcError(id, -32000, mensajeDeError(e)); }
    }
    if (typeof ctx.alLlamar === 'function') ctx.alLlamar(h.nombre, args);
    const fin = (ok) => {
      // El pedido conserva el ultimo CUIT marcado (la fila HTTP de la auditoria lo usa).
      if (ctxPedido && Object.prototype.hasOwnProperty.call(ctx, 'cuit')) ctxPedido.cuit = ctx.cuit;
      if (ctxPedido && Object.prototype.hasOwnProperty.call(ctx, 'cuitConsultado')) ctxPedido.cuitConsultado = ctx.cuitConsultado;
      if (typeof ctx.despuesDeHerramienta === 'function') {
        try { ctx.despuesDeHerramienta({ herramienta: h.nombre, ok, cuit: ctx.cuit || null, cuitConsultado: ctx.cuitConsultado || null }); } catch { /* auditoria best-effort */ }
      }
    };
    try {
      const datos = await conTimeout(Promise.resolve().then(() => h.ejecutar(args, ctx)), timeoutMs);
      fin(true);
      return rpcResultado(id, { content: [{ type: 'text', text: aTexto(datos) }] });
    } catch (e) {
      fin(false);
      // Error de la herramienta: va como resultado con isError (no como error JSON-RPC),
      // asi el modelo lee el motivo y puede explicarlo o reintentar.
      return rpcResultado(id, { content: [{ type: 'text', text: aTexto({ error: mensajeDeError(e) }) }], isError: true });
    }
  }

  async function atenderUno(msg, ctx) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Pedido JSON-RPC invalido');
    }
    // Notificaciones (sin id): no llevan respuesta (ej. notifications/initialized).
    if (msg.id === undefined || msg.id === null) return null;

    switch (msg.method) {
      case 'initialize':
        return rpcResultado(msg.id, {
          protocolVersion: negociarVersion(msg.params && msg.params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: nombre, title: titulo || nombre, version },
          ...(instrucciones ? { instructions: instrucciones } : {}),
        });
      case 'ping':
        return rpcResultado(msg.id, {});
      case 'tools/list':
        return rpcResultado(msg.id, { tools: definiciones() });
      case 'tools/call':
        return llamar(msg.id, msg.params || {}, ctx);
      default:
        return rpcError(msg.id, -32601, `Metodo no soportado: ${msg.method}`);
    }
  }

  /**
   * Atiende el body crudo de un POST /mcp.
   * @returns {Promise<object|Array|null>} respuesta JSON-RPC, o null si eran solo notificaciones (HTTP 202).
   */
  async function atender(raw, ctx) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, 'JSON invalido');
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return rpcError(null, -32600, 'Lote vacio');
      if (msg.length > MAX_LOTE) return rpcError(null, -32600, `Lote demasiado grande: maximo ${MAX_LOTE} mensajes por pedido`);
      // En orden, de a uno: un lote no multiplica la concurrencia contra ARCA.
      const salidas = [];
      for (const m of msg) {
        const r = await atenderUno(m, ctx);
        if (r) salidas.push(r);
      }
      return salidas.length ? salidas : null;
    }
    return atenderUno(msg, ctx);
  }

  return { atender, definiciones };
}

module.exports = { MAX_LOTE, crearServidor, negociarVersion, aTexto, VERSIONES, MAX_TEXTO };
