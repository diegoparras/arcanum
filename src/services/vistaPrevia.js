'use strict';

// Vista previa de un comprobante WSFEv1: valida todo lo que se puede validar antes
// de pedir el CAE y muestra el numero que le tocaria. NO emite, NO reserva numero,
// NO escribe nada. Pensado para el flujo "el asistente arma la factura, la persona
// la aprueba, recien ahi se emite" (con una clave de rol operador).
//
// revisarComprobante() es pura (testeable); vistaPrevia() agrega lo que necesita
// ARCA: ultimo numero autorizado y, si el receptor es un CUIT, su padron.

const crypto = require('crypto');
const wsfev1 = require('./wsfev1');
const padron = require('./padron');
const emisores = require('./emisores');
const datosImpresion = require('./datosImpresion');
const reglas = require('./reglas-comprobante');
const { analizarPadron } = require('./contribuyente');
const { config } = require('../config');
const { normalizeCuit } = require('../auth/tenants');

const TIPOS = {
  1: 'Factura A', 2: 'Nota de Debito A', 3: 'Nota de Credito A',
  6: 'Factura B', 7: 'Nota de Debito B', 8: 'Nota de Credito B',
  11: 'Factura C', 12: 'Nota de Debito C', 13: 'Nota de Credito C',
  51: 'Factura M', 52: 'Nota de Debito M', 53: 'Nota de Credito M',
  201: 'Factura de Credito Electronica MiPyME A', 202: 'Nota de Debito Electronica MiPyME A', 203: 'Nota de Credito Electronica MiPyME A',
  206: 'Factura de Credito Electronica MiPyME B', 207: 'Nota de Debito Electronica MiPyME B', 208: 'Nota de Credito Electronica MiPyME B',
  211: 'Factura de Credito Electronica MiPyME C', 212: 'Nota de Debito Electronica MiPyME C', 213: 'Nota de Credito Electronica MiPyME C',
};
const LETRA = {
  1: 'A', 2: 'A', 3: 'A', 201: 'A', 202: 'A', 203: 'A',
  6: 'B', 7: 'B', 8: 'B', 206: 'B', 207: 'B', 208: 'B',
  11: 'C', 12: 'C', 13: 'C', 211: 'C', 212: 'C', 213: 'C',
  51: 'M', 52: 'M', 53: 'M',
};
const NOTAS = new Set([2, 3, 7, 8, 12, 13, 52, 53, 202, 203, 207, 208, 212, 213]);
const DOC_TIPOS = { 80: 'CUIT', 86: 'CUIL', 87: 'CDI', 89: 'LE', 90: 'LC', 91: 'CI extranjera', 94: 'Pasaporte', 96: 'DNI', 99: 'Consumidor final (sin identificar)' };

