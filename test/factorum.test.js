'use strict';

// Cliente de Factorum: auth de servicio, JSON y multipart, filtros, errores claros, topes y
// passthrough binario. Contra un servidor HTTP falso en 127.0.0.1, sin red real.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearCliente, LIMITES } = require('../src/services/factorum');

function servidorFalso(manejar) {
  return new Promise((resolve) => {
    const pedidos = [];
    const srv = http.createServer((req, res) => {
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        const cuerpo = Buffer.concat(partes);
        pedidos.push({ method: req.method, url: req.url, headers: req.headers, cuerpo });
        manejar(req, res, cuerpo);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, pedidos, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

const responder = (res, status, datos, cab = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cab });
  res.end(JSON.stringify(datos));
};
const cliente = (url, token = 'tok-fa') => crearCliente({ leerConfig: async () => ({ url, token }) });

test('factorum: salud manda Bearer y devuelve version e IA', async () => {
  const f = await servidorFalso((req, res) => responder(res, 200, { ok: true, version: '0.1.0', ocr: true, ia: { habilitada: false } }));
  try {
    const s = await cliente(f.url).salud();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.version, '0.1.0');
    assert.strictEqual(f.pedidos[0].url, '/healthz');
    assert.strictEqual(f.pedidos[0].headers.authorization, 'Bearer tok-fa');
  } finally { f.srv.close(); }
});

test('factorum: sin configurar da 503 con mensaje claro', async () => {
  const c = crearCliente({ leerConfig: async () => ({ url: '', token: '' }) });
  await assert.rejects(c.comprobantes({}), (e) => e.httpStatus === 503 && /Factorum no esta configurado/.test(e.message));
  await assert.rejects(c.salud(), (e) => e.httpStatus === 503);
});

test('factorum: servidor caido da 503', async () => {
  await assert.rejects(cliente('http://127.0.0.1:1').lotes(), (e) => e.httpStatus === 503 && /No se pudo contactar a Factorum/.test(e.message));
});

test('factorum: verificar manda JSON con guardar=false y el consultante', async () => {
  const f = await servidorFalso((req, res) => responder(res, 200, { ok: true, veredicto: 'valida', mensaje: 'ok' }));
  try {
    const b64 = Buffer.from('%PDF-1.4 factura').toString('base64');
    const r = await cliente(f.url).verificar({ nombre: 'f.pdf', contenidoBase64: b64, cuitConsultante: '20111111112', ia: true });
    assert.strictEqual(r.veredicto, 'valida');
    const p = f.pedidos[0];
    assert.strictEqual(p.method, 'POST');
    assert.strictEqual(p.url, '/api/verificar');
    assert.match(p.headers['content-type'], /application\/json/);
    assert.deepStrictEqual(JSON.parse(p.cuerpo), { nombre: 'f.pdf', contenido_base64: b64, guardar: false, cuit_consultante: '20111111112', ia: true });
  } finally { f.srv.close(); }
});

test('factorum: verificar sin archivo o demasiado grande no llega a Factorum', async () => {
  const f = await servidorFalso((req, res) => responder(res, 200, { ok: true }));
  try {
    const c = cliente(f.url);
    await assert.rejects(c.verificar({ nombre: 'f.pdf' }), (e) => e.httpStatus === 400);
    await assert.rejects(c.verificar({ contenidoBase64: 'QQ==' }), (e) => e.httpStatus === 400);
    const grande = 'A'.repeat(Math.ceil((LIMITES.MAX_ARCHIVO * 4) / 3) + 400);
    await assert.rejects(c.verificar({ nombre: 'g.pdf', contenidoBase64: grande }), (e) => e.httpStatus === 413);
    assert.strictEqual(f.pedidos.length, 0);
  } finally { f.srv.close(); }
});

test('factorum: crearLote sube multipart con archivos, cliente, ia y constatar', async () => {
  const f = await servidorFalso((req, res) => responder(res, 202, { ok: true, lote: { id: 12, estado: 'procesando' } }));
  try {
    const r = await cliente(f.url).crearLote({
      archivos: [
        { nombre: 'a.pdf', contenido: Buffer.from('PDF-A') },
        { nombre: 'carpeta/b"x.zip', contenidoBase64: Buffer.from('ZIP-B').toString('base64') },
      ],
      clienteCuit: '20222222223', nombre: 'Noviembre', ia: false, constatar: true,
    });
    assert.strictEqual(r.lote.id, 12);
    const p = f.pedidos[0];
    assert.strictEqual(p.url, '/api/lotes');
    const m = /^multipart\/form-data; boundary=(.+)$/.exec(p.headers['content-type']);
    assert.ok(m, p.headers['content-type']);
    const cuerpo = p.cuerpo.toString('latin1');
    assert.match(cuerpo, /name="cliente_cuit"\r\n\r\n20222222223\r\n/);
    assert.match(cuerpo, /name="nombre"\r\n\r\nNoviembre\r\n/);
    assert.match(cuerpo, /name="ia"\r\n\r\nfalse\r\n/);
    assert.match(cuerpo, /name="constatar"\r\n\r\ntrue\r\n/);
    assert.match(cuerpo, /name="archivos"; filename="a.pdf"\r\nContent-Type: application\/pdf\r\n\r\nPDF-A\r\n/);
    // El nombre pierde la ruta y las comillas (no rompe la cabecera).
    assert.match(cuerpo, /name="archivos"; filename="bx.zip"\r\nContent-Type: application\/zip\r\n\r\nZIP-B\r\n/);
    assert.ok(cuerpo.endsWith(`--${m[1]}--\r\n`));
  } finally { f.srv.close(); }
});

test('factorum: crearLote sin archivos da 400 y con demasiados 413', async () => {
  const c = cliente('http://127.0.0.1:1');
  await assert.rejects(c.crearLote({ archivos: [] }), (e) => e.httpStatus === 400);
  const muchos = Array.from({ length: LIMITES.MAX_ARCHIVOS + 1 }, (_, i) => ({ nombre: `${i}.pdf`, contenido: Buffer.from('x') }));
  await assert.rejects(c.crearLote({ archivos: muchos }), (e) => e.httpStatus === 413);
});

test('factorum: comprobantes pasa solo los filtros conocidos', async () => {
  const f = await servidorFalso((req, res) => responder(res, 200, { ok: true, comprobantes: [], total: 0 }));
  try {
    await cliente(f.url).comprobantes({ estado: 'revisar', cliente: '20222222223', q: 'acme sa', vacio: '', otro: 'x', limite: 50, desde: '' });
    const u = new URL(f.pedidos[0].url, 'http://x');
    assert.strictEqual(u.pathname, '/api/comprobantes');
    assert.deepStrictEqual(Object.fromEntries(u.searchParams), { estado: 'revisar', cliente: '20222222223', q: 'acme sa', limite: '50' });
  } finally { f.srv.close(); }
});

test('factorum: corregir hace PATCH con el cuerpo y valida el id', async () => {
  const f = await servidorFalso((req, res) => responder(res, 200, { ok: true, comprobante: { id: 5, estado: 'aprobado' } }));
  try {
    const c = cliente(f.url);
    const r = await c.corregir(5, { campos: { iva_21: '21000.00' }, aprobar: true, usuario: 'diego' });
    assert.strictEqual(r.comprobante.estado, 'aprobado');
    assert.strictEqual(f.pedidos[0].method, 'PATCH');
    assert.strictEqual(f.pedidos[0].url, '/api/comprobantes/5');
    assert.deepStrictEqual(JSON.parse(f.pedidos[0].cuerpo), { campos: { iva_21: '21000.00' }, aprobar: true, usuario: 'diego' });
    await assert.rejects(c.corregir('5/../../x', {}), (e) => e.httpStatus === 400);
    await assert.rejects(c.lote('abc'), (e) => e.httpStatus === 400);
    assert.strictEqual(f.pedidos.length, 1);
  } finally { f.srv.close(); }
});

test('factorum: error de Factorum se propaga con su mensaje; 401 es de configuracion (502)', async () => {
  let status = 404;
  const f = await servidorFalso((req, res) => responder(res, status, { ok: false, error: 'No existe ese comprobante' }));
  try {
    const c = cliente(f.url);
    await assert.rejects(c.comprobante(99), (e) => e.httpStatus === 404 && /No existe ese comprobante/.test(e.message));
    status = 401;
    await assert.rejects(c.comprobante(99), (e) => e.httpStatus === 502 && /FACTORUM_TOKEN/.test(e.message));
    status = 500;
    await assert.rejects(c.resumen({}), (e) => e.httpStatus === 502);
  } finally { f.srv.close(); }
});

test('factorum: exportar y archivo devuelven los bytes con su tipo', async () => {
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
  const f = await servidorFalso((req, res) => {
    if (req.url.startsWith('/api/export.xlsx')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      return res.end(xlsx);
    }
    if (req.url === '/api/documentos/33/archivo') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="f.pdf"' });
      return res.end(Buffer.from('%PDF'));
    }
    responder(res, 404, { ok: false, error: 'no' });
  });
  try {
    const c = cliente(f.url);
    const x = await c.exportar('xlsx', { cliente: '20222222223', estado: 'ok' });
    assert.ok(x.body.equals(xlsx));
    assert.match(x.contentType, /spreadsheetml/);
    assert.strictEqual(f.pedidos[0].url, '/api/export.xlsx?estado=ok&cliente=20222222223');
    const a = await c.archivo(33);
    assert.strictEqual(a.body.toString(), '%PDF');
    assert.strictEqual(a.contentType, 'application/pdf');
    await assert.rejects(c.exportar('html', {}), (e) => e.httpStatus === 400);
    await assert.rejects(c.archivo(34), (e) => e.httpStatus === 404);
  } finally { f.srv.close(); }
});
