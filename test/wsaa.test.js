'use strict';

const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');

const { signTRA, inspectCert } = require('../src/auth/sign');
const { buildTRA } = require('../src/auth/wsaa');

// Genera un par de claves + certificado autofirmado para probar la firma CMS
// sin depender de ARCA ni de un certificado real.
function makeSelfSigned() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: 'commonName', value: 'arcanum-test' }, { name: 'organizationName', value: 'Test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

test('buildTRA arma un loginTicketRequest valido', () => {
  const tra = buildTRA('wsfe');
  assert.match(tra, /<service>wsfe<\/service>/);
  assert.match(tra, /<uniqueId>\d+<\/uniqueId>/);
  assert.match(tra, /<generationTime>.+<\/generationTime>/);
  assert.match(tra, /<expirationTime>.+<\/expirationTime>/);
});

test('signTRA produce un CMS base64 que vuelve a parsear con el contenido dentro', () => {
  const { certPem, keyPem } = makeSelfSigned();
  const tra = buildTRA('wsfe');
  const cms = signTRA(tra, certPem, keyPem);

  assert.ok(cms.length > 100, 'el CMS no puede estar vacio');
  // Re-parseamos el DER para confirmar que es un PKCS#7 signedData con contenido.
  const der = forge.util.decode64(cms);
  const asn1 = forge.asn1.fromDer(der);
  const p7 = forge.pkcs7.messageFromAsn1(asn1);
  assert.ok(p7.rawCapture.content, 'el contenido (TRA) debe viajar dentro del CMS');
});

test('signTRA rechaza una clave invalida con mensaje claro', () => {
  const { certPem } = makeSelfSigned();
  assert.throws(() => signTRA('<x/>', certPem, 'no-soy-una-clave'), /Clave privada invalida/);
});

test('inspectCert lee vigencia y subject', () => {
  const { certPem } = makeSelfSigned();
  const info = inspectCert(certPem);
  assert.equal(info.cn, 'arcanum-test');
  assert.equal(info.expired, false);
  assert.ok(info.notAfter instanceof Date);
});
