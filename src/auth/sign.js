'use strict';

// Firma CMS (PKCS#7) del Ticket de Requerimiento de Acceso (TRA).
//
// Este es EL nucleo del "kilombo" de WSAA: ARCA exige que el XML del TRA viaje
// firmado en formato CMS/PKCS#7, en DER, codificado en Base64. Lo hacemos 100%
// local con node-forge: la clave privada del contribuyente NUNCA sale de este
// contenedor ni pasa por ningun tercero.

const forge = require('node-forge');

/**
 * Firma el TRA y devuelve el CMS en Base64 listo para LoginCms.
 * @param {string} traXml  XML del loginTicketRequest (texto plano).
 * @param {string} certPem Certificado X.509 del contribuyente (PEM).
 * @param {string} keyPem  Clave privada asociada (PEM, sin passphrase).
 * @returns {string} CMS firmado, DER, en Base64.
 */
function signTRA(traXml, certPem, keyPem) {
  let cert;
  let key;
  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch (e) {
    throw new Error('Certificado invalido o ilegible (PEM): ' + e.message);
  }
  try {
    key = forge.pki.privateKeyFromPem(keyPem);
  } catch (e) {
    throw new Error('Clave privada invalida o protegida por passphrase (PEM): ' + e.message);
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });

  // detached:false => el contenido (TRA) viaja dentro del CMS, como exige ARCA.
  p7.sign({ detached: false });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

/**
 * Lee metadatos del certificado para diagnostico (no toca la clave privada).
 * @param {string} certPem
 * @returns {{subject:string, issuer:string, notBefore:Date, notAfter:Date, expired:boolean}}
 */
function inspectCert(certPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const attr = (field) => {
    const a = cert.subject.getField(field);
    return a ? a.value : null;
  };
  const now = new Date();
  return {
    subject: cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    cn: attr('CN'),
    serialNumber: cert.serialNumber,
    issuer: cert.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    expired: now > cert.validity.notAfter || now < cert.validity.notBefore,
  };
}

module.exports = { signTRA, inspectCert };
