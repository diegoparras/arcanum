'use strict';

// B-15 (auditoria 2026-11-26): sin clave por entorno, la clave de los backups quedaba en el mismo
// volumen que los backups. Ahora no se crean backups sin ARCANUM_MASTER_KEY o ARCANUM_BACKUP_KEY,
// y en produccion Arcanum no genera una master key nueva en el volumen.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV = ['ARCANUM_MASTER_KEY', 'ARCANUM_BACKUP_KEY', 'ARCANUM_ENV', 'ARCANUM_DATA_DIR'];
const previo = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; }
  for (const m of ['../src/config', '../src/crypto/vault', '../src/services/backup']) delete require.cache[require.resolve(m)];
});
function cargar(env) {
  for (const k of ENV) delete process.env[k];
  process.env.ARCANUM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-claves-'));
  Object.assign(process.env, env);
  for (const m of ['../src/config', '../src/crypto/vault', '../src/services/backup']) delete require.cache[require.resolve(m)];
  return { vault: require('../src/crypto/vault'), backup: require('../src/services/backup'), dir: process.env.ARCANUM_DATA_DIR };
}
const repo = { volcar: async () => ({ tenants: [] }) };

test('sin clave por entorno, no se crea el backup y el mensaje dice por que', async () => {
  const { backup, dir } = cargar({});
  await assert.rejects(backup.crear({ dir: path.join(dir, 'backups'), repo }), (e) => e.httpStatus === 409 && /ARCANUM_MASTER_KEY|ARCANUM_BACKUP_KEY/.test(e.message));
  assert.ok(!fs.existsSync(path.join(dir, 'backups')) || fs.readdirSync(path.join(dir, 'backups')).length === 0);
});

test('con ARCANUM_MASTER_KEY por entorno, el backup se crea', async () => {
  const { backup, dir } = cargar({ ARCANUM_MASTER_KEY: 'a'.repeat(64) });
  const r = await backup.crear({ dir: path.join(dir, 'backups'), repo });
  assert.match(r.nombre, /\.arcbak$/);
});

test('en produccion no se genera una master key nueva en el volumen', () => {
  const { vault, dir } = cargar({ ARCANUM_ENV: 'prod' });
  assert.throws(() => vault.encrypt('x'), /ARCANUM_MASTER_KEY/);
  assert.ok(!fs.existsSync(path.join(dir, '.masterkey')));
});

test('en produccion, una master key ya generada en el volumen se sigue usando (instalaciones previas)', () => {
  const { vault, dir } = cargar({ ARCANUM_ENV: 'prod' });
  fs.writeFileSync(path.join(dir, '.masterkey'), 'b'.repeat(64));
  assert.match(vault.encrypt('x'), /^v1:/);
});
