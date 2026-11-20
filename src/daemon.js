'use strict';

// Rutinas de fondo:
//  - monitor: hace dummy a cada servicio que lo soporte y guarda uptime/latencia.
//  - renovacion: mantiene los Tickets de Acceso calientes (renueva antes de vencer).
//  - vencimientos: avisa por webhook cuando un certificado o una clave de API esta por vencer.
//  - e-Ventanilla: avisa por webhook cuando llega una comunicacion nueva de ARCA.
//  - Mis Comprobantes: una vez por dia (ARCANUM_MC_HORA, hora argentina) baja emitidos y
//    recibidos del mes anterior y el actual de los CUIT con sincronizacion diaria, y revisa
//    los topes de Monotributo.

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
      if (ok && !lastArcaOk) {
        webhooks.emitir('arca_restablecido', { servicio: s.id }).catch(() => {});
        procesarCola().catch((e) => console.error('[arcanum][cola]', e.message)); // volvio ARCA: sale lo encolado
        setTimeout(() => caeaInformar().catch(() => {}), 1000); // y se informa lo emitido con CAEA
      }
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

// --- Cola de emision (contingencia) ---
async function procesarCola() {
  const hechos = await require('./services/colaEmision').servicio().procesarPendientes();
  const emitidos = hechos.filter((h) => h && h.estado === 'emitido').length;
  if (emitidos) console.log(`[arcanum][cola] ${emitidos} comprobante(s) emitidos desde la cola`);
  return hechos;
}

// --- CAEA (solo CUIT con CAEA prendido) ---
async function caeaPedirYAvisar() {
  const caea = require('./services/caea').servicio();
  for (const cuit of await caea.activos()) {
    try { await caea.asegurar(cuit); } catch (e) { console.error(`[arcanum][caea] ${maskCuit(cuit)}: ${e.message}`); }
    try { await caea.avisos(cuit); } catch (e) { console.error(`[arcanum][caea] avisos ${maskCuit(cuit)}: ${e.message}`); }
  }
}

async function caeaInformar() {
  if (!lastArcaOk) return; // con ARCA caido no tiene sentido: se informa cuando vuelve
  const caea = require('./services/caea').servicio();
  for (const cuit of await caea.activos()) {
    try {
      const r = await caea.informarPendientes(cuit);
      await caea.informarSinMovimiento(cuit);
      if (r.informados) console.log(`[arcanum][caea] ${maskCuit(cuit)}: ${r.informados} comprobante(s) CAEA informados`);
    } catch (e) { console.error(`[arcanum][caea] informar ${maskCuit(cuit)}: ${e.message}`); }
  }
}

// --- Emitidos por fuera de Arcanum (diario) ---
async function sincronizarEmitidos(ahoraFecha = new Date()) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'sync_ultima_diaria'");
  if (!tocaDiaria(ahoraFecha, parseInt(process.env.ARCANUM_SYNC_HORA || '5', 10), rows[0] && rows[0].value)) return;
  const { hoy } = rangoDiario(ahoraFecha);
  await db.query(
    "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('sync_ultima_diaria',$1,'daemon',now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [hoy]);
  const sync = require('./services/syncEmitidos').servicio();
  for (const t of (await tenants.list(config.env)).filter((x) => x.tieneCertificado)) {
    try {
      const r = await sync.sincronizar(t.cuit);
      if (r.traidos) console.log(`[arcanum][sync] ${maskCuit(t.cuit)}: ${r.traidos} comprobante(s) emitidos por fuera de Arcanum`);
    } catch (e) { console.error(`[arcanum][sync] ${maskCuit(t.cuit)}: ${e.message}`); }
  }
}

// --- Mis Comprobantes diario ---
const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina: UTC-3 todo el ano
function fechaAr(ahora) { return new Date(ahora.getTime() - AR_OFFSET_MS); }

/** ¿Corresponde correr la diaria? Despues de `hora` (Argentina) y si hoy todavia no corrio. */
function tocaDiaria(ahora, hora, ultima) {
  const ar = fechaAr(ahora);
  const hoy = ar.toISOString().slice(0, 10);
  return ar.getUTCHours() >= hora && ultima !== hoy;
}

/** Mes anterior completo + mes en curso hasta hoy (Argentina). */
function rangoDiario(ahora) {
  const ar = fechaAr(ahora);
  const hoy = ar.toISOString().slice(0, 10);
  const desde = new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  return { desde, hasta: hoy, hoy };
}

async function sincronizarMisComprobantes(ahora = new Date()) {
  const hora = parseInt(process.env.ARCANUM_MC_HORA || '6', 10);
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'mc_ultima_diaria'");
  if (!tocaDiaria(ahora, hora, rows[0] && rows[0].value)) return;
  const { desde, hasta, hoy } = rangoDiario(ahora);
  await db.query(
    "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('mc_ultima_diaria',$1,'daemon',now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [hoy]);
  const mc = require('./services/misComprobantes').servicio();
  for (const cuit of await mc.conSincronizacion()) {
    try {
      const corrida = await mc.sincronizar(cuit, { tipo: 'ambos', desde, hasta, origen: 'diaria', usuario: 'daemon' });
      await mc.seguir(corrida.id); // de a un CUIT por vez: Fisherboy admite 2 sesiones
    } catch (e) {
      console.error(`[arcanum][mis-comprobantes] ${maskCuit(cuit)}: ${e.message}`);
    }
  }
  const { rows: conMc } = await db.query('SELECT DISTINCT cuit FROM mc_comprobantes');
  await require('./services/monotributo').revisarAvisos(conMc.map((r) => r.cuit)).catch((e) => console.error('[arcanum][monotributo]', e.message));
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
  // Cola de emision: cada minuto intenta lo que ya toca (espera creciente por item).
  every(60 * 1000, procesarCola);
  // CAEA: pedir/recuperar codigos y avisar topes cada 6 h; informar cada 15 min si ARCA responde.
  setTimeout(() => caeaPedirYAvisar().catch((e) => console.error('[arcanum][caea]', e.message)), 4 * 60 * 1000);
  every(6 * 60 * 60 * 1000, caeaPedirYAvisar);
  every(15 * 60 * 1000, caeaInformar);
  // Emitidos por fuera de Arcanum: una vez por dia (ARCANUM_SYNC_HORA, 5 hora argentina).
  every(10 * 60 * 1000, sincronizarEmitidos);
  // Mis Comprobantes: se fija cada 10 minutos si ya toca la corrida diaria.
  setTimeout(() => sincronizarMisComprobantes().catch((e) => console.error('[arcanum][mis-comprobantes]', e.message)), 3 * 60 * 1000);
  every(10 * 60 * 1000, sincronizarMisComprobantes);
  console.log(`[arcanum] daemons activos (monitor 5m, vencimientos 12h, e-Ventanilla ${ventanillaMin > 0 ? `${ventanillaMin}m` : 'apagado'}, Mis Comprobantes diario ${process.env.ARCANUM_MC_HORA || '6'} h)`);
}

function stop() {
  timers.forEach(clearInterval);
}

module.exports = { start, stop, monitor, renovarTokens, avisarVencimientos, revisarVentanilla, sincronizarMisComprobantes, procesarCola, caeaPedirYAvisar, caeaInformar, sincronizarEmitidos, tocaDiaria, rangoDiario };
