'use strict';

// Constatacion masiva: WSCDC por comprobante + APOC una vez por emisor, tope de 500, y lista
// en CSV (formato propio o el de Mis Comprobantes recibidos).

const { test } = require('node:test');
const assert = require('node:assert');

const cons = require('../src/services/constatacion');

const item = (n, emisor = '30711111118') => ({ cuitEmisor: emisor, puntoVenta: 1, tipoComprobante: 11, numero: n, fecha: '2026-11-02', importeTotal: 100, cae: `7645${n}`, docTipo: 80, docNro: '20263630743' });

function deps() {
  const d = { wscdc: [], apocLlamadas: [] };
  d.constatar = async (consultante, it) => {
    d.wscdc.push(it);
    return it.numero === 2 ? { valido: false, resultado: 'R', observaciones: ['No existe el comprobante'] } : { valido: true, resultado: 'A', observaciones: [] };
  };
  d.apoc = async (consultante, emisor) => { d.apocLlamadas.push(emisor); return { esApocrifo: emisor === '30999999995' }; };
  return d;
}

test('marca invalido lo que WSCDC rechaza', async () => {
  const d = deps();
  const r = await cons.constatarLista('20263630743', [item(1), item(2)], { pausaMs: 0, deps: d });
  assert.deepStrictEqual(r.resultados.map((x) => x.valido), [true, false]);
  assert.deepStrictEqual(r.resultados[1].observaciones, ['No existe el comprobante']);
  assert.strictEqual(r.validos, 1);
  assert.strictEqual(r.invalidos, 1);
  assert.strictEqual(d.wscdc[0].fecha, '20261102');
});

test('consulta APOC una sola vez por emisor y marca apocrifos', async () => {
  const d = deps();
  const r = await cons.constatarLista('20263630743', [item(1), item(3), item(4, '30999999995')], { pausaMs: 0, deps: d });
  assert.deepStrictEqual(d.apocLlamadas.sort(), ['30711111118', '30999999995']);
  assert.strictEqual(r.resultados[2].apoc.esApocrifo, true);
  assert.strictEqual(r.emisoresApocrifos, 1);
});

test('un error de ARCA en un item no corta la lista', async () => {
  const d = deps();
  d.constatar = async (c, it) => { if (it.numero === 1) throw new Error('timeout de ARCA'); return { valido: true, resultado: 'A', observaciones: [] }; };
  const r = await cons.constatarLista('20263630743', [item(1), item(3)], { pausaMs: 0, deps: d });
  assert.strictEqual(r.resultados[0].valido, null);
  assert.match(r.resultados[0].error, /timeout/);
  assert.strictEqual(r.resultados[1].valido, true);
});

test('tope de 500', async () => {
  await assert.rejects(cons.constatarLista('20263630743', Array.from({ length: 501 }, (_, i) => item(i + 1)), { pausaMs: 0, deps: deps() }),
    (e) => e.httpStatus === 413);
});

test('CSV de lista se parsea (formato propio)', () => {
  const csv = 'cuitEmisor;puntoVenta;tipo;numero;fecha;importe;cae\n30711111118;1;11;125;02/11/2026;150000,00;76451234567890\n';
  const [it] = cons.parsearListaCsv(csv, '20263630743');
  assert.deepStrictEqual(
    { e: it.cuitEmisor, pv: it.puntoVenta, t: it.tipoComprobante, n: it.numero, f: it.fecha, i: it.importeTotal, cae: it.cae, dn: it.docNro },
    { e: '30711111118', pv: 1, t: 11, n: 125, f: '2026-11-02', i: 150000, cae: '76451234567890', dn: '20263630743' },
  );
});

test('CSV de Mis Comprobantes recibidos se parsea (el emisor es la contraparte)', () => {
  const csv = 'Fecha;Tipo;Punto de Venta;Número Desde;Cód. Autorización;Tipo Doc. Emisor;Nro. Doc. Emisor;Denominación Emisor;Imp. Total\n'
    + '05/11/2026;6 - Factura B;2;48;76451234567892;80;30711111118;PROVEEDOR SA;1.210,00\n';
  const [it] = cons.parsearListaCsv(csv, '20263630743');
  assert.strictEqual(it.cuitEmisor, '30711111118');
  assert.strictEqual(it.tipoComprobante, 6);
  assert.strictEqual(it.importeTotal, 1210);
});

test('fila de mc_comprobantes recibida se convierte en item', () => {
  const it = cons.itemDesdeMc({ cuit: '20263630743', cbte_tipo: 11, punto_venta: 1, numero_desde: 9, fecha: new Date('2026-11-02T00:00:00Z'), total: '50.5', cae: '7', doc_nro: '30711111118' });
  assert.deepStrictEqual(it, { cuitEmisor: '30711111118', puntoVenta: 1, tipoComprobante: 11, numero: 9, fecha: '2026-11-02', importeTotal: 50.5, cae: '7', docTipo: 80, docNro: '20263630743' });
});

// ---- Constatar los recibidos en segundo plano (con progreso y guardado de a uno) ----

