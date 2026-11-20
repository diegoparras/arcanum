'use strict';

// El <Cmp> de WSFEX tiene que respetar el WSDL REAL (test/fixtures/wsfexv1.wsdl). Es un servicio
// .NET: lo que llega con otro nombre o fuera de orden se ignora en silencio.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const wsfex = require('../src/services/wsfex');

const WSDL = fs.readFileSync(path.join(__dirname, 'fixtures', 'wsfexv1.wsdl'), 'utf8');

function hijos(tipo) {
  const m = WSDL.match(new RegExp(`<s:complexType name="${tipo}">([\s\S]*?)</s:complexType>`));
  if (!m) return null;
  return [...m[1].matchAll(/<s:element[^>]*name="(\w+)"[^>]*type="(?:tns:|s:)?(\w+)"/g)].map((x) => [x[1], x[2]]);
}

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

test('Cmp de WSFEX respeta el WSDL real e incluye CanMisMonExt (RG 5616)', () => {
  const inv = {
    cliente: 'ACME INC', paisDestino: 212, moneda: 'DOL', cotizacion: 1000, importeTotal: 500,
    permisoExistente: 'S', permisos: [{ id: '26001EC01000123A', destino: 212 }], pagaEnMonedaExtranjera: true,
    items: [{ codigo: 'X', descripcion: 'Software', cantidad: 1, unidad: 7, precioUnitario: 500, total: 500 }],
  };
  const xml = wsfex.armarCmp(inv, { id: 12, ptoVta: 5, numero: 3 });
  const [raiz] = arbol(xml);
  assert.strictEqual(raiz.nombre, 'Cmp');
  validar(raiz.hijos, 'ClsFEXRequest', 'Cmp');
  assert.match(xml, /<ar:CanMisMonExt>S<\/ar:CanMisMonExt>/);
});
