'use strict';

// Escapador unico para los CSV que exporta Arcanum (auditoria 2026-11-26, B-03).
//
// Una celda de texto que empieza con = + - @ (o con tab / retorno de carro) la planilla la
// interpreta como formula: un operador que escribe el nombre de un lote "=HYPERLINK(...)" hace
// correr algo en la maquina del admin que exporta. Esas celdas llevan un apostrofo adelante.
// Los numeros (tambien negativos) no se tocan: siguen siendo numeros en la planilla.

const NUMERO = /^-?\d+([.,]\d+)?$/;

function celdaCsv(v, sep = ';') {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (typeof v !== 'number' && !NUMERO.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  const especiales = new RegExp(`["\\n\\r${sep === ',' ? ',' : ';'}]`);
  return especiales.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { celdaCsv };
