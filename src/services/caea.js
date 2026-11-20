'use strict';

// CAEA (Codigo de Autorizacion Electronico Anticipado): OPCIONAL y por CUIT (apagado por defecto).
//
// Si esta prendido, Arcanum:
//   1. pide (o recupera) el CAEA de la quincena en curso y de la proxima (FECAEASolicitar /
//      FECAEAConsultar). "Todavia no se puede pedir" no es un error: se reintenta otro dia.
//   2. cuando ARCA no responde y un comprobante lleva mas de `minutos_espera` en la cola, lo
//      emite con CAEA, en el punto de venta CAEA del CUIT, numerado localmente.
//   3. cuando ARCA vuelve, informa cada comprobante CAEA (FECAEARegInformativo) y, vencida la
//      vigencia, informa "sin movimiento" los CAEA que no se usaron.
//   4. avisa (caea_informe_pendiente) a 2 dias de la fecha tope si falta informar algo.
//
// Pedir un CAEA obliga a informar: por eso esto solo corre para los CUIT que lo prendieron.

const { esIndisponibilidad } = require('./contingencia');

const AR_OFFSET_MS = 3 * 60 * 60 * 1000;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function enAr(fecha) {
  return new Date(fecha.getTime() - AR_OFFSET_MS);
}

function ymd(fecha) {
  return enAr(fecha).toISOString().slice(0, 10).replace(/-/g, '');
}

function ymdhms(fecha) {
  return enAr(fecha).toISOString().slice(0, 19).replace(/[-T:]/g, '');
}

/** Quincena de una fecha (hora argentina): { periodo: AAAAMM, orden: 1 (dias 1-15) | 2 }. */
function quincena(fecha) {
  const d = enAr(fecha);
  return { periodo: d.getUTCFullYear() * 100 + d.getUTCMonth() + 1, orden: d.getUTCDate() <= 15 ? 1 : 2 };
}

function siguiente({ periodo, orden }) {
  if (orden === 1) return { periodo, orden: 2 };
  const anio = Math.floor(periodo / 100);
  const mes = periodo % 100;
  return mes === 12 ? { periodo: (anio + 1) * 100 + 1, orden: 1 } : { periodo: periodo + 1, orden: 1 };
}

function quincenasAPedir(hoy) {
  const actual = quincena(hoy);
  return [actual, siguiente(actual)];
}

function diasEntre(desdeYmd, hastaYmd) {
  const f = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((f(hastaYmd) - f(desdeYmd)) / 86400000);
}

