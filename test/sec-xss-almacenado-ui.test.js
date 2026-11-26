'use strict';

// Auditoria de seguridad 2026-11-26, hallazgos A-04, A-05 y A-06 (XSS almacenado).
//
// La UI (public/index.html) arma las tablas con plantillas y las asigna a innerHTML. En tres vistas
// el dato que escribe un usuario de menor privilegio llega crudo:
//   A-04  Facturador masivo: el nombre del lote            (lo escribe un operador)
//   A-05  Clientes:          el nombre del cliente         (lo escribe un operador)
//   A-06  Comprobantes:      el CAE de un importado por QR (lo escribe un operador o viene en el QR
//                                                           de un tercero)
// Quien abre la vista es un admin o un superadmin: el script corre con su sesion.
//
// El test carga el script real de la pagina en un contexto aislado con un DOM minimo, le sirve por
// `fetch` lo mismo que devolveria la API con el dato malicioso guardado y mira el HTML que la vista
// asigna a #view. Corregido en 2.1.12: estos tests evitan que vuelva.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CARGA = '<img src=x onerror="window.__xss=1">';

/** Un elemento del DOM que acepta cualquier cosa: guarda lo que se le asigna y no hace nada mas. */
function elemento() {
  const datos = { innerHTML: '', textContent: '', value: '', className: '', hidden: false };
  const nulo = function () {};
  const proxy = new Proxy(nulo, {
    get(_t, k) {
      if (k in datos) return datos[k];
      if (k === 'then' || typeof k === 'symbol') return undefined;
      return proxy;
    },
    set(_t, k, v) { datos[k] = v; return true; },
    apply() { return proxy; },
  });
  return proxy;
}

/** Carga el script principal de la UI y devuelve sus funciones y el elemento #view. */
function cargarUi(respuestas) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const principal = scripts.sort((a, b) => b.length - a.length)[0];

  const elementos = new Map();
  const el = (sel) => { if (!elementos.has(sel)) elementos.set(sel, elemento()); return elementos.get(sel); };
  const document = {
    querySelector: el,
    getElementById: (id) => el('#' + id),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => elemento(),
    documentElement: elemento(),
    body: elemento(),
  };
  const pendiente = new Promise(() => {}); // lo que la UI pida al arrancar y no nos interesa
  const fetch = (url) => {
    const ruta = String(url).split('?')[0];
    if (!(ruta in respuestas)) return pendiente;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => respuestas[ruta],
    });
  };
  const contexto = {
    document, fetch, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hash: '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/', reload() {} },
    navigator: { clipboard: { writeText() {} } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, confirm: () => false, alert() {}, history: { replaceState() {} },
    URL, URLSearchParams, Date, JSON, Math, Intl, Promise, Number, String, Array, Object, Error,
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(principal, contexto, { filename: 'public/index.html (script)' });
  return { ui: contexto, vista: el('#view') };
}

function sinEtiquetaViva(htmlDeLaVista, donde) {
  assert.ok(htmlDeLaVista.length > 0, `la vista ${donde} no pinto nada (el arnes no la ejercito)`);
  assert.ok(
    !htmlDeLaVista.includes('<img src=x onerror='),
    `${donde}: el dato guardado llega a innerHTML sin escapar y el navegador ejecuta el onerror`,
  );
}

test('A-04: el nombre de un lote (lo escribe un operador) se escapa en Facturador masivo', async () => {
  const { ui, vista } = cargarUi({
    '/api/lotes': { ok: true, lotes: [{
      id: 1, nombre: 'lote ' + CARGA, perfil: 'servicios', cuit: '20111111112', created_at: '2026-11-20T10:00:00Z',
      resumen: { total: 1, emitidos: 0, recibidos: 0, pendientes: 1, rojo: 0, amarillo: 0, verde: 1 },
    }] },
  });
  await ui.vFacturador();
  sinEtiquetaViva(vista.innerHTML, 'Facturador (lote.nombre)');
});

test('A-05: el nombre de un cliente (lo escribe un operador) se escapa en Clientes', async () => {
  const { ui, vista } = cargarUi({
    '/api/tenants': { ok: true, tenants: [{
      cuit: '20999999993', nombre: 'cliente ' + CARGA, tieneClave: true, tieneCertificado: false,
    }] },
  });
  await ui.vClientes();
  sinEtiquetaViva(vista.innerHTML, 'Clientes (tenant.nombre)');
});

test('A-06: el CAE de un comprobante importado por QR se escapa en Comprobantes', async () => {
  const { ui, vista } = cargarUi({
    '/api/comprobantes': { ok: true, comprobantes: [{
      cuit: '20111111112', punto_venta: 9990, tipo_cbte: 11, numero: 99000001, fecha: '2026-11-01',
      cae: '7' + CARGA, importe_total: 1,
    }] },
  });
  await ui.vComprobantes();
  sinEtiquetaViva(vista.innerHTML, 'Comprobantes (cae)');
});
