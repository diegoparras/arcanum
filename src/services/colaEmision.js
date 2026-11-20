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

/** El comprobante consultado en ARCA es ESTA venta: mismo total y mismo documento del receptor. */
function coincide(consultado, cuerpo) {
  if (!consultado) return false;
  const total = Math.abs(Number(consultado.importeTotal) - Number(cuerpo.importeTotal)) < 0.01;
  const doc = String(consultado.docNro || '0').replace(/\D/g, '') === String(cuerpo.nroDocReceptor ?? '0').replace(/\D/g, '');
  return total && doc;
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
      // 1. Corte ambiguo: ¿ese numero ya lo tiene ARCA con esta venta?
      if (item.numero_intentado) {
        let consultado = null;
        try {
          consultado = await wsfev1.consultar(cuit, cuerpo.puntoVenta, cuerpo.tipoComprobante, item.numero_intentado);
        } catch (e) {
          if (esIndisponibilidad(e)) throw e;
          consultado = null; // 404: ARCA no lo tiene, el numero no se consumio
        }
        if (coincide(consultado, cuerpo)) {
          await wsfev1.registrarAdoptado(cuit, consultado, cuerpo, item.idempotency_key);
          const resultado = { ...consultado, aprobado: true, adoptado: true, cuit };
          return terminar(item, { estado: 'emitido', resultado, ultimo_error: null }, 'comprobante_emitido', resultado);
        }
      }
      // 2. Ventana de fecha: nunca re-fechar solo.
      if (fueraDeVentana(cuerpo.fecha, item.concepto, ahora())) {
        const msg = `ARCA ya no acepta la fecha ${cuerpo.fecha} (${Number(item.concepto) === 1 ? '5' : '10'} dias como maximo). Decidi: emitir con fecha de hoy o cancelar.`;
        return terminar(item, { estado: 'requiere_humano', ultimo_error: msg }, 'cola_requiere_humano', { id: item.id, cuit, motivo: msg });
      }
      // 3. Emitir (la idempotencyKey evita duplicar si ya salio por otro camino).
      const out = await wsfev1.authorizeInvoice(cuit, cuerpo);
      return terminar(item, { estado: out.aprobado ? 'emitido' : 'rechazado', resultado: out, ultimo_error: null }, null);
    } catch (e) {
      if (esIndisponibilidad(e)) {
        // 4. ARCA sigue sin responder: CAEA, si el CUIT lo prendio y ya se espero lo suficiente.
        //    NUNCA si hubo un intento ambiguo con CAE: ese CAE pudo haberse otorgado y saldrian
        //    dos comprobantes para la misma venta.
        const ambiguo = !!(e.numeroIntentado || item.numero_intentado);
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
    await repo.actualizar(id, campos);
    return procesar(id);
  }

  async function cancelar(id) {
    const item = await repo.obtener(id);
    if (!item) throw err('No existe ese item de la cola', 404);
    if (!['pendiente', 'requiere_humano'].includes(item.estado)) throw err(`El item esta ${item.estado}: no se puede cancelar`, 409);
    return repo.actualizar(id, { estado: 'cancelado', actualizado_at: ahora() });
  }

  return {
    encolar, procesar, procesarPendientes, reintentar, cancelar,
    obtener: (id) => repo.obtener(id),
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
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [it.cuit, config.env, it.idempotency_key, json(it.cuerpo), it.fecha, it.concepto, it.numero_intentado, it.proximo_intento_at, it.creado_por, it.origen]);
      if (rows[0]) return rows[0];
      const ya = await db.query('SELECT * FROM emision_cola WHERE idempotency_key = $1', [it.idempotency_key]);
      return { ...ya.rows[0], avisado: true };
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

module.exports = { crear, servicio, ESPERAS_MIN, proximoIntento, fueraDeVentana, coincide, ymdAr };
