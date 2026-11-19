'use strict';

// Rutinas de fondo:
//  - monitor: hace dummy a cada servicio que lo soporte y guarda uptime/latencia.
//  - renovacion: mantiene los Tickets de Acceso calientes (renueva antes de vencer).
//  - vencimientos: avisa por webhook cuando un certificado o una clave de API esta por vencer.
//  - e-Ventanilla: avisa por webhook cuando llega una comunicacion nueva de ARCA.

const db = require('./db');
const { config } = require('./config');
const catalog = require('./catalog');
const engine = require('./soap/engine');
const { getAccessTicket } = require('./auth/wsaa');
const webhooks = require('./services/webhooks');
const eventanilla = require('./services/eventanilla');
const tenants = require('./auth/tenants');
const apikeys = require('./auth/apikeys');

const timers = [];
let lastArcaOk = true;

function maskCuit(c) {
  const s = String(c || '');
  return s.length >= 5 ? s.slice(0, 2) + '*****' + s.slice(-2) : '***';
}

async function monitor() {
  // Limpieza: historial de status mas viejo que 7 dias.
  db.query("DELETE FROM service_status WHERE checked_at < now() - interval '7 days'").catch(() => {});
  const servicios = catalog.list().filter((s) => s.dummyOp);
  for (const s of servicios) {
    const t0 = Date.now();
    let ok = false;
    let detail = '';
    try {
      // e-Ventanilla es SOAP 1.2 + MTOM: usa su modulo rico, no el generico.
      if (s.id === 'eventanilla') await eventanilla.dummy(config.env);
      else await engine.call(s.id, s.dummyOp, {}, { entorno: config.env });
      ok = true;
    } catch (e) {
      detail = e.message.slice(0, 200);
    }
    const latency = Date.now() - t0;
    try {
      await db.query('INSERT INTO service_status (service, entorno, ok, latency_ms, detail) VALUES ($1,$2,$3,$4,$5)', [
        s.id, config.env, ok, latency, detail,
      ]);
    } catch {
      /* ignore */
    }
    // Aviso de caida/restablecimiento de ARCA basado en wsfev1 (el termometro).
    if (s.id === 'wsfev1') {
      if (!ok && lastArcaOk) webhooks.emitir('arca_caido', { servicio: s.id, detail }).catch(() => {});
      if (ok && !lastArcaOk) webhooks.emitir('arca_restablecido', { servicio: s.id }).catch(() => {});
      lastArcaOk = ok;
    }
  }
}

async function renovarTokens() {
  // Refresca los TA que esten activos: si estan dentro del margen, getAccessTicket
  // dispara un relogin proactivo; si no, no hace nada (barato).
  let rows = [];
  try {
    ({ rows } = await db.query('SELECT DISTINCT cuit, service, entorno FROM access_tickets WHERE entorno = $1', [config.env]));
  } catch {
    return;
  }
  for (const r of rows) {
    try {
      await getAccessTicket(r.cuit, r.service, r.entorno);
    } catch (e) {
      console.error('[arcanum][daemon] no se pudo renovar TA', maskCuit(r.cuit), r.service, e.message);
    }
  }
}

