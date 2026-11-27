'use strict';

// Cifrado en reposo de datos sensibles (claves privadas de los certificados).
// AES-256-GCM con master key de 32 bytes. La master key vive en el entorno
// (ARCANUM_MASTER_KEY), nunca en la base: si te roban un dump de Postgres, las
// claves privadas siguen cifradas e inutilizables.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function resolveKey() {
  const hex = config.masterKey;
  if (hex) {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      throw new Error('ARCANUM_MASTER_KEY debe ser 32 bytes en hex (64 caracteres). Generar: openssl rand -hex 32');
    }
    return buf;
  }
  // Sin master key explicita: en desarrollo generamos y persistimos una en disco
  // para no perder los datos entre reinicios. En produccion DEBE definirse por env.
  const keyFile = path.join(config.dataDir, '.masterkey');
  try {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } catch {
    // En produccion no se genera una nueva (B-15): quedaria en el mismo volumen que los backups y
    // los datos cifrados. Una ya generada por una instalacion previa se sigue leyendo (arriba).
    if (process.env.ARCANUM_ENV === 'prod' || config.isProd) {
      throw new Error('En producción ARCANUM_MASTER_KEY es obligatoria (64 hex: openssl rand -hex 32). Guardala fuera del servidor.');
    }
    const buf = crypto.randomBytes(32);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(keyFile, buf.toString('hex'), { mode: 0o600 });
    console.warn('[arcanum] ATENCIÓN: ARCANUM_MASTER_KEY no definida. Se generó una en', keyFile);
    console.warn('[arcanum] En producción fijala por entorno y respaldá esa clave: sin ella no se pueden descifrar los certificados.');
    return buf;
  }
}

let KEY = null;
function key() {
  if (!KEY) KEY = resolveKey();
  return KEY;
}

/**
 * Cifra texto y devuelve un string compacto "v1:iv:tag:cipher" en base64.
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/**
 * Descifra un string producido por encrypt(). Lanza si fue manipulado.
 */
function decrypt(payload) {
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Formato de cifrado inválido');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Clave derivada de la master key (HKDF-SHA256) para otro uso, p. ej. backups. Nunca expone la
 * master key en si.
 */
function derivar(info) {
  return Buffer.from(crypto.hkdfSync('sha256', key(), Buffer.from('arcanum'), Buffer.from(String(info)), 32));
}

/** Huella corta de la master key (8 hex del SHA-256) para verificar la copia guardada. */
function huella() {
  return crypto.createHash('sha256').update(key()).digest('hex').slice(0, 8);
}

module.exports = { encrypt, decrypt, derivar, huella };
