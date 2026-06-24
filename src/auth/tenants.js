'use strict';

// Tenants (clientes/CUITs) respaldados por Postgres. La clave privada se guarda
// CIFRADA (AES-256-GCM, ver crypto/vault). El certificado se guarda en claro
// (es publico). Cada (cuit, entorno) es un registro independiente: el cert de
// homologacion no sirve en produccion.

const forge = require('node-forge');
const db = require('../db');
const { encrypt, decrypt } = require('../crypto/vault');
const { inspectCert } = require('./sign');

function normalizeCuit(cuit) {
  return String(cuit || '').replace(/[^0-9]/g, '');
}

class TenantError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.name = 'TenantError';
    this.httpStatus = httpStatus;
  }
}

function fingerprint(pem) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem))).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex();
}

/** Crea/asegura el tenant y guarda su clave privada (cifrada). */
async function storeKey(cuit, entorno, keyPem, nombre) {
  const c = normalizeCuit(cuit);
  if (!c) throw new TenantError('CUIT invalido', 400);
  // Validamos que la clave parsee antes de guardarla.
  try {
    forge.pki.privateKeyFromPem(keyPem);
  } catch (e) {
    throw new TenantError('Clave privada invalida (PEM): ' + e.message, 400);
  }
  await db.query(
    `INSERT INTO tenants (cuit, entorno, nombre, key_enc, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (cuit, entorno) DO UPDATE SET key_enc = $4, nombre = COALESCE($3, tenants.nombre), updated_at = now()`,
    [c, entorno, nombre || null, encrypt(keyPem)],
  );
  return { cuit: c, entorno };
}

/** Guarda el certificado que devolvio ARCA, validando que case con la clave. */
async function storeCert(cuit, entorno, certPem) {
  const c = normalizeCuit(cuit);
  const { rows } = await db.query('SELECT key_enc FROM tenants WHERE cuit = $1 AND entorno = $2', [c, entorno]);
  if (!rows.length || !rows[0].key_enc) {
    throw new TenantError('Primero genera/carga la clave privada de este CUIT', 409);
  }
  const keyPem = decrypt(rows[0].key_enc);

  // Validacion: la clave publica del cert debe coincidir con la privada guardada.
  let cert;
  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch (e) {
    throw new TenantError('Certificado invalido (PEM): ' + e.message, 400);
  }
  const priv = forge.pki.privateKeyFromPem(keyPem);
  const pubFromPriv = forge.pki.setRsaPublicKey(priv.n, priv.e);
  if (forge.pki.publicKeyToPem(pubFromPriv) !== forge.pki.publicKeyToPem(cert.publicKey)) {
    throw new TenantError('El certificado no corresponde a la clave privada de este CUIT', 422);
  }

  const info = inspectCert(certPem);
  await db.query(
    `UPDATE tenants SET cert_pem = $3, key_fingerprint = $4, cert_not_before = $5, cert_not_after = $6, updated_at = now()
     WHERE cuit = $1 AND entorno = $2`,
    [c, entorno, certPem, fingerprint(certPem), info.notBefore, info.notAfter],
  );
  return { cuit: c, entorno, certificate: info };
}

/** Devuelve { cuit, certPem, keyPem } descifrado, o lanza si falta algo. */
async function load(cuit, entorno) {
  const c = normalizeCuit(cuit);
  if (!c) throw new TenantError('CUIT vacio o invalido', 400);
  const { rows } = await db.query('SELECT cert_pem, key_enc FROM tenants WHERE cuit = $1 AND entorno = $2', [c, entorno]);
  if (!rows.length) throw new TenantError(`No hay cliente cargado para el CUIT ${c} en ${entorno}`, 404);
  const { cert_pem, key_enc } = rows[0];
  if (!key_enc) throw new TenantError(`Falta la clave privada del CUIT ${c}`, 409);
  if (!cert_pem) throw new TenantError(`Falta el certificado del CUIT ${c} (pegá el .crt que devolvió ARCA)`, 409);
  return { cuit: c, certPem: cert_pem, keyPem: decrypt(key_enc) };
}

/** Lista tenants con metadata del certificado (sin exponer la clave). */
async function list(entorno) {
  const params = [];
  let where = '';
  if (entorno) {
    where = 'WHERE entorno = $1';
    params.push(entorno);
  }
  const { rows } = await db.query(
    `SELECT cuit, entorno, nombre, key_fingerprint, cert_not_before, cert_not_after,
            (cert_pem IS NOT NULL) AS tiene_cert, (key_enc IS NOT NULL) AS tiene_clave, updated_at
     FROM tenants ${where} ORDER BY cuit`,
    params,
  );
  const now = Date.now();
  return rows.map((r) => ({
    cuit: r.cuit,
    entorno: r.entorno,
    nombre: r.nombre,
    tieneClave: r.tiene_clave,
    tieneCertificado: r.tiene_cert,
    certVigenciaHasta: r.cert_not_after,
    certVencido: r.cert_not_after ? new Date(r.cert_not_after).getTime() < now : null,
    diasParaVencer: r.cert_not_after ? Math.ceil((new Date(r.cert_not_after).getTime() - now) / 86400000) : null,
  }));
}

module.exports = { load, list, storeKey, storeCert, normalizeCuit, TenantError };
