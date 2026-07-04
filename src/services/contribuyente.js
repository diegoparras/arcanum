'use strict';

// Vista consolidada de un contribuyente: combina Padron A5 (constancia) + WSAPOC
// (base de apocrifos) en una sola respuesta con "semaforo" de riesgo fiscal.
//   VERDE    -> activo, condicion frente al IVA determinada, no apocrifo.
//   AMARILLO -> falta algun dato para concluir (estado/condicion/APOC).
//   ROJO     -> apocrifo, o clave fiscal no activa.
//
// Pensado para el caso de uso del contador: "decime si le puedo facturar a este
// CUIT y que tipo de comprobante corresponde".

const padron = require('./padron');
const apoc = require('./apoc');
const reglas = require('./reglas-comprobante');
const { config } = require('../config');
const { normalizeCuit } = require('../auth/tenants');
const { SoapError } = require('../soap/client');

// IDs de impuesto frente al IVA (regimen general).
const IVA_RESP_INSCRIPTO = '30';
const IVA_EXENTO = '32';
const IVA_NO_RESPONSABLE = '33';

function asArray(x) {
  if (x === null || x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

function armarDomicilio(dg) {
  const d = dg && dg.domicilioFiscal;
  if (!d) return null;
  return [d.direccion, d.localidad, d.descripcionProvincia ? `(${d.descripcionProvincia})` : '']
    .filter(Boolean)
    .join(', ')
    .replace(', (', ' (');
}

function nombreDe(dg) {
  if (!dg) return null;
  if (dg.razonSocial) return dg.razonSocial;
  const ap = dg.apellido || '';
  const no = dg.nombre || '';
  const full = ap + (no ? `, ${no}` : '');
  return full || null;
}

/**
 * @param {string} cuitRepresentada  CUIT del titular del certificado (contador)
 * @param {string} cuitConsulta      CUIT a analizar
 * @param {object} [opts]            { entorno }
 */
async function consolidar(cuitRepresentada, cuitConsulta, opts = {}) {
  const repre = normalizeCuit(cuitRepresentada);
  const target = normalizeCuit(cuitConsulta);
  if (!target) throw new SoapError('CUIT a consultar invalido', 400);

  // Las dos consultas en paralelo. APOC es best-effort: si falla, no abortamos.
  const [pRes, aRes] = await Promise.allSettled([
    padron.consultarPersona('a5', repre, target),
    apoc.consultar(repre, target, opts.entorno),
  ]);

  if (pRes.status === 'rejected') throw pRes.reason; // sin padron no hay analisis

  const datos = pRes.value || {};
  const dg = datos.datosGenerales || {};
  const estadoClave = dg.estadoClave || null;
  const nombre = nombreDe(dg) || 'N/A';

  // --- Condicion frente al IVA ---
  const esMonotributo = !!(datos.datosMonotributo && datos.datosMonotributo.categoriaMonotributo);
  const impuestos = asArray(datos.datosRegimenGeneral && datos.datosRegimenGeneral.impuesto);
  const tieneImp = (id) => impuestos.some((i) => String(i.idImpuesto) === id);

  let tipoContribuyente;
  let condicionIVA;
  let tipoComprobante;
  if (esMonotributo) {
    const cat = datos.datosMonotributo.categoriaMonotributo;
    tipoContribuyente = 'MONOTRIBUTISTA';
    condicionIVA =
      `Monotributo - Categoria ${cat.idCategoria || ''}` +
      (cat.descripcionCategoria ? ` (${cat.descripcionCategoria})` : '');
    tipoComprobante = 'Factura C';
  } else if (tieneImp(IVA_RESP_INSCRIPTO)) {
    tipoContribuyente = 'RESPONSABLE_INSCRIPTO';
    condicionIVA = 'Responsable Inscripto en IVA';
    tipoComprobante = 'Factura A';
  } else if (tieneImp(IVA_EXENTO)) {
    tipoContribuyente = 'EXENTO';
    condicionIVA = 'IVA Exento';
    tipoComprobante = 'Factura B / Exento';
  } else if (tieneImp(IVA_NO_RESPONSABLE)) {
    tipoContribuyente = 'NO_RESPONSABLE';
    condicionIVA = 'No Responsable de IVA';
    tipoComprobante = 'Factura B';
  } else {
    tipoContribuyente = 'NO_DETERMINADO';
    condicionIVA = 'No determinado';
    tipoComprobante = 'Consultar';
  }

  // --- APOC ---
  const apocOk = aRes.status === 'fulfilled';
  const apocData = apocOk ? aRes.value : null;
  const esApocrifo = !!(apocData && apocData.esApocrifo);

  // --- Semaforo ---
  const advertencias = [];
  let semaforo;
  let motivoRiesgo = null;

  if (esApocrifo) {
    semaforo = 'ROJO';
    motivoRiesgo =
      'CUIT en base de apocrifos de ARCA' +
      (apocData.fechaCondicion ? ` desde ${apocData.fechaCondicion}` : '');
  } else if (estadoClave && estadoClave !== 'ACTIVO') {
    semaforo = 'ROJO';
    motivoRiesgo = `Estado de clave fiscal: ${estadoClave}`;
  } else if (tipoContribuyente === 'NO_DETERMINADO' || !estadoClave) {
    semaforo = 'AMARILLO';
    motivoRiesgo = !estadoClave
      ? 'No se pudo determinar el estado de la clave fiscal'
      : 'No se pudo determinar la condicion frente al IVA';
  } else {
    semaforo = 'VERDE';
  }

  if (!apocOk) advertencias.push('No se pudo consultar la base de apocrifos (WSAPOC).');

  // Sugerencia de comprobante a emitir (requiere condicion del emisor configurada).
  const receptorCondicionId = reglas.idDesdeTipoContribuyente(tipoContribuyente);
  const sugerencia = reglas.sugerirComprobante({
    emisorCondicion: (config.emisor && config.emisor.condicionIva) || '',
    receptorCondicionId,
  });

  return {
    cuit: target,
    nombre,
    semaforo,
    motivoRiesgo,
    fiscal: {
      tipoContribuyente,
      condicionIVA,
      tipoComprobante,
      estadoClave: estadoClave || 'N/A',
      domicilio: armarDomicilio(dg) || 'N/A',
      categoriaMonotributo: esMonotributo ? datos.datosMonotributo.categoriaMonotributo : null,
    },
    apoc: {
      consultado: apocOk,
      esApocrifo,
      fechaCondicion: apocData ? apocData.fechaCondicion : null,
      fechaPublicacion: apocData ? apocData.fechaPublicacion : null,
    },
    comprobanteSugerido: {
      letra: sugerencia.letra,
      tipoComprobante: sugerencia.tipoComprobante,
      requiereIva: sugerencia.requiereIva,
      condicionIvaReceptorId: receptorCondicionId,
      condicionIvaReceptor: sugerencia.condicionIvaReceptor,
      motivo: sugerencia.motivo,
    },
    advertencias,
    fuentes: ['padron_a5', 'wsapoc'],
  };
}

module.exports = { consolidar };
