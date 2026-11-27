'use strict';

// Emitidos para el libro de ventas de Factorum (2.4.0): el detalle por alicuota de Mis
// Comprobantes (JSON y CSV, solo si cierra), la prioridad entre Mis Comprobantes y la emision
// propia de Arcanum, la cobertura de las corridas de emitidos, la ruta (rol lectura, alcance por
// CUIT, errores genericos) y, con ARCANUM_TEST_DATABASE_URL, el repo SQL de verdad.

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const URL_DB = process.env.ARCANUM_TEST_DATABASE_URL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;
after(async () => { if (URL_DB) await require('../src/db').pool.end(); });

const mc = require('../src/services/misComprobantes');
const parser = require('../src/services/mcParser');
const { crearRutas } = require('../src/rutas/misComprobantes');
const { sendError } = require('../src/lib/http');
const { assertPuedeEscribir } = require('../src/auth/permisos');

const AHORA = new Date('2026-11-27T15:00:00Z');

// Una fila del JSON de listaResultados de Emitidos (49 columnas): las *Styled van en blanco.
function filaJson(o = {}) {
  const f = new Array(49).fill('');
  const v = {
    0: '15/10/2026', 1: '1', 3: '2', 4: '120', 5: '120', 8: '76123456789012', 10: '80', 11: '30711111118',
    12: 'CLIENTE SA', 13: '1', 14: 'PES', 37: '1500', 39: '0', 41: '0', 43: '0', 45: '262.5', 47: '1762.5', ...o,
  };
  for (const [k, x] of Object.entries(v)) f[Number(k)] = x;
  return f;
}
const json = (filas) => JSON.stringify({ estado: 'ok', datos: { data: filas } });

test('JSON de emitidos: el detalle por alicuota entra solo si cierra', () => {
  // 1000 al 21 % y 500 al 10,5 %: neto 1500, IVA 262,50.
  const bien = filaJson({ 25: '52.5', 27: '500', 29: '210', 31: '1000' });
  // Las mismas cifras corridas de lugar (el IVA donde va el neto): no cierra.
  const corrida = filaJson({ 25: '500', 27: '52.5', 29: '1000', 31: '210' });
  const sinDetalle = filaJson();
  const [a, b, c] = parser.desdeArchivo(Buffer.from(json([bien, corrida, sinDetalle])), 'x.json', 'emitido');
  assert.deepStrictEqual(a.alicuotas, [{ id: 4, netoGravado: 500, iva: 52.5 }, { id: 5, netoGravado: 1000, iva: 210 }]);
  assert.strictEqual(a.otrosTributos, 0);
  assert.strictEqual(b.alicuotas, null, 'columnas que no cierran: sin detalle, nunca uno equivocado');
  assert.strictEqual(c.alicuotas, null);
  assert.strictEqual(c.total, 1762.5);
});

test('JSON: exento con alicuota 0 % y otros tributos', () => {
  const f = filaJson({ 15: '300', 37: '300', 41: '0', 43: '12.3', 45: '0', 47: '312.3' });
  const [x] = parser.desdeArchivo(Buffer.from(json([f])), 'x.json', 'emitido');
  assert.deepStrictEqual(x.alicuotas, [{ id: 3, netoGravado: 300, iva: 0 }]);
  assert.strictEqual(x.otrosTributos, 12.3);
});

