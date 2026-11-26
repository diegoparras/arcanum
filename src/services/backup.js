'use strict';

// Backups de Arcanum, desde la app (la imagen no trae pg_dump):
//
//   ARCBAK1\n<cabecera JSON>\n<iv 12><tag 16><AES-256-GCM(gzip(JSON de las tablas))>
//
// - Cifrado autenticado: la cabecera (version, fecha, tablas, cantidades, sha256) va como AAD,
//   asi que tocarla tambien invalida el archivo.
// - Clave: HKDF de la master key ("arcanum-backup-v1"), o ARCANUM_BACKUP_KEY (64 hex) si se
//   quiere separar. Sin esa clave el backup no se puede abrir: hay que guardarla fuera del
//   servidor (la UI lo pide hasta que se confirma).
// - Se respaldan todas las tablas salvo logs y caches (requests, service_status, access_tickets).
//   Las claves privadas y la clave fiscal ya estan cifradas dentro de la base: siguen cifradas.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIA = 'ARCBAK1\n';
const TABLAS_EXCLUIDAS = ['requests', 'service_status', 'access_tickets', 'sesiones'];
const PADRES_PRIMERO = ['lotes']; // lote_items referencia a lotes
const NOMBRE = /^arcanum-\d{8}-\d{4}(-\d+)?\.arcbak$/;

function e422(msg) {
  return Object.assign(new Error(msg), { httpStatus: 422 });
}

/**
 * Clave de backup: ARCANUM_BACKUP_KEY (hex) o derivada de la master key, siempre que alguna venga
 * por entorno (B-15). Si la master key se genero en el volumen, quedaria junto a los backups: con
 * esos dos archivos se descifra todo, asi que no se crean.
 */
function clave() {
  if (!process.env.ARCANUM_BACKUP_KEY && !process.env.ARCANUM_MASTER_KEY) {
    throw Object.assign(new Error('No se crean backups sin ARCANUM_MASTER_KEY o ARCANUM_BACKUP_KEY por entorno: la clave quedaria en el mismo volumen que los backups.'), { httpStatus: 409 });
  }
  const env = process.env.ARCANUM_BACKUP_KEY;
  if (env) {
    const b = Buffer.from(env, 'hex');
    if (b.length !== 32) throw new Error('ARCANUM_BACKUP_KEY debe ser 32 bytes en hex (64 caracteres)');
    return b;
  }
  return require('../crypto/vault').derivar('arcanum-backup-v1');
}

function huella(k) {
  return crypto.createHash('sha256').update(Buffer.from(k)).digest('hex').slice(0, 8);
}

function empaquetar(tablas, meta, k) {
  const plano = zlib.gzipSync(Buffer.from(JSON.stringify(tablas)));
  const cabecera = JSON.stringify({
    formato: 1,
    creado: new Date().toISOString(),
    ...meta,
    tablas: Object.fromEntries(Object.entries(tablas).map(([t, filas]) => [t, filas.length])),
    sha256: crypto.createHash('sha256').update(plano).digest('hex'),
  });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(cabecera));
  const cifrado = Buffer.concat([c.update(plano), c.final()]);
  return Buffer.concat([Buffer.from(MAGIA), Buffer.from(cabecera), Buffer.from('\n'), iv, c.getAuthTag(), cifrado]);
}

function desempaquetar(buf, k) {
  const b = Buffer.from(buf);
  if (b.slice(0, MAGIA.length).toString() !== MAGIA) throw e422('No es un backup de Arcanum');
  const fin = b.indexOf(0x0a, MAGIA.length);
  if (fin < 0) throw e422('Backup danado (sin cabecera)');
  const cabeceraTxt = b.slice(MAGIA.length, fin).toString();
  let meta;
  try { meta = JSON.parse(cabeceraTxt); } catch { throw e422('Backup danado (cabecera ilegible)'); }
  const iv = b.slice(fin + 1, fin + 13);
  const tag = b.slice(fin + 13, fin + 29);
  const cifrado = b.slice(fin + 29);
  let plano;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAAD(Buffer.from(cabeceraTxt));
    d.setAuthTag(tag);
    plano = Buffer.concat([d.update(cifrado), d.final()]);
  } catch {
    throw e422('No se pudo descifrar el backup: la clave no coincide o el archivo fue modificado');
  }
  if (crypto.createHash('sha256').update(plano).digest('hex') !== meta.sha256) throw e422('El backup no pasa el control de integridad');
  return { meta, tablas: JSON.parse(zlib.gunzipSync(plano).toString()) };
}

function ruta(dir, nombre) {
  if (!NOMBRE.test(String(nombre || ''))) throw Object.assign(new Error('Nombre de backup invalido'), { httpStatus: 400 });
  return path.join(dir, nombre);
}

function listar(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => NOMBRE.test(n)).sort().reverse()
    .map((n) => ({ nombre: n, bytes: fs.statSync(path.join(dir, n)).size, creado: fs.statSync(path.join(dir, n)).mtime }));
}

