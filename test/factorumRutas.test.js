'use strict';

// Rutas de Factorum (facturas recibidas): permisos por rol y por CUIT, el token nunca vuelve, el
// proxy pasa lo que corresponde y los binarios llegan intactos. Servidor HTTP real en 127.0.0.1
// con Factorum simulado.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { crearRutas, clienteDelAlcance, consultanteDelAlcance } = require('../src/rutas/factorum');
const { sendError } = require('../src/lib/http');

const SUPER = { username: 'root', role: 'superadmin' };
const ADMIN = { username: 'admin', role: 'admin' };
const LECTURA = { username: 'lee', role: 'lectura' };
const OPERADOR = { username: 'op', role: 'operador', cuitAllow: ['30711111118'] };
const OPERADOR_2 = { username: 'op2', role: 'operador', cuitAllow: ['30711111118', '20222222223'] };
const OPERADOR_LIBRE = { username: 'op3', role: 'operador' };

const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);

function faFalso() {
  const f = { llamadas: [] };
  const cbtes = {
    5: { id: 5, documento_id: 33, cliente_cuit: '30711111118', archivo: 'f.pdf', estado: 'revisar', total: 121000 },
    6: { id: 6, documento_id: 34, cliente_cuit: '20333333334', archivo: 'otra.pdf', estado: 'ok' },
    7: { id: 7, documento_id: 35, cliente_cuit: null, archivo: 'x.html', estado: 'ok' },
  };
  f.config = async () => ({ url: 'http://factorum:8095', tokenCargado: true });
  f.guardarConfig = async (b, u) => { f.llamadas.push(['config', b, u]); return { url: b.url, tokenCargado: true }; };
  f.salud = async () => ({ ok: true, version: '0.1.0' });
  f.verificar = async (o) => { f.llamadas.push(['verificar', o]); return { ok: true, veredicto: 'valida', mensaje: 'ARCA confirma' }; };
  f.crearLote = async (o) => { f.llamadas.push(['lote', o]); return { ok: true, lote: { id: 12, estado: 'procesando' } }; };
  f.lotes = async () => ({ ok: true, total: 3, lotes: [{ id: 1, cliente_cuit: '30711111118' }, { id: 2, cliente_cuit: '20333333334' }, { id: 3, cliente_cuit: null }] });
  f.lote = async (id) => ({ ok: true, lote: { 1: { id: 1, cliente_cuit: '30711111118' }, 2: { id: 2, cliente_cuit: '20333333334' } }[id] });
  f.comprobantes = async (q) => { f.llamadas.push(['comprobantes', q]); return { ok: true, comprobantes: [], total: 0 }; };
  f.comprobante = async (id) => (cbtes[id] ? { ok: true, comprobante: cbtes[id], correcciones: [] } : { ok: false });
  f.corregir = async (id, b) => { f.llamadas.push(['corregir', id, b]); return { ok: true, comprobante: { ...cbtes[id], estado: 'aprobado' } }; };
  f.resumen = async (q) => { f.llamadas.push(['resumen', q]); return { ok: true, resumen: { cantidad: 0 } }; };
  f.exportar = async (fmt, q) => {
    f.llamadas.push(['exportar', fmt, q]);
    return fmt === 'xlsx'
      ? { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX }
      : { contentType: 'text/csv; charset=utf-8', body: Buffer.from('﻿a;b\n1,5;2') };
  };
  f.archivo = async (doc) => {
    f.llamadas.push(['archivo', doc]);
    return doc === 35 ? { contentType: 'text/html', body: Buffer.from('<script>x</script>') } : { contentType: 'application/pdf', body: Buffer.from('%PDF-1.7') };
  };
  return f;
}

async function conServidor(principal, factorum, fn) {
  const manejar = crearRutas({ factorum });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal);
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

const pedir = (base, method, ruta, cuerpo) => fetch(base + ruta, {
  method, headers: cuerpo ? { 'Content-Type': 'application/json' } : {}, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
});
const PDF64 = Buffer.from('%PDF-1.4').toString('base64');