test('CSV con columnas por alicuota: el neto total no se confunde con el de una alicuota', () => {
  const csv = [
    'Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Número Hasta;Cód. Autorización;Tipo Doc. Receptor;Nro. Doc. Receptor;Denominación Receptor;Tipo Cambio;Moneda;'
      + 'Imp. Neto Gravado IVA 0%;IVA 2,5%;Imp. Neto Gravado IVA 2,5%;IVA 5%;Imp. Neto Gravado IVA 5%;IVA 10,5%;Imp. Neto Gravado IVA 10,5%;IVA 21%;Imp. Neto Gravado IVA 21%;IVA 27%;Imp. Neto Gravado IVA 27%;'
      + 'Imp. Neto Gravado Total;Imp. Neto No Gravado;Imp. Op. Exentas;Otros Tributos;Total IVA;Imp. Total',
    '15/10/2026;1 - Factura A;2;121;121;76123456789013;80;30711111118;CLIENTE SA;1,00;$;0,00;0,00;0,00;0,00;0,00;52,50;500,00;210,00;1.000,00;0,00;0,00;1.500,00;0,00;0,00;30,00;262,50;1.792,50',
    '16/10/2026;1 - Factura A;2;122;122;76123456789014;80;30711111118;CLIENTE SA;1,00;$;0,00;0,00;0,00;0,00;0,00;0,00;0,00;99,00;1.000,00;0,00;0,00;1.000,00;0,00;0,00;0,00;210,00;1.210,00',
  ].join('\n');
  const [a, b] = parser.desdeArchivo(Buffer.from(csv), 'e.csv', 'emitido');
  assert.strictEqual(a.netoGravado, 1500, 'el neto es el total, no el de la alicuota 0 %');
  assert.strictEqual(a.iva, 262.5);
  assert.strictEqual(a.otrosTributos, 30);
  assert.deepStrictEqual(a.alicuotas, [{ id: 4, netoGravado: 500, iva: 52.5 }, { id: 5, netoGravado: 1000, iva: 210 }]);
  assert.strictEqual(b.alicuotas, null, 'el IVA de la alicuota no da con su neto ni con el total');
});

test('CSV viejo sin columnas por alicuota: sigue igual y sin detalle', () => {
  const csv = 'Fecha;Tipo;Punto de Venta;Número Desde;Número Hasta;Cód. Autorización;Tipo Doc. Receptor;Nro. Doc. Receptor;Denominación Receptor;Tipo Cambio;Moneda;Imp. Neto Gravado;Imp. Neto No Gravado;Imp. Op. Exentas;IVA;Imp. Total\n'
    + '10/11/2026;6 - Factura B;2;48;48;76451234567892;96;28111222;CONSUMIDOR;1,00;$;1.000,00;0,00;0,00;210,00;1.210,00\n';
  const [f] = parser.desdeArchivo(Buffer.from(csv), 'e.csv', 'emitido');
  assert.strictEqual(f.netoGravado, 1000);
  assert.strictEqual(f.alicuotas, null);
  assert.strictEqual(f.otrosTributos, null, 'sin la columna no se sabe: null, no 0');
});

const corrida = (id, tipo, desde, hasta, estado = 'terminado') => ({
  id, tipo, desde, hasta, estado, iniciada_at: new Date(`${hasta}T12:00:00Z`), terminada_at: estado === 'terminado' ? new Date(`${hasta}T12:05:00Z`) : null, cantidad: 10, error: null,
});

const fila = (n, extra = {}) => ({
  fecha: '2026-10-05', cbte_tipo: 1, punto_venta: 2, numero_desde: String(n), numero_hasta: String(n), cae: '76123456789012',
  doc_tipo: 80, doc_nro: '30711111118', contraparte: 'Cliente SA', moneda: 'PES', tipo_cambio: 1,
  neto_gravado: 1000, no_gravado: 0, exento: 0, iva: 210, total: 1210, otros_tributos: null, alicuotas: null, ...extra,
});

function repoFalso(filas, propias = [], corridas = [corrida(1, 'emitidos', '2026-01-01', '2026-11-20')]) {
  const r = { pedidos: [] };
  r.credencial = async () => ({ cuit: '30722222229', clave_cifrada: 'x', sincronizar: false });
  r.corridasEmitidos = async (cuit) => { r.pedidos.push(['corridas', cuit]); return corridas; };
  r.emitidosRango = async (cuit, desde, hasta, tope) => {
    r.pedidos.push(['rango', cuit, desde, hasta, tope]);
    const dentro = filas.filter((f) => f.fecha >= desde && f.fecha <= hasta);
    return { filas: dentro.slice(0, tope + 1), total: dentro.length };
  };
  r.propiasRango = async () => propias;
  return r;
}

const propia = (n, extra = {}, raw = {}) => ({
  punto_venta: 2, tipo_cbte: 1, numero: n, importe_total: 1210, ...extra,
  raw: { alicuotasIva: [{ id: 5, baseImponible: 1000, importe: 210 }], importeTributos: 0, tributos: [], ...raw },
});

