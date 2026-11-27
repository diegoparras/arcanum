'use strict';

// Herramientas MCP de Factorum (facturas recibidas): con Factorum configurado pasan por el
// cliente real contra un servidor HTTP falso; sin configurar, devuelven un error claro.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearServidor } = require('../src/mcp/servidor');
const { crearHerramientasFactorum, _internos: h } = require('../src/mcp/herramientas');
const { crearCliente } = require('../src/services/factorum');

const LECTURA = { username: 'clave:asistente', role: 'lectura', cuitAllow: ['30711111118'] };
const LECTURA_LIBRE = { username: 'clave:libre', role: 'lectura' };
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

const CBTE = {
  id: 5, lote_id: 12, documento_id: 33, cliente_cuit: '30711111118', archivo: 'f.pdf',
  tipo: 1, letra: 'A', punto_venta: 3, numero: 124, fecha: '2026-11-20', cuit_emisor: '30500010912', razon_social_emisor: 'ACME SA',
  neto_gravado: 100000.0, iva_21: 21000.0, iva_10_5: 0, total: 121000.0, cae: '76123456789012', vto_cae: '2026-11-30',
  estado: 'ok', confianza: 1, hallazgos: [{ codigo: 'qr_ok', nivel: 'info', mensaje: 'QR coincide' }], origenes: { total: 'qr' },
  constatacion: { valido: true, resultado: 'A', observaciones: [], apoc: { consultado: true, esApocrifo: false } },
};

