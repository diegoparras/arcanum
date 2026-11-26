'use strict';

// Lotes JSON-RPC en /mcp (auditoria 2026-11-26, M-01): tope de tamano, y cada herramienta pasa
// por el limite y la auditoria por separado, con su propio CUIT.

const { test } = require('node:test');
const assert = require('node:assert');

const { crearServidor } = require('../src/mcp/servidor');

const HERR = [{
  nombre: 'padron', descripcion: 'x', esquema: { type: 'object', properties: {} },
  ejecutar: async (args, ctx) => { ctx.cuit = '20111111112'; ctx.cuitConsultado = args.cuit; return { ok: true, cuit: args.cuit }; },
}];
const llamada = (id, cuit) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'padron', arguments: { cuit } } });

test('un lote de mas de 10 mensajes se rechaza entero', async () => {
  const s = crearServidor({ nombre: 'a', version: '1', herramientas: HERR });
  const r = await s.atender(JSON.stringify(Array.from({ length: 11 }, (_, i) => llamada(i + 1, '2033333333' + (i % 10)))), {});
  assert.strictEqual(r.error.code, -32600);
  assert.match(r.error.message, /10/);
});

test('cada herramienta del lote pasa por antes/despues con su propio CUIT', async () => {
  const antes = []; const despues = [];
  const ctx = {
    antesDeHerramienta: (nombre) => antes.push(nombre),
    despuesDeHerramienta: (d) => despues.push(d),
  };
  const s = crearServidor({ nombre: 'a', version: '1', herramientas: HERR });
  const r = await s.atender(JSON.stringify([llamada(1, '20300000001'), llamada(2, '20300000002'), llamada(3, '20300000003')]), ctx);
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(antes, ['padron', 'padron', 'padron']);
  assert.deepStrictEqual(despues.map((d) => d.cuitConsultado), ['20300000001', '20300000002', '20300000003']);
  assert.ok(despues.every((d) => d.herramienta === 'padron' && d.ok === true && d.cuit === '20111111112'));
});

test('si el limite corta a mitad del lote, las que siguen devuelven error y no se ejecutan', async () => {
  let ejecutadas = 0; let n = 0;
  const herr = [{ ...HERR[0], ejecutar: async () => { ejecutadas += 1; return {}; } }];
  const ctx = { antesDeHerramienta: () => { n += 1; if (n > 2) throw Object.assign(new Error('Limite de pedidos de esta clave alcanzado'), { httpStatus: 429 }); } };
  const s = crearServidor({ nombre: 'a', version: '1', herramientas: herr });
  const r = await s.atender(JSON.stringify([llamada(1, 'a'), llamada(2, 'b'), llamada(3, 'c'), llamada(4, 'd')]), ctx);
  assert.strictEqual(ejecutadas, 2);
  assert.ok(r[2].error && /Limite/.test(r[2].error.message));
  assert.ok(r[3].error);
});
