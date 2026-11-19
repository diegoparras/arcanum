'use strict';

// Tests del servidor MCP de solo consulta, las claves de API y la regla de solo lectura.
// Sin red ni base de datos.

const { test } = require('node:test');
const assert = require('node:assert');

const { crearServidor, MAX_TEXTO } = require('../src/mcp/servidor');
const { HERRAMIENTAS, _internos: h } = require('../src/mcp/herramientas');
const apikeys = require('../src/auth/apikeys');
const permisos = require('../src/auth/permisos');

const ctx = { principal: { username: 'clave:test', role: 'lectura' } };
const rpc = (method, params, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

function servidorCon(herramientas, extra = {}) {
  return crearServidor({ nombre: 'arcanum', version: '9.9.9', herramientas, ...extra });
}
const eco = { nombre: 'eco', titulo: 'Eco', descripcion: 'Devuelve lo recibido.', esquema: { type: 'object' }, ejecutar: (a) => ({ recibido: a }) };

// ---------- protocolo ----------
test('mcp: initialize negocia la version pedida y anuncia herramientas', async () => {
  const r = await servidorCon([eco]).atender(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }), ctx);
  assert.strictEqual(r.result.protocolVersion, '2025-03-26');
  assert.strictEqual(r.result.serverInfo.name, 'arcanum');
  assert.strictEqual(r.result.serverInfo.version, '9.9.9');
  assert.ok(r.result.capabilities.tools);
});
test('mcp: version desconocida -> responde con la ultima soportada', async () => {
  const r = await servidorCon([eco]).atender(rpc('initialize', { protocolVersion: '1999-01-01' }), ctx);
  assert.match(r.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.notStrictEqual(r.result.protocolVersion, '1999-01-01');
});
test('mcp: notificaciones no llevan respuesta (HTTP 202)', async () => {
  const r = await servidorCon([eco]).atender(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), ctx);
  assert.strictEqual(r, null);
});
test('mcp: ping, metodo desconocido, JSON invalido y pedido invalido', async () => {
  const s = servidorCon([eco]);
  assert.deepStrictEqual((await s.atender(rpc('ping'), ctx)).result, {});
  assert.strictEqual((await s.atender(rpc('resources/list'), ctx)).error.code, -32601);
  assert.strictEqual((await s.atender('{no es json', ctx)).error.code, -32700);
  assert.strictEqual((await s.atender(JSON.stringify({ foo: 1 }), ctx)).error.code, -32600);
});
test('mcp: lotes de mensajes', async () => {
  const s = servidorCon([eco]);
  const r = await s.atender(JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]), ctx);
  assert.strictEqual(r.length, 2);
});
test('mcp: tools/call devuelve el resultado como texto JSON', async () => {
  const r = await servidorCon([eco]).atender(rpc('tools/call', { name: 'eco', arguments: { a: 1 } }), ctx);
  assert.strictEqual(r.result.isError, undefined);
  assert.deepStrictEqual(JSON.parse(r.result.content[0].text), { recibido: { a: 1 } });
});
test('mcp: herramienta desconocida -> error -32602', async () => {
  const r = await servidorCon([eco]).atender(rpc('tools/call', { name: 'emitir', arguments: {} }), ctx);
  assert.strictEqual(r.error.code, -32602);
});
test('mcp: si la herramienta falla, isError con el motivo', async () => {
  const falla = { ...eco, nombre: 'falla', ejecutar: () => { throw new Error('ARCA rechazo la solicitud'); } };
  const r = await servidorCon([falla]).atender(rpc('tools/call', { name: 'falla' }), ctx);
  assert.strictEqual(r.result.isError, true);
  assert.match(JSON.parse(r.result.content[0].text).error, /ARCA rechazo/);
});
test('mcp: corte de tiempo -> error claro, no se cuelga', async () => {
  const lenta = { ...eco, nombre: 'lenta', ejecutar: () => new Promise((ok) => setTimeout(() => ok({}), 2000)) };
  const t0 = Date.now();
  const r = await servidorCon([lenta], { timeoutMs: 60 }).atender(rpc('tools/call', { name: 'lenta' }), ctx);
  assert.ok(Date.now() - t0 < 1500);
  assert.strictEqual(r.result.isError, true);
  assert.match(r.result.content[0].text, /no respondio a tiempo/);
});
test('mcp: respuestas largas se recortan bajo 20.000 caracteres', async () => {
  const grande = { ...eco, nombre: 'grande', ejecutar: () => ({ x: 'a'.repeat(50000) }) };
  const r = await servidorCon([grande]).atender(rpc('tools/call', { name: 'grande' }), ctx);
  const t = r.result.content[0].text;
  assert.ok(t.length < 20000);
  assert.ok(t.length > MAX_TEXTO - 10);
  assert.match(t, /recortada/);
});

// ---------- catalogo real de herramientas ----------
test('mcp: exactamente las 10 herramientas de consulta', () => {
  assert.deepStrictEqual(HERRAMIENTAS.map((x) => x.nombre).sort(), [
    'comprobante', 'comprobantes_recientes', 'comunicaciones_ventanilla', 'estado_arca', 'padron',
    'puntos_de_venta', 'riesgo_fiscal', 'ultimo_comprobante', 'vencimiento_certificado', 'vista_previa_comprobante',
  ]);
});
test('mcp: ninguna herramienta emite ni expone el motor generico', async () => {
  const lista = (await servidorCon(HERRAMIENTAS).atender(rpc('tools/list'), ctx)).result.tools;
  for (const t of lista) {
    assert.doesNotMatch(t.name, /emit|autoriz|crear|solicit|lote|ws_|importar|borrar/i, t.name);
    assert.strictEqual(t.annotations.readOnlyHint, true);
    assert.strictEqual(t.annotations.destructiveHint, false);
    assert.strictEqual(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 60, `descripcion de ${t.name}`);
    assert.match(t.description, /solo lectura/i);
    assert.ok(`arcanum_${t.name}`.length <= 64);
  }
});

