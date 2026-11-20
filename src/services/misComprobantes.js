'use strict';

// Mis Comprobantes (emitidos y recibidos) bajados de la pagina de ARCA con la sesion de agente
// de Fisherboy: no hay Web Service oficial para esto.
//
// Flujo de una corrida:
//   sincronizar() valida y crea la fila (una corrida viva por CUIT) -> seguir() en segundo plano:
//   por cada tipo (emitidos/recibidos) y tramo de fechas abre una sesion de Fisherboy con la
//   receta, sondea el estado (mirable en vivo desde la UI), baja el CSV, lo parsea y hace upsert.
//
// La clave fiscal vive cifrada con el vault. Se descifra solo para armar `secretos` del pedido
// a Fisherboy y nunca se registra, ni se devuelve por la API.

const { RECETA_DEFAULT, DOMINIOS } = require('./misComprobantes.receta');
const { desdeArchivo } = require('./mcParser');

const ESTADOS_VIVOS = ['iniciando', 'corriendo', 'esperando_humano', 'humano'];
const TIPOS = { emitidos: 'emitido', recibidos: 'recibido' };
const BOTON = { emitido: 'Emitidos', recibido: 'Recibidos' };
const TIMEOUT_SESION_MS = 25 * 60 * 1000;
const TRAMO_DIAS = Number(process.env.ARCANUM_MC_TRAMO_DIAS) || 365;

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

function cuitDe(c) {
  const s = String(c || '').replace(/\D/g, '');
  if (s.length !== 11) throw err('CUIT invalido (11 digitos)', 400);
  return s;
}

function iso(d) { return d.toISOString().slice(0, 10); }
function dia(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) throw err(`Fecha invalida: ${s} (use AAAA-MM-DD)`, 400);
  return new Date(`${s}T00:00:00Z`);
}
function ddmmaaaa(s) { const [a, m, d] = s.split('-'); return `${d}/${m}/${a}`; }

/** Parte [desde, hasta] en tramos de a lo sumo `maxDias` dias (ARCA limita el rango). */
function tramos(desde, hasta, maxDias = TRAMO_DIAS) {
  const ini = dia(desde);
  const fin = dia(hasta);
  if (ini > fin) throw err('El "desde" es posterior al "hasta"', 400);
  const out = [];
  let a = ini;
  while (a <= fin) {
    const b = new Date(Math.min(fin.getTime(), a.getTime() + (maxDias - 1) * 86400000));
    out.push({ desde: iso(a), hasta: iso(b) });
    a = new Date(b.getTime() + 86400000);
  }
  return out;
}