function fila(id, numero, emisor = '30711111118') {
  return { id, cuit: '20263630743', tipo: 'recibido', fecha: '2026-11-02', cbte_tipo: 1, punto_venta: 3950, numero_desde: numero, doc_nro: emisor, contraparte: `EMISOR ${emisor}`, total: 100, cae: '7' };
}
function repoFalso(filas) {
  const r = { guardados: [], pedidos: [] };
  r.pendientes = async (cuit, filtros, limite) => { r.pedidos.push({ cuit, filtros, limite }); return filas; };
  r.guardar = async (id, c) => { r.guardados.push([id, c.valido]); };
  r.contarPendientes = async () => 7;
  return r;
}

test('constatar en segundo plano: responde enseguida, avanza de a uno y guarda cada resultado al toque', async () => {
  const d = deps();
  let soltar;
  const compuerta = new Promise((r) => { soltar = r; });
  const constatar = d.constatar;
  d.constatar = async (c, it) => { if (it.numero === 2) await compuerta; return constatar(c, it); };
  const repo = repoFalso([fila(11, 1), fila(12, 2), fila(13, 3, '30999999995')]);
  const cuit = '20263630743';
  const inicial = await cons.iniciarConstatacion(cuit, { filtros: { contraparte: '30711111118' }, pausaMs: 0, deps: d, repo });
  assert.strictEqual(inicial.estado, 'corriendo');
  assert.strictEqual(inicial.total, 3);
  assert.deepStrictEqual(repo.pedidos[0].filtros, { contraparte: '30711111118' });
  await new Promise((r) => setTimeout(r, 10));
  const medio = cons.estadoConstatacion(cuit);
  assert.strictEqual(medio.hechos, 1, 'el primero ya termino mientras el segundo espera');
  assert.deepStrictEqual(repo.guardados, [[11, true]], 'guardado antes de que termine el resto');
  assert.ok(medio.actual && /3950-00000002/.test(medio.actual.comprobante), 'dice cual esta constatando');
  await assert.rejects(cons.iniciarConstatacion(cuit, { pausaMs: 0, deps: d, repo }), (e) => e.httpStatus === 409);
  soltar();
  await cons.esperarConstatacion(cuit);
  const fin = cons.estadoConstatacion(cuit);
  assert.strictEqual(fin.estado, 'terminado');
  assert.deepStrictEqual([fin.hechos, fin.validos, fin.invalidos, fin.conError, fin.emisoresApocrifos, fin.pendientes], [3, 2, 1, 0, 1, 7]);
  assert.deepStrictEqual(repo.guardados, [[11, true], [12, false], [13, true]]);
});

test('un error de ARCA en un comprobante no se guarda (se reintenta despues) y no corta el resto', async () => {
  const d = deps();
  d.constatar = async (c, it) => { if (it.numero === 1) throw new Error('WSCDC no responde'); return { valido: true, resultado: 'A', observaciones: [] }; };
  const repo = repoFalso([fila(21, 1), fila(22, 5)]);
  await cons.iniciarConstatacion('30711111118', { pausaMs: 0, deps: d, repo });
  await cons.esperarConstatacion('30711111118');
  const fin = cons.estadoConstatacion('30711111118');
  assert.deepStrictEqual([fin.estado, fin.conError, fin.validos], ['terminado', 1, 1]);
  assert.deepStrictEqual(repo.guardados, [[22, true]]);
});

test('sin recibidos pendientes termina enseguida con total cero', async () => {
  const repo = repoFalso([]);
  const r = await cons.iniciarConstatacion('20111111112', { pausaMs: 0, deps: deps(), repo });
  assert.deepStrictEqual([r.estado, r.total], ['terminado', 0]);
  assert.strictEqual(cons.estadoConstatacion('99999999999'), null);
});

// ---- Reintento con otro documento del receptor ----

test('si ARCA rechaza con el CUIT del receptor, reintenta con su DNI y da OK si coincide', async () => {
  const d = deps();
  d.constatar = async (c, it) => {
    d.wscdc.push([it.docTipo, it.docNro]);
    return it.docTipo === 96 ? { valido: true, resultado: 'A', observaciones: [] }
      : { valido: false, resultado: 'R', observaciones: [{ code: 1, message: 'El documento del receptor no coincide' }] };
  };
  const r = await cons.constatarLista('20263630743', [item(1)], { pausaMs: 0, deps: d });
  const x = r.resultados[0];
  assert.strictEqual(x.valido, true);
  assert.deepStrictEqual(x.receptor, { como: 'DNI', docTipo: 96, docNro: '26363074' });
  assert.deepStrictEqual(x.receptorProbado, ['CUIT', 'DNI']);
  assert.deepStrictEqual(d.wscdc, [[80, '20263630743'], [96, '26363074']], 'no prueba consumidor final si el DNI ya dio OK');
  assert.strictEqual(r.validos, 1);
});