function crear({ repo, wsfev1, webhooks, ahora = () => new Date() } = {}) {
  async function configActiva(cuit) {
    const c = await repo.config(cuit);
    return c && c.activo ? c : null;
  }

  async function asegurar(cuit) {
    const cfg = await configActiva(cuit);
    if (!cfg) return [];
    const out = [];
    for (const q of quincenasAPedir(ahora())) {
      if (await repo.caea(cuit, q.periodo, q.orden)) { out.push({ ...q, estado: 'ya_estaba' }); continue; }
      let g = await wsfev1.caeaConsultar(cuit, q.periodo, q.orden);
      if (!g) {
        try {
          g = await wsfev1.caeaSolicitar(cuit, q.periodo, q.orden);
        } catch (e) {
          if (esIndisponibilidad(e)) throw e;
          out.push({ ...q, estado: 'todavia_no', motivo: String(e.message || e).slice(0, 200) });
          continue;
        }
      }
      const guardado = await repo.guardarCaea(cuit, {
        periodo: q.periodo, orden: q.orden, caea: g.caea || g.CAEA,
        vig_desde: g.vigDesde || g.FchVigDesde, vig_hasta: g.vigHasta || g.FchVigHasta, tope_inf: g.topeInf || g.FchTopeInf,
      });
      await webhooks.emitir('caea_obtenido', { cuit, periodo: q.periodo, orden: q.orden, caea: guardado.caea, topeInforme: guardado.tope_inf }).catch(() => {});
      out.push({ ...q, estado: 'obtenido', caea: guardado.caea });
    }
    return out;
  }

  /** ¿Este item de la cola se emite con CAEA? CUIT con CAEA prendido, espera cumplida y CAEA vigente. */
  async function corresponde(item, momento = ahora()) {
    const cfg = await configActiva(item.cuit);
    if (!cfg) return false;
    const creado = new Date(item.creado_at || momento);
    if ((momento.getTime() - creado.getTime()) / 60000 < Number(cfg.minutos_espera ?? 30)) return false;
    return !!(await repo.vigente(item.cuit, item.cuerpo.fecha || ymd(momento)));
  }

  async function emitirConCaea(cuit, item) {
    const cfg = await configActiva(cuit);
    if (!cfg) throw err('Este CUIT no tiene CAEA prendido', 409);
    const cuerpo = { ...item.cuerpo, puntoVenta: Number(cfg.punto_venta) };
    const fecha = cuerpo.fecha || ymd(ahora());
    const vig = await repo.vigente(cuit, fecha);
    if (!vig) throw err(`No hay un CAEA vigente para el ${fecha}: no se puede emitir en contingencia`, 409);
    const tipo = Number(cuerpo.tipoComprobante);
    const pv = Number(cfg.punto_venta);
    return repo.conLock(`emit:caea:${cuit}:${pv}:${tipo}`, async () => {
      let ultimoArca = 0;
      try { ultimoArca = Number((await wsfev1.lastAuthorized(cuit, pv, tipo)).ultimoNumero) || 0; } catch { ultimoArca = 0; }
      const numero = Math.max(Number(await repo.maxNumero(cuit, pv, tipo)) || 0, ultimoArca) + 1;
      const out = {
        ...cuerpo,
        aprobado: true, resultado: 'A', modo: 'CAEA', informado: false,
        cae: vig.caea, caea: vig.caea, caeVencimiento: vig.vig_hasta, fchHsGen: ymdhms(ahora()),
        puntoVenta: pv, tipoComprobante: tipo, numero, fecha, cuit,
        importeTotal: Number(cuerpo.importeTotal || 0),
        docTipo: parseInt(cuerpo.tipoDocReceptor ?? 99, 10),
        docNro: String(cuerpo.nroDocReceptor ?? 0).replace(/\D/g, '') || '0',
      };
      await repo.persistir(cuit, out, item.idempotency_key);
      await webhooks.emitir('comprobante_emitido', out).catch(() => {});
      return out;
    });
  }

  async function informarPendientes(cuit) {
    let informados = 0;
    let errores = 0;
    for (const row of await repo.pendientesInformar(cuit)) {
      const raw = row.raw || {};
      const inv = { ...raw, puntoVenta: row.punto_venta, tipoComprobante: row.tipo_cbte };
      try {
        const r = await wsfev1.caeaInformar(cuit, inv, { caea: raw.caea, numero: row.numero, cbteFecha: raw.fecha, fchHsGen: raw.fchHsGen });
        if (r.resultado === 'A') {
          await repo.marcarInformado(row.id, r);
          informados += 1;
        } else {
          const msg = (r.observaciones || r.errores || []).map((o) => `${o.code}: ${o.message}`).join('; ') || `Resultado ${r.resultado}`;
          await repo.marcarErrorInforme(row.id, msg);
          await webhooks.emitir('caea_informe_error', { cuit, comprobante: row.numero, puntoVenta: row.punto_venta, motivo: msg }).catch(() => {});
          errores += 1;
        }
      } catch (e) {
        if (esIndisponibilidad(e)) break; // ARCA otra vez caido: se sigue en la proxima vuelta
        await repo.marcarErrorInforme(row.id, String(e.message || e).slice(0, 300));
        errores += 1;
      }
    }
    return { informados, errores };
  }

  async function informarSinMovimiento(cuit) {
    const cfg = await configActiva(cuit);
    if (!cfg) return [];
    const hoy = ymd(ahora());
    const hechos = [];
    for (const c of await repo.caeas(cuit)) {
      if (!(c.vig_hasta < hoy)) continue;
      if ((await repo.cantidadConCaea(c.caea)) > 0) continue;
      if (await repo.sinMovHecho(c.id, cfg.punto_venta)) continue;
      const r = await wsfev1.caeaSinMovimiento(cuit, cfg.punto_venta, c.caea);
      await repo.guardarSinMov(c.id, cfg.punto_venta, r);
      hechos.push({ caea: c.caea, puntoVenta: cfg.punto_venta, resultado: r.resultado });
    }
    return hechos;
  }

  async function avisos(cuit) {
    const cfg = await configActiva(cuit);
    if (!cfg) return 0;
    const hoy = ymd(ahora());
    const pendientes = await repo.pendientesInformar(cuit);
    let n = 0;
    for (const c of await repo.caeas(cuit)) {
      const dias = diasEntre(hoy, c.tope_inf);
      if (dias > 2 || dias < 0) continue;
      const sinInformar = pendientes.filter((p) => (p.raw || {}).caea === c.caea).length;
      const faltaSinMov = c.vig_hasta < hoy && (await repo.cantidadConCaea(c.caea)) === 0 && !(await repo.sinMovHecho(c.id, cfg.punto_venta));
      if (!sinInformar && !faltaSinMov) continue;
      const k = `caea_aviso:${cuit}:${c.caea}`;
      if (await repo.avisoHecho(k)) continue;
      await webhooks.emitir('caea_informe_pendiente', { cuit, caea: c.caea, topeInforme: c.tope_inf, comprobantesSinInformar: sinInformar, faltaSinMovimiento: faltaSinMov }).catch(() => {});
      await repo.marcarAviso(k);
      n += 1;
    }
    return n;
  }

  return {
    asegurar, corresponde, emitirConCaea, informarPendientes, informarSinMovimiento, avisos,
    config: (cuit) => repo.config(cuit),
    guardarConfig: (cuit, c, usuario) => repo.guardarConfig(cuit, c, usuario),
    estado: async (cuit) => ({ config: await repo.config(cuit), caeas: await repo.caeas(cuit), pendientes: (await repo.pendientesInformar(cuit)).length }),
    activos: () => repo.activos(),
  };
}

