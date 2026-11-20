'use strict';

// Las credenciales que Arcanum genera solo (clave de API y contrasena del primer superadmin)
// nunca van al log: los registros los ve cualquiera con acceso al panel. Quedan en el volumen
// de datos con permisos 0600 y el log dice donde leerlas.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sec = require('../src/auth/secretosIniciales');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arcanum-sec-'));
const capturar = () => { const l = []; return { log: (...a) => l.push(a.join(' ')), lineas: l }; };

test('guardar y leer un secreto: archivo 0600 en el directorio de datos', () => {
  const dir = path.join(tmp(), 'sub');
  const ruta = sec.guardarSecreto(dir, 'prueba', 'valor-secreto');
  assert.strictEqual(ruta, path.join(dir, 'prueba'));
  assert.strictEqual(sec.leerSecreto(dir, 'prueba'), 'valor-secreto');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(ruta).mode & 0o777, 0o600);
  assert.strictEqual(sec.leerSecreto(dir, 'no-existe'), null);
});

test('clave de API definida por entorno: se usa tal cual y no se escribe nada', () => {
  const dir = tmp();
  const { log, lineas } = capturar();
  const r = sec.resolverApiKey({ apiKey: 'de-entorno', dataDir: dir, log });
  assert.strictEqual(r.clave, 'de-entorno');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(lineas, []);
});

test('clave de API generada: se guarda, el log dice donde y NUNCA la muestra; se reutiliza al reiniciar', () => {
  const dir = tmp();
  const a = capturar();
  const r1 = sec.resolverApiKey({ apiKey: '', dataDir: dir, log: a.log });
  assert.match(r1.clave, /^[0-9a-f]{48}$/);
  assert.ok(a.lineas.some((l) => l.includes(path.join(dir, sec.ARCHIVO_API_KEY))), 'el log dice donde esta');
  assert.ok(a.lineas.every((l) => !l.includes(r1.clave)), 'la clave no aparece en el log');
  const b = capturar();
  const r2 = sec.resolverApiKey({ apiKey: '', dataDir: dir, log: b.log });
  assert.strictEqual(r2.clave, r1.clave, 'la misma clave despues de reiniciar');
  assert.ok(b.lineas.every((l) => !l.includes(r1.clave)));
});

test('clave de API sin poder guardarla: funciona igual, avisa como fijarla y no la muestra', () => {
  const dir = path.join(tmp(), 'archivo');
  fs.writeFileSync(dir, 'no soy un directorio');
  const { log, lineas } = capturar();
  const r = sec.resolverApiKey({ apiKey: '', dataDir: dir, log });
  assert.ok(r.clave);
  assert.ok(lineas.some((l) => l.includes('ARCANUM_API_KEY')));
  assert.ok(lineas.every((l) => !l.includes(r.clave)));
});

test('primer superadmin con contrasena generada: queda en archivo, no en el retorno ni en el log', async () => {
  const db = require('../src/db');
  const original = db.query;
  const insertados = [];
  db.query = async (sql, params) => {
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
    insertados.push(params);
    return { rows: [] };
  };
  const antes = process.env.ARCANUM_ADMIN_PASS;
  delete process.env.ARCANUM_ADMIN_PASS;
  try {
    const users = require('../src/auth/users');
    const dir = tmp();
    const r = await users.seedAdmin({ guardarClave: (p) => sec.guardarSecreto(dir, sec.ARCHIVO_CLAVE_ADMIN, p) });
    assert.strictEqual(r.generated, true);
    assert.strictEqual(r.pass, undefined, 'la contrasena no viaja en el retorno (no hay forma de loguearla por error)');
    assert.strictEqual(r.ruta, path.join(dir, sec.ARCHIVO_CLAVE_ADMIN));
    const guardada = sec.leerSecreto(dir, sec.ARCHIVO_CLAVE_ADMIN);
    assert.ok(guardada && guardada.length >= 12);
    assert.strictEqual(insertados.length, 1);
    assert.ok(users.verifyPassword(guardada, insertados[0][1]), 'el hash guardado es de la contrasena del archivo');

    // Si no se puede guardar, no se crea el usuario (si no, nadie podria entrar nunca).
    insertados.length = 0;
    const fallo = await users.seedAdmin({ guardarClave: () => { throw new Error('disco de solo lectura'); } });
    assert.strictEqual(fallo.creado, false);
    assert.match(fallo.error, /solo lectura/);
    assert.strictEqual(insertados.length, 0);
  } finally {
    db.query = original;
    if (antes !== undefined) process.env.ARCANUM_ADMIN_PASS = antes;
  }
});
