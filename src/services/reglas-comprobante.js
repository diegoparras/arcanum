'use strict';

// Reglas de comprobante: sugiere la LETRA (A/B/C) y si corresponde discriminar
// IVA, segun la condicion del emisor y del receptor frente al IVA. Es una ayuda
// (no reemplaza el criterio del contador). Tambien expone la tabla oficial de
// "Condicion IVA del receptor" (RG 5616, obligatoria en WSFEv1 desde 2025).

// FEParamGetCondicionIvaReceptor (ids oficiales de ARCA).
const CONDICION_IVA_RECEPTOR = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado - Ley 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
};

// Tipos de comprobante (codigos ARCA).
const TIPOS = {
  A: { factura: 1, notaDebito: 2, notaCredito: 3 },
  B: { factura: 6, notaDebito: 7, notaCredito: 8 },
  C: { factura: 11, notaDebito: 12, notaCredito: 13 },
  M: { factura: 51, notaDebito: 52, notaCredito: 53 },
};

function condicionIvaLabel(id) {
  return CONDICION_IVA_RECEPTOR[Number(id)] || null;
}

// Mapea el tipoContribuyente que devuelve el padron (A5) al id de condicion IVA.
function idDesdeTipoContribuyente(tipo) {
  switch (String(tipo || '').toUpperCase()) {
    case 'RESPONSABLE_INSCRIPTO': return 1;
    case 'EXENTO': return 4;
    case 'MONOTRIBUTISTA': return 6;
    case 'NO_RESPONSABLE': return 15;
    case 'CONSUMIDOR_FINAL': return 5;
    default: return null;
  }
}

/**
 * Sugiere el comprobante a emitir.
 * @param {object} p
 * @param {string} p.emisorCondicion   'RI' | 'MONOTRIBUTO' | 'EXENTO'
 * @param {number} [p.receptorCondicionId]  id de condicion IVA del receptor (tabla oficial)
 * @param {string} [p.docKind]         'factura' | 'notaDebito' | 'notaCredito'
 * @returns {{letra, tipoComprobante, requiereIva, condicionIvaReceptorId, condicionIvaReceptor, motivo}}
 */
function sugerirComprobante(p = {}) {
  const emisor = String(p.emisorCondicion || '').toUpperCase();
  const docKind = p.docKind && TIPOS.A[p.docKind] ? p.docKind : 'factura';
  const recId = p.receptorCondicionId != null ? Number(p.receptorCondicionId) : null;

  let letra;
  let requiereIva;
  let motivo;

  if (emisor === 'MONOTRIBUTO' || emisor === 'MONOTRIBUTISTA' || emisor === 'EXENTO') {
    letra = 'C';
    requiereIva = false;
    motivo = `Emisor ${emisor === 'EXENTO' ? 'Exento' : 'Monotributista'}: siempre comprobante C (sin discriminar IVA).`;
  } else if (emisor === 'RI' || emisor === 'RESPONSABLE_INSCRIPTO') {
    if (recId === 1) {
      letra = 'A';
      requiereIva = true;
      motivo = 'Emisor RI a receptor Responsable Inscripto: comprobante A (IVA discriminado).';
    } else {
      letra = 'B';
      requiereIva = true;
      motivo = 'Emisor RI a receptor no inscripto (CF/Monotributo/Exento): comprobante B (IVA incluido).';
    }
  } else {
    return { letra: null, tipoComprobante: null, requiereIva: null, condicionIvaReceptorId: recId, condicionIvaReceptor: condicionIvaLabel(recId), motivo: 'Condicion del emisor no configurada (definí ARCANUM_EMISOR_CONDICION_IVA).' };
  }

  return {
    letra,
    tipoComprobante: TIPOS[letra][docKind],
    requiereIva,
    condicionIvaReceptorId: recId,
    condicionIvaReceptor: condicionIvaLabel(recId),
    motivo,
  };
}

module.exports = { CONDICION_IVA_RECEPTOR, TIPOS, condicionIvaLabel, idDesdeTipoContribuyente, sugerirComprobante };