test('factorum rutas: config solo superadmin y el token nunca vuelve', async () => {
  const fa = faFalso();
  await conServidor(ADMIN, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/config')).status, 403);
    assert.strictEqual((await pedir(base, 'PUT', '/api/factorum/config', { url: 'http://x', token: 't' })).status, 403);
  });
  await conServidor(SUPER, fa, async (base) => {
    const r = await (await pedir(base, 'GET', '/api/factorum/config')).json();
    assert.deepStrictEqual(r.factorum, { url: 'http://factorum:8095', tokenCargado: true });
    const put = await pedir(base, 'PUT', '/api/factorum/config', { url: 'http://factorum:8095', token: 'secreto-fa' });
    assert.strictEqual(put.status, 200);
    assert.ok(!(await put.text()).includes('secreto-fa'));
    assert.deepStrictEqual(fa.llamadas[0], ['config', { url: 'http://factorum:8095', token: 'secreto-fa' }, 'root']);
  });
});

test('factorum rutas: salud la ve cualquier rol y un error no rompe la UI', async () => {
  const fa = faFalso();
  await conServidor(LECTURA, fa, async (base) => {
    assert.strictEqual((await (await pedir(base, 'GET', '/api/factorum/salud')).json()).factorum.ok, true);
  });
  fa.salud = async () => { throw Object.assign(new Error('Factorum no esta configurado'), { httpStatus: 503 }); };
  await conServidor(LECTURA, fa, async (base) => {
    const r = await pedir(base, 'GET', '/api/factorum/salud');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).factorum, { ok: false, error: 'Factorum no esta configurado' });
  });
});

test('factorum rutas: lectura lee pero no verifica, ni sube, ni corrige', async () => {
  const fa = faFalso();
  await conServidor(LECTURA, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes')).status, 200);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/lotes')).status, 200);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/resumen')).status, 200);
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64 })).status, 403);
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/lotes', { archivos: [{ nombre: 'f.pdf', contenido_base64: PDF64 }] })).status, 403);
    assert.strictEqual((await pedir(base, 'PATCH', '/api/factorum/comprobantes/5', { aprobar: true })).status, 403);
  });
  assert.deepStrictEqual(fa.llamadas.map((l) => l[0]), ['comprobantes', 'resumen']);
});

test('factorum rutas: verificar usa el unico CUIT del operador como consultante', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    const r = await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64, ia: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).veredicto, 'valida');
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64, cuit_consultante: '20333333334' })).status, 403);
  });
  assert.deepStrictEqual(fa.llamadas[0], ['verificar', { nombre: 'f.pdf', contenidoBase64: PDF64, cuitConsultante: '30711111118', ia: true }]);
  assert.strictEqual(fa.llamadas.length, 1);
});

test('factorum rutas: verificar con varios CUITs pide el consultante; sin scope lo deja a Factorum', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR_2, fa, async (base) => {
    const r = await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64 });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /cuit_consultante/);
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64, cuit_consultante: '20-22222222-3' })).status, 200);
  });
  await conServidor(OPERADOR_LIBRE, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'f.pdf', contenido_base64: PDF64 })).status, 200);
  });
  assert.strictEqual(fa.llamadas[0][1].cuitConsultante, '20222222223');
  assert.strictEqual(fa.llamadas[1][1].cuitConsultante, undefined);
});

test('factorum rutas: verificar acepta archivos de mas de 2 MB (tope propio)', async () => {
  const fa = faFalso();
  const grande = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
  await conServidor(OPERADOR_LIBRE, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/verificar', { nombre: 'g.pdf', contenido_base64: grande })).status, 200);
  });
  assert.strictEqual(fa.llamadas[0][1].contenidoBase64.length, grande.length);
});