async function avisarVencimientos() {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT cuit, nombre, cert_not_after FROM tenants
       WHERE entorno = $1 AND cert_not_after IS NOT NULL
         AND cert_not_after < now() + interval '30 days'`,
      [config.env],
    ));
  } catch {
    return;
  }
  for (const r of rows) {
    const dias = Math.ceil((new Date(r.cert_not_after).getTime() - Date.now()) / 86400000);
    console.warn(`[arcanum] certificado del CUIT ${maskCuit(r.cuit)} vence en ${dias} dias`);
    webhooks.emitir('cert_por_vencer', { cuit: r.cuit, nombre: r.nombre, vence: r.cert_not_after, dias }).catch(() => {});
  }
  // Claves de API que vencen en menos de 7 dias (se avisa una vez por clave).
  try {
    for (const k of await apikeys.porVencerSinAviso(7)) {
      console.warn(`[arcanum] la clave de API "${k.nombre}" vence en ${k.dias} dias`);
      webhooks.emitir('clave_por_vencer', k).catch(() => {});
    }
  } catch (e) {
    console.error('[arcanum][daemon] claves por vencer:', e.message);
  }
}

// e-Ventanilla: avisa (webhook comunicacion_nueva) cuando ARCA publica una comunicacion
// nueva para un CUIT con certificado. Solo consulta el listado (no la marca como leida).
// La primera vez por CUIT se toma linea de base sin avisar lo historico.
const fallosVentanilla = new Set();
async function revisarVentanilla() {
  if (!(await webhooks.hayInteresados('comunicacion_nueva'))) return;
  const lista = (await tenants.list(config.env)).filter((t) => t.tieneCertificado && !t.certVencido);
  for (const t of lista) {
    let r;
    try {
      r = await eventanilla.consultarComunicaciones(t.cuit, { entorno: config.env });
      fallosVentanilla.delete(t.cuit);
    } catch (e) {
      // Un aviso por CUIT hasta que vuelva a andar (ej. cert sin el servicio e-Ventanilla asociado).
      if (!fallosVentanilla.has(t.cuit)) console.warn(`[arcanum][ventanilla] ${maskCuit(t.cuit)}: ${e.message.slice(0, 160)}`);
      fallosVentanilla.add(t.cuit);
      continue;
    }
    const { rows: base } = await db.query(
      'SELECT 1 FROM ventanilla_vistas WHERE cuit = $1 AND entorno = $2 AND id_comunicacion = 0',
      [t.cuit, config.env],
    );
    const primeraVez = !base.length;
    const ids = [0, ...r.comunicaciones.map((c) => c.idComunicacion).filter((x) => x > 0)];
    const { rows: nuevas } = await db.query(
      `INSERT INTO ventanilla_vistas (cuit, entorno, id_comunicacion)
       SELECT $1, $2, unnest($3::bigint[]) ON CONFLICT DO NOTHING RETURNING id_comunicacion`,
      [t.cuit, config.env, ids],
    );
    if (primeraVez) continue;
    for (const n of nuevas) {
      const c = r.comunicaciones.find((x) => Number(x.idComunicacion) === Number(n.id_comunicacion));
      if (!c) continue;
      webhooks.emitir('comunicacion_nueva', {
        cuit: t.cuit,
        nombre: t.nombre,
        idComunicacion: c.idComunicacion,
        asunto: c.asunto,
        organismo: c.sistemaPublicadorDesc,
        fechaPublicacion: c.fechaPublicacion,
        fechaVencimiento: c.fechaVencimiento,
        prioridad: c.prioridad,
        tieneAdjunto: c.tieneAdjunto,
      }).catch(() => {});
    }
  }
}

function every(ms, fn) {
  const t = setInterval(() => fn().catch((e) => console.error('[arcanum][daemon]', e.message)), ms);
  t.unref?.();
  timers.push(t);
}

function start() {
  if (process.env.ARCANUM_DAEMONS === '0') {
    console.log('[arcanum] daemons deshabilitados (ARCANUM_DAEMONS=0)');
    return;
  }
  // Primer monitoreo a los 5s del arranque, luego cada 5 min.
  // NO renovamos tokens proactivamente: ARCA rechaza pedir un TA nuevo mientras
  // el anterior siga vigente. El token se renueva solo, on-demand, recien cuando
  // vencio (asi hay un unico login cada ~12h por servicio).
  setTimeout(() => monitor().catch(() => {}), 5000);
  every(5 * 60 * 1000, monitor);
  setTimeout(() => avisarVencimientos().catch(() => {}), 60 * 1000);
  every(12 * 60 * 60 * 1000, avisarVencimientos);
  const ventanillaMin = parseInt(process.env.ARCANUM_VENTANILLA_MIN || '60', 10);
  if (ventanillaMin > 0) {
    setTimeout(() => revisarVentanilla().catch((e) => console.error('[arcanum][ventanilla]', e.message)), 2 * 60 * 1000);
    every(ventanillaMin * 60 * 1000, revisarVentanilla);
  }
  console.log(`[arcanum] daemons activos (monitor 5m, vencimientos 12h, e-Ventanilla ${ventanillaMin > 0 ? `${ventanillaMin}m` : 'apagado'})`);
}

function stop() {
  timers.forEach(clearInterval);
}

module.exports = { start, stop, monitor, renovarTokens, avisarVencimientos, revisarVentanilla };
