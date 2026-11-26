'use strict';

// Auditoria de seguridad 2026-11-26, hallazgo A-08.
//
// El catalogo de servicios decide a que URL manda Arcanum el sobre SOAP, que lleva el Ticket de
// Acceso de WSAA (<Token> y <Sign>) del CUIT. Dos defectos encadenados:
//   1. `catalog.upsert` no valida los endpoints: acepta http, IPs internas, el servicio de metadata
//      de la nube o cualquier host de un tercero, tambien al pisar un servicio builtin.
//   2. La ruta /api/services deja escribir al rol `admin` (y por lo tanto a una clave de API con rol
//      admin y a la clave maestra), cuando README, users.js y el propio catalog.js dicen que el
//      catalogo lo edita solo el superadmin.
// Resultado: una clave de API admin filtrada redirige un servicio y se lleva el Token+Sign de
// cualquier CUIT con certificado, valido 12 horas contra ARCA por fuera de Arcanum.
//
// Corregido en 2.1.13 (catalog.validarEndpoint y la ruta /api/services): estos tests evitan que vuelva.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const db = require('../src/db');

const DEF = {
  id: 'sec_audit_svc',
  nombre: 'Servicio de prueba',
  categoria: 'otros',
  wsaaService: 'wsfe',
  soapNamespace: 'http://ar.gov.afip.dif.FEV1/',
};

/** Base simulada: guarda los servicios que se inserten y responde vacio a todo lo demas. */
function baseSimulada() {
  const servicios = new Map();
  const original = { query: db.query, tx: db.tx, withLock: db.withLock };
  db.query = async (sql, params = []) => {
    if (/INSERT INTO services/i.test(sql)) { servicios.set(params[0], params[1]); return { rows: [] }; }
    if (/FROM services/i.test(sql)) {
      return { rows: [...servicios].map(([id, definition]) => ({ id, definition: JSON.parse(definition), enabled: true, origin: 'custom' })) };
    }
    return { rows: [] };
  };
  db.tx = async (fn) => fn({ query: db.query });
  db.withLock = async (_k, fn) => fn({ query: db.query });
  return { servicios, restaurar: () => Object.assign(db, original) };
}

test('A-08: el catalogo rechaza endpoints que no son de ARCA (metadata, red interna, terceros)', async () => {
  const base = baseSimulada();
  const catalog = require('../src/catalog');
  try {
    const destinos = [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/api/health',
      'http://postgres:5432/',
      'https://atacante.example/soap',
    ];
    const aceptados = [];
    for (const url of destinos) {
      try {
        await catalog.upsert({ ...DEF, endpoints: { homo: url, prod: url } }, 'test');
        aceptados.push(url);
      } catch { /* rechazado: es lo esperado */ }
    }
    assert.deepStrictEqual(aceptados, [], 'el catalogo guardo endpoints fuera de ARCA; ahi viajan Token y Sign de WSAA');
  } finally {
    base.restaurar();
  }
});

test('A-08: un admin que no es superadmin (ni una clave de API admin) no edita el catalogo', async () => {
  const base = baseSimulada();
  const session = require('../src/auth/session');
  const { server } = require('../src/server');
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const pedir = (cookie) => new Promise((ok, mal) => {
    const cuerpo = JSON.stringify({ ...DEF, id: 'sec_audit_rol', endpoints: { homo: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx', prod: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx' } });
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/services', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo), Cookie: cookie, Connection: 'close' },
    }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    req.on('error', mal);
    req.end(cuerpo);
  });
  try {
    const admin = `arcanum_sess=${session.sign({ username: 'adm', role: 'admin' })}`;
    const operador = `arcanum_sess=${session.sign({ username: 'op', role: 'operador' })}`;
    assert.strictEqual(await pedir(operador), 403, 'control: un operador no edita el catalogo');
    assert.strictEqual(await pedir(admin), 403, 'el rol admin edito el catalogo, documentado como exclusivo del superadmin');
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    base.restaurar();
  }
});
