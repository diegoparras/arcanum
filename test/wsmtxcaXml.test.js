'use strict';

// El comprobante de WSMTXCA tiene que respetar el WSDL REAL (test/fixtures/wsmtxca.wsdl): los
// servicios Java de ARCA validan nombres Y orden de la secuencia de ComprobanteType.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const wsmtxca = require('../src/services/wsmtxca');

const WSDL = fs.readFileSync(path.join(__dirname, 'fixtures', 'wsmtxca.wsdl'), 'utf8');

function hijos(tipo) {
  const m = WSDL.match(new RegExp(`<\w+:complexType name="${tipo}">([\s\S]*?)</\w+:complexType>`));
  if (!m) return null;
  return [...m[1].matchAll(/<\w+:element[^>]*name="(\w+)"[^>]*type="(?:tns:|xsd:)?(\w+)"/g)].map((x) => [x[1], x[2]]);
}

function arbol(xml) {
  const raiz = { nombre: '#', hijos: [] };
  const pila = [raiz];
  for (const m of xml.matchAll(/<(\/?)(\w+)>/g)) {
    if (m[1]) { pila.pop(); continue; }
    const nodo = { nombre: m[2], hijos: [] };
    pila[pila.length - 1].hijos.push(nodo);
    pila.push(nodo);
  }
  return raiz.hijos;
}

function validar(nodos, tipo, ruta) {
  const esperados = hijos(tipo);
  if (!esperados || !esperados.length) return;
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
  tipoDocReceptor: 80, nroDocReceptor: '30711111118', condicionIvaReceptor: 1, concepto: 2,
  importeGravado: 1000, importeTotal: 1210, moneda: 'DOL', cotizacion: 1000, pagaEnMonedaExtranjera: true,
  observaciones: 'prueba',
  items: [{ codigo: 'A1', descripcion: 'Servicio', cantidad: 1, precioUnitario: 1000, codigoCondicionIVA: 5, importeIVA: 210, importeItem: 1210 }],
  subtotalesIVA: [{ codigo: 5, importe: 210 }],
};

test('comprobante de WSMTXCA respeta el WSDL real (nombres y orden)', () => {
  const xml = wsmtxca.armarComprobante(INV, { tipoCbte: 1, ptoVta: 4, numero: 9, fechaEmision: '2026-11-20', concepto: 2 });
  const [raiz] = arbol(xml);
  assert.strictEqual(raiz.nombre, 'comprobanteCAERequest');
  validar(raiz.hijos, 'ComprobanteType', 'comprobanteCAERequest');
  const nombres = raiz.hijos.map((n) => n.nombre);
  assert.ok(nombres.includes('condicionIVAReceptor'));
  assert.ok(nombres.includes('cancelaEnMismaMonedaExtranjera'));
});

test('en pesos no manda cancelaEnMismaMonedaExtranjera', () => {
  const xml = wsmtxca.armarComprobante({ ...INV, moneda: 'PES', cotizacion: 1 }, { tipoCbte: 1, ptoVta: 4, numero: 9, fechaEmision: '2026-11-20', concepto: 1 });
  assert.doesNotMatch(xml, /cancelaEnMismaMonedaExtranjera|condicionIVAReceptorId/);
});
