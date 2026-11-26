'use strict';

// Login a WSAA sin retener una conexion de la base (auditoria 2026-11-26, M-03). Antes el POST a
// WSAA corria dentro de una transaccion: con ARCA lento, 10 pedidos agotaban el pool y nadie mas
// podia usar la base.

const { test } = require('node:test');
const assert = require('node:assert');

const db = require('../src/db');
const tokenStore = require('../src/auth/tokenStore');

function baseSimulada() {
  const tickets = new Map();
  const original = { query: db.query, tx: db.tx, withLock: db.withLock };
  let enTx = 0;
  db.tx = async () => { enTx += 1; throw new Error('no deberia abrir una transaccion durante el login a WSAA'); };
  db.withLock = db.tx;
  db.query = async (sql, p = []) => {
    if (/^SELECT token, sign/i.test(sql.trim())) {
      const t = tickets.get(p.join('|'));
      return { rows: t ? [t] : [] };
    }
    if (/^INSERT INTO access_tickets/i.test(sql.trim())) {
      tickets.set([p[0], p[1], p[2]].join('|'), { token: p[3], sign: p[4], generation_time: p[5], expiration_time: p[6] });
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { restaurar: () => Object.assign(db, original), enTx: () => enTx };
}

test('pedidos concurrentes del mismo ticket hacen un solo login y no abren transacciones', async () => {
  const b = baseSimulada();
  let logins = 0;
  const fetcher = async () => {
    logins += 1;
    await new Promise((r) => setTimeout(r, 60)); // WSAA lento
    return { token: 'T', sign: 'S', generationTime: new Date().toISOString(), expirationTime: new Date(Date.now() + 12 * 3600e3).toISOString() };
  };
  try {
    const r = await Promise.all(Array.from({ length: 8 }, () => tokenStore.getOrCreate('20111111112', 'wsfe', 'homo', fetcher)));
    assert.strictEqual(logins, 1);
    assert.ok(r.every((t) => t.token === 'T'));
    assert.strictEqual(b.enTx(), 0);
    // Ya guardado: el siguiente sale de la base sin login.
    await tokenStore.getOrCreate('20111111112', 'wsfe', 'homo', fetcher);
    assert.strictEqual(logins, 1);
  } finally { b.restaurar(); }
});

test('si el login falla, el siguiente pedido lo vuelve a intentar', async () => {
  const b = baseSimulada();
  let n = 0;
  const fetcher = async () => { n += 1; if (n === 1) throw new Error('WSAA caido'); return { token: 'T2', sign: 'S', expirationTime: new Date(Date.now() + 3600e3 * 12).toISOString() }; };
  try {
    await assert.rejects(tokenStore.getOrCreate('20111111112', 'wscdc', 'homo', fetcher), /WSAA caido/);
    assert.strictEqual((await tokenStore.getOrCreate('20111111112', 'wscdc', 'homo', fetcher)).token, 'T2');
  } finally { b.restaurar(); }
});

test('B-14: token y sign se guardan cifrados y se leen descifrados; los viejos en claro siguen sirviendo', async () => {
  const crypto = require('crypto');
  process.env.ARCANUM_MASTER_KEY = process.env.ARCANUM_MASTER_KEY || crypto.randomBytes(32).toString('hex');
  const filas = new Map();
  const original = { query: db.query, tx: db.tx };
  db.query = async (sql, p = []) => {
    if (/^\s*INSERT INTO access_tickets/i.test(sql)) { filas.set(p.slice(0, 3).join('|'), { token: p[3], sign: p[4], generation_time: p[5], expiration_time: p[6] }); return { rows: [] }; }
    if (/^\s*SELECT token, sign/i.test(sql)) { const f = filas.get(p.join('|')); return { rows: f ? [f] : [] }; }
    return { rows: [] };
  };
  try {
    const exp = new Date(Date.now() + 12 * 3600e3).toISOString();
    await tokenStore.getOrCreate('20111111112', 'wsfe', 'prod', async () => ({ token: 'TOKEN-REAL', sign: 'SIGN-REAL', expirationTime: exp }));
    const guardada = filas.get('20111111112|wsfe|prod');
    assert.ok(!guardada.token.includes('TOKEN-REAL') && /^v1:/.test(guardada.token), 'el token quedo en claro en la base');
    assert.ok(!guardada.sign.includes('SIGN-REAL') && /^v1:/.test(guardada.sign));
    const leido = await tokenStore.read('20111111112', 'wsfe', 'prod');
    assert.strictEqual(leido.token, 'TOKEN-REAL');
    assert.strictEqual(leido.sign, 'SIGN-REAL');
    filas.set('20111111112|wscdc|prod', { token: 'VIEJO-EN-CLARO', sign: 'S', expiration_time: exp });
    assert.strictEqual((await tokenStore.readRaw('20111111112', 'wscdc', 'prod')).token, 'VIEJO-EN-CLARO');
  } finally { db.query = original.query; db.tx = original.tx; }
});