function servidorFalso() {
  return new Promise((resolve) => {
    const pedidos = [];
    const srv = http.createServer((req, res) => {
      let cuerpo = '';
      req.on('data', (c) => { cuerpo += c; });
      req.on('end', () => {
        pedidos.push({ method: req.method, url: req.url, cuerpo });
        const u = new URL(req.url, 'http://x');
        const resp = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
        if (u.pathname === '/api/comprobantes') return resp({ ok: true, total: 1, comprobantes: [CBTE] });
        if (u.pathname === '/api/comprobantes/5') return resp({ ok: true, comprobante: CBTE, correcciones: [{ campo: 'iva_21', antes: '0', despues: '21000.00' }] });
        if (u.pathname === '/api/comprobantes/6') return resp({ ok: true, comprobante: { ...CBTE, id: 6, cliente_cuit: '20333333334' }, correcciones: [] });
        if (u.pathname === '/api/resumen') return resp({ ok: true, resumen: { cantidad: 1, neto_gravado: 100000, iva_21: 21000, total: 121000 } });
        if (u.pathname === '/api/verificar') {
          return resp({
            ok: true, veredicto: 'valida', mensaje: 'ARCA confirma que el comprobante existe con esos datos.',
            resultado: { archivo: 'f.pdf', sha256: 'abc', paginas: 1, comprobantes: [{ comprobante: CBTE, hallazgos: [], estado: 'ok', confianza: 1 }], extractores: ['qr'] },
            constatacion: [{ valido: true, resultado: 'A', observaciones: [] }],
          });
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no existe' }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, pedidos, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function servidorMcp(factorum) {
  return crearServidor({ nombre: 'arcanum', version: '9.9.9', herramientas: crearHerramientasFactorum({ factorum }) });
}
async function llamar(s, principal, name, args) {
  const ctx = { principal };
  const r = await s.atender(rpc('tools/call', { name, arguments: args }), ctx);
  return { r: r.result, datos: JSON.parse(r.result.content[0].text), ctx };
}

test('mcp factorum: cuatro herramientas de solo lectura', async () => {
  const lista = (await servidorMcp(crearCliente({ leerConfig: async () => ({}) })).atender(rpc('tools/list'), { principal: LECTURA })).result.tools;
  assert.deepStrictEqual(lista.map((t) => t.name), ['facturas_recibidas', 'factura_recibida', 'resumen_facturas_recibidas', 'verificar_factura']);
  for (const t of lista) {
    assert.match(t.description, /solo lectura/i);
    assert.strictEqual(t.annotations.readOnlyHint, true);
  }
});

test('mcp factorum: sin configurar, cada herramienta devuelve un error claro', async () => {
  const s = servidorMcp(crearCliente({ leerConfig: async () => ({ url: '', token: '' }) }));
  for (const [name, args] of [['facturas_recibidas', {}], ['factura_recibida', { id: 5 }], ['resumen_facturas_recibidas', {}], ['verificar_factura', { nombre: 'f.pdf', contenido_base64: 'JVBERi0=' }]]) {
    const { r, datos } = await llamar(s, LECTURA, name, args);
    assert.strictEqual(r.isError, true, name);
    assert.match(datos.error, /Factorum no está configurado/, name);
  }
});

test('mcp factorum: facturas_recibidas resume y fuerza el cliente del scope', async () => {
  const f = await servidorFalso();
  try {
    const s = servidorMcp(crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) }));
    const { r, datos, ctx } = await llamar(s, LECTURA, 'facturas_recibidas', { estado: 'ok', desde: '2026-11-01' });
    assert.strictEqual(r.isError, undefined);
    assert.strictEqual(datos.total, 1);
    const c = datos.comprobantes[0];
    assert.strictEqual(c.comprobante, '0003-00000124');
    assert.strictEqual(c.tipoNombre, 'Factura A');
    assert.deepStrictEqual(c.emisor, { cuit: '30500010912', nombre: 'ACME SA' });
    assert.deepStrictEqual(c.importes, { neto_gravado: 100000, iva_21: 21000, total: 121000 });
    assert.strictEqual(c.constatacion.apocrifo, false);
    assert.strictEqual(ctx.cuit, '30711111118');
    const u = new URL(f.pedidos[0].url, 'http://x');
    assert.deepStrictEqual(Object.fromEntries(u.searchParams), { cliente: '30711111118', estado: 'ok', desde: '2026-11-01', limite: '20' });
    const fuera = await llamar(s, LECTURA, 'facturas_recibidas', { cliente: '20333333334' });
    assert.strictEqual(fuera.r.isError, true);
    assert.match(fuera.datos.error, /No autorizado/);
  } finally { f.srv.close(); }
});

test('mcp factorum: factura_recibida trae correcciones y respeta el scope', async () => {
  const f = await servidorFalso();
  try {
    const s = servidorMcp(crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) }));
    const { datos } = await llamar(s, LECTURA, 'factura_recibida', { id: 5 });
    assert.strictEqual(datos.id, 5);
    assert.strictEqual(datos.correcciones.length, 1);
    assert.deepStrictEqual(datos.origenes, { total: 'qr' });
    const otro = await llamar(s, LECTURA, 'factura_recibida', { id: 6 });
    assert.strictEqual(otro.r.isError, true);
  } finally { f.srv.close(); }
});

test('mcp factorum: resumen y verificar (sin guardar, con el consultante del scope)', async () => {
  const f = await servidorFalso();
  try {
    const s = servidorMcp(crearCliente({ leerConfig: async () => ({ url: f.url, token: 't' }) }));
    const res = await llamar(s, LECTURA_LIBRE, 'resumen_facturas_recibidas', { cliente: '30711111118' });
    assert.strictEqual(res.datos.resumen.total, 121000);
    const b64 = Buffer.from('%PDF-1.4').toString('base64');
    const v = await llamar(s, LECTURA, 'verificar_factura', { nombre: 'f.pdf', contenido_base64: b64 });
    assert.strictEqual(v.r.isError, undefined);
    assert.strictEqual(v.datos.veredicto, 'valida');
    assert.strictEqual(v.datos.guardado, false);
    assert.strictEqual(v.datos.comprobantes[0].cae, '76123456789012');
    const enviado = JSON.parse(f.pedidos.find((p) => p.url === '/api/verificar').cuerpo);
    assert.strictEqual(enviado.guardar, false);
    assert.strictEqual(enviado.cuit_consultante, '30711111118');
  } finally { f.srv.close(); }
});

test('mcp factorum: resumirCbteFactorum acepta el comprobante anidado de verificar', () => {
  const r = h.resumirCbteFactorum({ comprobante: { tipo: 11, punto_venta: 1, numero: 7, total: '500.00' }, estado: 'revisar', hallazgos: [{ nivel: 'aviso', mensaje: 'x' }] });
  assert.strictEqual(r.comprobante, '0001-00000007');
  assert.strictEqual(r.estado, 'revisar');
  assert.strictEqual(r.importes.total, 500);
  assert.strictEqual(r.hallazgos.length, 1);
});
