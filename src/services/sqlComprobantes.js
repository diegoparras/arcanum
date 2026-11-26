'use strict';

// Conflicto al guardar una emision propia (WSFEv1, WSFEX, WSMTXCA, traidos de ARCA).
//
// Un comprobante importado (de un tercero, por QR) se guarda bajo el CUIT del consultante con el
// punto de venta y numero del emisor, asi que puede ocupar el mismo (cuit, entorno, pv, tipo, nro)
// que una emision propia. Antes la emision hacia DO NOTHING: ARCA daba el CAE pero Arcanum no la
// registraba (auditoria 2026-11-26, M-09). Ahora la emision propia reemplaza al importado; contra
// otra emision propia sigue sin pisar nada.
const CONFLICTO_EMISION = `ON CONFLICT (cuit, entorno, punto_venta, tipo_cbte, numero) DO UPDATE SET
       cae = EXCLUDED.cae, cae_vto = EXCLUDED.cae_vto, resultado = EXCLUDED.resultado, fecha = EXCLUDED.fecha,
       importe_total = EXCLUDED.importe_total, doc_tipo = EXCLUDED.doc_tipo, doc_nro = EXCLUDED.doc_nro,
       idempotency_key = EXCLUDED.idempotency_key, raw = EXCLUDED.raw, origen = EXCLUDED.origen
     WHERE comprobantes.origen = 'importado'`;

module.exports = { CONFLICTO_EMISION };
