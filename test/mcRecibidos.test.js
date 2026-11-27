'use strict';

// Recibidos para la conciliacion de Factorum: la cobertura de la sincronizacion (que periodo esta
// bajado y que falta), el servicio con un repo doble (tope, truncado, fechas, formato) y la ruta
// (rol lectura, alcance por CUIT, sin datos de otros CUITs). Contra Postgres, con
// ARCANUM_TEST_DATABASE_URL, el repo SQL de verdad.

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const URL_DB = process.env.ARCANUM_TEST_DATABASE_URL;
if (URL_DB) process.env.DATABASE_URL = URL_DB;
after(async () => { if (URL_DB) await require('../src/db').pool.end(); });

const mc = require('../src/services/misComprobantes');
const { crearRutas } = require('../src/rutas/misComprobantes');
const { sendError } = require('../src/lib/http');
const { assertPuedeEscribir } = require('../src/auth/permisos');

const AHORA = new Date('2026-11-27T15:00:00Z');
const corrida = (id, desde, hasta, estado = 'terminado', extra = {}) => ({
  id, tipo: 'recibidos', desde, hasta, estado, iniciada_at: new Date(`${hasta}T12:00:00Z`), terminada_at: estado === 'terminado' ? new Date(`${hasta}T12:05:00Z`) : null, cantidad: 10, error: null, ...extra,
});

test('unirRangos junta los que se pisan o se tocan', () => {
  assert.deepStrictEqual(mc.unirRangos([
    { desde: '2026-03-01', hasta: '2026-03-31' }, { desde: '2026-01-01', hasta: '2026-01-31' },
    { desde: '2026-02-01', hasta: '2026-02-10' }, { desde: '2026-03-15', hasta: '2026-04-05' }, { desde: '2026-06-01', hasta: '2026-05-01' },
  ]), [{ desde: '2026-01-01', hasta: '2026-02-10' }, { desde: '2026-03-01', hasta: '2026-04-05' }]);
});

test('cobertura: periodo cubierto, con huecos y sin sincronizar', () => {
  const cs = [corrida(1, '2025-11-01', '2026-10-31'), corrida(2, '2026-10-01', '2026-11-20')];
  const c = mc.coberturaRecibidos(cs, '2026-10-01', '2026-10-31', AHORA);
  assert.strictEqual(c.sincronizado, true);
  assert.strictEqual(c.cubre, true);
  assert.deepStrictEqual(c.faltan, []);
  assert.deepStrictEqual(c.rangos, [{ desde: '2025-11-01', hasta: '2026-11-20' }]);
  assert.strictEqual(c.ultimaSincronizacion.corrida, 2);
  assert.strictEqual(c.ultimaSincronizacion.hasta, '2026-11-20');

  const fin = mc.coberturaRecibidos(cs, '2026-11-01', '2026-11-30', AHORA);
  assert.strictEqual(fin.cubre, false);
  assert.deepStrictEqual(fin.faltan, [{ desde: '2026-11-21', hasta: '2026-11-30' }]);

  const medio = mc.coberturaRecibidos([corrida(1, '2026-01-01', '2026-01-31'), corrida(2, '2026-03-01', '2026-03-31')], '2025-12-15', '2026-04-10', AHORA);
  assert.deepStrictEqual(medio.faltan, [
    { desde: '2025-12-15', hasta: '2025-12-31' }, { desde: '2026-02-01', hasta: '2026-02-28' }, { desde: '2026-04-01', hasta: '2026-04-10' }]);

  const nada = mc.coberturaRecibidos([], '2026-11-01', '2026-11-30', AHORA);
  assert.strictEqual(nada.sincronizado, false);
  assert.strictEqual(nada.cubre, false);
  assert.deepStrictEqual(nada.faltan, [{ desde: '2026-11-01', hasta: '2026-11-30' }]);
  assert.strictEqual(nada.ultimaSincronizacion, null);
  assert.strictEqual(nada.ultimaCorrida, null);
});

test('cobertura: una corrida que fallo no cubre, y se informa la ultima y la que esta en curso', () => {
  const cs = [
    corrida(1, '2026-01-01', '2026-06-30'),
    corrida(2, '2026-07-01', '2026-11-26', 'error', { error: 'ARCA rechazó el ingreso', cantidad: 40 }),
    corrida(3, '2026-07-01', '2026-11-27', 'corriendo', { latido_at: new Date('2026-11-27T14:58:00Z') }),
  ];
  const c = mc.coberturaRecibidos(cs, '2026-06-01', '2026-08-31', AHORA);
  assert.deepStrictEqual(c.faltan, [{ desde: '2026-07-01', hasta: '2026-08-31' }]);
  assert.strictEqual(c.ultimaCorrida.corrida, 3);
  assert.strictEqual(c.enCurso.corrida, 3);
  const vieja = mc.coberturaRecibidos([cs[0], cs[1]], '2026-06-01', '2026-08-31', AHORA);
  assert.strictEqual(vieja.ultimaCorrida.estado, 'error');
  assert.match(vieja.ultimaCorrida.error, /rechazó/);
  assert.strictEqual(vieja.enCurso, null);
  // Una viva sin latido hace mas de 10 minutos ya no cuenta como en curso.
  const trabada = mc.coberturaRecibidos([corrida(4, '2026-07-01', '2026-11-27', 'corriendo', { latido_at: new Date('2026-11-27T14:00:00Z') })], '2026-07-01', '2026-07-31', AHORA);
  assert.strictEqual(trabada.enCurso, null);
});