// --- repo en Postgres ------------------------------------------------------------
function repoSql() {
  const db = require('../db');
  const { config } = require('../config');
  return {
    async config(cuit) {
      const { rows } = await db.query('SELECT * FROM caea_config WHERE cuit = $1', [cuit]);
      return rows[0] || null;
    },
    async guardarConfig(cuit, { activo, puntoVenta, minutosEspera }, usuario) {
      const { rows } = await db.query(
        `INSERT INTO caea_config (cuit, activo, punto_venta, minutos_espera, actualizado_at, actualizado_por)
         VALUES ($1,$2,$3,$4,now(),$5)
         ON CONFLICT (cuit) DO UPDATE SET activo = $2, punto_venta = $3, minutos_espera = $4, actualizado_at = now(), actualizado_por = $5
         RETURNING *`, [cuit, !!activo, puntoVenta, minutosEspera, usuario || null]);
      return rows[0];
    },
    async activos() {
      const { rows } = await db.query('SELECT cuit FROM caea_config WHERE activo = true ORDER BY cuit');
      return rows.map((r) => r.cuit);
    },
    async caeas(cuit) {
      const { rows } = await db.query('SELECT * FROM caea WHERE cuit = $1 AND entorno = $2 ORDER BY periodo DESC, orden DESC', [cuit, config.env]);
      return rows;
    },
    async caea(cuit, periodo, orden) {
      const { rows } = await db.query('SELECT * FROM caea WHERE cuit = $1 AND entorno = $2 AND periodo = $3 AND orden = $4', [cuit, config.env, periodo, orden]);
      return rows[0] || null;
    },
    async guardarCaea(cuit, g) {
      const { rows } = await db.query(
        `INSERT INTO caea (cuit, entorno, periodo, orden, caea, vig_desde, vig_hasta, tope_inf)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (cuit, entorno, periodo, orden) DO UPDATE SET caea = EXCLUDED.caea RETURNING *`,
        [cuit, config.env, g.periodo, g.orden, g.caea, g.vig_desde, g.vig_hasta, g.tope_inf]);
      return rows[0];
    },
    async vigente(cuit, fechaYmd) {
      const { rows } = await db.query(
        'SELECT * FROM caea WHERE cuit = $1 AND entorno = $2 AND vig_desde <= $3 AND vig_hasta >= $3 ORDER BY periodo DESC LIMIT 1',
        [cuit, config.env, fechaYmd]);
      return rows[0] || null;
    },
    async maxNumero(cuit, pv, tipo) {
      const { rows } = await db.query(
        'SELECT COALESCE(MAX(numero), 0) AS n FROM comprobantes WHERE cuit = $1 AND entorno = $2 AND punto_venta = $3 AND tipo_cbte = $4',
        [cuit, config.env, pv, tipo]);
      return Number(rows[0].n);
    },
    conLock: (k, fn) => db.withLock(k, fn),
    async persistir(cuit, out, idem) {
      await db.query(
        `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
           importe_total, doc_tipo, doc_nro, idempotency_key, raw)
         VALUES ($1,$2,$3,$4,$5,$6, to_date($7,'YYYYMMDD'),'A', to_date($8,'YYYYMMDD'),$9,$10,$11,$12,$13)`,
        [cuit, config.env, out.puntoVenta, out.tipoComprobante, out.numero, out.caea, out.caeVencimiento, out.fecha,
          out.importeTotal, out.docTipo, out.docNro, idem || null, JSON.stringify(out)]);
    },
    async pendientesInformar(cuit) {
      const { rows } = await db.query(
        "SELECT * FROM comprobantes WHERE cuit = $1 AND entorno = $2 AND raw->>'modo' = 'CAEA' AND COALESCE(raw->>'informado','false') = 'false' ORDER BY numero",
        [cuit, config.env]);
      return rows;
    },
    async marcarInformado(id, r) {
      await db.query("UPDATE comprobantes SET raw = raw || jsonb_build_object('informado', true, 'informe', $2::jsonb, 'informeError', null) WHERE id = $1", [id, JSON.stringify(r)]);
    },
    async marcarErrorInforme(id, msg) {
      await db.query("UPDATE comprobantes SET raw = raw || jsonb_build_object('informeError', $2::text) WHERE id = $1", [id, msg]);
    },
    async cantidadConCaea(cod) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM comprobantes WHERE raw->>'caea' = $1", [cod]);
      return rows[0].n;
    },
    async sinMovHecho(caeaId, pv) {
      const { rows } = await db.query('SELECT 1 FROM caea_sin_mov WHERE caea_id = $1 AND punto_venta = $2', [caeaId, pv]);
      return rows.length > 0;
    },
    async guardarSinMov(caeaId, pv, r) {
      await db.query(
        'INSERT INTO caea_sin_mov (caea_id, punto_venta, informado_at, resultado) VALUES ($1,$2,now(),$3) ON CONFLICT DO NOTHING',
        [caeaId, pv, JSON.stringify(r)]);
    },
    async avisoHecho(k) {
      const { rows } = await db.query('SELECT 1 FROM settings WHERE key = $1', [k]);
      return rows.length > 0;
    },
    async marcarAviso(k) {
      await db.query("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, now()::text, 'daemon', now()) ON CONFLICT (key) DO NOTHING", [k]);
    },
  };
}

let porDefecto = null;
function servicio() {
  if (!porDefecto) porDefecto = crear({ repo: repoSql(), wsfev1: require('./wsfev1'), webhooks: require('./webhooks') });
  return porDefecto;
}

module.exports = { crear, servicio, quincena, quincenasAPedir, ymd, ymdhms };
