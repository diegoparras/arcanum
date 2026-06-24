'use strict';

// Metricas para el dashboard: estado de ARCA, uptime, emisiones, tokens y certs.

const db = require('./../db');
const { config } = require('../config');
const catalog = require('../catalog');

async function resumen() {
  const env = config.env;
  const [estado, uptime, emisiones, serie, tokens, certs, reqs] = await Promise.all([
    // Estado actual de cada servicio (ultimo chequeo).
    db.query(
      `SELECT DISTINCT ON (service) service, ok, latency_ms, checked_at
       FROM service_status WHERE entorno = $1 ORDER BY service, checked_at DESC`,
      [env],
    ),
    // Uptime 24h por servicio (% de chequeos OK).
    db.query(
      `SELECT service, round(100.0 * sum(case when ok then 1 else 0 end) / count(*), 1) AS uptime, round(avg(latency_ms)) AS lat
       FROM service_status WHERE entorno = $1 AND checked_at > now() - interval '24 hours' GROUP BY service`,
      [env],
    ),
    // Emisiones de hoy / aprobadas.
    db.query(
      `SELECT count(*) FILTER (WHERE created_at::date = now()::date) AS hoy,
              count(*) AS total,
              coalesce(sum(importe_total) FILTER (WHERE created_at::date = now()::date),0) AS monto_hoy
       FROM comprobantes WHERE entorno = $1`,
      [env],
    ),
    // Serie de emisiones ultimos 14 dias.
    db.query(
      `SELECT created_at::date AS dia, count(*) AS n FROM comprobantes
       WHERE entorno = $1 AND created_at > now() - interval '14 days' GROUP BY dia ORDER BY dia`,
      [env],
    ),
    db.query(`SELECT count(*) AS n FROM access_tickets WHERE entorno = $1 AND expiration_time > now()`, [env]),
    db.query(
      `SELECT count(*) FILTER (WHERE cert_not_after < now() + interval '30 days') AS por_vencer,
              count(*) FILTER (WHERE cert_not_after < now()) AS vencidos
       FROM tenants WHERE entorno = $1 AND cert_not_after IS NOT NULL`,
      [env],
    ),
    // Peticiones ultimas 24h: total, errores, latencia media.
    db.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ok = false) AS errores, round(avg(duration_ms)) AS lat
       FROM requests WHERE ts > now() - interval '24 hours'`,
    ),
  ]);

  const uptimeMap = {};
  for (const r of uptime.rows) uptimeMap[r.service] = { uptime: Number(r.uptime), latencia: Number(r.lat) };

  // Solo reportamos servicios que hoy se monitorean (tienen dummy sin-auth).
  const monitoreados = new Set(catalog.list().filter((s) => s.dummyOp).map((s) => s.id));

  return {
    entorno: env,
    arca: estado.rows.filter((r) => monitoreados.has(r.service)).map((r) => ({
      servicio: r.service,
      ok: r.ok,
      latencia: r.latency_ms,
      uptime24h: uptimeMap[r.service]?.uptime ?? null,
      ultimoChequeo: r.checked_at,
    })),
    emisiones: {
      hoy: Number(emisiones.rows[0].hoy),
      total: Number(emisiones.rows[0].total),
      montoHoy: Number(emisiones.rows[0].monto_hoy),
      serie: serie.rows.map((r) => ({ dia: r.dia, n: Number(r.n) })),
    },
    tokensVigentes: Number(tokens.rows[0].n),
    certificados: { porVencer: Number(certs.rows[0].por_vencer), vencidos: Number(certs.rows[0].vencidos) },
    peticiones24h: {
      total: Number(reqs.rows[0].total),
      errores: Number(reqs.rows[0].errores),
      latenciaMedia: Number(reqs.rows[0].lat) || 0,
    },
  };
}

// Formato Prometheus para quien quiera Grafana.
async function prometheus() {
  const r = await resumen();
  const lines = [];
  lines.push('# HELP arcanum_emisiones_hoy Comprobantes emitidos hoy');
  lines.push('# TYPE arcanum_emisiones_hoy gauge');
  lines.push(`arcanum_emisiones_hoy ${r.emisiones.hoy}`);
  lines.push('# TYPE arcanum_tokens_vigentes gauge');
  lines.push(`arcanum_tokens_vigentes ${r.tokensVigentes}`);
  lines.push('# TYPE arcanum_certificados_por_vencer gauge');
  lines.push(`arcanum_certificados_por_vencer ${r.certificados.porVencer}`);
  lines.push('# TYPE arcanum_peticiones_errores_24h gauge');
  lines.push(`arcanum_peticiones_errores_24h ${r.peticiones24h.errores}`);
  for (const a of r.arca) {
    lines.push(`arcanum_servicio_up{servicio="${a.servicio}"} ${a.ok ? 1 : 0}`);
    if (a.latencia != null) lines.push(`arcanum_servicio_latencia_ms{servicio="${a.servicio}"} ${a.latencia}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { resumen, prometheus };