test('emitidos: prioridad del desglose entre Mis Comprobantes y la emision propia', async () => {
  const mcAli = [{ id: 5, netoGravado: 1000, iva: 210 }];
  const filas = [
    fila(1, { alicuotas: mcAli }), // solo Mis Comprobantes
    fila(2), // solo la emision propia
    fila(3, { alicuotas: [{ id: 4, netoGravado: 2000, iva: 210 }], neto_gravado: 2000, total: 2210 }), // las dos, distintas
    fila(4, { total: 1300, otros_tributos: 90 }), // la propia con otro total: no se usa
    fila(5), // ninguna
  ];
  const propias = [
    propia(2, {}, { importeTributos: 0, tributos: [] }),
    propia(3, { importe_total: 2210 }, { alicuotasIva: [{ id: 5, baseImponible: 1000, importe: 210 }] }),
    propia(4, { importe_total: 1210 }),
    propia(9, {}, { tributos: [{ id: 6, descripcion: 'Percepción IVA', importe: 30 }] }),
  ];
  const s = mc.crear({ repo: repoFalso(filas, propias), fisherboy: {}, vault: {}, webhooks: {}, ahora: () => AHORA });
  const r = await s.emitidos('30-72222222-9', { desde: '2026-10-01', hasta: '2026-10-31' });
  const [a, b, c, d, e] = r.comprobantes;
  assert.deepStrictEqual([a.fuenteAlicuotas, b.fuenteAlicuotas, c.fuenteAlicuotas, d.fuenteAlicuotas, e.fuenteAlicuotas],
    ['mis_comprobantes', 'arcanum', 'mis_comprobantes', null, null]);
  assert.deepStrictEqual(b.alicuotas, [{ id: 5, netoGravado: 1000, iva: 210 }]);
  assert.strictEqual(b.emisionArcanum, true);
  assert.deepStrictEqual(b.tributos, []);
  assert.strictEqual(b.otrosTributos, 0, 'sin el dato de Mis Comprobantes, el de la emision propia');
  assert.strictEqual(c.desgloseDistinto, true);
  assert.deepStrictEqual(c.alicuotas, [{ id: 4, netoGravado: 2000, iva: 210 }]);
  assert.strictEqual(d.emisionArcanum, false, 'otro total: no es la misma venta');
  assert.strictEqual(d.tributos, null);
  assert.strictEqual(d.otrosTributos, 90);
  assert.strictEqual(e.alicuotas, null);
  assert.deepStrictEqual(Object.keys(a).sort(), ['alicuotas', 'cae', 'cbteTipo', 'desgloseDistinto', 'docNro', 'docTipo', 'emisionArcanum', 'exento', 'fecha', 'fechaVtoPago',
    'fuenteAlicuotas', 'iva', 'moneda', 'netoGravado', 'noGravado', 'numeroDesde', 'numeroHasta', 'otrosTributos', 'puntoVenta', 'receptor', 'tipoCambio', 'total', 'tributos'].sort());
  assert.strictEqual(a.receptor, 'Cliente SA');
  assert.strictEqual(r.cobertura.cubre, true);
  assert.strictEqual(r.cobertura.credencial, true);
});

test('emitidos: tributos de la emision propia y cobertura de emitidos', async () => {
  const filas = [fila(7, { total: 1240, otros_tributos: 30 })];
  const propias = [propia(7, { importe_total: 1240 }, { importeTributos: 30, tributos: [{ id: 6, descripcion: 'Percepción IVA', importe: 30 }], fechaVtoPago: '20261120' })];
  const repo = repoFalso(filas, propias, [corrida(1, 'ambos', '2026-01-01', '2026-10-20'), corrida(2, 'emitidos', '2026-10-21', '2026-10-25', 'error')]);
  const s = mc.crear({ repo, fisherboy: {}, vault: {}, webhooks: {}, ahora: () => AHORA });
  const r = await s.emitidos('30722222229', { desde: '2026-10-01', hasta: '2026-10-31' });
  assert.deepStrictEqual(r.comprobantes[0].tributos, [{ id: 6, descripcion: 'Percepción IVA', importe: 30 }]);
  assert.strictEqual(r.comprobantes[0].fechaVtoPago, '20261120');
  assert.deepStrictEqual(r.cobertura.faltan, [{ desde: '2026-10-21', hasta: '2026-10-31' }], 'la corrida que falló no cubre');
  assert.deepStrictEqual(repo.pedidos[0], ['rango', '30722222229', '2026-10-01', '2026-10-31', mc.MAX_RECIBIDOS]);
});

