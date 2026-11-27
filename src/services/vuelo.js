'use strict';

// Emision "en vuelo": antes de mandar FECAESolicitar se anota (por idempotencyKey) el numero, el
// total, el receptor y la fecha. Si la respuesta no llega (timeout, corte, Arcanum se reinicia en
// medio), el proximo intento con la MISMA clave resuelve primero ese vuelo:
//
//   ARCA tiene ese numero y es esta venta (total, receptor y fecha)  -> se adopta ese CAE
//   ARCA dice "no existe" (602) o 404                                -> el numero quedo libre
//   cualquier otra respuesta                                         -> no se emite; se reintenta
//
// Asi nunca salen dos CAE para la misma venta, venga el reintento de la cola, del cliente o de un
// reinicio. Los pedidos sin idempotencyKey no tienen esta proteccion (la UI y la cola siempre la mandan).

const { SoapError } = require('../soap/client');

function noExiste(e) {
  if (!e) return false;
  if (e.httpStatus === 404) return true;
  const errs = (e.extra && e.extra.errors) || [];
  return errs.some((x) => Number(x.code) === 602);
}

function coincide(v, c) {
  if (!c) return false;
  const total = Math.abs(Number(c.importeTotal) - Number(v.importe_total)) < 0.01;
  const doc = String(c.docNro ?? '0').replace(/\D/g, '') === String(v.doc_nro ?? '0').replace(/\D/g, '');
  const fecha = !v.fecha || String(c.fecha || '').replace(/-/g, '') === String(v.fecha).replace(/-/g, '');
  return total && doc && fecha;
}

/** Resuelve el vuelo pendiente de una clave. { estado: 'adoptar', consultado } | { estado: 'libre' }. */
async function resolver(v, { consultar }) {
  if (!v) return { estado: 'libre' };
  let c;
  try {
    c = await consultar(v.cuit, v.punto_venta, v.tipo_cbte, v.numero);
  } catch (e) {
    if (noExiste(e)) return { estado: 'libre' };
    throw new SoapError(
      `No se pudo verificar en ARCA si el intento anterior (número ${v.numero}) se emitió: no se emite otro hasta saberlo. ${e.message || ''}`.trim(),
      503, { tipo: 'verificacion' });
  }
  return coincide(v, c) ? { estado: 'adoptar', consultado: c } : { estado: 'libre' };
}

// Las claves valen por (cuit, entorno), igual que en comprobantes y en la cola (auditoria 2026-11-26, A-03).
function repoSql(db = require('../db')) {
  const entorno = () => require('../config').config.env;
  return {
    async obtener(cuit, idem) {
      const { rows } = await db.query(
        'SELECT * FROM emisiones_en_vuelo WHERE cuit = $1 AND entorno = $2 AND idempotency_key = $3', [cuit, entorno(), idem]);
      return rows[0] || null;
    },
    async anotar(idem, d) {
      await db.query(
        `INSERT INTO emisiones_en_vuelo (idempotency_key, cuit, entorno, punto_venta, tipo_cbte, numero, importe_total, doc_nro, fecha)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (cuit, entorno, idempotency_key) DO UPDATE SET numero = EXCLUDED.numero, importe_total = EXCLUDED.importe_total,
           doc_nro = EXCLUDED.doc_nro, fecha = EXCLUDED.fecha, punto_venta = EXCLUDED.punto_venta, tipo_cbte = EXCLUDED.tipo_cbte, creado_at = now()`,
        [idem, d.cuit, d.entorno, d.puntoVenta, d.tipoCbte, d.numero, d.importeTotal, d.docNro, d.fecha]);
    },
    async borrar(cuit, idem) {
      await db.query('DELETE FROM emisiones_en_vuelo WHERE cuit = $1 AND entorno = $2 AND idempotency_key = $3', [cuit, entorno(), idem]);
    },
  };
}

module.exports = { resolver, coincide, noExiste, repoSql };
