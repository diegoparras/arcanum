'use strict';

// Tipos de comprobante de ARCA que RESTAN al sumar lo facturado (notas de credito),
// incluidas las de exportacion (21), las de tique (110, 112-114) y las de FCE MiPyME (203/208/213).
const NOTAS_CREDITO = new Set([3, 8, 13, 21, 53, 110, 112, 113, 114, 203, 208, 213]);

// Notas de debito: suman como una factura; se distinguen solo para filtrar.
const NOTAS_DEBITO = new Set([2, 7, 12, 20, 52, 202, 207, 212]);

function esNotaCredito(tipo) {
  return NOTAS_CREDITO.has(Number(tipo));
}

function esNotaDebito(tipo) {
  return NOTAS_DEBITO.has(Number(tipo));
}

/** Importe con signo: las notas de credito restan. */
function conSigno(tipo, importe) {
  const n = Number(importe) || 0;
  return esNotaCredito(tipo) ? -n : n;
}

module.exports = { NOTAS_CREDITO, NOTAS_DEBITO, esNotaCredito, esNotaDebito, conSigno };