test('factorum rutas: subir lote respeta el cliente del scope y pasa las opciones', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    const body = { archivos: [{ nombre: 'f.pdf', contenido_base64: PDF64 }], ia: false, constatar: true, nombre: 'Nov' };
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/lotes', { ...body, cliente_cuit: '20333333334' })).status, 403);
    const r = await pedir(base, 'POST', '/api/factorum/lotes', body);
    assert.strictEqual(r.status, 202);
    assert.strictEqual((await r.json()).lote.id, 12);
    assert.strictEqual((await pedir(base, 'POST', '/api/factorum/lotes', { cliente_cuit: '30711111118' })).status, 400);
  });
  assert.strictEqual(fa.llamadas.length, 1);
  assert.deepStrictEqual(fa.llamadas[0][1], {
    archivos: [{ nombre: 'f.pdf', contenidoBase64: PDF64 }], clienteCuit: '30711111118', nombre: 'Nov', ia: false, constatar: true,
  });
});

test('factorum rutas: comprobantes con scope fuerza el cliente; fuera de scope 403', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes?estado=revisar&q=acme')).status, 200);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes?cliente=20333333334')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/resumen?cliente=20333333334')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/export.xlsx?cliente=20333333334')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes?estado=raro')).status, 400);
  });
  await conServidor(OPERADOR_2, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes')).status, 400);
  });
  await conServidor(ADMIN, fa, async (base) => {
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes?cliente=20333333334&lote=12')).status, 200);
  });
  const qs = fa.llamadas.filter((l) => l[0] === 'comprobantes').map((l) => l[1]);
  assert.deepStrictEqual(qs, [{ estado: 'revisar', q: 'acme', cliente: '30711111118' }, { lote: '12', cliente: '20333333334' }]);
});

test('factorum rutas: lotes y comprobantes de otro cliente no se ven con scope', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    const r = await (await pedir(base, 'GET', '/api/factorum/lotes')).json();
    assert.deepStrictEqual(r.lotes.map((l) => l.id), [1]);
    assert.strictEqual(r.total, 1);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/lotes/1')).status, 200);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/lotes/2')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/5')).status, 200);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/6')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/7')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/6/archivo')).status, 403);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/99')).status, 404);
  });
  await conServidor(ADMIN, fa, async (base) => {
    assert.strictEqual((await (await pedir(base, 'GET', '/api/factorum/lotes')).json()).lotes.length, 3);
    assert.strictEqual((await pedir(base, 'GET', '/api/factorum/comprobantes/6')).status, 200);
  });
  assert.ok(!fa.llamadas.some((l) => l[0] === 'archivo'));
});

test('factorum rutas: corregir pone el usuario de Arcanum y respeta el scope', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    const r = await pedir(base, 'PATCH', '/api/factorum/comprobantes/5', { campos: { iva_21: '21000.00' }, aprobar: true, usuario: 'otro' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).comprobante.estado, 'aprobado');
    assert.strictEqual((await pedir(base, 'PATCH', '/api/factorum/comprobantes/6', { aprobar: true })).status, 403);
    assert.strictEqual((await pedir(base, 'PATCH', '/api/factorum/comprobantes/5', { campos: { cliente_cuit: '20333333334' } })).status, 403);
  });
  const c = fa.llamadas.filter((l) => l[0] === 'corregir');
  assert.deepStrictEqual(c, [['corregir', '5', { campos: { iva_21: '21000.00' }, aprobar: true, usuario: 'op' }]]);
});

