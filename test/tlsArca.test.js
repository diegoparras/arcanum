'use strict';

// TLS de ARCA: varios servidores de ARCA (p. ej. servicios1.afip.gov.ar, wsfev1) negocian
// Diffie-Hellman de 1024 bits, que OpenSSL 3 rechaza por defecto (ERR_SSL_DH_KEY_TOO_SMALL).
// Estas pruebas reproducen ese servidor EN LOCAL (nunca se conecta a ARCA) y verifican que:
//   - las opciones TLS de ARCA (SECLEVEL=1) lo aceptan y las de por defecto no;
//   - el agente relajado se usa SOLO para hosts de ARCA;
//   - un fallo de conexion dice la causa real, no solo "fetch failed".

const test = require('node:test');
const assert = require('node:assert');
const tls = require('node:tls');
const crypto = require('node:crypto');
const forge = require('node-forge');

const tlsArca = require('../src/soap/tlsArca');
const { post } = require('../src/soap/client');

// --- Servidor TLS local que imita a ARCA: solo TLS 1.2 + DHE con primo de 1024 bits ---

function dhParams1024Pem() {
  // Grupo 2 de Oakley (RFC 2409, 1024 bits), el mismo tamano que negocia ARCA.
  const p = crypto.getDiffieHellman('modp2').getPrime();
  const asn1 = forge.asn1;
  const seq = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, forge.util.hexToBytes('00' + p.toString('hex'))),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, String.fromCharCode(2)),
  ]);
  const der = Buffer.from(asn1.toDer(seq).getBytes(), 'binary');
  return `-----BEGIN DH PARAMETERS-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END DH PARAMETERS-----\n`;
}

function certAutofirmado() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

let servidor;
let puerto;
let ca;

test.before(async () => {
  const { key, cert } = certAutofirmado();
  ca = cert;
  servidor = tls.createServer({
    key,
    cert,
    dhparam: dhParams1024Pem(),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2', // sin TLS 1.3: obliga a DHE, como ARCA
    ciphers: 'DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:@SECLEVEL=0',
  }, (s) => {
    s.on('error', () => {});
    s.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
  });
  servidor.on('tlsClientError', () => {});
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  puerto = servidor.address().port;
});

test.after(() => new Promise((r) => servidor.close(r)));

function conectar(opciones) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: puerto, servername: 'localhost', ca, ...opciones });
    s.once('secureConnect', () => { s.destroy(); resolve('ok'); });
    s.once('error', reject);
  });
}

test('el servidor local reproduce a ARCA: la seguridad por defecto lo rechaza', async () => {
  await assert.rejects(conectar({}), { code: 'ERR_SSL_DH_KEY_TOO_SMALL' });
});

test('las opciones TLS de ARCA (SECLEVEL=1) si se conectan', async () => {
  assert.strictEqual(await conectar({ ...tlsArca.OPCIONES_TLS_ARCA }), 'ok');
});

test('las opciones TLS de ARCA son SECLEVEL=1 (no 0) con TLS 1.2 como minimo', () => {
  assert.strictEqual(tlsArca.OPCIONES_TLS_ARCA.ciphers, 'DEFAULT@SECLEVEL=1');
  assert.strictEqual(tlsArca.OPCIONES_TLS_ARCA.minVersion, 'TLSv1.2');
  assert.ok(Object.isFrozen(tlsArca.OPCIONES_TLS_ARCA));
});

test('el agente de ARCA (undici) se conecta al servidor con DH chico', async () => {
  const { fetch } = require('undici');
  const agente = tlsArca.crearAgenteArca({ ca });
  try {
    const r = await fetch(`https://localhost:${puerto}/`, { dispatcher: agente });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), 'ok');
  } finally {
    await agente.close();
  }
});

test('esHostArca reconoce los dominios de ARCA y nada mas', () => {
  for (const h of [
    'servicios1.afip.gov.ar', 'wsaa.afip.gov.ar', 'wswhomo.afip.gov.ar', 'serviciosjava.afip.gov.ar',
    'eapoc-ws.afip.gob.ar', 'cpea-ws.arca.gob.ar', 'servicios3.arca.gob.ar', 'afip.gob.ar', 'SERVICIOS1.AFIP.GOV.AR',
  ]) assert.ok(tlsArca.esHostArca(h), h);
  for (const h of [
    'evilafip.gov.ar', 'afip.gov.ar.example.com', 'arca.gob.ar.evil.net', 'example.com', 'localhost',
    '127.0.0.1', 'gov.ar', 'xarca.gob.ar', '',
  ]) assert.ok(!tlsArca.esHostArca(h), h);
});

test('dispatcherPara usa el agente de ARCA solo para URLs de ARCA', () => {
  const agente = tlsArca.dispatcherPara('https://servicios1.afip.gov.ar/wsfev1/service.asmx');
  assert.ok(agente, 'debe haber agente para ARCA');
  assert.strictEqual(tlsArca.dispatcherPara('https://wsaa.afip.gov.ar/ws/services/LoginCms'), agente, 'mismo agente compartido');
  assert.strictEqual(tlsArca.dispatcherPara('https://hooks.example.com/arcanum'), undefined);
  assert.strictEqual(tlsArca.dispatcherPara('https://servicios1.afip.gov.ar.evil.net/x'), undefined);
  assert.strictEqual(tlsArca.dispatcherPara('http://servicios1.afip.gov.ar/x'), undefined, 'solo https');
  assert.strictEqual(tlsArca.dispatcherPara('no es una url'), undefined);
});

test('causaDeFallo saca el codigo real de e.cause', () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('dh key too small'), { code: 'ERR_SSL_DH_KEY_TOO_SMALL' });
  assert.strictEqual(tlsArca.causaDeFallo(e), 'fetch failed (ERR_SSL_DH_KEY_TOO_SMALL)');
  const sinCodigo = new TypeError('fetch failed');
  sinCodigo.cause = new Error('socket hang up');
  assert.strictEqual(tlsArca.causaDeFallo(sinCodigo), 'fetch failed (socket hang up)');
  assert.strictEqual(tlsArca.causaDeFallo(new Error('otra cosa')), 'otra cosa');
});

test('un fallo de conexion del cliente SOAP dice la causa, no solo "fetch failed"', async () => {
  // Puerto local cerrado: ECONNREFUSED, sin salir de la maquina.
  const libre = await new Promise((r) => {
    const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  await assert.rejects(
    post(`https://127.0.0.1:${libre}/ws`, '"x"', '<x/>'),
    (e) => e.name === 'SoapError' && /No se pudo conectar con ARCA: .*\(ECONNREFUSED\)/.test(e.message),
  );
});