test('emitidos: tope, truncado y validaciones como recibidos', async () => {
  const s = mc.crear({ repo: repoFalso([fila(1), fila(2), fila(3)]), fisherboy: {}, vault: {}, webhooks: {}, ahora: () => AHORA });
  const corto = await s.emitidos('30722222229', { desde: '2026-10-01', hasta: '2026-10-31', limite: '2' });
  assert.strictEqual(corto.comprobantes.length, 2);
  assert.strictEqual(corto.truncado, true);
  const es400 = (e) => e.httpStatus === 400;
  await assert.rejects(s.emitidos('123', { desde: '2026-01-01', hasta: '2026-01-31' }), es400);
  await assert.rejects(s.emitidos('30722222229', { desde: '2026-01-01' }), es400);
  await assert.rejects(s.emitidos('30722222229', { desde: '2026-02-01', hasta: '2026-01-31' }), es400);
  await assert.rejects(s.emitidos('30722222229', { desde: '2023-01-01', hasta: '2026-01-31' }), /2 años/);
});

async function conServidor(principal, mcDoble, fn) {
  const manejar = crearRutas({ mc: mcDoble });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      assertPuedeEscribir(principal, req.method, url.pathname);
      const ok = await manejar(req, res, url, url.pathname.split('/').filter(Boolean), principal);
      if (!ok) { res.writeHead(404); res.end(); }
    } catch (e) { sendError(res, e); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('ruta emitidos: lectura con alcance ve solo sus CUITs, y los errores no muestran el detalle', async () => {
  const pedidos = [];
  const doble = {
    emitidos: async (cuit, o) => {
      pedidos.push([cuit, o]);
      if (o.desde === 'roto') throw new Error('relation "comprobantes" secreta');
      return { cuit, desde: o.desde, hasta: o.hasta, total: 0, tope: 20000, truncado: false, cobertura: {}, comprobantes: [] };
    },
  };
  const LECTURA = { username: 'clave:factorum', role: 'lectura', cuitAllow: ['30722222229'] };
  const orig = console.error;
  console.error = () => {};
  try {
    await conServidor(LECTURA, doble, async (base) => {
      const ok = await fetch(`${base}/api/mis-comprobantes/30722222229/emitidos?desde=2026-10-01&hasta=2026-10-31`);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.headers.get('cache-control'), 'no-store');
      assert.strictEqual((await ok.json()).ok, true);
      const otro = await fetch(`${base}/api/mis-comprobantes/20263630743/emitidos?desde=2026-10-01&hasta=2026-10-31`);
      assert.strictEqual(otro.status, 403);
      assert.strictEqual((await fetch(`${base}/api/mis-comprobantes/30722222229/emitidos`, { method: 'POST' })).status, 403, 'lectura no hace POST');
      const roto = await fetch(`${base}/api/mis-comprobantes/30722222229/emitidos?desde=roto&hasta=2026-10-31`);
      assert.strictEqual(roto.status, 500);
      const b = await roto.json();
      assert.ok(!b.error.includes('secreta'));
    });
  } finally { console.error = orig; }
  assert.deepStrictEqual(pedidos.map((p) => p[0]), ['30722222229', '30722222229']);
});

