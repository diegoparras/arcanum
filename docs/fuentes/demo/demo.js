'use strict';
// Datos de demostración para las capturas, el video y las guías. Todo es ficticio: CUITs de
// dígitos repetidos, nombres inventados y certificados autofirmados que ARCA nunca aceptaría.
// Corre dentro del contenedor de arc-demo.sh, con el código de Arcanum.
process.chdir('/app');
const forge = require('/app/node_modules/node-forge');
const db = require('/app/src/db');
const { config } = require('/app/src/config');
const catalog = require('/app/src/catalog');

function cuit(pref, d) {
  const base = `${pref}${String(d).repeat(8)}`;
  const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0; for (let i = 0; i < 10; i++) s += Number(base[i]) * m[i];
  let v = 11 - (s % 11); if (v === 11) v = 0; if (v === 10) return null;
  return base + v;
}
const lista = [];
for (const pref of ['20', '23', '27', '30', '33']) for (let d = 1; d <= 9; d++) { const c = cuit(pref, d); if (c) lista.push(c); }

async function main() {
  await db.waitForDb(); await db.migrate(); await catalog.init();
  const env = config.env;
  const onboarding = require('/app/src/services/onboarding');
  const tenants = require('/app/src/auth/tenants');
  const vault = require('/app/src/crypto/vault');
  const clientes = [
    [lista.find((c) => c.startsWith('30') && c[2] === '7') || '30777777771', 'Estudio Contable Demo SRL'],
    [lista.find((c) => c.startsWith('20') && c[2] === '1'), 'Martina Ejemplo'],
    [lista.find((c) => c.startsWith('30') && c[2] === '5'), 'Panadería La Espiga Demo SA'],
    [lista.find((c) => c.startsWith('27') && c[2] === '5'), 'Lucía Prueba Consultora'],
  ];
  for (const [i, [c, nombre]] of clientes.entries()) {
    await onboarding.crearCliente(c, nombre, env);
    if (i === 3) continue; // una queda "esperando el certificado de ARCA"
    const { rows } = await db.query('SELECT key_enc FROM tenants WHERE cuit=$1 AND entorno=$2', [c, env]);
    const key = forge.pki.privateKeyFromPem(vault.decrypt(rows[0].key_enc));
    const pub = forge.pki.setRsaPublicKey(key.n, key.e);
    const cert = forge.pki.createCertificate();
    cert.publicKey = pub; cert.serialNumber = '0' + (1000 + i);
    cert.validity.notBefore = new Date(Date.now() - 40 * 864e5);
    cert.validity.notAfter = new Date(Date.now() + (i === 2 ? 21 : 600) * 864e5); // uno por vencer
    const attrs = [{ name: 'commonName', value: `demo-${c}` }, { name: 'countryName', value: 'AR' }, { type: '2.5.4.5', value: `CUIT ${c}` }];
    cert.setSubject(attrs); cert.setIssuer([{ name: 'commonName', value: 'Computadores Demo' }, { name: 'countryName', value: 'AR' }]);
    cert.sign(key, forge.md.sha256.create());
    await tenants.storeCert(c, env, forge.pki.certificateToPem(cert));
  }
  const principal = clientes[0][0];
  const contrapartes = lista.filter((c) => !clientes.some((x) => x[0] === c)).slice(0, 14);
  const nombresCli = ['Universidad del Ejemplo', 'Cooperativa del Sur Demo', 'Fundación Horizonte Demo', 'Clínica Modelo SA', 'Juan Ficticio', 'Laboratorio Alfa Demo', 'Colegio San Demo'];
  const nombresProv = ['Proveedor Alfa SRL', 'Servicios Beta SA', 'Telefonía Gamma', 'Insumos Delta', 'Alquileres Épsilon', 'Librería Zeta', 'Energía Eta SA'];

  // Comprobantes emitidos por Arcanum: los últimos 14 días.
  let nro = 1200;
  for (let d = 13; d >= 0; d--) {
    const n = d === 0 ? 6 : 2 + ((d * 7) % 6);
    for (let k = 0; k < n; k++) {
      nro += 1;
      const total = 85000 + ((nro * 7919) % 420000);
      const doc = contrapartes[nro % 7];
      await db.query(
        `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha, importe_total, doc_tipo, doc_nro, raw, created_at)
         VALUES ($1,$2,4,$3,$4,$5,current_date+10,'A',current_date-$6::int,$7,80,$8,$9, now() - make_interval(days => $6::int, mins => $10::int))`,
        [principal, env, nro % 9 === 0 ? 3 : 1, nro, '7' + String(4123456789000 + nro), d, total, doc,
          JSON.stringify({ aprobado: true, receptorNombre: nombresCli[nro % 7], importeTotal: total }), k * 37]);
    }
  }
  // Mis Comprobantes: dos años de emitidos y recibidos, con el negocio creciendo.
  await db.query(`INSERT INTO mc_comprobantes (cuit, tipo, fecha, cbte_tipo, punto_venta, numero_desde, numero_hasta, cae, doc_tipo, doc_nro, contraparte, moneda, tipo_cambio, neto_gravado, no_gravado, exento, iva, total)
    SELECT $1,'emitido', current_date - (g*2.5)::int, CASE WHEN g % 19 = 0 THEN 3 ELSE 1 END, 4, 800+g, 800+g, '7'||lpad(g::text,13,'0'), 80,
      ($2::text[])[1 + g % 7], ($3::text[])[1 + g % 7], 'PES', 1,
      round((120000 + (g*7919 % 700000) + (300-g)*1500)::numeric/1.21, 2), 0, 0, round((120000 + (g*7919 % 700000) + (300-g)*1500)::numeric*0.21/1.21, 2),
      CASE WHEN g % 19 = 0 THEN -round((40000 + g*90)::numeric,2) ELSE round((120000 + (g*7919 % 700000) + (300-g)*1500)::numeric, 2) END
    FROM generate_series(1, 290) g`, [principal, contrapartes.slice(0, 7), nombresCli]);
  await db.query(`INSERT INTO mc_comprobantes (cuit, tipo, fecha, cbte_tipo, punto_venta, numero_desde, numero_hasta, cae, doc_tipo, doc_nro, contraparte, moneda, tipo_cambio, neto_gravado, no_gravado, exento, iva, total, constatacion)
    SELECT $1,'recibido', current_date - (g*1.8)::int, (ARRAY[1,6,11,1])[1 + g % 4], 7, 5000+g, 5000+g, '8'||lpad(g::text,13,'0'), 80,
      ($2::text[])[1 + g % 7], ($3::text[])[1 + g % 7], 'PES', 1,
      round((15000 + (400-g)*90 + (g % 6)*20000)::numeric/1.21,2), 0, 0, round((15000 + (400-g)*90 + (g % 6)*20000)::numeric*0.21/1.21,2),
      round((15000 + (400-g)*90 + (g % 6)*20000)::numeric, 2),
      CASE WHEN g % 31 = 0 THEN '{"valido":false,"resultado":"R","observaciones":[{"code":1,"message":"Comprobante no autorizado"}]}'::jsonb
           WHEN g % 3 = 0 THEN NULL ELSE '{"valido":true,"resultado":"A","apoc":{"esApocrifo":false}}'::jsonb END
    FROM generate_series(1, 400) g`, [principal, contrapartes.slice(7, 14), nombresProv]);
  await db.query(`INSERT INTO mc_credenciales (cuit, cuit_login, clave_cifrada, sincronizar, actualizada_por) VALUES ($1,$1,$2,true,'admin')`, [principal, vault.encrypt('clave-demo')]);
  for (const [i, t] of ['emitidos', 'recibidos', 'ambos'].entries()) {
    await db.query(`INSERT INTO mc_corridas (cuit, tipo, desde, hasta, estado, origen, usuario, iniciada_at, terminada_at, cantidad)
      VALUES ($1,$2,current_date-30,current_date,'terminado',$3,'admin', now()-make_interval(days=>$4::int), now()-make_interval(days=>$4::int)+interval '3 minutes', $5)`,
      [principal, t, i === 2 ? 'diaria' : 'manual', i, 40 + i * 17]);
  }
  // Estado de ARCA (monitor) y pedidos de las últimas 24 h.
  const monit = catalog.list().filter((s) => s.dummyOp).map((s) => s.id);
  for (const s of monit) for (let k = 0; k < 24; k++) {
    await db.query('INSERT INTO service_status (service, entorno, ok, latency_ms, checked_at) VALUES ($1,$2,$3,$4, now() - make_interval(mins => $5::int))',
      [s, env, !(s === 'wsfex' && k === 7), 180 + ((s.length * 97 + k * 13) % 420), k * 60]);
  }
  await db.query(`INSERT INTO requests (cuit, service, operation, http_method, path, status, ok, duration_ms, usuario, ip, ts)
    SELECT $1, (ARRAY['wsfev1','padron','comprobantes','mis-comprobantes'])[1+g%4], NULL, 'GET', '/api/demo', CASE WHEN g % 41 = 0 THEN 502 ELSE 200 END, g % 41 <> 0, 40 + g % 300, 'admin', '127.0.0.1', now() - make_interval(mins => g)
    FROM generate_series(1, 640) g`, [principal]);
  // Lote, cola de contingencia, usuarios, claves y webhook.
  const lotes = require('/app/src/services/lotes');
  await lotes.crear(principal, { nombre: 'Honorarios noviembre', perfil: 'pyme', items: nombresCli.slice(0, 5).map((n, i) => ({ nombre: n, cuit: contrapartes[i], email: `demo${i}@ejemplo.com`, periodo: '2026-11', importeTotal: 180000 + i * 25000, tipoComprobante: 11, puntoVenta: 4 })) });
  await db.query(`INSERT INTO emision_cola (cuit, entorno, idempotency_key, cuerpo, fecha, concepto, estado, intentos, proximo_intento_at, ultimo_error, creado_por, origen)
    VALUES ($1,$2,'demo-cola-1',$3, current_date, 1, 'pendiente', 2, now()+interval '4 minutes', 'ARCA no responde (timeout)', 'admin', 'ui')`,
    [principal, env, JSON.stringify({ puntoVenta: 4, tipoComprobante: 1, importeTotal: 254100 })]);
  const users = require('/app/src/auth/users');
  await users.crear({ username: 'carla', password: 'demo-demo-demo-1', role: 'operador', cuitAllow: [principal] });
  await users.crear({ username: 'auditoria', password: 'demo-demo-demo-2', role: 'lectura' });
  const apikeys = require('/app/src/auth/apikeys');
  await apikeys.crear({ nombre: 'n8n facturación', rol: 'operador', cuits: [principal], limitePorMinuto: 120 }, 'admin');
  await apikeys.crear({ nombre: 'Asistente de consultas', rol: 'lectura', venceDias: 90 }, 'admin');
  await db.query("INSERT INTO webhooks (url, eventos, secret) VALUES ('https://hooks.ejemplo.com/arcanum', $1, 'demo')", [['comprobante_emitido', 'arca_caido', 'cert_por_vencer', 'tope_monotributo']]);
  // La master key de la demo es descartable: se da por resguardada para que no aparezca el aviso.
  await db.query("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('master_key_respaldada_at', now()::text, 'demo', now()) ON CONFLICT (key) DO NOTHING");
  console.log('demo ok', principal);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