function repoFalso(filas, corridas = [corrida(1, '2026-01-01', '2026-11-20')]) {
  const r = { pedidos: [] };
  r.credencial = async () => ({ cuit: '30711111118', clave_cifrada: 'x', sincronizar: true });
  r.corridasRecibidos = async (cuit) => { r.pedidos.push(['corridas', cuit]); return corridas; };
  r.recibidosRango = async (cuit, desde, hasta, tope) => {
    r.pedidos.push(['rango', cuit, desde, hasta, tope]);
    const dentro = filas.filter((f) => f.fecha >= desde && f.fecha <= hasta);
    return { filas: dentro.slice(0, tope + 1), total: dentro.length };
  };
  return r;
}

const fila = (n, extra = {}) => ({
  fecha: '2026-10-05', cbte_tipo: 1, punto_venta: 3, numero_desde: String(n), numero_hasta: String(n), cae: '76123456789012',
  doc_tipo: 80, doc_nro: '30500000001', contraparte: 'Proveedor SA', moneda: 'PES', tipo_cambio: 1,
  neto_gravado: 1000, no_gravado: 0, exento: 0, iva: 210, total: 1210, emisor_apocrifo: null, ...extra,
});

test('recibidos: formato, cobertura, tope y truncado', async () => {
  const repo = repoFalso([fila(1), fila(2, { moneda: 'DOL', tipo_cambio: 1050.5, emisor_apocrifo: true }), fila(3, { fecha: '2026-11-25' })]);
  const s = mc.crear({ repo, fisherboy: {}, vault: {}, webhooks: {}, ahora: () => AHORA });
  const r = await s.recibidos('30-71111111-8', { desde: '2026-10-01', hasta: '2026-11-30' });
  assert.strictEqual(r.cuit, '30711111118');
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.truncado, false);
  assert.strictEqual(r.tope, mc.MAX_RECIBIDOS);
  assert.deepStrictEqual(r.comprobantes[0], {
    fecha: '2026-10-05', cbteTipo: 1, puntoVenta: 3, numeroDesde: 1, numeroHasta: 1, cae: '76123456789012', docTipo: 80,
    cuitEmisor: '30500000001', emisor: 'Proveedor SA', moneda: 'PES', tipoCambio: 1,
    netoGravado: 1000, noGravado: 0, exento: 0, iva: 210, total: 1210, emisorApocrifo: null,
  });
  assert.strictEqual(r.comprobantes[1].emisorApocrifo, true);
  assert.strictEqual(r.comprobantes[1].tipoCambio, 1050.5);
  assert.strictEqual(r.cobertura.cubre, false, 'del 21 al 30 de noviembre no está bajado');
  assert.deepStrictEqual(r.cobertura.faltan, [{ desde: '2026-11-21', hasta: '2026-11-30' }]);
  assert.strictEqual(r.cobertura.credencial, true);
  assert.strictEqual(r.cobertura.sincronizarDiaria, true);

  const corto = await s.recibidos('30711111118', { desde: '2026-10-01', hasta: '2026-11-30', limite: '2' });
  assert.strictEqual(corto.comprobantes.length, 2);
  assert.strictEqual(corto.truncado, true);
  assert.strictEqual(corto.total, 3);
  const enorme = await s.recibidos('30711111118', { desde: '2026-10-01', hasta: '2026-11-30', limite: '999999' });
  assert.strictEqual(enorme.tope, mc.MAX_RECIBIDOS, 'el tope no se pasa');
});

