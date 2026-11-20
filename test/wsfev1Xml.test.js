'use strict';

// El pedido FECAESolicitar tiene que respetar el WSDL REAL de WSFEv1 (test/fixtures/wsfev1.wsdl,
// bajado de ARCA): nombres de elemento y orden de la secuencia. ARCA ignora los elementos que no
// conoce y revienta con NullReferenceException (bug de produccion 2026-11-20: FeCAECabRequest en
// vez de FeCabReq, FECAEDetalle en vez de FeDetReq/FECAEDetRequest, CbteFecha en vez de CbteFch).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const wsfev1 = require('../src/services/wsfev1');

const WSDL = fs.readFileSync(path.join(__dirname, 'fixtures', 'wsfev1.wsdl'), 'utf8');

/** Hijos (nombre, tipo) de un complexType del WSDL, incluida la base que extiende. */
function hijos(tipo) {
  const m = WSDL.match(new RegExp(`<s:complexType name="${tipo}">([\\s\\S]*?)</s:complexType>`));
  if (!m) return null;
  const base = m[1].match(/base="tns:(\w+)"/);
  const propios = [...m[1].matchAll(/<s:element[^>]*name="(\w+)"[^>]*type="([\w:]+)"/g)].map((x) => [x[1], x[2].replace(/^tns:/, '')]);
  return [...(base ? hijos(base[1]) : []), ...propios];
}

/** XML -> arbol { nombre, hijos[] } (sin el prefijo ar:). Suficiente para un pedido SOAP simple. */
function arbol(xml) {
  const raiz = { nombre: '#', hijos: [] };
  const pila = [raiz];
  for (const m of xml.matchAll(/<(\/?)ar:(\w+)>/g)) {
    if (m[1]) { pila.pop(); continue; }
    const nodo = { nombre: m[2], hijos: [] };
    pila[pila.length - 1].hijos.push(nodo);
    pila.push(nodo);
  }
  return raiz.hijos;
}

/** Valida recursivamente nombres y orden de `nodos` contra el tipo del WSDL. */
function validar(nodos, tipo, ruta) {
  const esperados = hijos(tipo);
  if (!esperados || !esperados.length) return; // tipo simple
  let ultimo = -1;
  for (const n of nodos) {
    const i = esperados.findIndex(([nombre]) => nombre === n.nombre);
    assert.ok(i >= 0, `${ruta}: <${n.nombre}> no existe en ${tipo}. Validos: ${esperados.map((e) => e[0]).join(', ')}`);
    assert.ok(i >= ultimo, `${ruta}: <${n.nombre}> esta fuera de orden en ${tipo}`);
    ultimo = i;
    validar(n.hijos, esperados[i][1], `${ruta}/${n.nombre}`);
  }
}

const INV = {
  puntoVenta: 3, tipoComprobante: 1, concepto: 3, tipoDocReceptor: 80, nroDocReceptor: '30711111118',
  importeTotal: 1331, importeNeto: 1000, importeIva: 210, importeTributos: 121, condicionIvaReceptor: 1,
  moneda: 'DOL', cotizacion: 1000, pagaEnMonedaExtranjera: true,
  alicuotasIva: [{ id: 5, baseImponible: 1000, importe: 210 }],
  tributos: [{ id: 99, descripcion: 'Percepcion', baseImponible: 1000, alicuota: 12.1, importe: 121 }],
  comprobantesAsociados: [{ tipo: 1, puntoVenta: 3, numero: 10, cuit: '20263630743', fecha: '2026-11-01' }],
};

test('FECAESolicitar respeta el WSDL real (nombres y orden)', () => {
  const xml = wsfev1.armarFeCAEReq(INV, { ptoVta: 3, tipoCbte: 1, concepto: 3, numero: 11, cbteFecha: '20261120' });
  const nodos = arbol(xml);
  assert.deepStrictEqual(nodos.map((n) => n.nombre), ['FeCAEReq']);
  validar(nodos[0].hijos, 'FECAERequest', 'FeCAEReq');
  const det = nodos[0].hijos.find((n) => n.nombre === 'FeDetReq').hijos[0];
  assert.strictEqual(det.nombre, 'FECAEDetRequest');
  assert.ok(det.hijos.some((n) => n.nombre === 'CbteFch'));
  assert.ok(det.hijos.some((n) => n.nombre === 'Iva'));
});

test('la cabecera lleva CantReg, PtoVta y CbteTipo', () => {
  const xml = wsfev1.armarFeCAEReq({ ...INV, alicuotasIva: [], tributos: [], comprobantesAsociados: [] },
    { ptoVta: 7, tipoCbte: 11, concepto: 1, numero: 5, cbteFecha: '20261120' });
  assert.match(xml, /<ar:FeCabReq><ar:CantReg>1<\/ar:CantReg><ar:PtoVta>7<\/ar:PtoVta><ar:CbteTipo>11<\/ar:CbteTipo><\/ar:FeCabReq>/);
  assert.match(xml, /<ar:CbteFch>20261120<\/ar:CbteFch>/);
  assert.doesNotMatch(xml, /CbteFecha|FeCAECabRequest|FECAEDetalle/);
});

test('FeCAEARegInfReq (CAEA) respeta el WSDL real', () => {
  const xml = wsfev1.armarFeCAEReq({ ...INV, alicuotasIva: [], tributos: [], comprobantesAsociados: [] },
    { ptoVta: 9, tipoCbte: 11, concepto: 1, numero: 3, cbteFecha: '20261120', caea: '31111111111111', fchHsGen: '20261120101500' });
  const nodos = arbol(xml);
  assert.deepStrictEqual(nodos.map((n) => n.nombre), ['FeCAEARegInfReq']);
  validar(nodos[0].hijos, 'FECAEARequest', 'FeCAEARegInfReq');
  const det = nodos[0].hijos.find((n) => n.nombre === 'FeDetReq').hijos[0];
  assert.strictEqual(det.nombre, 'FECAEADetRequest');
  assert.deepStrictEqual(det.hijos.slice(-2).map((n) => n.nombre), ['CAEA', 'CbteFchHsGen']);
});