// ---------- parsers de las herramientas ----------
test('herramientas: parseComprobante entiende "0003-00000124" y prefijos', () => {
  assert.deepStrictEqual(h.parseComprobante('0003-00000124'), { puntoVenta: 3, numero: 124, tipo: null });
  assert.deepStrictEqual(h.parseComprobante('3-124'), { puntoVenta: 3, numero: 124, tipo: null });
  assert.strictEqual(h.parseComprobante('FC 0003-00000124').tipo, 11);
  assert.throws(() => h.parseComprobante('factura 124'), /0003-00000124/);
});
test('herramientas: parseTipo acepta codigo o letra', () => {
  assert.strictEqual(h.parseTipo(6), 6);
  assert.strictEqual(h.parseTipo('11'), 11);
  assert.strictEqual(h.parseTipo('C'), 11);
  assert.strictEqual(h.parseTipo('NCB'), 8);
  assert.strictEqual(h.parseTipo(undefined), null);
  assert.throws(() => h.parseTipo('XYZ'), /no reconocido/);
});
test('herramientas: formatos de numero y fecha', () => {
  assert.strictEqual(h.formatearNumero(3, 124), '0003-00000124');
  assert.strictEqual(h.fechaIso('20261110'), '2026-11-10');
  assert.strictEqual(h.fechaIso('2026-11-10T00:00:00Z'), '2026-11-10');
  assert.throws(() => h.cuit11('123'), /11 digitos/);
  assert.strictEqual(h.cuit11('20-26363074-3'), '20263630743');
});
test('herramientas: resumen del padron A5 (monotributista)', () => {
  const r = h.resumirPadron('20263630743', {
    datosGenerales: {
      apellido: 'PARRAS', nombre: 'DIEGO', tipoPersona: 'FISICA', estadoClave: 'ACTIVO',
      domicilioFiscal: { direccion: 'CHARLONE 501', codPostal: '1427', descripcionProvincia: 'CABA' },
    },
    datosMonotributo: {
      categoriaMonotributo: { idCategoria: '42', descripcionCategoria: 'H LOCACIONES DE SERVICIOS' },
      actividad: { idActividad: '960990', descripcionActividad: 'SERVICIOS PERSONALES', orden: '1' },
    },
    datosRegimenGeneral: {
      actividad: { idActividad: '960990', descripcionActividad: 'SERVICIOS PERSONALES', orden: '1' },
      impuesto: { idImpuesto: '11', descripcionImpuesto: 'GANANCIAS', estadoImpuesto: 'AC' },
    },
  });
  assert.strictEqual(r.nombre, 'PARRAS, DIEGO');
  assert.strictEqual(r.tipoContribuyente, 'MONOTRIBUTISTA');
  assert.match(r.condicionIVA, /Monotributo/);
  assert.strictEqual(r.condicionIvaReceptorId, 6);
  assert.strictEqual(r.actividades.length, 1); // deduplicada
  assert.strictEqual(r.domicilioFiscal.provincia, 'CABA');
  assert.strictEqual(r.impuestos[0].estado, 'AC');
});

// ---------- claves de API ----------
test('apikeys: la clave llega por Bearer o por X-API-Key', () => {
  assert.strictEqual(apikeys.extraerClave({ authorization: 'Bearer ark_abc' }), 'ark_abc');
  assert.strictEqual(apikeys.extraerClave({ authorization: 'bearer   ark_abc  ' }), 'ark_abc');
  assert.strictEqual(apikeys.extraerClave({ 'x-api-key': 'k1', authorization: 'Bearer k2' }), 'k1');
  assert.strictEqual(apikeys.extraerClave({ authorization: 'Basic dXNlcjpwYXNz' }), '');
  assert.strictEqual(apikeys.extraerClave({}), '');
});
test('apikeys: se guarda un hash SHA-256 (nunca la clave)', () => {
  const x = apikeys.hash('ark_secreto');
  assert.match(x, /^[0-9a-f]{64}$/);
  assert.strictEqual(x, apikeys.hash('ark_secreto'));
  assert.ok(!x.includes('secreto'));
  assert.ok(!apikeys.ROLES.includes('superadmin'));
});

// ---------- regla de solo lectura ----------
test('permisos: rol lectura solo puede GET/HEAD (falla cerrado)', () => {
  const lectura = { role: 'lectura' };
  assert.doesNotThrow(() => permisos.assertPuedeEscribir(lectura, 'GET'));
  assert.doesNotThrow(() => permisos.assertPuedeEscribir(lectura, 'HEAD'));
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.throws(() => permisos.assertPuedeEscribir(lectura, m), (e) => e.httpStatus === 403);
  }
  assert.doesNotThrow(() => permisos.assertPuedeEscribir({ role: 'operador' }, 'POST'));
});
test('permisos: clave acotada a un CUIT no opera otros', () => {
  const p = { role: 'lectura', cuitAllow: ['20263630743'] };
  assert.doesNotThrow(() => permisos.assertCuitAllowed(p, '20-26363074-3'));
  assert.throws(() => permisos.assertCuitAllowed(p, '30500010912'), (e) => e.httpStatus === 403);
  assert.doesNotThrow(() => permisos.assertCuitAllowed({ role: 'admin', cuitAllow: ['1'] }, '30500010912'));
});