// --- repo en Postgres (los tests le pasan un doble) -------------------------------
function repoSql() {
  const db = require('../db');
  return {
    async credencial(cuit) {
      const { rows } = await db.query('SELECT * FROM mc_credenciales WHERE cuit = $1', [cuit]);
      return rows[0] || null;
    },
    async guardarCredencial(cuit, { cuitLogin, claveCifrada, sincronizar, usuario }) {
      await db.query(
        `INSERT INTO mc_credenciales (cuit, cuit_login, clave_cifrada, sincronizar, actualizada_at, actualizada_por)
         VALUES ($1, $2, $3, COALESCE($4, false), now(), $5)
         ON CONFLICT (cuit) DO UPDATE SET cuit_login = $2,
           clave_cifrada = COALESCE($3, mc_credenciales.clave_cifrada),
           sincronizar = COALESCE($4, mc_credenciales.sincronizar),
           rechazada_at = CASE WHEN $3 IS NULL THEN mc_credenciales.rechazada_at ELSE NULL END,
           rechazo_motivo = CASE WHEN $3 IS NULL THEN mc_credenciales.rechazo_motivo ELSE NULL END,
           actualizada_at = now(), actualizada_por = $5`,
        [cuit, cuitLogin, claveCifrada, sincronizar, usuario || null],
      );
    },
    async marcarRechazada(cuit, motivo) {
      await db.query('UPDATE mc_credenciales SET rechazada_at = now(), rechazo_motivo = $2 WHERE cuit = $1', [cuit, String(motivo || '').slice(0, 300)]);
    },
    async borrarCredencial(cuit) {
      await db.query('DELETE FROM mc_credenciales WHERE cuit = $1', [cuit]);
    },
    async conSincronizacion() {
      const { rows } = await db.query('SELECT cuit FROM mc_credenciales WHERE sincronizar = true AND rechazada_at IS NULL ORDER BY cuit');
      return rows.map((r) => r.cuit);
    },
    async corridaViva(cuit) {
      const { rows } = await db.query(
        `SELECT * FROM mc_corridas WHERE cuit = $1 AND estado = ANY($2)
           AND iniciada_at > now() - interval '40 minutes' ORDER BY id DESC LIMIT 1`, [cuit, ESTADOS_VIVOS]);
      return rows[0] || null;
    },
    async corrida(id) {
      const { rows } = await db.query('SELECT * FROM mc_corridas WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async crearCorrida(d) {
      const { rows } = await db.query(
        `INSERT INTO mc_corridas (cuit, tipo, desde, hasta, estado, origen, usuario)
         VALUES ($1,$2,$3,$4,'iniciando',$5,$6) RETURNING *`,
        [d.cuit, d.tipo, d.desde, d.hasta, d.origen, d.usuario || null]);
      return rows[0];
    },
    async actualizarCorrida(id, campos) {
      const cols = Object.keys(campos);
      if (!cols.length) return null;
      const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const vals = cols.map((c) => (c === 'log' ? JSON.stringify(campos[c]) : campos[c]));
      const { rows } = await db.query(`UPDATE mc_corridas SET ${set} WHERE id = $1 RETURNING *`, [id, ...vals]);
      return rows[0];
    },
    async guardarComprobantes(cuit, tipo, corridaId, filas) {
      let n = 0;
      for (const f of filas) {
        await db.query(
          `INSERT INTO mc_comprobantes (cuit, tipo, fecha, cbte_tipo, punto_venta, numero_desde, numero_hasta, cae,
             doc_tipo, doc_nro, contraparte, moneda, tipo_cambio, neto_gravado, no_gravado, exento, iva, total,
             corrida_id, actualizado_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
           ON CONFLICT (cuit, tipo, cbte_tipo, punto_venta, numero_desde, doc_nro) DO UPDATE SET
             fecha = EXCLUDED.fecha, numero_hasta = EXCLUDED.numero_hasta, cae = EXCLUDED.cae,
             doc_tipo = EXCLUDED.doc_tipo, contraparte = EXCLUDED.contraparte, moneda = EXCLUDED.moneda,
             tipo_cambio = EXCLUDED.tipo_cambio, neto_gravado = EXCLUDED.neto_gravado,
             no_gravado = EXCLUDED.no_gravado, exento = EXCLUDED.exento, iva = EXCLUDED.iva,
             total = EXCLUDED.total, corrida_id = EXCLUDED.corrida_id, actualizado_at = now()`,
          [cuit, tipo, f.fecha, f.cbteTipo, f.puntoVenta || 0, f.numeroDesde, f.numeroHasta, f.cae, f.docTipo,
            f.docNro || '', f.contraparte, f.moneda, f.tipoCambio, f.netoGravado, f.noGravado, f.exento, f.iva,
            f.total, corridaId]);
        n += 1;
      }
      return n;
    },
    async receta() {
      const { rows } = await db.query("SELECT value FROM settings WHERE key = 'mc_receta'");
      return rows[0] && rows[0].value ? JSON.parse(rows[0].value) : null;
    },
    async guardarReceta(receta, usuario) {
      await db.query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('mc_receta',$1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()",
        [JSON.stringify(receta), usuario || null]);
    },
    async borrarReceta() {
      await db.query("DELETE FROM settings WHERE key = 'mc_receta'");
    },
    async listar(cuit, { tipo, desde, hasta, limite = 500 } = {}) {
      const cond = ['cuit = $1'];
      const vals = [cuit];
      if (tipo) { vals.push(tipo); cond.push(`tipo = $${vals.length}`); }
      if (desde) { vals.push(desde); cond.push(`fecha >= $${vals.length}`); }
      if (hasta) { vals.push(hasta); cond.push(`fecha <= $${vals.length}`); }
      vals.push(Math.min(Number(limite) || 500, 5000));
      const { rows } = await db.query(
        `SELECT * FROM mc_comprobantes WHERE ${cond.join(' AND ')} ORDER BY fecha DESC, id DESC LIMIT $${vals.length}`, vals);
      return rows;
    },
    async corridas(cuit, limite = 20) {
      const { rows } = await db.query(
        `SELECT id, cuit, tipo, desde, hasta, estado, origen, usuario, iniciada_at, terminada_at, cantidad, error
           FROM mc_corridas WHERE cuit = $1 ORDER BY id DESC LIMIT $2`, [cuit, Math.min(Number(limite) || 20, 200)]);
      return rows;
    },
  };
}

/** ARCA no acepto la clave: fallo el paso marcado verifica_login, o el aviso de la pagina lo dice. */
function loginRechazado(st) {
  if ((st.log || []).some((l) => l && l.verifica_login && l.ok === false)) return true;
  return /clave|contrase|usuario/i.test(String(st.alerta || ''));
}

// --- el servicio --------------------------------------------------------------
function crear({ repo, fisherboy, vault, webhooks, esperaMs = 2000, ahora = () => new Date() } = {}) {
  const lanzados = new Set();

  async function receta() {
    return (await repo.receta()) || RECETA_DEFAULT;
  }

  async function guardarReceta(r, usuario) {
    const http = process.env.ARCANUM_MC_RECETA_HTTP === '1'; // SOLO pruebas locales (maqueta)
    if (!r || typeof r.url !== 'string' || !(http ? /^https?:\/\//.test(r.url) : /^https:\/\//.test(r.url)) || !Array.isArray(r.pasos) || !r.pasos.length) {
      throw err('La receta necesita `url` (https) y una lista `pasos`', 400);
    }
    if (r.pasos.length > 60 || r.pasos.some((p) => !p || typeof p.do !== 'string')) {
      throw err('Cada paso es un objeto con `do` (tope 60 pasos)', 400);
    }
    if (JSON.stringify(r).length > 64 * 1024) throw err('La receta es demasiado grande', 413);
    await repo.guardarReceta({ url: r.url, pasos: r.pasos }, usuario);
    return receta();
  }

  async function restaurarReceta() {
    await repo.borrarReceta();
    return RECETA_DEFAULT;
  }

  async function estadoCredencial(cuit) {
    const c = await repo.credencial(cuitDe(cuit));
    return c
      ? { cargada: !!c.clave_cifrada, cuitLogin: c.cuit_login, sincronizar: !!c.sincronizar, actualizada: c.actualizada_at || null, actualizadaPor: c.actualizada_por || null, rechazada: c.rechazada_at || null, rechazoMotivo: c.rechazo_motivo || null }
      : { cargada: false, cuitLogin: null, sincronizar: false, actualizada: null, actualizadaPor: null, rechazada: null, rechazoMotivo: null };
  }

  async function guardarCredencial(cuit, { cuitLogin, clave, sincronizar } = {}, usuario) {
    const c = cuitDe(cuit);
    const login = cuitDe(cuitLogin || c);
    const previa = await repo.credencial(c);
    if (!clave && !(previa && previa.clave_cifrada)) throw err('Falta la clave fiscal', 400);
    if (clave && String(clave).length > 200) throw err('Clave demasiado larga', 400);
    await repo.guardarCredencial(c, {
      cuitLogin: login,
      claveCifrada: clave ? vault.encrypt(String(clave)) : null,
      sincronizar: sincronizar === undefined ? null : !!sincronizar,
      usuario,
    });
    return estadoCredencial(c);
  }

  async function sincronizar(cuit, { tipo = 'ambos', desde, hasta, origen = 'manual', usuario } = {}) {
    const c = cuitDe(cuit);
    if (!['emitidos', 'recibidos', 'ambos'].includes(tipo)) throw err('tipo: emitidos | recibidos | ambos', 400);
    tramos(desde, hasta); // valida fechas
    const cred = await repo.credencial(c);
    if (!cred || !cred.clave_cifrada) throw err('Este CUIT no tiene clave fiscal cargada en Mis Comprobantes', 400);
    if (cred.rechazada_at) {
      throw err(`ARCA rechazo esta clave fiscal${cred.rechazo_motivo ? ` (${cred.rechazo_motivo})` : ''}. Para no bloquear la cuenta no se reintenta: volve a cargar la clave antes de sincronizar`, 409);
    }
    const viva = await repo.corridaViva(c);
    if (viva) throw Object.assign(err(`Ya hay una sincronizacion en curso para este CUIT (corrida ${viva.id})`, 409), { corrida: viva.id });
    return repo.crearCorrida({ cuit: c, tipo, desde, hasta, origen, usuario });
  }

  /** Lanza seguir() sin esperar (lo usa la API). */
  function lanzar(id) {
    if (lanzados.has(id)) return;
    lanzados.add(id);
    seguir(id).catch((e) => console.error('[arcanum] mis comprobantes: corrida', id, e.message))
      .finally(() => lanzados.delete(id));
  }

  async function correrSesion(id, corrida, cred, tipo, tramo, r, secretos, avisado) {
    const { token } = await fisherboy.iniciar({
      url: r.url,
      receta: r.pasos,
      variables: { cuit_login: cred.cuit_login || corrida.cuit, cuit: corrida.cuit, tipo_boton: BOTON[tipo], rango: `${ddmmaaaa(tramo.desde)} - ${ddmmaaaa(tramo.hasta)}` },
      secretos,
      dominios: DOMINIOS,
      ia: true,
    });
    await repo.actualizarCorrida(id, { token_fb: token, estado: 'corriendo' });
    try {
      const fin = Date.now() + TIMEOUT_SESION_MS;
      let st;
      for (;;) {
        st = await fisherboy.estado(token);
        if (['terminado', 'error', 'cerrado'].includes(st.estado)) break;
        if (['corriendo', 'esperando_humano', 'humano'].includes(st.estado)) {
          await repo.actualizarCorrida(id, { estado: st.estado });
        }
        if (st.estado === 'esperando_humano' && !avisado.hecho) {
          avisado.hecho = true;
          await webhooks.emitir('mis_comprobantes_fallo', { cuit: corrida.cuit, corrida: id, necesitaHumano: true, motivo: st.motivo_humano || 'ARCA pide a una persona' }).catch(() => {});
        }
        if (Date.now() > fin) throw err('La sesion de Fisherboy no termino en 25 minutos', 504);
        await new Promise((res) => setTimeout(res, esperaMs));
      }
      if (st.estado !== 'terminado') {
        const motivo = st.error || 'la sesion se cerro antes de terminar';
        const e = err(st.alerta ? `${motivo} (ARCA dice: ${st.alerta})` : motivo, 502);
        e.logFb = (st.log || []).slice(-40);
        if (loginRechazado(st)) {
          e.message = `ARCA rechazo el ingreso: ${e.message}. La credencial queda bloqueada hasta que la vuelvas a cargar.`;
          await repo.marcarRechazada(corrida.cuit, st.alerta || motivo);
        }
        throw e;
      }
      const archivos = st.archivos || [];
      if (!archivos.length) throw err('La receta termino sin descargar nada de Mis Comprobantes', 502);
      let n = 0;
      for (const a of archivos) {
        const filas = desdeArchivo(await fisherboy.archivo(token, a.n), a.nombre, tipo);
        n += await repo.guardarComprobantes(corrida.cuit, tipo, id, filas);
      }
      return { n, log: st.log || [] };
    } finally {
      await Promise.resolve(fisherboy.cerrar(token)).catch(() => {});
    }
  }

  async function seguir(id) {
    const fila = await repo.corrida(id);
    if (!fila) throw err(`No existe la corrida ${id}`, 404);
    const avisado = { hecho: false };
    let total = 0;
    let log = [];
    try {
      const cred = await repo.credencial(fila.cuit);
      if (!cred || !cred.clave_cifrada) throw err('La clave fiscal se borro durante la corrida', 400);
      const r = await receta();
      const secretos = { clave_fiscal: vault.decrypt(cred.clave_cifrada) };
      const tipos = fila.tipo === 'ambos' ? ['emitido', 'recibido'] : [TIPOS[fila.tipo]];
      const desde = typeof fila.desde === 'string' ? fila.desde : iso(new Date(fila.desde));
      const hasta = typeof fila.hasta === 'string' ? fila.hasta : iso(new Date(fila.hasta));
      for (const tipo of tipos) {
        for (const tramo of tramos(desde, hasta)) {
          const res = await correrSesion(id, fila, cred, tipo, tramo, r, secretos, avisado);
          total += res.n;
          log = log.concat(res.log.slice(-40));
        }
      }
      await repo.actualizarCorrida(id, { estado: 'terminado', cantidad: total, terminada_at: ahora(), log, error: null });
      await webhooks.emitir('mis_comprobantes_sincronizado', { cuit: fila.cuit, corrida: id, tipo: fila.tipo, desde, hasta, cantidad: total }).catch(() => {});
    } catch (e) {
      if (e.logFb) log = log.concat(e.logFb);
      await repo.actualizarCorrida(id, { estado: 'error', cantidad: total, terminada_at: ahora(), log, error: String(e.message || e).slice(0, 500) });
      await webhooks.emitir('mis_comprobantes_fallo', { cuit: fila.cuit, corrida: id, error: String(e.message || e).slice(0, 300) }).catch(() => {});
    }
  }

  async function exportarCsv(cuit, filtros) {
    const filas = await repo.listar(cuitDe(cuit), { ...filtros, limite: 5000 });
    const cols = ['tipo', 'fecha', 'cbte_tipo', 'punto_venta', 'numero_desde', 'numero_hasta', 'cae', 'doc_tipo', 'doc_nro', 'contraparte', 'moneda', 'tipo_cambio', 'neto_gravado', 'no_gravado', 'exento', 'iva', 'total'];
    const esc = (v) => {
      const s = v == null ? '' : (v instanceof Date ? iso(v) : String(v));
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(';'), ...filas.map((f) => cols.map((k) => esc(f[k])).join(';'))].join('\n') + '\n';
  }

  return {
    receta, guardarReceta, restaurarReceta,
    estadoCredencial, guardarCredencial,
    borrarCredencial: async (cuit) => repo.borrarCredencial(cuitDe(cuit)),
    sincronizar, seguir, lanzar,
    corrida: async (id) => repo.corrida(Number(id)),
    listar: async (cuit, filtros) => repo.listar(cuitDe(cuit), filtros),
    corridas: async (cuit, limite) => repo.corridas(cuitDe(cuit), limite),
    conSincronizacion: async () => repo.conSincronizacion(),
    exportarCsv,
  };
}

let porDefecto = null;
function servicio() {
  if (!porDefecto) {
    porDefecto = crear({
      repo: repoSql(),
      fisherboy: require('./fisherboy'),
      vault: require('../crypto/vault'),
      webhooks: require('./webhooks'),
    });
  }
  return porDefecto;
}

module.exports = { crear, servicio, tramos, cuitDe, ESTADOS_VIVOS, RECETA_DEFAULT };