function cuitValido(c) {
  const s = normalizeCuit(c);
  if (!/^\d{11}$/.test(s)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((a, p, i) => a + p * Number(s[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) return false;
  return dv === Number(s[10]);
}

function ymd(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function diasEntre(aYmd, bYmd) {
  const f = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((f(aYmd) - f(bYmd)) / 86400000);
}
const iso = (s) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

/**
 * Revision sin red: devuelve { problemas, advertencias, datos } donde problemas son
 * cosas por las que ARCA (o Arcanum) rechazaria el comprobante.
 * @param {object} inv  el mismo cuerpo que POST /api/wsfev1/comprobantes
 * @param {object} [o]  { hoy: Date }
 */
function revisarComprobante(inv = {}, o = {}) {
  const problemas = [];
  const advertencias = [];
  const hoy = ymd(o.hoy || new Date());

  const pv = parseInt(inv.puntoVenta, 10);
  if (!(pv >= 1 && pv <= 99998)) problemas.push('"puntoVenta" debe ser un numero de 1 a 99998.');
  const tipo = parseInt(inv.tipoComprobante, 10);
  const letra = LETRA[tipo] || null;
  if (!letra) problemas.push(`"tipoComprobante" ${inv.tipoComprobante ?? '(vacio)'} no es un comprobante de WSFEv1 conocido (1 = Factura A, 6 = Factura B, 11 = Factura C...).`);
  const concepto = parseInt(inv.concepto ?? 1, 10);
  if (![1, 2, 3].includes(concepto)) problemas.push('"concepto" debe ser 1 (productos), 2 (servicios) o 3 (ambos).');

  const total = Number(inv.importeTotal || 0);
  if (!(total > 0)) problemas.push('"importeTotal" debe ser mayor a 0.');
  try {
    wsfev1.validarImportes(inv);
  } catch (e) {
    problemas.push(e.message);
  }

  const iva = Number(inv.importeIva || 0);
  const alicuotas = Array.isArray(inv.alicuotasIva) ? inv.alicuotasIva : [];
  if (letra === 'C' && (iva !== 0 || alicuotas.length)) {
    problemas.push('Los comprobantes C no discriminan IVA: "importeIva" tiene que ser 0 y sin "alicuotasIva" (el total va en "importeNeto").');
  }
  if ((letra === 'A' || letra === 'B' || letra === 'M') && Number(inv.importeNeto || 0) > 0 && !alicuotas.length) {
    problemas.push(`Los comprobantes ${letra} con neto gravado necesitan "alicuotasIva" (ej. [{ "id": 5, "baseImponible": 100, "importe": 21 }] para 21%).`);
  }
  if (NOTAS.has(tipo) && !(Array.isArray(inv.comprobantesAsociados) && inv.comprobantesAsociados.length)) {
    problemas.push('Las notas de credito y debito necesitan "comprobantesAsociados" (el comprobante que corrigen).');
  }

  // Receptor
  const docTipo = parseInt(inv.tipoDocReceptor ?? 99, 10);
  const docNro = normalizeCuit(inv.nroDocReceptor ?? 0) || '0';
  if (!DOC_TIPOS[docTipo]) advertencias.push(`"tipoDocReceptor" ${docTipo} no es de los habituales (80 CUIT, 86 CUIL, 96 DNI, 99 consumidor final).`);
  if (docTipo === 80 && !cuitValido(docNro)) problemas.push(`El CUIT del receptor (${docNro}) no es valido (digito verificador).`);
  if (letra === 'A' && docTipo !== 80) problemas.push('Una Factura A necesita al receptor identificado por CUIT ("tipoDocReceptor": 80).');
  try {
    wsfev1.validarIdentificacionConsumidorFinal(inv, tipo);
  } catch (e) {
    problemas.push(e.message);
  }
  const condRec = inv.condicionIvaReceptor != null && inv.condicionIvaReceptor !== '' ? parseInt(inv.condicionIvaReceptor, 10) : null;
  if (condRec == null) {
    problemas.push('Falta "condicionIvaReceptor" (obligatoria en WSFEv1, RG 5616): 1 = Responsable Inscripto, 5 = Consumidor Final, 6 = Monotributo, 4 = Exento.');
  } else if (!reglas.condicionIvaLabel(condRec)) {
    problemas.push(`"condicionIvaReceptor" ${condRec} no esta en la tabla de ARCA.`);
  }
  if (letra === 'A' && condRec != null && ![1, 6, 13, 16].includes(condRec)) {
    advertencias.push(`Factura A a un receptor "${reglas.condicionIvaLabel(condRec) || condRec}": lo habitual es B.`);
  }

  // Fecha: ARCA acepta hasta 5 dias antes o despues (productos) o 10 (servicios).
  let fecha = hoy;
  if (inv.fecha) {
    try {
      fecha = wsfev1.fmtDate(inv.fecha);
    } catch (e) {
      problemas.push(e.message);
    }
  }
  const margen = concepto === 1 ? 5 : 10;
  const delta = diasEntre(fecha, hoy);
  if (Math.abs(delta) > margen) {
    problemas.push(`La fecha ${iso(fecha)} esta a ${Math.abs(delta)} dias de hoy: ARCA acepta hasta ${margen} dias ${delta < 0 ? 'para atras' : 'para adelante'} para este concepto.`);
  }
  if (concepto !== 1 && !(inv.fechaServicioDesde && inv.fechaServicioHasta && inv.fechaVtoPago)) {
    advertencias.push('Servicios sin "fechaServicioDesde", "fechaServicioHasta" o "fechaVtoPago": se usara la fecha del comprobante.');
  }
  if (!inv.idempotencyKey) {
    advertencias.push('Sin "idempotencyKey": si al emitir se corta la conexion y se reintenta, podria salir duplicado. Usa la que propone "cuerpoParaEmitir".');
  }

  return {
    problemas,
    advertencias,
    datos: {
      puntoVenta: pv || null,
      tipo: tipo || null,
      tipoNombre: TIPOS[tipo] || null,
      letra,
      concepto,
      fecha: iso(fecha),
      receptor: { tipoDocumento: DOC_TIPOS[docTipo] || String(docTipo), numeroDocumento: docNro !== '0' ? docNro : null, condicionIvaId: condRec, condicionIva: condRec != null ? reglas.condicionIvaLabel(condRec) : null },
      importes: {
        neto: Number(inv.importeNeto || 0), iva, exento: Number(inv.importeExento || 0),
        noGravado: Number(inv.importeNoGravado || 0), tributos: Number(inv.importeTributos || 0), total,
        moneda: inv.moneda || 'PES', cotizacion: Number(inv.cotizacion ?? 1),
      },
    },
  };
}

/**
 * Vista previa completa (consulta ARCA, no escribe nada).
 * @param {string} cuit  emisor
 * @param {object} inv   cuerpo de emision
 */
async function vistaPrevia(cuit, inv) {
  const emisor = normalizeCuit(cuit);
  const previo = await wsfev1.previoIdempotente(emisor, inv.idempotencyKey || null);
  if (previo) {
    return {
      valido: false,
      yaEmitido: true,
      problemas: ['Ya se emitio un comprobante con esta "idempotencyKey": emitir de nuevo devuelve ese mismo comprobante, no uno nuevo.'],
      advertencias: [],
      comprobanteExistente: previo,
      entorno: config.env,
    };
  }

  const r = revisarComprobante(inv);
  const { datos } = r;

  // Condicion del emisor y del receptor (padron, si es CUIT) -> letra sugerida.
  let emisorCondicion = '';
  try {
    const { emisor: datosEmisor, faltan } = await datosImpresion.completarEmisor(emisor);
    emisorCondicion = (datosEmisor.condicionIva || '').toUpperCase();
    if (faltan.length) {
      r.advertencias.push(`El PDF va a salir sin ${faltan.map((f) => f.etiqueta).join(', ')} del emisor: cargalos en Clientes > Datos fiscales${faltan.some((f) => !f.desdeArca) ? ' (Ingresos Brutos e inicio de actividades no los da ARCA por web service)' : ''}.`);
    }
  } catch {
    try { emisorCondicion = ((await emisores.get(emisor)).condicionIva || '').toUpperCase(); } catch { /* sin datos de emisor */ }
  }
  let receptorPadron = null;
  if (datos.receptor.tipoDocumento === 'CUIT' && cuitValido(datos.receptor.numeroDocumento)) {
    try {
      const { datos: p, cache } = await padron.consultarPersonaConMeta('a5', emisor, datos.receptor.numeroDocumento);
      const a = analizarPadron(p);
      receptorPadron = {
        nombre: a.nombre,
        domicilio: datosImpresion.fichaDesdePadron(p).domicilio,
        estadoClave: a.estadoClave,
        condicionIVA: a.condicionIVA,
        condicionIvaReceptorId: reglas.idDesdeTipoContribuyente(a.tipoContribuyente),
        consultado: cache.consultado,
      };
      if (a.estadoClave && a.estadoClave !== 'ACTIVO') r.advertencias.push(`El CUIT del receptor figura con clave fiscal ${a.estadoClave}.`);
      const idPadron = receptorPadron.condicionIvaReceptorId;
      if (idPadron && datos.receptor.condicionIvaId == null) {
        r.problemas.push(`Falta "condicionIvaReceptor": segun el padron corresponde ${idPadron} (${reglas.condicionIvaLabel(idPadron)}).`);
      } else if (idPadron && datos.receptor.condicionIvaId !== idPadron) {
        r.advertencias.push(`"condicionIvaReceptor" es ${datos.receptor.condicionIvaId} pero el padron dice ${idPadron} (${reglas.condicionIvaLabel(idPadron)}).`);
      }
    } catch (e) {
      r.advertencias.push(`No se pudo consultar el padron del receptor: ${e.message.slice(0, 200)}`);
    }
  }
  const condRec = datos.receptor.condicionIvaId ?? (receptorPadron && receptorPadron.condicionIvaReceptorId);
  const sugerencia = reglas.sugerirComprobante({ emisorCondicion, receptorCondicionId: condRec });
  if (sugerencia.letra && datos.letra && sugerencia.letra !== datos.letra && datos.letra !== 'M') {
    r.advertencias.push(`Por la condicion del emisor y del receptor corresponderia comprobante ${sugerencia.letra}, no ${datos.letra}. ${sugerencia.motivo}`);
  }

  // Proximo numero (no se reserva: si se emite otro antes, cambia).
  let numero = null;
  if (datos.letra && datos.puntoVenta) {
    try {
      const u = await wsfev1.lastAuthorized(emisor, datos.puntoVenta, datos.tipo);
      numero = Number(u.ultimoNumero) + 1;
    } catch (e) {
      r.advertencias.push(`No se pudo consultar el ultimo numero en ARCA: ${e.message.slice(0, 200)}`);
    }
  }
  if (inv.numero && numero && parseInt(inv.numero, 10) !== numero) {
    r.problemas.push(`"numero" ${inv.numero} no es el siguiente: ARCA espera ${numero}. Conviene no mandar "numero" y dejar que Arcanum lo calcule.`);
  }

  const cuerpo = { ...inv, cuit: emisor };
  delete cuerpo.numero;
  if (!cuerpo.idempotencyKey) cuerpo.idempotencyKey = `prev-${crypto.randomBytes(8).toString('hex')}`;
  if (cuerpo.condicionIvaReceptor == null && receptorPadron && receptorPadron.condicionIvaReceptorId) {
    cuerpo.condicionIvaReceptor = receptorPadron.condicionIvaReceptorId;
  }
  if (receptorPadron && !cuerpo.receptorNombre && receptorPadron.nombre && receptorPadron.nombre !== 'N/A') cuerpo.receptorNombre = receptorPadron.nombre;
  if (receptorPadron && !cuerpo.receptorDomicilio && receptorPadron.domicilio) cuerpo.receptorDomicilio = receptorPadron.domicilio;

  return {
    valido: r.problemas.length === 0,
    problemas: r.problemas,
    advertencias: r.advertencias,
    emisor,
    comprobante: datos.tipoNombre && numero ? `${datos.tipoNombre} ${String(datos.puntoVenta).padStart(4, '0')}-${String(numero).padStart(8, '0')}` : null,
    numeroPropuesto: numero,
    numeroNota: 'El numero no se reserva: si se emite otro comprobante antes, sera el siguiente.',
    ...datos,
    receptor: { ...datos.receptor, ...(receptorPadron ? { padron: receptorPadron } : {}) },
    letraSugerida: sugerencia.letra,
    cuerpoParaEmitir: cuerpo,
    entorno: config.env,
  };
}

module.exports = { revisarComprobante, vistaPrevia, cuitValido, TIPOS, LETRA };
