'use strict';

// Cola de emision (contingencia): cuando ARCA no responde, el comprobante queda en espera y sale
// solo cuando vuelve. Tres reglas que no se negocian:
//
//  1. Nunca dos CAE para la misma venta. Si el pedido llego a mandarse a ARCA (corte ambiguo),
//     antes de reintentar se consulta ese numero: si existe con el mismo importe y receptor, se
//     ADOPTA ese CAE. Ademas cada item tiene su idempotencyKey (la emision la respeta).
//  2. Nunca se re-fecha solo. La fecha se fija al encolar; si ARCA ya no la acepta (5 dias para
//     productos, 10 para servicios) el item pasa a "requiere_humano" y una persona decide.
//  3. Un rechazo de ARCA o un error del pedido es final: reintentar daria lo mismo.

const crypto = require('crypto');
const { esIndisponibilidad } = require('./contingencia');

const ESPERAS_MIN = [1, 2, 5, 10, 30, 60];
const AR_OFFSET_MS = 3 * 60 * 60 * 1000; // Argentina, UTC-3

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function ymdAr(fecha) {
  return new Date(fecha.getTime() - AR_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

function ymdDe(v) {
  const s = String(v || '');
  if (/^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

function proximoIntento(intentos, ahora) {
  const min = ESPERAS_MIN[Math.min(Math.max(intentos, 1), ESPERAS_MIN.length) - 1];
  return new Date(ahora.getTime() + min * 60000);
}

/** ¿ARCA ya no acepta esta fecha? 5 dias atras para productos (concepto 1), 10 para servicios. */
function fueraDeVentana(fechaYmd, concepto, hoy) {
  const f = ymdDe(fechaYmd);
  if (!f) return false;
  const d = Date.UTC(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8));
  const h = ymdAr(hoy);
  const dh = Date.UTC(+h.slice(0, 4), +h.slice(4, 6) - 1, +h.slice(6, 8));
  const dias = Math.round((dh - d) / 86400000);
  return dias > (Number(concepto) === 1 ? 5 : 10);
}

function crear({ repo, wsfev1, webhooks, ahora = () => new Date(), caea = null } = {}) {
  async function encolar(cuit, inv, { numeroIntentado = null, usuario = null, origen = 'api' } = {}) {
    const cuerpo = { ...inv, cuit };
    cuerpo.fecha = ymdDe(inv.fecha) || ymdAr(ahora());
    cuerpo.idempotencyKey = inv.idempotencyKey || `cola-${crypto.randomBytes(10).toString('hex')}`;
    const item = await repo.insertar({
      cuit,
      idempotency_key: cuerpo.idempotencyKey,
      cuerpo,
      fecha: cuerpo.fecha,
      concepto: parseInt(inv.concepto ?? 1, 10),
      numero_intentado: numeroIntentado,
      proximo_intento_at: proximoIntento(1, ahora()),
      creado_por: usuario,
      origen,
    });
    if (item.estado === 'pendiente' && !item.avisado) {
      await webhooks.emitir('comprobante_encolado', { id: item.id, cuit, idempotencyKey: item.idempotency_key, importeTotal: cuerpo.importeTotal }).catch(() => {});
    }
    return item;
  }

  async function terminar(item, campos, evento, payload) {
    const fin = await repo.actualizar(item.id, { ...campos, actualizado_at: ahora() });
    if (evento) await webhooks.emitir(evento, payload).catch(() => {});
    return fin;
  }

  async function procesar(id) {
    const item = await repo.tomar(id);
    if (!item) return repo.obtener(id);
    const { cuit } = item;
    const cuerpo = item.cuerpo;
    try {
      // 1. Ventana de fecha: nunca re-fechar solo. (Si hubo un intento ambiguo, primero se deja
      //    que la emision resuelva ese vuelo: puede que el CAE ya exista con la fecha original.)
      if (!item.numero_intentado && fueraDeVentana(cuerpo.fecha, item.concepto, ahora())) {
        const msg = `ARCA ya no acepta la fecha ${cuerpo.fecha} (${Number(item.concepto) === 1 ? '5' : '10'} dias como maximo). Decidi: emitir con fecha de hoy o cancelar.`;
        return terminar(item, { estado: 'requiere_humano', ultimo_error: msg }, 'cola_requiere_humano', { id: item.id, cuit, motivo: msg });
      }
      // 2. Emitir. La emision resuelve primero cualquier intento anterior con esta clave
      //    (services/vuelo.js): si ARCA ya lo otorgo, lo adopta en vez de sacar otro CAE.
      const out = await wsfev1.authorizeInvoice(cuit, cuerpo);
      if (!out.aprobado && item.numero_intentado) {
        const msg = 'ARCA rechazo el reintento de un comprobante cuyo primer intento quedo en duda: revisa en ARCA si ya tiene CAE antes de volver a emitirlo.';
        return terminar(item, { estado: 'requiere_humano', resultado: out, ultimo_error: msg }, 'cola_requiere_humano', { id: item.id, cuit, motivo: msg });
      }
      return terminar(item, { estado: out.aprobado ? 'emitido' : 'rechazado', resultado: out, ultimo_error: null }, null);
    } catch (e) {
      if (esIndisponibilidad(e)) {
        // 3. ARCA sigue sin responder: CAEA, si el CUIT lo prendio y ya se espero lo suficiente.
        //    NUNCA si hubo un intento ambiguo con CAE (o una emision en vuelo sin resolver): ese
        //    CAE pudo haberse otorgado y saldrian dos comprobantes para la misma venta.
        const enVuelo = wsfev1.hayVuelo ? await wsfev1.hayVuelo(item.idempotency_key).catch(() => true) : false;
        const ambiguo = !!(e.numeroIntentado || item.numero_intentado || enVuelo);
        if (caea && !ambiguo && (await caea.corresponde(item, ahora()))) {
          const out = await caea.emitirConCaea(cuit, item);
          return terminar(item, { estado: 'emitido', modo: 'CAEA', resultado: out, ultimo_error: null }, null);
        }
        const intentos = (item.intentos || 0) + 1;
        return repo.actualizar(item.id, {
          estado: 'pendiente',
          intentos,
          proximo_intento_at: proximoIntento(intentos, ahora()),
          numero_intentado: e.numeroIntentado || item.numero_intentado,
          ultimo_error: String(e.message || e).slice(0, 300),
          actualizado_at: ahora(),
        });
      }
      const final = e.httpStatus === 400 || e.httpStatus === 422;
      const msg = String(e.message || e).slice(0, 300);
      return terminar(item, { estado: final ? 'rechazado' : 'requiere_humano', ultimo_error: msg },
        final ? null : 'cola_requiere_humano', { id: item.id, cuit, motivo: msg });
    }
  }

  async function procesarPendientes() {
    const ids = await repo.pendientesListos(ahora());
    const hechos = [];
    for (const id of ids) hechos.push(await procesar(id));
    return hechos;
  }

  async function reintentar(id, { fechaHoy = false } = {}) {
    const item = await repo.obtener(id);
    if (!item) throw err('No existe ese item de la cola', 404);
    if (!['pendiente', 'requiere_humano'].includes(item.estado)) throw err(`El item esta ${item.estado}: no se puede reintentar`, 409);
    const campos = { estado: 'pendiente', proximo_intento_at: ahora(), actualizado_at: ahora() };
    if (fechaHoy) {
      const hoy = ymdAr(ahora());
      campos.cuerpo = { ...item.cuerpo, fecha: hoy };
      campos.fecha = hoy;
    }
    // Condicional: si el daemon lo tomo entre la lectura y aca, no se pisa (seria procesarlo dos veces).
    if (!(await repo.reabrir(id, campos))) throw err('El item cambio de estado mientras tanto (lo esta procesando la cola): volve a mirarlo', 409);
    return procesar(id);
  }

  async function cancelar(id) {
    const item = await repo.obtener(id);
    if (!item) throw err('No existe ese item de la cola', 404);
    if (!['pendiente', 'requiere_humano'].includes(item.estado)) throw err(`El item esta ${item.estado}: no se puede cancelar`, 409);
    const fin = await repo.reabrir(id, { estado: 'cancelado', actualizado_at: ahora() });
    if (!fin) throw err('El item cambio de estado mientras tanto (lo esta procesando la cola): volve a mirarlo', 409);
    return fin;
  }

  return {
    encolar, procesar, procesarPendientes, reintentar, cancelar,
    obtener: (id) => repo.obtener(id),
    porClave: (k) => (repo.porClave ? repo.porClave(k) : null),
    listar: (f) => repo.listar(f || {}),
    reencolarProcesando: () => repo.reencolarProcesando(),
  };
}

// --- repo en Postgres ------------------------------------------------------------
function repoSql() {
  const db = require('../db');
  const { config } = require('../config');
  const json = (v) => (v === undefined ? undefined : JSON.stringify(v));
  return {
    async insertar(it) {
      const { rows } = await db.query(
        `INSERT INTO emision_cola (cuit, entorno, idempotency_key, cuerpo, fecha, concepto, estado, numero_intentado, proximo_intento_at, creado_por, origen)
         VALUES ($1,$2,$3,$4,to_date($5,'YYYYMMDD'),$6,'pendiente',$7,$8,$9,$10)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           numero_intentado = COALESCE(EXCLUDED.numero_intentado, emision_cola.numero_intentado)
         RETURNING *, (xmax = 0) AS insertado`,
        [it.cuit, config.env, it.idempotency_key, json(it.cuerpo), it.fecha, it.concepto, it.numero_intentado, it.proximo_intento_at, it.creado_por, it.origen]);
      const { insertado, ...fila } = rows[0];
      return insertado ? fila : { ...fila, avisado: true };
    },
    // Cambio condicional: solo si sigue abierto (pendiente o requiere_humano). null si no.
    async reabrir(id, campos) {
      const cols = Object.keys(campos);
      const set = cols.map((c, i) => `${c} = ${c === 'fecha' ? `to_date($${i + 2},'YYYYMMDD')` : `$${i + 2}`}`).join(', ');
      const vals = cols.map((c) => (['cuerpo', 'resultado'].includes(c) ? json(campos[c]) : campos[c]));
      const { rows } = await db.query(
        `UPDATE emision_cola SET ${set} WHERE id = $1 AND estado IN ('pendiente', 'requiere_humano') RETURNING *`, [id, ...vals]);
      return rows[0] || null;
    },
    async porClave(k) {
      const { rows } = await db.query('SELECT * FROM emision_cola WHERE idempotency_key = $1', [k]);
      return rows[0] || null;
    },
    async obtener(id) {
      const { rows } = await db.query('SELECT * FROM emision_cola WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async tomar(id) {
      const { rows } = await db.query(
        "UPDATE emision_cola SET estado = 'procesando', actualizado_at = now() WHERE id = $1 AND estado = 'pendiente' RETURNING *", [id]);
      return rows[0] || null;
    },
    async actualizar(id, campos) {
      const cols = Object.keys(campos);
      const set = cols.map((c, i) => `${c} = ${c === 'fecha' ? `to_date($${i + 2},'YYYYMMDD')` : `$${i + 2}`}`).join(', ');
      const vals = cols.map((c) => (['cuerpo', 'resultado'].includes(c) ? json(campos[c]) : campos[c]));
      const { rows } = await db.query(`UPDATE emision_cola SET ${set} WHERE id = $1 RETURNING *`, [id, ...vals]);
      return rows[0];
    },
    async pendientesListos(ahora) {
      const { rows } = await db.query(
        "SELECT id FROM emision_cola WHERE estado = 'pendiente' AND entorno = $1 AND proximo_intento_at <= $2 ORDER BY id LIMIT 100", [config.env, ahora]);
      return rows.map((r) => r.id);
    },
    async reencolarProcesando() {
      const { rowCount } = await db.query("UPDATE emision_cola SET estado = 'pendiente', proximo_intento_at = now() WHERE estado = 'procesando'");
      return rowCount;
    },
    async listar({ cuit, estado, limite = 200 } = {}) {
      const cond = ['entorno = $1'];
      const vals = [config.env];
      if (cuit) { vals.push(cuit); cond.push(`cuit = $${vals.length}`); }
      if (estado) { vals.push(estado); cond.push(`estado = $${vals.length}`); }
      vals.push(Math.min(Number(limite) || 200, 1000));
      const { rows } = await db.query(`SELECT * FROM emision_cola WHERE ${cond.join(' AND ')} ORDER BY id DESC LIMIT $${vals.length}`, vals);
      return rows;
    },
  };
}

let porDefecto = null;
function servicio() {
  if (!porDefecto) {
    let caeaSvc = null;
    try { caeaSvc = require('./caea').servicio(); } catch { caeaSvc = null; }
    porDefecto = crear({ repo: repoSql(), wsfev1: require('./wsfev1'), webhooks: require('./webhooks'), caea: caeaSvc });
  }
  return porDefecto;
}

module.exports = { crear, servicio, ESPERAS_MIN, proximoIntento, fueraDeVentana, ymdAr };
