'use strict';

// Sincronizar emitidos con ARCA (FECompConsultar): trae a Arcanum lo que se facturo por fuera
// (facturador web de ARCA, otro sistema) para que reportes, Monotributo y MCP lo vean todo.
//
// Por cada punto de venta CAE habilitado y cada tipo usual: desde el ultimo numero de ARCA hacia
// atras, salta los que Arcanum ya tiene y consulta los que faltan (incluidos huecos del medio),
// hasta pasar la fecha limite (`dias`, 90 por defecto) o el tope de consultas por corrida. Lo que
// trae se guarda con origen 'arca'. Ademas compara el ultimo local contra ARCA (CAE e importe).

const { esIndisponibilidad } = require('./contingencia');

const TIPOS_USUALES = [1, 2, 3, 6, 7, 8, 11, 12, 13, 51, 52, 53];
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;

function ymdLimite(hoy, dias) {
  return new Date(hoy.getTime() - AR_OFFSET_MS - dias * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

function ymdDe(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10).replace(/-/g, '');
  return String(v).replace(/-/g, '').slice(0, 8);
}

function puntoDeVentaCae(p) {
  const tipo = String(p.EmisionTipo || '');
  const baja = p.FchBaja && String(p.FchBaja) !== 'NULL';
  return /CAE/i.test(tipo) && !/CAEA/i.test(tipo) && String(p.Bloqueado || 'N').toUpperCase() !== 'S' && !baja;
}

function crear({ wsfev1, repo, webhooks, ahora = () => new Date() } = {}) {
  async function sincronizar(cuit, { dias = Number(process.env.ARCANUM_SYNC_DIAS) || 90, tope = 500, tipos = TIPOS_USUALES } = {}) {
    const limite = ymdLimite(ahora(), dias);
    const pvs = (await wsfev1.getParams(cuit, 'puntosVenta')).filter(puntoDeVentaCae).map((p) => Number(p.Nro));
    let consultas = 0;
    let pendiente = false;
    const porPuntoVenta = {};
    const diferencias = [];
    let traidos = 0;

    afuera: for (const pv of pvs) {
      for (const tipo of tipos) {
        const ultimo = Number((await wsfev1.lastAuthorized(cuit, pv, tipo)).ultimoNumero) || 0;
        if (!ultimo) continue;
        const locales = await repo.locales(cuit, pv, tipo); // { numero: { fecha, cae, importe } }
        const numerosLocales = Object.keys(locales).map(Number);
        const maxLocal = numerosLocales.length ? Math.max(...numerosLocales) : 0;

        // Control: el ultimo que tiene Arcanum, ¿coincide con ARCA?
        if (maxLocal && maxLocal <= ultimo) {
          if (consultas >= tope) { pendiente = true; break afuera; }
          consultas += 1;
          try {
            const c = await wsfev1.consultar(cuit, pv, tipo, maxLocal);
            const l = locales[maxLocal];
            if (l.cae && c.cae && String(l.cae) !== String(c.cae)) diferencias.push({ puntoVenta: pv, tipo, numero: maxLocal, motivo: `CAE distinto (Arcanum ${l.cae}, ARCA ${c.cae})` });
            else if (Math.abs(Number(l.importe) - Number(c.importeTotal)) >= 0.01) diferencias.push({ puntoVenta: pv, tipo, numero: maxLocal, motivo: `Importe distinto (Arcanum ${l.importe}, ARCA ${c.importeTotal})` });
          } catch (e) {
            if (esIndisponibilidad(e)) throw e;
          }
        }

        for (let n = ultimo; n >= 1; n -= 1) {
          const l = locales[n];
          if (l) {
            if (ymdDe(l.fecha) < limite) break;
            continue;
          }
          if (consultas >= tope) { pendiente = true; break afuera; }
          consultas += 1;
          let c;
          try {
            c = await wsfev1.consultar(cuit, pv, tipo, n);
          } catch (e) {
            if (esIndisponibilidad(e)) throw e;
            continue; // numero que ARCA no devuelve: seguimos
          }
          if (ymdDe(c.fecha) < limite) break;
          await repo.insertar(cuit, c);
          traidos += 1;
          porPuntoVenta[pv] = (porPuntoVenta[pv] || 0) + 1;
        }
      }
    }
    const r = { traidos, porPuntoVenta, diferencias, pendiente, consultas };
    if (traidos || diferencias.length) await webhooks.emitir('emitidos_por_fuera', { cuit, ...r }).catch(() => {});
    return r;
  }

  return { sincronizar };
}

function repoSql() {
  const db = require('../db');
  const { config } = require('../config');
  return {
    async locales(cuit, pv, tipo) {
      const { rows } = await db.query(
        'SELECT numero, fecha, cae, importe_total FROM comprobantes WHERE cuit = $1 AND entorno = $2 AND punto_venta = $3 AND tipo_cbte = $4',
        [cuit, config.env, pv, tipo]);
      return Object.fromEntries(rows.map((r) => [r.numero, { fecha: r.fecha, cae: r.cae, importe: Number(r.importe_total) }]));
    },
    async insertar(cuit, c) {
      const raw = { ...c, cuit, aprobado: c.resultado === 'A', origen: 'arca' };
      await db.query(
        `INSERT INTO comprobantes (cuit, entorno, punto_venta, tipo_cbte, numero, cae, cae_vto, resultado, fecha,
           importe_total, doc_tipo, doc_nro, raw, origen)
         VALUES ($1,$2,$3,$4,$5,$6, to_date(NULLIF($7,''),'YYYYMMDD'),$8, to_date(NULLIF($9,''),'YYYYMMDD'),$10,$11,$12,$13,'arca')
         ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO NOTHING`,
        [cuit, config.env, c.puntoVenta, c.tipoComprobante, c.numero, c.cae, String(c.caeVencimiento || ''), c.resultado,
          String(c.fecha || ''), Number(c.importeTotal || 0), c.docTipo || null, String(c.docNro || ''), JSON.stringify(raw)]);
    },
  };
}

let porDefecto = null;
function servicio() {
  if (!porDefecto) porDefecto = crear({ wsfev1: require('./wsfev1'), repo: repoSql(), webhooks: require('./webhooks') });
  return porDefecto;
}

module.exports = { crear, servicio, TIPOS_USUALES, puntoDeVentaCae };