/** Deja los `retener` mas nuevos (por nombre, que lleva fecha y hora). Devuelve los borrados. */
function podar(dir, retener) {
  const todos = fs.readdirSync(dir).filter((n) => NOMBRE.test(n)).sort();
  const borrar = todos.slice(0, Math.max(0, todos.length - Math.max(1, retener)));
  for (const n of borrar) fs.unlinkSync(path.join(dir, n));
  return borrar;
}

function ordenRestauracion(nombres) {
  const padres = PADRES_PRIMERO.filter((t) => nombres.includes(t));
  return [...padres, ...nombres.filter((t) => !padres.includes(t))];
}

/** Simulacro (por defecto) o reemplazo real de los datos, en una transaccion. */
async function restaurar(buf, { confirmar = false, clave: k = clave(), repo = repoSql() } = {}) {
  const { meta, tablas } = desempaquetar(buf, k);
  if (!confirmar) return { simulacro: true, creado: meta.creado, version: meta.version || null, tablas: meta.tablas };
  await repo.reemplazar(tablas);
  return { simulacro: false, creado: meta.creado, version: meta.version || null, tablas: meta.tablas };
}

function nombreNuevo(dir, fecha = new Date()) {
  const ar = new Date(fecha.getTime() - 3 * 3600000).toISOString();
  const base = `arcanum-${ar.slice(0, 10).replace(/-/g, '')}-${ar.slice(11, 16).replace(':', '')}`;
  let n = `${base}.arcbak`;
  for (let i = 2; fs.existsSync(path.join(dir, n)); i += 1) n = `${base}-${i}.arcbak`;
  return n;
}

/** Crea un backup en `dir` y poda. */
async function crear({ dir = directorio(), repo = repoSql(), retener = Number(process.env.ARCANUM_BACKUP_RETENER) || 14 } = {}) {
  const k = clave(); // antes de tocar nada: sin clave por entorno no hay backup (B-15)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tablas = await repo.volcar();
  const { config } = require('../config');
  const buf = empaquetar(tablas, { version: config.version, entorno: config.env }, k);
  const nombre = nombreNuevo(dir);
  fs.writeFileSync(path.join(dir, nombre), buf, { mode: 0o600 });
  const podados = podar(dir, retener);
  return { nombre, bytes: buf.length, tablas: Object.fromEntries(Object.entries(tablas).map(([t, f]) => [t, f.length])), podados };
}

function directorio() {
  const { config } = require('../config');
  return path.join(config.dataDir, 'backups');
}

function repoSql(db = require('../db')) {
  return {
    // Una sola foto: todas las tablas en la misma transaccion REPEATABLE READ (si no, un lote
    // creado a mitad del volcado deja items sin su lote y la restauracion rompe la FK).
    async volcar() {
      return db.tx(async (c) => {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { rows } = await c.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
        const out = {};
        for (const { table_name: t } of rows) {
          if (TABLAS_EXCLUIDAS.includes(t)) continue;
          out[t] = (await c.query(`SELECT * FROM "${t}"`)).rows;
        }
        return out;
      });
    },
    async reemplazar(tablas) {
      await db.tx(async (c) => {
        const { rows: existentes } = await c.query(
          "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'");
        const columnas = {};
        for (const r of existentes) (columnas[r.table_name] = columnas[r.table_name] || {})[r.column_name] = r.data_type;
        const nombres = ordenRestauracion(Object.keys(tablas).filter((t) => columnas[t] && !TABLAS_EXCLUIDAS.includes(t)));
        if (!nombres.length) return;
        await c.query(`TRUNCATE ${nombres.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
        for (const t of nombres) {
          for (const fila of tablas[t]) {
            const cols = Object.keys(fila).filter((k) => columnas[t][k]);
            if (!cols.length) continue;
            const vals = cols.map((k) => (columnas[t][k] === 'jsonb' || columnas[t][k] === 'json') && fila[k] != null ? JSON.stringify(fila[k]) : fila[k]);
            await c.query(`INSERT INTO "${t}" (${cols.map((k) => `"${k}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
          }
          // Secuencia solo si la tabla la tiene (services.id es TEXT): un setval que falla aborta
          // la transaccion entera aunque se atrape el error en JS.
          if (columnas[t].id) {
            const { rows: sq } = await c.query("SELECT pg_get_serial_sequence($1, 'id') AS seq", [`"${t}"`]);
            if (sq[0] && sq[0].seq) {
              await c.query(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${t}"), 0), 1), (SELECT COUNT(*) > 0 FROM "${t}"))`);
            }
          }
        }
      });
    },
  };
}

module.exports = {
  MAGIA, TABLAS_EXCLUIDAS, clave, huella, empaquetar, desempaquetar, ruta, listar, podar, ordenRestauracion,
  restaurar, crear, directorio, repoSql,
};