test('emitidos en Postgres: solo los emitidos del CUIT y del rango, con alicuotas y la emision propia', { skip: URL_DB ? false : 'sin ARCANUM_TEST_DATABASE_URL' }, async () => {
  const db = require('../src/db');
  const { config } = require('../src/config');
  await db.migrate();
  const A = '30799999981';
  const B = '30799999982';
  const limpiar = async () => {
    await db.query('DELETE FROM mc_comprobantes WHERE cuit = ANY($1)', [[A, B]]);
    await db.query('DELETE FROM mc_corridas WHERE cuit = ANY($1)', [[A, B]]);
    await db.query('DELETE FROM comprobantes WHERE cuit = ANY($1)', [[A, B]]);
  };
  await limpiar();
  const ins = (cuit, tipo, fecha, n, total, alicuotas = null) => db.query(
    `INSERT INTO mc_comprobantes (cuit, tipo, fecha, cbte_tipo, punto_venta, numero_desde, numero_hasta, doc_tipo, doc_nro, contraparte, moneda, tipo_cambio, neto_gravado, iva, total, alicuotas, otros_tributos)
     VALUES ($1, $2, $3, 1, 2, $4, $4, 80, '30711111118', 'Cliente SA', 'PES', 1, $5 / 1.21, $5 - $5 / 1.21, $5, $6, 0)`, [cuit, tipo, fecha, n, total, alicuotas && JSON.stringify(alicuotas)]);
  await ins(A, 'emitido', '2026-10-01', 1, 1210, [{ id: 5, netoGravado: 1000, iva: 210 }]);
  await ins(A, 'emitido', '2026-10-31', 2, 121);
  await ins(A, 'emitido', '2026-11-01', 3, 100);
  await ins(A, 'recibido', '2026-10-10', 4, 100);
  await ins(B, 'emitido', '2026-10-10', 5, 100);
  await db.query(`INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, resultado, fecha, importe_total, doc_tipo, doc_nro, raw)
    VALUES ($1, $2, 2, 1, 2, '76000000000002', 'A', '2026-10-31', 121, 80, '30711111118', $3)`,
  [A, config.env, JSON.stringify({ alicuotasIva: [{ id: 5, baseImponible: 100, importe: 21 }], importeTributos: 0, tributos: [] })]);
  await db.query(`INSERT INTO mc_corridas (cuit, tipo, desde, hasta, estado, iniciada_at, terminada_at, cantidad)
    VALUES ($1, 'recibidos', '2026-01-01', '2026-11-27', 'terminado', now(), now(), 4), ($1, 'emitidos', '2026-10-01', '2026-10-20', 'terminado', now(), now(), 1)`, [A]);
  const r = await mc.servicio().emitidos(A, { desde: '2026-10-01', hasta: '2026-10-31' });
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.comprobantes.map((c) => [c.fecha, c.numeroDesde, c.fuenteAlicuotas]), [['2026-10-01', 1, 'mis_comprobantes'], ['2026-10-31', 2, 'arcanum']]);
  assert.deepStrictEqual(r.comprobantes[0].alicuotas, [{ id: 5, netoGravado: 1000, iva: 210 }]);
  assert.deepStrictEqual(r.comprobantes[1].alicuotas, [{ id: 5, netoGravado: 100, iva: 21 }]);
  assert.strictEqual(r.comprobantes[0].docNro, '30711111118');
  assert.deepStrictEqual(r.cobertura.faltan, [{ desde: '2026-10-21', hasta: '2026-10-31' }], 'la corrida de recibidos no cubre emitidos');
  const vacio = await mc.servicio().emitidos(B, { desde: '2026-11-01', hasta: '2026-11-30' });
  assert.strictEqual(vacio.total, 0);
  assert.strictEqual(vacio.cobertura.sincronizado, false);
  // El guardado de una corrida conserva el detalle por alicuota y los otros tributos.
  const filas = parser.desdeArchivo(Buffer.from(json([filaJson({ 4: '777', 5: '777', 25: '52.5', 27: '500', 29: '210', 31: '1000', 43: '5', 47: '1767.5' })])), 'x.json', 'emitido');
  await mc.repoSql().guardarComprobantes(A, 'emitido', null, filas);
  const { rows: [g] } = await db.query("SELECT alicuotas, otros_tributos::float8 AS ot FROM mc_comprobantes WHERE cuit = $1 AND numero_desde = 777", [A]);
  assert.deepStrictEqual(g.alicuotas, [{ id: 4, netoGravado: 500, iva: 52.5 }, { id: 5, netoGravado: 1000, iva: 210 }]);
  assert.strictEqual(g.ot, 5);
  await limpiar();
});