test('si no coincide ni con CUIT ni con DNI, prueba como consumidor final', async () => {
  const d = deps();
  d.constatar = async (c, it) => {
    d.wscdc.push(it.docTipo);
    return it.docTipo === 99 && it.docNro === '0' ? { valido: true, resultado: 'A', observaciones: [] } : { valido: false, resultado: 'R', observaciones: [] };
  };
  const r = await cons.constatarLista('20263630743', [item(1)], { pausaMs: 0, deps: d });
  assert.strictEqual(r.resultados[0].receptor.como, 'consumidor_final');
  assert.deepStrictEqual(d.wscdc, [80, 96, 99]);
});

test('si no coincide de ninguna forma queda NO CONSTA con el motivo original de ARCA', async () => {
  const d = deps();
  d.constatar = async (c, it) => ({ valido: false, resultado: 'R', observaciones: [{ code: it.docTipo, message: `rechazo ${it.docTipo}` }] });
  const r = await cons.constatarLista('20263630743', [item(1)], { pausaMs: 0, deps: d });
  const x = r.resultados[0];
  assert.strictEqual(x.valido, false);
  assert.strictEqual(x.receptor, undefined);
  assert.deepStrictEqual(x.receptorProbado, ['CUIT', 'DNI', 'consumidor_final']);
  assert.deepStrictEqual(x.observaciones, [{ code: 80, message: 'rechazo 80' }], 'se muestra el rechazo con el CUIT, no el de la ultima variante');
});

test('una empresa receptora no tiene DNI: solo se prueba como consumidor final', async () => {
  const d = deps();
  d.constatar = async (c, it) => { d.wscdc.push(it.docTipo); return { valido: false, resultado: 'R', observaciones: [] }; };
  await cons.constatarLista('30711111118', [{ ...item(1), docNro: '30711111118' }], { pausaMs: 0, deps: d });
  assert.deepStrictEqual(d.wscdc, [80, 99]);
});

test('lo aprobado a la primera, o un error de ARCA, no dispara reintentos', async () => {
  const d = deps();
  const r = await cons.constatarLista('20263630743', [item(1)], { pausaMs: 0, deps: d });
  assert.strictEqual(r.resultados[0].receptorProbado, undefined);
  assert.strictEqual(d.wscdc.length, 1);
  const e = deps();
  e.constatar = async (c, it) => { e.wscdc.push(it); throw new Error('WSCDC no responde'); };
  const r2 = await cons.constatarLista('20263630743', [item(1)], { pausaMs: 0, deps: e });
  assert.strictEqual(r2.resultados[0].valido, null);
  assert.strictEqual(e.wscdc.length, 1);
});

test('lo que se guarda dice con que documento dio OK y que se probo', async () => {
  const d = deps();
  d.constatar = async (c, it) => (it.docTipo === 96 ? { valido: true, resultado: 'A', observaciones: [] } : { valido: false, resultado: 'R', observaciones: [] });
  const repo = repoFalso([fila(31, 1)]);
  const completos = [];
  repo.guardar = async (id, c) => { completos.push([id, c]); };
  await cons.iniciarConstatacion('20444444441', { pausaMs: 0, deps: d, repo });
  await cons.esperarConstatacion('20444444441');
  const [, g] = completos[0];
  assert.strictEqual(g.valido, true);
  assert.deepStrictEqual(g.receptor, { como: 'DNI', docTipo: 96, docNro: '26363074' });
  assert.deepStrictEqual(g.receptorProbado, ['CUIT', 'DNI']);
});

// ---- Detener y seguir despues ----

test('detener corta entre un comprobante y el siguiente: lo hecho queda y el resto sigue pendiente', async () => {
  const d = deps();
  let soltar;
  const compuerta = new Promise((r) => { soltar = r; });
  const constatar = d.constatar;
  d.constatar = async (c, it) => { if (it.numero === 1) await compuerta; return constatar(c, it); };
  const repo = repoFalso([fila(41, 1), fila(42, 3), fila(43, 4)]);
  const cuit = '20555555551';
  await cons.iniciarConstatacion(cuit, { pausaMs: 0, deps: d, repo });
  await new Promise((r) => setTimeout(r, 5));
  const pedido = cons.detenerConstatacion(cuit);
  assert.strictEqual(pedido.deteniendo, true);
  assert.strictEqual(pedido.detener, undefined, 'la marca interna no se muestra');
  soltar();
  await cons.esperarConstatacion(cuit);
  const fin = cons.estadoConstatacion(cuit);
  assert.strictEqual(fin.estado, 'detenido');
  assert.strictEqual(fin.hechos, 1, 'termino el que estaba en curso y paro');
  assert.deepStrictEqual(repo.guardados, [[41, true]], 'los demas no se tocaron: quedan pendientes');
  assert.ok(fin.terminada);
  assert.throws(() => cons.detenerConstatacion(cuit), (e) => e.httpStatus === 409, 'ya no hay nada corriendo');
  // Se puede volver a arrancar enseguida.
  const otra = await cons.iniciarConstatacion(cuit, { pausaMs: 0, deps: deps(), repo: repoFalso([fila(42, 3)]) });
  assert.strictEqual(otra.estado, 'corriendo');
  await cons.esperarConstatacion(cuit);
});

test('detener sin nada corriendo responde 409', () => {
  assert.throws(() => cons.detenerConstatacion('20666666661'), (e) => e.httpStatus === 409);
});