test('factorum rutas: export y archivo pasan los bytes intactos', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    const x = await pedir(base, 'GET', '/api/factorum/export.xlsx?estado=ok');
    assert.strictEqual(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);
    assert.match(x.headers.get('content-disposition'), /attachment; filename="facturas-recibidas-30711111118.xlsx"/);
    assert.ok(Buffer.from(await x.arrayBuffer()).equals(XLSX));
    const csv = await pedir(base, 'GET', '/api/factorum/export.csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.strictEqual(Buffer.from(await csv.arrayBuffer()).toString('utf8'), '﻿a;b\n1,5;2');
    const a = await pedir(base, 'GET', '/api/factorum/comprobantes/5/archivo');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.headers.get('content-type'), 'application/pdf');
    assert.match(a.headers.get('content-disposition'), /^inline; filename="f.pdf"/);
    assert.strictEqual(a.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(Buffer.from(await a.arrayBuffer()).toString(), '%PDF-1.7');
  });
  await conServidor(ADMIN, fa, async (base) => {
    // Un tipo que no es PDF ni imagen nunca se sirve inline desde el origen de Arcanum.
    const h = await pedir(base, 'GET', '/api/factorum/comprobantes/7/archivo');
    assert.strictEqual(h.headers.get('content-type'), 'application/octet-stream');
    assert.match(h.headers.get('content-disposition'), /^attachment/);
  });
  assert.deepStrictEqual(fa.llamadas.filter((l) => l[0] === 'exportar').map((l) => [l[1], l[2]]), [
    ['xlsx', { estado: 'ok', cliente: '30711111118' }], ['csv', { cliente: '30711111118' }],
  ]);
  assert.deepStrictEqual(fa.llamadas.filter((l) => l[0] === 'archivo').map((l) => l[1]), [33, 35]);
});

test('factorum rutas: Factorum caido se informa con su estado', async () => {
  const fa = faFalso();
  fa.comprobantes = async () => { throw Object.assign(new Error('No se pudo contactar a Factorum (ECONNREFUSED)'), { httpStatus: 503 }); };
  await conServidor(ADMIN, fa, async (base) => {
    const r = await pedir(base, 'GET', '/api/factorum/comprobantes');
    assert.strictEqual(r.status, 503);
    assert.match((await r.json()).error, /No se pudo contactar a Factorum/);
  });
});

test('factorum alcance: helpers de cliente y consultante', () => {
  assert.strictEqual(clienteDelAlcance(ADMIN, undefined), undefined);
  assert.strictEqual(clienteDelAlcance(OPERADOR, ''), '30711111118');
  assert.throws(() => clienteDelAlcance(OPERADOR, '123'), (e) => e.httpStatus === 400);
  assert.strictEqual(consultanteDelAlcance(OPERADOR_LIBRE, null), undefined);
  assert.strictEqual(consultanteDelAlcance(OPERADOR, null), '30711111118');
  assert.strictEqual(consultanteDelAlcance({ role: 'lectura', cuitAllow: ['20222222223'] }, undefined), '20222222223');
});

test('factorum: la clave de Arcanum para Factorum puede ser de rol lectura (POST /api/constatacion)', () => {
  // Factorum constata con POST /api/constatacion, que solo consulta: es una excepcion de POST
  // para el rol lectura, como la vista previa. El resto de los POST sigue cerrado.
  const permisos = require('../src/auth/permisos');
  assert.doesNotThrow(() => permisos.assertPuedeEscribir({ role: 'lectura' }, 'POST', '/api/constatacion'));
  assert.throws(() => permisos.assertPuedeEscribir({ role: 'lectura' }, 'POST', '/api/wsfev1/comprobantes'), (e) => e.httpStatus === 403);
  assert.throws(() => permisos.assertPuedeEscribir({ role: 'lectura' }, 'POST', '/api/mis-comprobantes/30711111118/constatar'), (e) => e.httpStatus === 403);
  assert.doesNotThrow(() => permisos.assertPuedeEscribir({ role: 'lectura' }, 'GET', '/api/padron/a5/30500010912'));
  assert.doesNotThrow(() => permisos.assertPuedeEscribir({ role: 'operador', cuitAllow: ['30711111118'] }, 'POST', '/api/constatacion'));
});

test('P-04: corregir rechaza variantes de cliente_cuit con otra capitalizacion', async () => {
  const fa = faFalso();
  await conServidor(OPERADOR, fa, async (base) => {
    for (const k of ['Cliente_Cuit', 'CLIENTE_CUIT', 'clienteCuit']) {
      const r = await pedir(base, 'PATCH', '/api/factorum/comprobantes/5', { campos: { [k]: '20333333334' } });
      assert.strictEqual(r.status, 400, k);
    }
  });
  assert.strictEqual(fa.llamadas.filter((l) => l[0] === 'corregir').length, 0);
});
