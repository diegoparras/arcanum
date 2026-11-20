'use strict';

// Backups: cifrado autenticado (cabecera incluida), ida y vuelta, clave equivocada o archivo
// tocado = 422, retencion, nombres seguros, huella de la master key y restauracion con simulacro.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const backup = require('../src/services/backup');

const K1 = crypto.randomBytes(32);
const K2 = crypto.randomBytes(32);
const TABLAS = {
  tenants: [{ cuit: '20263630743', key_enc: 'v1:abc', nombre: 'Prueba' }],
  comprobantes: [{ id: 1, cuit: '20263630743', numero: 5, raw: { cae: '1', items: [1, 2] }, fecha: '2026-11-20' }],
};

test('ida y vuelta conserva tablas y filas', () => {
  const buf = backup.empaquetar(TABLAS, { version: '0.10.0' }, K1);
  assert.strictEqual(buf.slice(0, 8).toString(), 'ARCBAK1\n');
  const { meta, tablas } = backup.desempaquetar(buf, K1);
  assert.deepStrictEqual(tablas, TABLAS);
  assert.deepStrictEqual(meta.tablas, { tenants: 1, comprobantes: 1 });
  assert.strictEqual(meta.version, '0.10.0');
  assert.ok(!buf.toString('latin1').includes('v1:abc'), 'el contenido va cifrado');
});

test('otra clave da 422', () => {
  const buf = backup.empaquetar(TABLAS, {}, K1);
  assert.throws(() => backup.desempaquetar(buf, K2), (e) => e.httpStatus === 422 && /descifrar/.test(e.message));
});

test('un byte cambiado da 422 (en el contenido o en la cabecera)', () => {
  const buf = backup.empaquetar(TABLAS, {}, K1);
  const a = Buffer.from(buf); a[a.length - 3] ^= 1;
  assert.throws(() => backup.desempaquetar(a, K1), (e) => e.httpStatus === 422);
  const b = Buffer.from(buf.toString('latin1').replace('"tenants":1', '"tenants":9'), 'latin1');
  assert.throws(() => backup.desempaquetar(b, K1), (e) => e.httpStatus === 422);
  assert.throws(() => backup.desempaquetar(Buffer.from('cualquier cosa'), K1), (e) => e.httpStatus === 422);
});

test('podar deja los N mas nuevos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcbak-'));
  const nombres = ['arcanum-20261101-0300.arcbak', 'arcanum-20261102-0300.arcbak', 'arcanum-20261103-0300.arcbak', 'otro.txt'];
  for (const n of nombres) fs.writeFileSync(path.join(dir, n), 'x');
  const borrados = backup.podar(dir, 2);
  assert.deepStrictEqual(borrados, ['arcanum-20261101-0300.arcbak']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['arcanum-20261102-0300.arcbak', 'arcanum-20261103-0300.arcbak', 'otro.txt']);
});

test('ruta rechaza nombres raros y ../', () => {
  assert.throws(() => backup.ruta('/data/backups', '../.masterkey'), (e) => e.httpStatus === 400);
  assert.throws(() => backup.ruta('/data/backups', 'arcanum-x.arcbak'), (e) => e.httpStatus === 400);
  assert.strictEqual(backup.ruta('/data/backups', 'arcanum-20261120-0300.arcbak'), path.join('/data/backups', 'arcanum-20261120-0300.arcbak'));
});

test('huella estable y corta', () => {
  assert.strictEqual(backup.huella(K1), backup.huella(Buffer.from(K1)));
  assert.match(backup.huella(K1), /^[0-9a-f]{8}$/);
  assert.notStrictEqual(backup.huella(K1), backup.huella(K2));
});

test('restaurar sin confirmar no escribe; con confirmar reemplaza', async () => {
  const buf = backup.empaquetar(TABLAS, {}, K1);
  const repo = { reemplazos: [], reemplazar: async (t) => { repo.reemplazos.push(Object.keys(t)); } };
  const sim = await backup.restaurar(buf, { confirmar: false, clave: K1, repo });
  assert.strictEqual(sim.simulacro, true);
  assert.deepStrictEqual(sim.tablas, { tenants: 1, comprobantes: 1 });
  assert.strictEqual(repo.reemplazos.length, 0);
  const ok = await backup.restaurar(buf, { confirmar: true, clave: K1, repo });
  assert.strictEqual(ok.simulacro, false);
  assert.strictEqual(repo.reemplazos.length, 1);
});

test('lotes se restaura antes que lote_items', () => {
  const o = backup.ordenRestauracion(['lote_items', 'comprobantes', 'lotes']);
  assert.ok(o.indexOf('lotes') < o.indexOf('lote_items'));
  assert.deepStrictEqual([...o].sort(), ['comprobantes', 'lote_items', 'lotes']);
});

function clienteFalso(serial) {
  const c = { q: [] };
  c.query = async (sql, vals) => {
    c.q.push(sql);
    if (/information_schema\.columns/.test(sql)) return { rows: [{ table_name: 'services', column_name: 'id', data_type: 'text' }, { table_name: 'lotes', column_name: 'id', data_type: 'bigint' }] };
    if (/pg_get_serial_sequence/.test(sql) && /AS seq/.test(sql)) return { rows: [{ seq: serial[String(vals[0]).replace(/"/g, '')] || null }] };
    if (/setval/.test(sql) && !serial[(sql.match(/'"(\w+)"'/) || [])[1]]) throw new Error('COALESCE types text and integer cannot be matched');
    return { rows: [] };
  };
  return c;
}

test('restaurar no hace setval en tablas sin secuencia (id de texto)', async () => {
  const c = clienteFalso({ lotes: 'public.lotes_id_seq' });
  const repo = backup.repoSql({ tx: async (fn) => fn(c), query: c.query });
  await repo.reemplazar({ services: [{ id: 'wsfev1' }], lotes: [{ id: 3 }] });
  const setvals = c.q.filter((s) => /setval/.test(s));
  assert.strictEqual(setvals.length, 1);
  assert.match(setvals[0], /lotes/);
});

test('el volcado es una foto consistente (una transaccion de solo lectura)', async () => {
  const c = { q: [], query: async (sql) => { c.q.push(sql); return /information_schema\.tables/.test(sql) ? { rows: [{ table_name: 'lotes' }] } : { rows: [] }; } };
  let enTx = false;
  const repo = backup.repoSql({ tx: async (fn) => { enTx = true; return fn(c); }, query: async () => { throw new Error('fuera de la transaccion'); } });
  await repo.volcar();
  assert.ok(enTx);
  assert.match(c.q[0], /REPEATABLE READ/i);
  assert.match(c.q[0], /READ ONLY/i);
});
