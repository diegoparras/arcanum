'use strict';

// Alta de clientes y ciclo de vida del certificado.
//
// Flujo guiado:
//   1. crearCliente(cuit, nombre)  -> genera clave privada (se guarda cifrada en
//      DB) + CSR. Devuelve el CSR para que el contador lo suba a ARCA.
//   2. (el contador sube el CSR a ARCA y descarga el .crt)
//   3. cargarCertificado(cuit, certPem) -> valida que el cert case con la clave
//      y lo guarda. A partir de aca el CUIT puede operar.

const forge = require('node-forge');
const db = require('./../db');
const { config } = require('../config');
const { encrypt } = require('../crypto/vault');
const tenants = require('../auth/tenants');

/**
 * Genera clave privada + CSR para un CUIT y los persiste (clave cifrada).
 * @returns {{cuit, csr, key:'(guardada cifrada)', subject}}
 */
async function crearCliente(cuit, nombre, entorno = config.env) {
  const c = tenants.normalizeCuit(cuit);
  if (!c || c.length < 11) throw err('CUIT invalido (11 digitos)', 400);
  if (!nombre || !String(nombre).trim()) throw err('Falta el nombre / razon social', 400);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  // DN que pide ARCA: C=AR, O=<razon social>, CN=<algo>, serialNumber=CUIT <cuit>
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: String(nombre).trim().slice(0, 64) },
    { name: 'commonName', value: `arcanum-${c}` },
    { type: '2.5.4.5', value: `CUIT ${c}` }, // serialNumber
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  await tenants.storeKey(c, entorno, keyPem, nombre);
  await db.query('UPDATE tenants SET csr_pem = $3 WHERE cuit = $1 AND entorno = $2', [c, entorno, csrPem]);

  return {
    cuit: c,
    nombre,
    entorno,
    csr: csrPem,
    subject: `C=AR, O=${nombre}, CN=arcanum-${c}, serialNumber=CUIT ${c}`,
  };
}

/** Devuelve el CSR ya generado (para volver a copiarlo). */
async function getCsr(cuit, entorno = config.env) {
  const c = tenants.normalizeCuit(cuit);
  const { rows } = await db.query('SELECT csr_pem FROM tenants WHERE cuit = $1 AND entorno = $2', [c, entorno]);
  if (!rows.length || !rows[0].csr_pem) throw err('Este CUIT no tiene un CSR generado', 404);
  return rows[0].csr_pem;
}

/** Carga el certificado devuelto por ARCA (valida que case con la clave). */
async function cargarCertificado(cuit, certPem, entorno = config.env) {
  if (!certPem || !/BEGIN CERTIFICATE/.test(certPem)) {
    throw err('Pega el certificado en formato PEM (incluyendo -----BEGIN CERTIFICATE-----)', 400);
  }
  return tenants.storeCert(cuit, entorno, certPem);
}

/** Permite cargar una clave privada propia (en vez de generar el CSR aca). */
async function importarClave(cuit, nombre, keyPem, entorno = config.env) {
  return tenants.storeKey(cuit, entorno, keyPem, nombre);
}

/** Importa un par existente (clave + certificado) en una sola operacion. */
async function importarPar(cuit, nombre, keyPem, certPem, entorno = config.env) {
  if (!keyPem || !/BEGIN (RSA |EC )?PRIVATE KEY/.test(keyPem)) {
    throw err('Falta la clave privada en formato PEM', 400);
  }
  await tenants.storeKey(cuit, entorno, keyPem, nombre);
  return tenants.storeCert(cuit, entorno, certPem);
}

async function eliminarCliente(cuit, entorno = config.env) {
  const c = tenants.normalizeCuit(cuit);
  await db.query('DELETE FROM access_tickets WHERE cuit = $1 AND entorno = $2', [c, entorno]);
  await db.query('DELETE FROM tenants WHERE cuit = $1 AND entorno = $2', [c, entorno]);
  return { eliminado: c };
}

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

module.exports = { crearCliente, getCsr, cargarCertificado, importarClave, importarPar, eliminarCliente };