test('recibidos: valida CUIT y fechas', async () => {
  const s = mc.crear({ repo: repoFalso([]), fisherboy: {}, vault: {}, webhooks: {}, ahora: () => AHORA });
  const es400 = (e) => e.httpStatus === 400;
  await assert.rejects(s.recibidos('123', { desde: '2026-01-01', hasta: '2026-01-31' }), es400);
  await assert.rejects(s.recibidos('30711111118', { desde: '2026-01-01' }), es400);
  await assert.rejects(s.recibidos('30711111118', { desde: '01/01/2026', hasta: '2026-01-31' }), es400);
  await assert.rejects(s.recibidos('30711111118', { desde: '2026-02-01', hasta: '2026-01-31' }), es400);
  await assert.rejects(s.recibidos('30711111118', { desde: '2023-01-01', hasta: '2026-01-31' }), /2 años/);
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

test('ruta: una clave de lectura con alcance ve solo sus CUITs', async () => {
  const pedidos = [];
  const doble = { recibidos: async (cuit, o) => { pedidos.push([cuit, o]); return { cuit, desde: o.desde, hasta: o.hasta, total: 0, tope: 20000, truncado: false, cobertura: {}, comprobantes: [] }; } };
  const LECTURA = { username: 'clave:factorum', role: 'lectura', cuitAllow: ['30711111118'] };
  await conServidor(LECTURA, doble, async (base) => {
    const ok = await fetch(`${base}/api/mis-comprobantes/30711111118/recibidos?desde=2026-10-01&hasta=2026-10-31`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('cache-control'), 'no-store');
    const texto = await ok.text();
    assert.ok(!texto.includes('\n  '), 'JSON compacto');
    assert.strictEqual(JSON.parse(texto).ok, true);
    const otro = await fetch(`${base}/api/mis-comprobantes/20263630743/recibidos?desde=2026-10-01&hasta=2026-10-31`);
    assert.strictEqual(otro.status, 403);
    assert.deepStrictEqual(pedidos, [['30711111118', { desde: '2026-10-01', hasta: '2026-10-31', limite: undefined }]]);
    assert.strictEqual((await fetch(`${base}/api/mis-comprobantes/30711111118/recibidos`, { method: 'POST' })).status, 403, 'lectura no hace POST');
  });
});

test('ruta: un error inesperado no muestra el detalle', async () => {
  const doble = { recibidos: async () => { throw new Error('relation "mc_comprobantes" secreta'); } };
  const orig = console.error;
  console.error = () => {};
  try {
    await conServidor({ username: 'a', role: 'admin' }, doble, async (base) => {
      const r = await fetch(`${base}/api/mis-comprobantes/30711111118/recibidos?desde=2026-10-01&hasta=2026-10-31`);
      assert.strictEqual(r.status, 500);
      const b = await r.json();
      assert.ok(!b.error.includes('secreta'));
      assert.match(b.error, /Error interno/);
    });
  } finally { console.error = orig; }
});

test('recibidos en Postgres: solo los recibidos del CUIT y del rango, y la cobertura', { skip: URL_DB ? false : 'sin ARCANUM_TEST_DATABASE_URL' }, async () => {
  const db = require('../src/db');
  await db.migrate();
  const A = '30799999991';
  const B = '30799999992';
  await db.query('DELETE FROM mc_comprobantes WHERE cuit = ANY($1)', [[A, B]]);
  await db.query('DELETE FROM mc_corridas WHERE cuit = ANY($1)', [[A, B]]);
  const ins = (cuit, tipo, fecha, n, total, extra = '') => db.query(
    `INSERT INTO mc_comprobantes (cuit, tipo, fecha, cbte_tipo, punto_venta, numero_desde, numero_hasta, doc_tipo, doc_nro, contraparte, moneda, tipo_cambio, neto_gravado, iva, total, constatacion)
     VALUES ($1, $2, $3, 1, 2, $4, $4, 80, '30500000001', 'Proveedor SA', 'PES', 1, $5 / 1.21, $5 - $5 / 1.21, $5, ${extra ? `'${extra}'::jsonb` : 'NULL'})`, [cuit, tipo, fecha, n, total]);
  await ins(A, 'recibido', '2026-10-01', 1, 1210.5, '{"valido":true,"apoc":{"esApocrifo":false}}');
  await ins(A, 'recibido', '2026-10-31', 2, 100);
  await ins(A, 'recibido', '2026-11-01', 3, 100);
  await ins(A, 'emitido', '2026-10-10', 4, 100);
  await ins(B, 'recibido', '2026-10-10', 5, 100);
  await db.query(`INSERT INTO mc_corridas (cuit, tipo, desde, hasta, estado, iniciada_at, terminada_at, cantidad)
    VALUES ($1, 'ambos', '2026-01-01', '2026-10-20', 'terminado', now(), now(), 4), ($1, 'emitidos', '2026-10-21', '2026-11-27', 'terminado', now(), now(), 1)`, [A]);
  const r = await mc.servicio().recibidos(A, { desde: '2026-10-01', hasta: '2026-10-31' });
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.comprobantes.map((c) => [c.fecha, c.numeroDesde]), [['2026-10-01', 1], ['2026-10-31', 2]]);
  assert.strictEqual(r.comprobantes[0].total, 1210.5);
  assert.strictEqual(r.comprobantes[0].emisorApocrifo, false);
  assert.strictEqual(r.comprobantes[1].emisorApocrifo, null);
  assert.ok(r.comprobantes.every((c) => c.cuitEmisor === '30500000001'));
  assert.deepStrictEqual(r.cobertura.faltan, [{ desde: '2026-10-21', hasta: '2026-10-31' }], 'la corrida de emitidos no cubre recibidos');
  assert.strictEqual(r.cobertura.ultimaSincronizacion.hasta, '2026-10-20');
  const vacio = await mc.servicio().recibidos(B, { desde: '2026-11-01', hasta: '2026-11-30' });
  assert.strictEqual(vacio.total, 0);
  assert.strictEqual(vacio.cobertura.sincronizado, false);
  await db.query('DELETE FROM mc_comprobantes WHERE cuit = ANY($1)', [[A, B]]);
  await db.query('DELETE FROM mc_corridas WHERE cuit = ANY($1)', [[A, B]]);
});
